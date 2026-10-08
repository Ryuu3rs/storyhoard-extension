import type { ReadingProgress } from "@amr/contracts"
import {
    db,
    isHttpUrl,
    listVersionsByWork,
    listWorkOverrides,
    putChapters,
    recordAnalyticsEvent,
    saveProgress,
    saveReaderResolvedChapter,
    trackExternalChapter,
    updateManga
} from "../database"
import { parseChapterLabel } from "@amr/source-sdk"
import { workKeyOf } from "../work-identity"
import { rankWorkVersions, shouldShowBetterHint, withDerivedCanonical, type VersionCtx } from "../work-ranking"
import { recordMirrorVersions, versionIdFor } from "../work-versions"
import { chapterListForUrl, isProfileSource, isTextNumberedSource } from "../arch-sources"
import { chaptersFromObservedList, recordObservedChapters } from "../observed-chapter-list"
import { getCachedOfficialSites, officialNameForHost } from "../official-sources"
import {
    chaptersForLanguage,
    findSource,
    getSourceById,
    listChaptersBySource,
    resolveChapterFromHtml,
    resolveChapterUrl,
    tabOriginsForSource
} from "../sources"
import { getSettings } from "../settings"
import {
    ensureChapterListRefreshed,
    MANGAHUB_INTERNAL_ID_MIN,
    mineAndCacheEpisodesFromHtml,
    scheduleChapterListRefresh
} from "../background/chapter-cache"
import { fetchChapterHtmlViaTab } from "../background/tab-fetch"
import {
    captureChapter,
    isBotBlocked,
    isPlaceholderTitle,
    isSlugLikeTitle,
    refreshExternalMangaMetadata
} from "../background/capture"
import { publishLive } from "../live"
import type { HandlerMap } from "../background/handler-types"

// MangaHub internal-id rows (sortKey >= floor) are legacy poison, never a real chapter -
// exclude them from every read-time chapter list so a stale one can't become a phantom
// "next" past the true latest chapter (the "Next always available on MangaHub" bug).
function dropMangahubInternalIds<T extends { sourceId: string; sortKey: number }>(chapters: T[]): T[] {
    return chapters.filter(
        c => !(c.sourceId === "mangahub" && Number.isFinite(c.sortKey) && c.sortKey >= MANGAHUB_INTERNAL_ID_MIN)
    )
}

