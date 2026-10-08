import { SourceRequestError } from "@amr/source-sdk"
import {
    cacheCover,
    db,
    recordAnalyticsEvent,
    saveProgress,
    saveResolvedChapter,
    trackExternalChapter,
    updateManga
} from "../database"
import { isProfileSource } from "../arch-sources"
import { findSource, resolveChapterUrl, resolveMangaMetadata } from "../sources"
import { getSettings } from "../settings"
import { scheduleChapterListRefresh } from "./chapter-cache"
import { fetchCoverBlob } from "./covers"
import { publishLive } from "../live"

// URLs currently being captured - deduplicate concurrent calls for the same URL
// (e.g. rapid navigation events or the same URL from multiple listener paths).
const capturingUrls = new Set<string>()

export async function captureChapter(url: string) {
    if (capturingUrls.has(url)) return { supported: true as const, added: false as const }
    capturingUrls.add(url)
    try {
        return await doCaptureChapter(url)
    } finally {
        capturingUrls.delete(url)
    }
}

async function doCaptureChapter(url: string) {
    const parsedUrl = new URL(url)
    const source = findSource(parsedUrl)

    if (!source || source.match(parsedUrl) !== "chapter") {
        return { supported: false as const }
    }

    const settings = await getSettings()
    const markRead = settings.markReadOnVisit ?? true
    if (!settings.autoAdd) {
        // Auto-add is off, so don't create anything - but still advance read progress for a
        // title already in the library (createIfMissing:false), so opening a chapter on the
        // source site of a book you already track keeps your position current.
        if (markRead) {
            const mangaInfo = source.parseMangaUrl?.(parsedUrl) ?? undefined
            try {
                const tracked = await trackExternalChapter({
                    url,
                    sourceId: source.manifest.id,
                    completed: true,
                    createIfMissing: false,
                    ...(mangaInfo ? { mangaInfo } : {}),
                    ...(source.normalizeSourceMangaId ? { normalizeSlug: source.normalizeSourceMangaId } : {})
                })
                if (tracked.tracked) publishLive(["library", "chapters", "progress"], [tracked.mangaId])
            } catch (error) {
                console.debug("[AMR] mark-read-on-visit (auto-add off) failed", { url, error })
            }
        }
        return { supported: true as const, added: false as const }
    }

    let resolved
    try {
        resolved = await resolveChapterUrl(url)
    } catch (error) {
        // The source's images can't be scraped (anti-scrape / spoiler / dead CDN).
        // Still add the title and track it by URL so the library follows progress
        // even when the chapter only reads on the source site.
        void recordAnalyticsEvent({
            event: "capture_error",
            sourceId: source.manifest.id,
            detail: JSON.stringify({ errorType: classifyError(error) }),
            ts: Date.now()
        })
        const mangaInfo = source.parseMangaUrl?.(parsedUrl) ?? undefined
        let tracked
        try {
            tracked = await trackExternalChapter({
                url,
                sourceId: source.manifest.id,
                completed: markRead,
                ...(mangaInfo ? { mangaInfo } : {}),
                ...(source.normalizeSourceMangaId ? { normalizeSlug: source.normalizeSourceMangaId } : {})
            })
        } catch (trackError) {
            console.warn("[AMR] Failed to track external chapter", { url, trackError })
            return { supported: true as const, added: false as const }
        }
        console.debug("[AMR] Captured chapter without scraping", { url, error })
        // Best-effort: prime the chapter list so the on-page panel can show prev/next.
        // Uses tab injection for JS-rendered list pages (e.g. Webtoons) to get the
        // full episode count, not just what SW-fetch returns. Gate on tracked.created
        // like reader.ts's chapter:track: without it, a fully-populated title (e.g. a
        // oneshot) whose images can't be scraped re-opened the up-to-20-tab crawl on
        // every cooldown-apart revisit. Use tracked.mangaId (the actual DB entry).
        if (mangaInfo && tracked.created) {
            scheduleChapterListRefresh(source, mangaInfo.sourceMangaId, mangaInfo.mangaUrl, tracked.mangaId)
        }
        // The external-track path only has a humanized-slug title and no cover (resolveChapter
        // was blocked). Best-effort pull the real title/cover from the manga page. Retry on ANY
        // visit where the title is still a slug placeholder - not only on first creation: if the
        // manga page was also gated at mint time the title would otherwise stay a slug forever
        // (no periodic job re-derives title). scheduleChapterListRefresh stays created-gated to
        // avoid re-opening the tab-crawl on every revisit.
        if (mangaInfo && (tracked.created || isPlaceholderTitle(tracked.title, mangaInfo.sourceMangaId))) {
            void refreshExternalMangaMetadata(source.manifest.id, mangaInfo, tracked.mangaId)
        }
        publishLive(["library", "chapters"], [tracked.mangaId])
        await flashAddedBadge()
        return { supported: true as const, added: true as const, external: true as const, title: tracked.title }
    }

    void recordAnalyticsEvent({ event: "capture_ok", sourceId: source.manifest.id, ts: Date.now() })

    // A profile (user-added) source resolves a chapter without ever reading the series page, so the
    // title it hands back is the URL slug and there is no cover. Note what is already stored so a
    // real title/cover is neither overwritten by that placeholder nor left unfilled.
    const profileSource = isProfileSource(source.manifest.id)
    const stored = profileSource ? await db.manga.get(resolved.manga.manga.id) : undefined
    const keepStoredIdentity = !!stored && !isPlaceholderTitle(stored.title, resolved.manga.sourceMangaId)
    const needsMetadata = profileSource && !keepStoredIdentity

    await saveResolvedChapter({
        manga: keepStoredIdentity
            ? {
                  ...resolved.manga.manga,
                  title: stored.title,
                  normalizedTitle: stored.normalizedTitle,
                  ...(stored.coverUrl ? { coverUrl: stored.coverUrl } : {})
              }
            : resolved.manga.manga,
        chapter: resolved.chapter,
        sourceLink: {
            mangaId: resolved.manga.manga.id,
            sourceId: resolved.manga.sourceId,
            sourceMangaId: resolved.manga.sourceMangaId,
            url: resolved.manga.url,
            title: resolved.manga.manga.title,
            addedAt: Date.now(),
            updatedAt: Date.now()
        }
    })
    // Mark the visited chapter read (ratcheting forward only, never regressing) so reading on
    // the source site keeps progress current, same as the AMR reader would. saveResolvedChapter
    // has already written this chapter row, so saveProgress can look up its sortKey.
    if (markRead) {
        try {
            await saveProgress({
                mangaId: resolved.manga.manga.id,
                chapterId: resolved.chapter.id,
                pageIndex: 0,
                pageCount: 1,
                completed: true,
                updatedAt: Date.now()
            })
        } catch (error) {
            console.debug("[AMR] mark-read-on-visit failed", { url, error })
        }
    }

    publishLive(["library", "chapters", "progress"], [resolved.manga.manga.id])

    // Fill the real title and cover from the series page (through the source's own request scope).
    // Fire-and-forget: a gated or failing series page just leaves the placeholder, retried on the
    // next visit because the stored title still equals it.
    if (needsMetadata) {
        void refreshExternalMangaMetadata(
            source.manifest.id,
            { sourceMangaId: resolved.manga.sourceMangaId, mangaUrl: resolved.manga.url },
            resolved.manga.manga.id
        )
    }

    // Best-effort: cache the cover as a Blob so the UI can render it from IndexedDB
    // instead of hotlinking the source CDN on every render. The manga record keeps
    // its real remote coverUrl untouched - a cover-fetch failure here must never
    // fail the capture itself.
    if (resolved.manga.manga.coverUrl) {
        try {
            const blob = await fetchCoverBlob(resolved.manga.manga.coverUrl)
            if (blob) await cacheCover(resolved.manga.manga.id, blob)
        } catch (error) {
            console.warn("[AMR] Failed to cache cover", { url: resolved.manga.manga.coverUrl, error })
        }
    }

    // Fire-and-forget: cache the full chapter list so the on-page panel can
    // show prev/next siblings without a network round-trip on each visit.
    // Dedup by manga so two rapid captures of the same series don't double-fetch.
    scheduleChapterListRefresh(source, resolved.manga.sourceMangaId, resolved.manga.url, resolved.manga.manga.id)

    await flashAddedBadge()
    return { supported: true as const, added: true as const, manga: resolved.manga.manga }
}

