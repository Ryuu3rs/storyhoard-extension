// User-added sources. Profiles persist in the Dexie `archProfiles` store, so they survive
// restarts and flow into backup/export like real data, and are re-registered into the live
// registry on every startup. They are created by the typed source:* handlers (handlers/add-source.ts).

import { createBoundedRequestClient, type SourceAdapter, type SourceContext } from "@amr/source-sdk"
import { sourceRegistry } from "@amr/sources"
import { createAdapterFromProfile, parseProfile, type CaptureSignals, type SiteProfile } from "@amr/source-engine"
import { db, deleteArchProfile, listArchProfileRows, type ArchProfileOrigin, type StoredArchProfile } from "./database"
import { isCommittedSeedProfile } from "./migration/seed-profiles"
import { getSettings } from "./settings"
import { validateProfileScope } from "./source-scope"
import {
    chaptersForLanguage,
    clearExtraSourceOrigins,
    getSourceById,
    setExtraSourceOrigins,
    wrapFetch
} from "./sources"
import { scheduleChapterListRefresh } from "./background/chapter-cache"

// The adapters this module registered from a profile (as opposed to bundled ones), by source id.
// Tracked by adapter identity, not just id, so a profile id that was later overwritten in the
// registry by a bundled adapter is never mistaken for profile-backed. Profile-backed sources have
// no getChapterListUrl, but their listChapters is the only way to fill the chapter dropdown and
// detect new chapters, so they refresh through the standard list path.
const profileAdapters = new Map<string, SourceAdapter>()

export function isProfileSource(id: string): boolean {
    const adapter = profileAdapters.get(id)
    return adapter !== undefined && getSourceById(id) === adapter
}

// True when `id` resolves to a registered adapter that is NOT profile-backed, i.e. a bundled one.
function resolvesToBundledAdapter(id: string): boolean {
    return getSourceById(id) !== undefined && !isProfileSource(id)
}

// The sideload "Classic reader" build (VITE_ARCH_TRACK=A) renders page images itself; the shipped
// engine never does.
function isArchBuild(): boolean {
    return import.meta.env.VITE_ARCH_TRACK === "A"
}

// A shipped build never scrapes page images, whatever a stored or restored format-1 profile says:
// drop the image extraction recipe, the image hosts and the "pages" capability before the adapter
// is built, so resolveChapter stays inert and no image host joins the request scope.
function withoutImageExtraction(profile: SiteProfile): SiteProfile {
    const stripped: SiteProfile = { ...profile }
    delete stripped.pages
    delete stripped.imageOrigins
    const capabilities = profile.capabilities.filter(c => c !== "pages")
    stripped.capabilities = capabilities.length > 0 ? capabilities : ["chapters"]
    return stripped
}

// Register a profile into the live registry. Refuses (returns false) when its id already resolves
// to a bundled adapter: a stored or restored profile must never displace a shipped adapter.
export function registerProfile(profile: SiteProfile): boolean {
    if (resolvesToBundledAdapter(profile.id)) {
        console.warn(`[AMR] Not registering profile "${profile.id}": it collides with a bundled source`)
        return false
    }
    const effective = isArchBuild() ? profile : withoutImageExtraction(profile)
    const adapter = createAdapterFromProfile(effective)
    sourceRegistry.upsert(adapter)
    setExtraSourceOrigins(effective.id, [...effective.origins, ...(effective.imageOrigins ?? [])])
    profileAdapters.set(effective.id, adapter)
    return true
}

// Who wrote a stored row. Rows written before the field existed fall back to content: a row that
// is exactly the committed seed profile is a seed row, anything else was added by the user.
function rowOrigin(row: StoredArchProfile): ArchProfileOrigin {
    if (row.origin === "seed" || row.origin === "user") return row.origin
    return isCommittedSeedProfile(row.profile) ? "seed" : "user"
}

