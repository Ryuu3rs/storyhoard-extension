// User-added sources. Profiles persist in the Dexie `archProfiles` store, so they survive
// restarts and flow into backup/export like real data, and are re-registered into the live
// registry on every startup. They are created by the typed source:* handlers (handlers/add-source.ts).

import { createBoundedRequestClient, type FetchFunction, type SourceContext } from "@amr/source-sdk"
import { sourceRegistry } from "@amr/sources"
import { createAdapterFromProfile, parseProfile, type CaptureSignals, type SiteProfile } from "@amr/source-engine"
import { db, deleteArchProfile, listArchProfiles } from "./database"
import { getSettings } from "./settings"
import { chaptersForLanguage, clearExtraSourceOrigins, getSourceById, setExtraSourceOrigins } from "./sources"
import { scheduleChapterListRefresh } from "./background/chapter-cache"

// Bundled adapters handed over to the user-supplied-profile path. Empty: real adapter removal
// is a separate, later phase.
const DISABLED_BUNDLED_IDS: string[] = []

// Ids of sources registered from a profile (as opposed to a bundled adapter). Profile-backed
// sources have no getChapterListUrl, but their listChapters is the only way to fill the
// chapter dropdown and detect new chapters, so they refresh through the standard list path.
const profileSourceIds = new Set<string>()

export function isProfileSource(id: string): boolean {
    return profileSourceIds.has(id)
}

export function registerProfile(profile: SiteProfile): void {
    sourceRegistry.upsert(createAdapterFromProfile(profile))
    setExtraSourceOrigins(profile.id, [...profile.origins, ...(profile.imageOrigins ?? [])])
    profileSourceIds.add(profile.id)
}

// Register every persisted imported profile into the live registry. Exported so a backup
// restore can re-apply profiles without a full restart.
// onlyUnresolved: skip a profile whose id already resolves to a registered (bundled) adapter, so the
// one-time migration seed can never displace a shipped adapter - it only fills in ids with none.
export async function registerStoredArchProfiles(options: { onlyUnresolved?: boolean } = {}): Promise<void> {
    for (const raw of await listArchProfiles()) {
        const parsed = parseProfile(raw)
        if (!parsed.ok) continue
        if (options.onlyUnresolved && getSourceById(parsed.profile.id)) continue
        registerProfile(parsed.profile)
    }
}

// Run once at background startup: drop any handed-over bundled adapters, then re-register the
// profiles the user imported in a previous session.
export async function initUserSources(): Promise<void> {
    for (const id of DISABLED_BUNDLED_IDS) sourceRegistry.unregister(id)
    await registerStoredArchProfiles()
}

// Injected into the target tab to capture DOM signals. Self-contained (no closures) so it can
// be serialized by scripting.executeScript. Reads og metadata + candidate links/images.
function captureInspector(): CaptureSignals {
    const meta = (p: string): string | undefined =>
        document.querySelector(`meta[property="${p}"]`)?.getAttribute("content") ?? undefined
    const links = Array.from(document.querySelectorAll("a[href]"))
        .slice(0, 500)
        .map(a => ({ href: a.getAttribute("href") ?? "", text: (a.textContent ?? "").trim().slice(0, 40) }))
    const images = Array.from(document.querySelectorAll("img"))
        .slice(0, 500)
        .flatMap(img => {
            const out: string[] = []
            const src = img.getAttribute("src")
            const data = img.getAttribute("data-url") ?? img.getAttribute("data-src")
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
    if (source && manga && (source.getChapterListUrl || profileSourceIds.has(source.manifest.id))) {
        scheduleChapterListRefresh(source, manga.sourceMangaId ?? manga.id, manga.mangaUrl ?? manga.sourceUrl, manga.id)
    }

    return scoped.map(c => ({ url: c.url, title: c.title, sortKey: c.sortKey }))
}

export type AddedSource = { id: string; name: string; domains: string[] }

// The user-added sources (id, display name, domains) for the management UI.
export async function listImportedProfiles(): Promise<AddedSource[]> {
    const out: AddedSource[] = []
    for (const raw of await listArchProfiles()) {
        const r = raw as { id?: unknown; name?: unknown; domains?: unknown }
        if (typeof r?.id !== "string") continue
        out.push({
            id: r.id,
            name: typeof r.name === "string" ? r.name : r.id,
            domains: Array.isArray(r.domains) ? r.domains.filter((d): d is string => typeof d === "string") : []
        })
    }
    return out
}

// Remove a user-added source and unregister it. Only ever touches a stored profile: a bundled
// adapter's id is never unregistered through this path. Returns whether anything was removed.
export async function deleteImportedProfile(id: string): Promise<boolean> {
    if (!(await db.archProfiles.get(id))) return false
    sourceRegistry.unregister(id)
    profileSourceIds.delete(id)
    clearExtraSourceOrigins(id)
    await deleteArchProfile(id)
    return true
}

// A bounded request context for the health-check probe, scoped to the profile's own origins +
// image hosts (so a redirect to a sibling mirror is allowed but nothing else is).
export function buildProbeContext(profile: SiteProfile): SourceContext {
    const fetchImpl: FetchFunction = async (url, init) => {
        const response = await fetch(url, init as RequestInit)
        return { ok: response.ok, status: response.status, text: () => response.text() }
    }
    return {
        request: createBoundedRequestClient({
            fetch: fetchImpl,
            allowedOrigins: [...profile.origins, ...(profile.imageOrigins ?? [])],
            maxRequests: 30,
            maxResponseBytes: 8 * 1024 * 1024,
            timeoutMs: 15_000
        }),
        now: () => Date.now(),
        logger: { debug: () => undefined, warn: () => undefined }
    }
}