// Best-effort metadata recovery for an externally-tracked title (added while the chapter
// page was bot-blocked, so it has only a slug title and no cover). New titles only - the
// caller gates on tracked.created - so this never clobbers a title the user renamed. A
// failure here is expected on fully-gated sources and leaves the slug title untouched.
// A raw URL slug ("solo-leveling-season-2"): separator-joined, no whitespace, and all lowercase.
// The lowercase check is what keeps genuinely hyphenated single-token DISPLAY titles - "Spider-Man",
// "Re-Zero", "Kaiju-No8" - from being mistaken for a slug and discarded in favour of the humanized
// placeholder; a real adapter slug is lowercased, a display title keeps its capitals.
export function isSlugLikeTitle(title: string): boolean {
    return /[-_]/.test(title) && !/\s/.test(title) && !/[A-Z]/.test(title)
}

// A title that is still the placeholder derived from the URL: either a raw slug, or the humanized
// slug ("demo title" / "Demo Title") that trackExternalChapter and the profile engine write. Unlike
// isSlugLikeTitle this also catches the spaced form, which is what a freshly captured profile-source
// row carries, so the metadata recovery fires for it.
export function isPlaceholderTitle(title: string, sourceMangaId: string): boolean {
    if (isSlugLikeTitle(title)) return true
    const squash = (value: string): string => value.toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, "")
    const slug = squash(sourceMangaId)
    return slug.length > 0 && squash(title) === slug
}