// Register every persisted profile into the live registry. Exported so a backup restore or sync
// pull can re-apply profiles without a full restart. Each row is re-checked on every registration,
// because restore/pull only validate shape:
//   * the stored row id must equal the profile's own id
//   * a seed row is trusted only while it is byte-equal to the committed seed profile
//   * any other row must pass validateProfileScope (public https origin, domains within it)
// A row that fails is skipped (and left in place), never registered.
// onlyUnresolved: skip a profile whose id already resolves to a bundled adapter, so the migration
// seed and a restore can never displace a shipped adapter - they only fill in ids with none.
export async function registerStoredArchProfiles(options: { onlyUnresolved?: boolean } = {}): Promise<void> {
    for (const row of await listArchProfileRows()) {
        const parsed = parseProfile(row.profile)
        if (!parsed.ok) continue
        const profile = parsed.profile
        if (row.id !== profile.id) {
            console.warn(`[AMR] Skipping stored profile "${row.id}": row id does not match profile id`)
            continue
        }
        if (options.onlyUnresolved && resolvesToBundledAdapter(profile.id)) continue
        if (rowOrigin(row) === "seed") {
            if (!isCommittedSeedProfile(profile)) {
                console.warn(`[AMR] Skipping stored profile "${row.id}": it no longer matches the migration seed`)
                continue
            }
        } else if (!validateProfileScope(profile)) {
            console.warn(`[AMR] Skipping stored profile "${row.id}": its origins are outside the allowed scope`)
            continue
        }
        registerProfile(profile)
    }
}

// Run once at background startup: re-register the profiles stored in a previous session. A stored
// profile only ever fills in an id with no bundled adapter.
export async function initUserSources(): Promise<void> {
    await registerStoredArchProfiles({ onlyUnresolved: true })
}

// Injected into the target tab to capture DOM signals. Self-contained (no closures) so it can
// be serialized by scripting.executeScript. Reads og metadata + candidate links/images.
function captureInspector(): CaptureSignals {
    // Everything captured is page-controlled, so each value is length-capped here (inlined: this
    // function is serialized into the tab and cannot close over module constants).
    const cap = (value: string | null | undefined): string | undefined =>
        value === null || value === undefined ? undefined : value.slice(0, 2048)
    const meta = (p: string): string | undefined =>
        cap(document.querySelector(`meta[property="${p}"]`)?.getAttribute("content"))
    const links = Array.from(document.querySelectorAll("a[href]"))
        .slice(0, 500)
        .map(a => ({ href: cap(a.getAttribute("href")) ?? "", text: (a.textContent ?? "").trim().slice(0, 40) }))
    const images = Array.from(document.querySelectorAll("img"))
        .slice(0, 500)
        .flatMap(img => {
            const out: string[] = []
            const src = cap(img.getAttribute("src"))
            const data = cap(img.getAttribute("data-url") ?? img.getAttribute("data-src"))
            if (src) out.push(src)
            if (data) out.push(data)
            return out
        })
    return {
        url: location.href,
        ogTitle: meta("og:title"),
        ogImage: meta("og:image"),
        ogSiteName: meta("og:site_name"),
        links,
        images
    }
}

// Inspect one tab. Undefined when the tab cannot be read (no host access yet, or a restricted page).
export async function captureTabSignals(tabId: number): Promise<CaptureSignals | undefined> {
    try {
        const results = await browser.scripting.executeScript({ target: { tabId }, func: captureInspector })
        return results[0]?.result as CaptureSignals | undefined
    } catch {
        return undefined
    }
}