// Fallback for chapter:siblings when no cached row has the exact page URL. A stored URL
// can legitimately differ from the one the user is on: Comix, for example, addresses
// chapters by an opaque id that only its encrypted API knows, so the cached list uses a
// placeholder-id URL the site redirects to the canonical one. Without this the on-page
// panel's prev/next stayed dead even with a fully cached list. Matches on the manga the
// URL belongs to plus the chapter number in the path, so it only ever resolves to a
// chapter of that same title.
const CHAPTER_NUM_IN_PATH = /(?:^|\/|-)chapter[-_/]?(\d+(?:\.\d+)?)(?:\/|$|[-_?#])/i

async function findChapterByNumberInUrl(rawUrl: string) {
    let parsed: URL
    try {
        parsed = new URL(rawUrl)
    } catch {
        return undefined
    }
    const source = findSource(parsed)
    const mangaInfo = source?.parseMangaUrl?.(parsed)
    if (!source || !mangaInfo) return undefined
    const num = Number.parseFloat(parsed.pathname.match(CHAPTER_NUM_IN_PATH)?.[1] ?? "")
    if (!Number.isFinite(num)) return undefined
    const mangaId = `${source.manifest.id}:manga:${mangaInfo.sourceMangaId}`
    return await db.chapters
        .where("mangaId")
        .equals(mangaId)
        .filter(c => c.sortKey === num)
        .first()
}

// ARCH TRACK A: build the ranking context from the user's settings. preferredLanguages is the
// primary 2-letter subtag of the language setting.
async function buildVersionCtx(lastReadNumber?: number): Promise<VersionCtx> {
    const { language } = await getSettings()
    const primary = language.toLowerCase().split(/[-_]/)[0] ?? language
    return {
        preferredLanguages: new Set(primary ? [primary] : []),
        now: Date.now(),
        ...(lastReadNumber !== undefined ? { lastReadNumber } : {})
    }
}

export const readerHandlers: HandlerMap = {
    // Name + tip link of a source, for the reader header's support buttons.
    "source:info": async request => {
        const source = getSourceById(request.sourceId)
        if (!source) return null
        return {
            id: source.manifest.id,
            name: source.manifest.name,
            homepage: source.manifest.homepage ?? null,
            supportUrl: source.manifest.supportUrl ?? null
        }
    },
    "page:current": async (_request, ctx) => {
        const tab = ctx.sender.tab ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0]
        const url = tab?.url
        if (!url) return { supported: false }
        let parsedUrl: URL
        try {
            parsedUrl = new URL(url)
        } catch {
            return { supported: false }
        }
        const source = findSource(parsedUrl)
        const pageType = source?.match(parsedUrl) ?? "none"
        return {
            supported: Boolean(source) && pageType !== "none",
            pageType,
            url,
            ...(source ? { sourceName: source.manifest.name } : {})
        }
    },

    "page:capture": async request => {
        return await captureChapter(request.url)
    },

    "reader:resolve": async request => {
        // Offline fallback: if the chapter can't be fetched (no network) but a downloaded copy
        // exists, build a ResolvedChapter from the stored rows so the reader still opens it (its
        // refreshDownloadState swaps in the page blobs) and progress still records. Keyed by the
        // exact opened URL via the cached chapter row.
        const resolveFromDownload = async (): Promise<Awaited<ReturnType<typeof resolveChapterUrl>> | null> => {
            const chapterRow = await db.chapters.where("url").equals(request.url).first()
            if (!chapterRow) return null
            const download = await db.downloads.get(chapterRow.id)
            if (!download || download.pageCount <= 0) return null
            const mangaRow = await db.manga.get(chapterRow.mangaId)
            if (!mangaRow) return null
            const link = await db.sourceLinks.get(chapterRow.mangaId)
            return {
                manga: {
                    manga: mangaRow,
                    sourceId: mangaRow.sourceId,
                    sourceMangaId: mangaRow.sourceMangaId ?? "",
                    url: link?.url ?? mangaRow.mangaUrl ?? mangaRow.sourceUrl ?? request.url
                },
                chapter: { ...chapterRow, sourceChapterId: chapterRow.id, language: chapterRow.language ?? "en" },
                // Placeholder pages sized to the download; the reader renders the real blobs.
                pages: Array.from({ length: download.pageCount }, (_, i) => ({
                    id: `${chapterRow.id}:offline:${i}`,
                    url: ""
                }))
            }
        }

        let resolved
        try {
            resolved = await resolveChapterUrl(request.url)
            const directSrcId = findSource(new URL(request.url))?.manifest.id
            void recordAnalyticsEvent({
                event: "resolve_direct",
                ...(directSrcId ? { sourceId: directSrcId } : {}),
                ts: Date.now()
            })
        } catch (fetchError) {
            if (isBotBlocked(fetchError)) {
                const srcId = findSource(new URL(request.url))?.manifest.id
                void recordAnalyticsEvent({
                    event: "resolve_tab",
                    ...(srcId ? { sourceId: srcId } : {}),
                    ts: Date.now()
                })
                const html = await fetchChapterHtmlViaTab(request.url, srcId ? tabOriginsForSource(srcId) : undefined)
                resolved = await resolveChapterFromHtml(request.url, html)
                // Mine all episode links from the rendered viewer DOM and cache
                // them so the on-site panel's prev/next and mark-as-read work.
                // Awaited (not fire-and-forget): it's a local regex parse + bulkPut,
                // not a network call, and the reader calls loadSiblings right after
                // this handler returns - a race here would leave siblings empty.
                await mineAndCacheEpisodesFromHtml(
                    resolved.manga.manga.id,
                    resolved.manga.sourceId,
                    resolved.manga.sourceMangaId,
                    new URL(request.url).hostname,
                    html
                ).catch(() => {})
            } else {
                // Network fetch failed (e.g. offline) and it's not a bot-block. Serve a
                // downloaded copy if we have one before surfacing the error.
                const offline = await resolveFromDownload()
                if (offline) return offline
                throw fetchError
            }
        }
        // Slug-rotation self-heal (Asura and friends rotate the per-series slug hash): the
        // URL the reader opened resolves to a FRESH source/manga/chapter id, but the library
        // entry lives under the slug it was added with. If the resolved manga id isn't in the
        // library yet a cached chapter row already maps this exact URL to an existing entry,
        // rebind the resolved identity onto that entry - otherwise saveProgress silently drops
        // every write (its manga-exists guard) and nothing is ever tracked.
        if ((await db.manga.get(resolved.manga.manga.id)) === undefined) {
            const owned = await db.chapters.where("url").equals(request.url).first()
            if (owned && (await db.manga.get(owned.mangaId))) {
                resolved.manga.manga.id = owned.mangaId
                resolved.chapter.id = owned.id
                resolved.chapter.mangaId = owned.mangaId
            }
        }
        // Persist chapter so saveProgress can look up its sortKey for
        // lastReadChapterNumber, plus backfill coverUrl into the library entry if
        // missing - one transaction. The live publish is driven by MUTATION_SCOPES
        // (["chapters", "library"]) so the library scope also covers the backfill.
        await saveReaderResolvedChapter({
            chapter: resolved.chapter,
            mangaId: resolved.manga.manga.id,
            ...(resolved.manga.manga.coverUrl ? { coverUrl: resolved.manga.manga.coverUrl } : {})
        })
        return resolved
    },

    "chapter:siblings": async request => {
        // Look up cached chapters from DB - no network call needed.
        // auto-capture already stored chapters when the user first visited.
        let chRecord = await db.chapters.where("url").equals(request.url).first()
        if (!chRecord) chRecord = await findChapterByNumberInUrl(request.url)
        if (!chRecord)
            return { prevUrl: null, nextUrl: null, mangaTitle: null, chapterTitle: null, mangaId: null, workKey: null }
        const manga = await db.manga.get(chRecord.mangaId)
        if (!manga)
            return { prevUrl: null, nextUrl: null, mangaTitle: null, chapterTitle: null, mangaId: null, workKey: null }
        const all = await db.chapters.where("mangaId").equals(chRecord.mangaId).sortBy("sortKey")
        // Step prev/next within a single language so on a multi-language source (MangaDex
        // serves the same chapter in several languages) "next" lands on the next chapter in
        // that language, never a different translation. Prefer the user's language; if the
        // open chapter isn't in it (they deliberately opened another), stay within THAT
        // chapter's own language rather than the full cross-language list.
        const { language } = await getSettings()
        const cleaned = dropMangahubInternalIds(all)
        const preferred = chaptersForLanguage(cleaned, language)
        const inPreferred = preferred.some(c => c.id === chRecord.id)
        const sameLanguage = cleaned.filter(c => (c.language ?? "") === (chRecord.language ?? ""))
        const scoped = inPreferred ? preferred : sameLanguage.length > 0 ? sameLanguage : all
        // Dedupe by chapter number so a leftover duplicate upload of the same number (legacy
        // data from before the adapter deduped) is never a prev/next target; the currently
        // open row always wins for its own number.
        const byNumber = new Map<number, (typeof scoped)[number]>()
        const unnumbered: typeof scoped = []
        for (const chapter of scoped) {
            if (!Number.isFinite(chapter.sortKey)) {
                unnumbered.push(chapter)
                continue
            }
            const current = byNumber.get(chapter.sortKey)
            if (!current || chapter.id === chRecord.id) byNumber.set(chapter.sortKey, chapter)
        }
        const siblings = [...byNumber.values(), ...unnumbered].sort((a, b) => a.sortKey - b.sortKey)
        const idx = siblings.findIndex(c => c.id === chRecord.id)
        const prev = idx > 0 ? siblings[idx - 1] : null
        const next = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null
        return {
            prevUrl: prev?.url ?? null,
            nextUrl: next?.url ?? null,
            mangaTitle: manga.title,
            chapterTitle: chRecord.title ?? null,
            // ARCH TRACK A: the work context the panel needs to ask for the best version.
            mangaId: manga.id,
            workKey: workKeyOf(manga, manga.id)
        }
    },

    "reader:chapters": async request => {
        // The chapter dropdown shows only the user's preferred language on a
        // multi-language source; chaptersForLanguage keeps untagged chapters and falls
        // back to the full list when nothing matches (see its doc in sources.ts).
        const { language } = await getSettings()
        const fromCache = async () => {
            const cached = await db.chapters.where("mangaId").equals(request.mangaId).sortBy("sortKey")
            return chaptersForLanguage(dropMangahubInternalIds(cached), language).map(c => ({
                url: c.url,
                sortKey: c.sortKey,
                title: c.title
            }))
        }

        const source = getSourceById(request.sourceId)
        if (source?.getChapterListUrl) {
            // JS-rendered list page (e.g. Webtoons) - a plain SW fetch is known to
            // return a partial/empty list, so check the DB cache first instead of
            // attempting a fetch we already know will fail.
            const cached = await fromCache()
            if (cached.length > 0) {
                // Already have something to show - refresh in the background without
                // blocking this response (picks up newly published episodes, and keeps
                // paginating for the true total on a long-running series).
                scheduleChapterListRefresh(source, request.sourceMangaId, request.mangaUrl, request.mangaId)
                return cached
            }
            // Nothing cached yet - this is the very first time this title's chapter
            // list has ever been requested. Firing scheduleChapterListRefresh here and
            // returning the (empty) cache immediately would race it: reader:resolve's
            // own viewer-page mining only sees whatever handful of nearby episodes
            // Webtoons' viewer dropdown happens to have rendered, which is often too
            // few to populate the cache, so the response would come back empty and the
            // reader would show no prev/next controls on a title's first-ever open.
            // Await the tab-rendered list-page refresh (joins the same in-flight
            // refresh if one is already running, e.g. from auto-capture) so the first
            // response reflects real data instead of racing it.
            await ensureChapterListRefreshed(source, request.sourceMangaId, request.mangaUrl, request.mangaId)
            const refreshed = await fromCache()
            if (refreshed.length > 0) return refreshed
        }

        try {
            const chapters = await listChaptersBySource(
                request.sourceId,
                request.sourceMangaId,
                request.mangaUrl,
                language ? [language] : undefined
            )
            // A list that's just the 2-3 paginate prev/next links isn't useful - fall
            // back to whatever's cached rather than showing a broken nav with 1-2 items.
            if (chapters.length <= 2) return await fromCache()
            await putChapters(chapters)
            publishLive(["chapters"], [request.mangaId])
            return chaptersForLanguage(dropMangahubInternalIds(chapters), language)
                .map(c => ({ url: c.url, sortKey: c.sortKey, title: c.title }))
                .sort((a, b) => a.sortKey - b.sortKey)
        } catch {
            // Source can't list chapters over the network (e.g. mgeko, or bot-blocked
            // mid-session) - fall back to whatever's cached rather than no nav at all.
            return await fromCache()
        }
    },

    "reader:progress:get": async request => {
        return (await db.progress.get(request.chapterId)) ?? null
    },

    "reader:progress": async request => {
        const progress: ReadingProgress = {
            mangaId: request.mangaId,
            chapterId: request.chapterId,
            pageIndex: request.pageIndex,
            pageCount: request.pageCount,
            completed: request.completed,
            updatedAt: Date.now()
        }
        await saveProgress(progress)
        return progress
    },

    "chapter:track": async request => {
        const parsedUrl = new URL(request.url)
        const source = findSource(parsedUrl)
        if (!source || source.match(parsedUrl) !== "chapter") {
            return { supported: false as const }
        }
        void recordAnalyticsEvent({
            event: "on_site_track",
            sourceId: source.manifest.id,
            ts: Date.now()
        })
        // Prefer the adapter's URL-level series id. When the adapter can't derive one from a
        // chapter URL (e.g. MangaDex's /chapter/<uuid>, which carries no series id, and has no
        // parseMangaUrl at all), a plain URL track keys the entry off deriveSlug's generic
        // first path segment - "chapter" - so EVERY distinct title on that source collapses
        // onto one shared record. A manual mark on a new title then silently merges into the
        // first one tracked and never appears as its own library entry - the "Mark read
        // doesn't add the manga" report. Resolve the chapter once to recover the real series
        // id (unique per title, stable across its chapters) so the entry is a proper,
        // per-title record instead of a colliding stub.
        let mangaInfo = source.parseMangaUrl?.(parsedUrl) ?? undefined
        let resolvedManga: Awaited<ReturnType<typeof resolveChapterUrl>>["manga"] | undefined
        if (!mangaInfo) {
            try {
                const resolved = await resolveChapterUrl(request.url)
                resolvedManga = resolved.manga
                mangaInfo = { sourceMangaId: resolved.manga.sourceMangaId, mangaUrl: resolved.manga.url }
            } catch {
                // Offline / bot-blocked - fall through to the lightweight URL track below so
                // the read is still recorded, even if the entry stays a URL-keyed stub.
            }
        }
        // A source whose URL holds only an internal chapter id is numbered from the label the page shows.
        const labelNumber =
            request.label !== undefined && isTextNumberedSource(source.manifest.id)
                ? parseChapterLabel(request.label).number
                : undefined
        const tracked = await trackExternalChapter({
            url: request.url,
            sourceId: source.manifest.id,
            ...(labelNumber !== undefined ? { number: labelNumber } : {}),
            ...(mangaInfo ? { mangaInfo } : {}),
            // Lets the matcher recognise the same series across a rotated slug hash (Asura),
            // so an external mark-read attaches to the existing entry instead of duplicating it.
            ...(source.normalizeSourceMangaId ? { normalizeSlug: source.normalizeSourceMangaId } : {})
        })
        // No chapter-list refresh on a title that already has one. Marking a chapter read
        // must never re-open a tab crawl: on a getChapterListUrl source (Webtoons) that
        // crawl opens up to 20 background tabs, and "Mark read" was doing it on every
        // click. For an already-populated title the list is kept fresh by the page's own
        // auto-capture and, if the reader is open, by its loadSiblings subscriber - both
        // cooldown-gated.
        //
        // But a title being tracked for the FIRST time may have no other populate path at
        // all: auto-capture bails before scheduling anything when the user has auto-add
        // off, and the on-page panel's prev/next comes from a plain DB read that never
        // triggers a crawl. Schedule the populate exactly once - when THIS track created
        // the manga record. A count-based heuristic can't tell "not yet populated" from "a
        // real oneshot with one chapter", so it re-crawled a oneshot on every revisit; the
        // creation flag is unambiguous and fires only on the genuine first track.
        if (tracked.created) {
            if (mangaInfo) {
                scheduleChapterListRefresh(source, mangaInfo.sourceMangaId, mangaInfo.mangaUrl, tracked.mangaId)
            }
            // trackExternalChapter titles a fresh record from the chapter URL slug, which is a
            // placeholder at best ("Chapter", "Title No:95") - upgrade it to the real title and
            // cover so the new entry is recognizable in the library. Use the metadata the
            // resolve above already returned when we have it, otherwise best-effort pull it by
            // series id, mirroring the auto-capture external-track path (capture.ts).
            if (resolvedManga) {
                const patch: Parameters<typeof updateManga>[1] = {}
                if (resolvedManga.manga.title && !isSlugLikeTitle(resolvedManga.manga.title)) {
                    patch.title = resolvedManga.manga.title
                    patch.normalizedTitle = resolvedManga.manga.title.toLocaleLowerCase("en").replace(/\s+/g, " ")
                }
                if (resolvedManga.manga.coverUrl) patch.coverUrl = resolvedManga.manga.coverUrl
                // The dispatcher publishes ["library", "chapters"] for chapter:track once this
                // handler resolves (see MUTATION_SCOPES), so this in-band update needs no
                // separate publish - the refresh below is the fire-and-forget branch that does.
                if (Object.keys(patch).length > 0) await updateManga(tracked.mangaId, patch)
            } else if (mangaInfo) {
                void refreshExternalMangaMetadata(source.manifest.id, mangaInfo, tracked.mangaId)
            }
        } else if (mangaInfo && isPlaceholderTitle(tracked.title, mangaInfo.sourceMangaId)) {
            // Not first creation, but the title is still a slug placeholder - the manga page was
            // gated when the entry was minted and no periodic job re-derives title. Retry the
            // recovery on this visit so it doesn't stay a slug forever (mirrors capture.ts).
            void refreshExternalMangaMetadata(source.manifest.id, mangaInfo, tracked.mangaId)
        }
        return { supported: true as const, ...tracked }
    },

    "chapter:open-in-reader": async request => {
        const srcId = findSource(new URL(request.url))?.manifest.id
        void recordAnalyticsEvent({
            event: "reader_opened",
            ...(srcId ? { sourceId: srcId } : {}),
            ts: Date.now()
        })
        void captureChapter(request.url).catch(() => {})
        // On-site reading: open the chapter on the source itself; the in-app reader is retired.
        await browser.tabs.create({ url: request.url })
        return null
    },

    // ARCH TRACK A: rank a work's versions and open the best source's own page in a tab. The
    // on-site destination that replaces the in-app reader. "best" is advisory - this opens a tab,
    // it never repoints the tracked row.
    "work:open-best": async request => {
        const manga = await db.manga.get(request.mangaId)
        if (!manga) throw new Error("Title not found")
        const workKey = workKeyOf(manga, manga.id)
        const versions = await listVersionsByWork(workKey)
        const overrides = await listWorkOverrides()
        const pref = overrides.find(
            o => o.preferredSourceId && (o.members.includes(workKey) || o.members.includes(manga.id))
        )
        const ctx = await buildVersionCtx(manga.lastReadChapterNumber)
        const { best } = rankWorkVersions(versions, ctx, pref?.preferredSourceId)
        // Never navigate to a non-http(s) url from the pool (a hostile row could carry one).
        const url = best?.url && isHttpUrl(best.url) ? best.url : manga.sourceUrl
        await browser.tabs.create({ url })
        return { url }
    },

    // The on-site panel's chapter dropdown list (deduped + language-filtered, with a background
    // refresh for paginated sources). Ships to every user alongside the panel.
    "work:chapter-list": async request => {
        return chapterListForUrl(request.url)
    },

    // The chapter list the panel read from the user's own rendered page. This is how a profile source
    // with no list the extension can fetch fills its chapter dropdown and notices new chapters: the
    // user's tab is the only place the list exists. Nothing the page reports is trusted: only a
    // profile source is accepted, the title must already be tracked, and every link is re-checked
    // against the source's own origins and chapter URL shape (see chaptersFromObservedList).
    "work:record-chapter-list": async request => {
        const none = { recorded: 0, advanced: false }
        const pageUrl = new URL(request.url)
        const source = findSource(pageUrl)
        const origins = source ? tabOriginsForSource(source.manifest.id) : undefined
        if (!source || !origins || !isProfileSource(source.manifest.id)) return none
        const sourceId = source.manifest.id
        const info = source.parseMangaUrl?.(pageUrl) ?? undefined
        let manga = request.mangaId ? await db.manga.get(request.mangaId) : undefined
        if (manga && manga.sourceId !== sourceId) manga = undefined
        if (!manga && info) manga = await db.manga.get(`${sourceId}:manga:${info.sourceMangaId}`)
        if (!manga) {
            const chapter = await db.chapters.where("url").equals(request.url).first()
            manga = chapter ? await db.manga.get(chapter.mangaId) : undefined
        }
        const sourceMangaId = manga?.sourceMangaId ?? info?.sourceMangaId
        if (!manga || !sourceMangaId) return none
        const chapters = chaptersFromObservedList({
            source,
            sourceMangaId,
            mangaId: manga.id,
            allowedOrigins: origins,
            numberFromUrl: !isTextNumberedSource(sourceId),
            items: request.items
        })
        return recordObservedChapters({ mangaId: manga.id, chapters })
    },

    // Record cross-source versions for a tracked title from a mirror check (see recordMirrorVersions).
    "work:record-mirrors": async request => {
        await recordMirrorVersions(request.mangaId, request.mirrors)
        return null
    },

    // ARCH TRACK A: the on-site panel's "a more complete version is available" hint. Returns
    // hasBetter only when the ranker's best clears the silent-unless-clearly-better gate. Names the
    // destination only when it is a verified official site (decision D2 / R4).
    "work:best-for-url": async request => {
        const none = { hasBetter: false as const }
        let chRecord = await db.chapters.where("url").equals(request.url).first()
        if (!chRecord) chRecord = await findChapterByNumberInUrl(request.url)
        if (!chRecord) return none
        const manga = await db.manga.get(chRecord.mangaId)
        if (!manga) return none
        const workKey = workKeyOf(manga, manga.id)
        const versions = await listVersionsByWork(workKey)
        if (versions.length < 2) return none // cold start / single version: never nag
        const overrides = await listWorkOverrides()
        const pref = overrides.find(
            o => o.preferredSourceId && (o.members.includes(workKey) || o.members.includes(manga.id))
        )
        const ctx = withDerivedCanonical(versions, await buildVersionCtx(manga.lastReadChapterNumber))
        const { best } = rankWorkVersions(versions, ctx, pref?.preferredSourceId)
        const current =
            versions.find(v => v.id === versionIdFor(manga.sourceId, manga.sourceMangaId, manga.id)) ??
            versions.find(v => v.sourceId === manga.sourceId)
        if (!current || !best || !isHttpUrl(best.url) || !shouldShowBetterHint(current, best, ctx)) return none
        const sites = await getCachedOfficialSites()
        let officialName: string | undefined
        try {
            officialName = officialNameForHost(new URL(best.url).hostname, sites)
        } catch {
            officialName = undefined
        }
        return {
            hasBetter: true as const,
            bestUrl: best.url,
            bestIsOfficial: officialName !== undefined,
            ...(officialName ? { officialName } : {})
        }
    }
}
