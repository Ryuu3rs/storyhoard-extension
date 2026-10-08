// User-added sources. Profiles persist in the Dexie `archProfiles` store, so they survive
// restarts and flow into backup/export like real data, and are re-registered into the live
// registry on every startup. They are created by the typed source:* handlers (handlers/add-source.ts).

import {
    createBoundedRequestClient,
    matchesSourceDomain,
    type FetchFunction,
    type SourceAdapter,
    type SourceContext
} from "@amr/source-sdk"
import { sourceRegistry } from "@amr/sources"
import {
    createAdapterFromProfile,
    parseProfile,
    type CaptureSignals,
    type ListSource,
    type SiteProfile
} from "@amr/source-engine"
import { db, deleteArchProfile, listArchProfileRows, type ArchProfileOrigin, type StoredArchProfile } from "./database"
import { isCommittedSeedProfile } from "./migration/seed-profiles"
import { getSettings } from "./settings"
import { validateProfileScope } from "./source-scope"
import type { UpdateMode } from "./update-mode"
import {
    chaptersForLanguage,
    clearExtraSourceOrigins,
    getSourceById,
    setExtraSourceOrigins,
    wrapFetch
} from "./sources"
import { scheduleChapterListRefresh } from "./background/chapter-cache"
import { fetchChapterHtmlViaTab } from "./background/tab-fetch"

// The adapters this module registered from a profile (as opposed to bundled ones), by source id.
// Tracked by adapter identity, not just id, so a profile id that was later overwritten in the
// registry by a bundled adapter is never mistaken for profile-backed. Profile-backed sources have
// no getChapterListUrl, but their listChapters is the only way to fill the chapter dropdown and
// detect new chapters, so they refresh through the standard list path.
const profileAdapters = new Map<string, SourceAdapter>()

// Profile ids registered WITHOUT a chapter list (recognition-only seeds). They keep a library row
// resolving and trackable, but listChapters returns nothing, so new chapters are never detected.
const trackingOnlyIds = new Set<string>()

// How each registered profile source gets its chapter list (see ListSource); absent means "fetch".
const listSources = new Map<string, ListSource>()

// Profile sources whose chapter numbers are read from the link text, not the URL (numberSource text/title).
const textNumberedIds = new Set<string>()

// Selectors a profile gives for the chapter list its site renders in the page (list.renderedSelectors).
type RenderedSelectors = NonNullable<NonNullable<SiteProfile["list"]>["renderedSelectors"]>
const renderedSelectorsById = new Map<string, RenderedSelectors>()

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

// "https://site.example/" -> "https://site.example", so every origin comparison and URL built from
// profile.origin sees the bare origin the scope check validated.
function bareOrigin(origin: string): string {
    try {
        return new URL(origin).origin
    } catch {
        return origin
    }
}

// Register a profile into the live registry. Refuses (returns false) when its id already resolves
// to a bundled adapter: a stored or restored profile must never displace a shipped adapter.
export function registerProfile(profile: SiteProfile): boolean {
    if (resolvesToBundledAdapter(profile.id)) {
        console.warn(`[AMR] Not registering profile "${profile.id}": it collides with a bundled source`)
        return false
    }
    const base = isArchBuild() ? profile : withoutImageExtraction(profile)
    const effective = { ...base, origin: bareOrigin(base.origin) }
    const adapter = createAdapterFromProfile(effective)
    sourceRegistry.upsert(adapter)
    setExtraSourceOrigins(effective.id, [...effective.origins, ...(effective.imageOrigins ?? [])])
    profileAdapters.set(effective.id, adapter)
    listSources.set(effective.id, effective.listSource ?? "fetch")
    if (effective.numberSource === "text" || effective.numberSource === "title") textNumberedIds.add(effective.id)
    else textNumberedIds.delete(effective.id)
    if (effective.list?.renderedSelectors) renderedSelectorsById.set(effective.id, effective.list.renderedSelectors)
    else renderedSelectorsById.delete(effective.id)
    // An "on-visit" source has a list pattern but is never read in the background, so for update
    // checks it is tracking-only: its chapters are recorded from the page when the user opens the site.
    if (effective.list && effective.listSource !== "on-visit") trackingOnlyIds.delete(effective.id)
    else trackingOnlyIds.add(effective.id)
    return true
}

// How a registered profile source learns about new chapters: "auto" (a background fetch or a rendered
// tab on the update schedule), "on-visit" (only from the user's own tab; also every list-less
// recognition-only source), or undefined when `id` is not a profile source.
export function updateModeOf(id: string): UpdateMode | undefined {
    if (!isProfileSource(id)) return undefined
    return trackingOnlyIds.has(id) ? "on-visit" : "auto"
}