// Full chapter list for the series a chapter URL belongs to, for the on-site panel's chapter
// dropdown. Reads the local cache, deduped by chapter number (preferring an entry that has a real
// title, so a titleless capture never shows up as a stray "Chapter N" beside a proper "Episode N"),
// and language-filtered like the reader's list. When the source paginates its list on a JS-rendered
// page (e.g. Webtoons), a background refresh is scheduled so the dropdown fills out on the next open
// instead of showing only the handful of chapters captured so far. Returns [] when not tracked.
export async function chapterListForUrl(url: string): Promise<Array<{ url: string; title: string; sortKey: number }>> {
    const ch = await db.chapters.where("url").equals(url).first()
    if (!ch) return []
    const manga = await db.manga.get(ch.mangaId)
    const { language } = await getSettings()
    const cached = await db.chapters.where("mangaId").equals(ch.mangaId).sortBy("sortKey")

    // Dedup by chapter number; keep the entry whose title is a real label over a titleless one so
    // the dropdown reads consistently (this is what caused the mixed "Episode 2 / Chapter 2" list).
    const hasTitle = (t: string | undefined): boolean => !!t && t !== "N/A"
    const byKey = new Map<number, (typeof cached)[number]>()
    const unkeyed: typeof cached = []
    for (const c of cached) {
        if (!Number.isFinite(c.sortKey)) {
            unkeyed.push(c)
            continue
        }
        const existing = byKey.get(c.sortKey)
        if (!existing || (!hasTitle(existing.title) && hasTitle(c.title)) || c.url === url) byKey.set(c.sortKey, c)
    }
    const deduped = [...byKey.values(), ...unkeyed].sort((a, b) => a.sortKey - b.sortKey)
    const scoped = chaptersForLanguage(deduped, language)

    // Fill a sparse/paginated list in the background for next time (source-gated; only runs for a
    // source that knows how to fetch its full list: a tab-crawled list URL, or a profile-backed
    // source whose listChapters fetches it directly).
    const source = manga ? getSourceById(manga.sourceId) : undefined
    if (source && manga && (source.getChapterListUrl || isProfileSource(source.manifest.id))) {
        scheduleChapterListRefresh(source, manga.sourceMangaId ?? manga.id, manga.mangaUrl ?? manga.sourceUrl, manga.id)
    }

    return scoped.map(c => ({ url: c.url, title: c.title, sortKey: c.sortKey }))
}

export type AddedSource = { id: string; name: string; domains: string[] }

// The user-added sources (id, display name, domains) for the management UI. Seeded rows are not
// user-added sites and are never listed.
export async function listImportedProfiles(): Promise<AddedSource[]> {
    const out: AddedSource[] = []
    for (const row of await listArchProfileRows()) {
        if (rowOrigin(row) !== "user") continue
        const r = row.profile as { id?: unknown; name?: unknown; domains?: unknown }
        if (typeof r?.id !== "string") continue
        out.push({
            id: r.id,
            name: typeof r.name === "string" ? r.name : r.id,
            domains: Array.isArray(r.domains) ? r.domains.filter((d): d is string => typeof d === "string") : []
        })
    }
    return out
}

// Remove a user-added source and unregister it. Only a row the user added can be removed, and
// never while its id resolves to a bundled adapter: a seed row, or a row that collides with a
// bundled id, is left alone, so this path can never unregister a shipped adapter. Returns whether
// anything was removed.
export async function deleteImportedProfile(id: string): Promise<boolean> {
    const row = await db.archProfiles.get(id)
    if (!row || rowOrigin(row) !== "user") return false
    if (resolvesToBundledAdapter(id)) return false
    sourceRegistry.unregister(id)
    profileAdapters.delete(id)
    clearExtraSourceOrigins(id)
    await deleteArchProfile(id)
    return true
}

// A bounded request context for the health-check probe, scoped to the profile's own origins +
// image hosts (so a redirect to a sibling mirror is allowed but nothing else is).
export function buildProbeContext(profile: SiteProfile): SourceContext {
    return {
        request: createBoundedRequestClient({
            // The shared wrapper hands the client the final URL, headers and body stream, so the
            // redirect-destination check and the response size cap apply to the probe too.
            fetch: wrapFetch,
            allowedOrigins: [...profile.origins, ...(profile.imageOrigins ?? [])],
            requirePublicHttps: true,
            maxRequests: 30,
            maxResponseBytes: 8 * 1024 * 1024,
            timeoutMs: 15_000
        }),
        now: () => Date.now(),
        logger: { debug: () => undefined, warn: () => undefined }
    }
}