export async function refreshExternalMangaMetadata(
    sourceId: string,
    mangaInfo: { sourceMangaId: string; mangaUrl: string },
    mangaId: string
): Promise<void> {
    try {
        const meta = await resolveMangaMetadata({
            sourceId,
            sourceMangaId: mangaInfo.sourceMangaId,
            mangaUrl: mangaInfo.mangaUrl
        })
        if (!meta) return
        const patch: Parameters<typeof updateManga>[1] = {}
        // Only replace the title trackExternalChapter already humanized (dashes/underscores
        // -> spaced, title-cased) when resolveManga returned a REAL title, not an adapter's
        // raw-slug fallback (e.g. comix returns "solo-leveling-season-2" on a parse miss).
        // A slug-shaped string - separators and no spaces - is a downgrade, so keep ours.
        if (meta.title && !isSlugLikeTitle(meta.title)) {
            patch.title = meta.title
            patch.normalizedTitle = meta.title.toLocaleLowerCase("en").replace(/\s+/g, " ")
        }
        if (meta.coverUrl) patch.coverUrl = meta.coverUrl
        if (Object.keys(patch).length === 0) return
        await updateManga(mangaId, patch)
        if (meta.coverUrl) {
            try {
                const blob = await fetchCoverBlob(meta.coverUrl)
                if (blob) await cacheCover(mangaId, blob)
            } catch (error) {
                console.warn("[AMR] Failed to cache external cover", { url: meta.coverUrl, error })
            }
        }
        publishLive(["library"], [mangaId])
    } catch (error) {
        console.debug("[AMR] External metadata refresh failed", { mangaId, error })
    }
}

// Alarm that clears the "ADD" badge. A setTimeout does not survive MV3 service-worker
// suspension, so a worker torn down before the timeout fired would leave the badge
// stuck. An alarm wakes the worker to clear it; background.ts also clears it on
// startup as a final net.
export const ADD_BADGE_ALARM_NAME = "amr:clear-add-badge"

export async function clearAddedBadge() {
    await browser.action.setBadgeText({ text: "" })
}

export async function flashAddedBadge() {
    await browser.action.setBadgeBackgroundColor({ color: "#2d8a61" })
    await browser.action.setBadgeText({ text: "ADD" })
    // setTimeout keeps the flash short while the worker stays alive; the alarm is the
    // durable clear for the case where the worker suspends before it fires.
    setTimeout(() => void clearAddedBadge(), 4000)
    // Best-effort: the alarms API is absent in some contexts (and in unit tests); the
    // setTimeout above still handles the common case, so a missing alarms API is fine.
    await browser.alarms?.create(ADD_BADGE_ALARM_NAME, { when: Date.now() + 4000 })
}

// "Add available": a per-tab badge on an unrecognised reader page. Tab-scoped so it never fights the
// global "ADD" flash above, and tracked so only a badge we set is ever cleared (a blanket tab clear
// would hide the global flash on that tab).
const ADD_AVAILABLE_TEXT = "+"
const addAvailableTabs = new Set<number>()

export async function setAddAvailableBadge(tabId: number): Promise<void> {
    addAvailableTabs.add(tabId)
    await browser.action.setBadgeBackgroundColor({ tabId, color: "#3b6fd4" })
    await browser.action.setBadgeText({ tabId, text: ADD_AVAILABLE_TEXT })
}

// Clears the per-tab hint. Presence comes from the browser's own tab badge, not only the in-memory
// set: the set is lost when the service worker is suspended, which left a stale "+" on a tab whose
// page has since moved on. The global "ADD" flash is a different text, so it is never cleared here.
export async function clearAddAvailableBadge(tabId: number): Promise<void> {
    const tracked = addAvailableTabs.delete(tabId)
    let text = ""
    try {
        text = (await browser.action.getBadgeText({ tabId })) ?? ""
    } catch {
        // getBadgeText is best-effort; fall back to what this worker remembers
    }
    if (!tracked && text !== ADD_AVAILABLE_TEXT) return
    // null drops the per-tab override so the global badge text shows again; "" would pin a blank badge.
    // Both browsers accept null, but the bundled typings only declare string.
    await browser.action.setBadgeText({ tabId, text: null as unknown as string })
}

export function classifyError(error: unknown): string {
    if (error instanceof SourceRequestError) {
        const s = error.status
        if (s === 403 || s === 502 || s === 503) return "bot-block"
        if (s === 404) return "not-found"
        if (s === undefined) return "network"
        return `http-${s}`
    }
    return "unknown"
}

export function isBotBlocked(error: unknown): boolean {
    if (!(error instanceof SourceRequestError)) return false
    const { status } = error
    // Adapter deliberately signalled bot-block - use tab fallback.
    if (error.message === "blocked") return true
    // CDN / reverse-proxy blocks that real browser session can bypass.
    return status === 403 || status === 502 || status === 503
    // NOTE: status === undefined (network timeout / connection refused) is intentionally
    // NOT treated as bot-blocked here. A genuinely-down site should fast-fail the reader
    // rather than burning 25 s on a tab that also can't load.
}