// True for a profile source whose URLs hold only an internal chapter id, so a chapter's number has to
// be read from the page's visible text.
export function isTextNumberedSource(id: string): boolean {
    return isProfileSource(id) && textNumberedIds.has(id)
}

// The CSS selectors a profile source declares for the chapter list rendered in the user's page, if any.
export function renderedSelectorsOf(id: string): RenderedSelectors | undefined {
    return isProfileSource(id) ? renderedSelectorsById.get(id) : undefined
}

// True for a profile source whose chapter list is built in the browser and read by rendering its page
// in a background tab.
export function isTabListSource(id: string): boolean {
    return isProfileSource(id) && listSources.get(id) === "tab"
}

// True for a profile-backed source that cannot list chapters, so its titles are tracked but their
// new chapters are not auto-detected.
export function isTrackingOnlySource(id: string): boolean {
    return trackingOnlyIds.has(id) && isProfileSource(id)
}

export function trackingOnlySourceIds(): string[] {
    return [...trackingOnlyIds].filter(isProfileSource)
}

// Who wrote a stored row. Rows written before the field existed fall back to content: a row that
// is exactly the committed seed profile is a seed row, anything else was added by the user.
function rowOrigin(row: StoredArchProfile): ArchProfileOrigin {
    if (row.origin === "seed" || row.origin === "user") return row.origin
    return isCommittedSeedProfile(row.profile) ? "seed" : "user"
}

// True only when the browser already holds host access for every origin the profile will read.
async function holdsHostAccess(profile: SiteProfile): Promise<boolean> {
    try {
        return await browser.permissions.contains({ origins: [...profile.origins, ...(profile.imageOrigins ?? [])] })
    } catch {
        return false
    }
}

// Register every persisted profile into the live registry. Exported so a backup restore or sync
// pull can re-apply profiles without a full restart. Each row is re-checked on every registration,
// because restore/pull only validate shape:
//   * the stored row id must equal the profile's own id
//   * a seed row is trusted only while it is byte-equal to the committed seed profile
//   * any other row must pass validateProfileScope (public https origin, domains within it) AND the
//     browser must already hold host access for its origins. A row that arrived through backup
//     restore, data import or sync pull is attacker-controllable, and registering it would let it
//     match pages and fetch from its origin without the user ever having granted that site. The
//     user-visible consequence: after restoring a backup on a fresh profile, each added site stays
//     inactive until its access is granted again (re-adding the site from one of its pages does that).
// A row that fails is skipped (and left in place), never registered.
// onlyUnresolved: skip a profile whose id already resolves to a bundled adapter, so the migration
// seed and a restore can never displace a shipped adapter - they only fill in ids with none.
async function registerStoredRows(options: { onlyUnresolved?: boolean }): Promise<Set<string>> {
    const registered = new Set<string>()
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
        } else if (!(await holdsHostAccess(profile))) {
            console.warn(`[AMR] Skipping stored profile "${row.id}": host access for its origins was never granted`)
            continue
        }
        if (registerProfile(profile)) registered.add(profile.id)
    }
    return registered
}

export async function registerStoredArchProfiles(options: { onlyUnresolved?: boolean } = {}): Promise<void> {
    await registerStoredRows(options)
}

// Re-sync the live registry with the stored rows after a restore, import or sync pull replaced them.
// Registration alone only adds, so a source whose row the restore dropped (or that no longer passes
// the checks above) would stay registered in memory, invisible to the source list and unremovable,
// until the worker restarted. Anything this module registered that is not re-registered is dropped.
export async function resyncStoredArchProfiles(): Promise<void> {
    const registered = await registerStoredRows({ onlyUnresolved: true })
    for (const [id, adapter] of [...profileAdapters]) {
        if (registered.has(id)) continue
        if (getSourceById(id) === adapter) sourceRegistry.unregister(id)
        profileAdapters.delete(id)
        trackingOnlyIds.delete(id)
        listSources.delete(id)
        textNumberedIds.delete(id)
        renderedSelectorsById.delete(id)
        clearExtraSourceOrigins(id)
    }
}

// The seeded, list-less profile that already claims this page's host, if any. Such a source is a
// recognition-only stand-in: re-capturing the site is allowed to replace it with a working one. A
// bundled adapter, a user-added profile, or a seed that carries a chapter list is never returned.
export async function findUpgradeableSeed(url: URL): Promise<SiteProfile | undefined> {
    for (const [id, adapter] of profileAdapters) {
        if (!isProfileSource(id) || !matchesSourceDomain(url.hostname, adapter.manifest.domains)) continue
        const row = await db.archProfiles.get(id)
        if (!row || rowOrigin(row) !== "seed") continue
        const parsed = parseProfile(row.profile)
        if (!parsed.ok || parsed.profile.list || !isCommittedSeedProfile(parsed.profile)) continue
        return parsed.profile
    }
    return undefined
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
    // Content signals for "does this look like a reader?": page-sized images (an icon, avatar or
    // thumbnail is not one) and a reader container element. Lazy images have no natural size yet, so
    // their rendered box counts when it is page-sized.
    const pageImages = Array.from(document.querySelectorAll("img"))
        .slice(0, 500)
        .filter(img => {
            const w = Math.max(img.naturalWidth, img.clientWidth)
            const h = Math.max(img.naturalHeight, img.clientHeight)
            const lazy =
                img.hasAttribute("data-src") || img.hasAttribute("data-url") || img.hasAttribute("data-lazy-src")
            return w >= 300 && (h >= 300 || lazy)
        })
    const largeImages = pageImages.length
    // A vertical image strip: three or more page-sized images that share one parent element.
    const perParent = new Map<Element, number>()
    for (const img of pageImages) {
        const parent = img.parentElement
        if (parent) perParent.set(parent, (perParent.get(parent) ?? 0) + 1)
    }
    const imageStrip = Array.from(perParent.values()).some(count => count >= 3)
    const readerContainer =
        document.querySelector(
            "#readerarea, .reading-content, #reader, .reader, .chapter-content, .reader-area, .chapter-reader, [id*='reader' i], [class*='reader' i]"
        ) !== null

    // Structured data: the @type strings of every JSON-LD block (walked iteratively and bounded, since
    // the page controls the JSON).
    const jsonLd: string[] = []
    const pending: unknown[] = []
    for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 10)) {
        const text = script.textContent ?? ""
        if (text.length > 200_000) continue
        try {
            pending.push(JSON.parse(text))
        } catch {
            // malformed JSON-LD is ignored
        }
    }
    for (let visited = 0; pending.length > 0 && visited < 500 && jsonLd.length < 10; visited++) {
        const node = pending.pop()
        if (Array.isArray(node)) pending.push(...node.slice(0, 50))
        else if (node !== null && typeof node === "object") {
            const record = node as Record<string, unknown>
            const type = record["@type"]
            for (const t of Array.isArray(type) ? type : [type]) {
                if (typeof t === "string" && jsonLd.length < 10) jsonLd.push(t.slice(0, 64))
            }
            if (record["@graph"] !== undefined) pending.push(record["@graph"])
        }
    }

    // Previous / next chapter controls: anchors and buttons labelled (text, aria-label, title or rel).
    const PREV = /\bprev(?:ious)?\b|←|上一?章|前の?話/i
    const NEXT = /\bnext\b|→|下一?章|次の?話/i
    let navPrev = false
    let navNext = false
    for (const control of Array.from(document.querySelectorAll("a, button")).slice(0, 500)) {
        const label = [
            (control.textContent ?? "").trim().slice(0, 40),
            control.getAttribute("aria-label") ?? "",
            control.getAttribute("title") ?? "",
            control.getAttribute("rel") ?? ""
        ].join(" ")
        if (PREV.test(label)) navPrev = true
        if (NEXT.test(label)) navNext = true
        if (navPrev && navNext) break
    }

    // Reader framework fingerprints (the same class names the reader panel keys its restyle layers on).
    const readerEngine = document.querySelector(".reading-content, .wp-manga-chapter-img, .page-break")
        ? ("madara" as const)
        : document.querySelector("#readerarea, .ts-main")
          ? ("mangastream" as const)
          : document.querySelector("#cp_image, #chapterpager, .reader-main")
            ? ("dm5" as const)
            : undefined

    // The selected / current entry of a chapter dropdown or list.
    const activeChapter = document.querySelector(
        [
            "select[class*='chapter' i] option:checked",
            "select[id*='chapter' i] option:checked",
            "select[name*='chapter' i] option:checked",
            "[class*='chapter' i] [aria-current]",
            "[id*='chapter' i] [aria-current]",
            "[class*='chapter' i] .active",
            "[class*='chapter' i] .current",
            "[id*='chapter' i] .active",
            "[id*='chapter' i] .current"
        ].join(", ")
    )
    const activeChapterText = cap((activeChapter?.textContent ?? "").trim().slice(0, 80)) || undefined

    return {
        url: location.href,
        ogTitle: meta("og:title"),
        ogImage: meta("og:image"),
        ogSiteName: meta("og:site_name"),
        links,
        images,
        largeImages,
        readerContainer,
        lang: cap(document.documentElement.getAttribute("lang")),
        docTitle: cap(document.title),
        ogType: meta("og:type"),
        jsonLd,
        imageStrip,
        chapterNav: { prev: navPrev, next: navNext },
        readerEngine,
        activeChapterText
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
    // An on-visit source is never read in the background, so no refresh is scheduled for it.
    const backgroundListed = source?.getChapterListUrl || (source && updateModeOf(source.manifest.id) === "auto")
    if (source && manga && backgroundListed) {
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

// Host-access patterns held by every OTHER registered profile, so a revoke never pulls access a
// still-registered source depends on.
async function originsUsedByOtherProfiles(exceptId: string): Promise<Set<string>> {
    const used = new Set<string>()
    for (const row of await listArchProfileRows()) {
        if (row.id === exceptId || !isProfileSource(row.id)) continue
        const raw = row.profile as { origins?: unknown; imageOrigins?: unknown }
        for (const list of [raw?.origins, raw?.imageOrigins]) {
            if (!Array.isArray(list)) continue
            for (const pattern of list) if (typeof pattern === "string") used.add(pattern)
        }
    }
    return used
}

// Give back the host access a user-added source held, except for any origin another registered
// profile still uses. Best effort: a leftover grant is harmless without a registered source.
export async function revokeOriginsNotUsedByOthers(origins: string[], exceptId: string): Promise<void> {
    const shared = await originsUsedByOtherProfiles(exceptId)
    const revocable = [...new Set(origins)].filter(pattern => !shared.has(pattern))
    if (revocable.length === 0) return
    try {
        await browser.permissions.remove({ origins: revocable })
    } catch {
        // best effort
    }
}

// Remove a user-added source and unregister it, and revoke the host access it was granted (unless
// another registered profile shares that origin). Only a row the user added can be removed, and
// never while its id resolves to a bundled adapter: a seed row, or a row that collides with a
// bundled id, is left alone, so this path can never unregister a shipped adapter. Returns whether
// anything was removed.
export async function deleteImportedProfile(id: string): Promise<boolean> {
    const row = await db.archProfiles.get(id)
    if (!row || rowOrigin(row) !== "user") return false
    if (resolvesToBundledAdapter(id)) return false
    // Only a profile that is still in scope has its origins revoked: a tampered row that lists a
    // bundled source's host must not be able to pull that source's access on removal.
    const parsed = parseProfile(row.profile)
    const granted =
        parsed.ok && validateProfileScope(parsed.profile)
            ? [...parsed.profile.origins, ...(parsed.profile.imageOrigins ?? [])]
            : []
    sourceRegistry.unregister(id)
    profileAdapters.delete(id)
    trackingOnlyIds.delete(id)
    listSources.delete(id)
    textNumberedIds.delete(id)
    renderedSelectorsById.delete(id)
    clearExtraSourceOrigins(id)
    await deleteArchProfile(id)
    await revokeOriginsNotUsedByOthers(granted, id)
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

// The same probe context, but the one series page the check needs is read through a real (background)
// tab instead of a service-worker fetch. A site that gates scripted requests behind a bot check
// (e.g. Cloudflare) serves a tab fine, because the tab is the user's own browser session. Held to
// the same bounds as the plain probe: only the profile's own origins, public https only, a small
// request budget and a response-size cap. Only the series page and the profile's own chapter-list
// page (when that is a different page) are ever opened - any other URL fails closed - and the tab
// needs the host access the add flow has already obtained to be read at all.
export function buildTabProbeContext(profile: SiteProfile, seriesUrl: string): SourceContext {
    const series = new URL(seriesUrl)
    const readable = new Set([series.origin + series.pathname])
    try {
        const adapter = createAdapterFromProfile(profile)
        const slug = adapter.parseMangaUrl?.(series)?.sourceMangaId
        const listPage = slug ? adapter.chapterListRenderUrl?.(slug, seriesUrl) : undefined
        if (listPage) {
            const list = new URL(listPage)
            readable.add(list.origin + list.pathname)
        }
    } catch {
        // a profile that cannot build an adapter names no separate list page: the series page only
    }
    const fetchViaTab: FetchFunction = async (requestUrl, init) => {
        const target = new URL(requestUrl)
        if (init.method !== "GET" || !readable.has(target.origin + target.pathname)) {
            throw new Error("Only the series page and its chapter list can be read through a tab")
        }
        const html = await fetchChapterHtmlViaTab(requestUrl, profile.origins)
        if (!html) throw new Error("The tab returned no page")
        return { ok: true, status: 200, text: async () => html }
    }
    return {
        request: createBoundedRequestClient({
            fetch: fetchViaTab,
            allowedOrigins: [...profile.origins, ...(profile.imageOrigins ?? [])],
            requirePublicHttps: true,
            maxRequests: 6,
            maxResponseBytes: 8 * 1024 * 1024,
            timeoutMs: 45_000,
            maxRetries: 0,
            cacheTtlMs: 60_000
        }),
        now: () => Date.now(),
        logger: { debug: () => undefined, warn: () => undefined }
    }
}
