// Discover rails from weeb.ltd (trending, this season, staff picks, community picks) for a library too
// small to recommend from. Public lists only: the request carries no cookies and nothing about the user,
// and an item never carries a link, so a rail can only open the title page in the app.

import { isPublicCoverUrl, publicCoverOrNull } from "./background/covers"
import type { CatalogMediaType, CatalogTitle } from "./catalog-search"
import { sanitizePageText, sanitizeTextList } from "./page-text"
import { indexLibrary, ownedEntry } from "./search-view"
import { isWorkId } from "./work-identity"

export const WEEB_RAILS = ["trending", "seasonal", "staff", "community", "genre"] as const
export type WeebRailId = (typeof WEEB_RAILS)[number]

export type WeebDiscoverItem = {
    anilistId: number | null
    workId: string | null
    title: string
    altTitles: string[]
    cover: string | null
    mediaType: CatalogMediaType | null
    genres: string[]
    metric: string
}

export type WeebDiscoverRail = {
    rail: WeebRailId
    label: string
    note: string | null
    genre: string | null
    items: WeebDiscoverItem[]
}

export type WeebDiscover = {
    rails: WeebDiscoverRail[]
    source: "discover" | "picks" | "none"
    fetchedAt: number
}

export type WeebRailResult =
    | { ok: true; rail: WeebDiscoverRail }
    | {
          ok: false
          status: "missing" | "unknown-genre" | "bad-request" | "rate-limited" | "unavailable"
          genres?: string[]
      }

export type WeebDiscoverDeps = { siteBase: string; fetch: typeof fetch }

// The rails a new library opens on, in the order they show.
export const MAIN_RAILS: readonly WeebRailId[] = ["trending", "seasonal", "staff", "community"]
// Below this many titles there is too little to recommend from, so weeb.ltd's rails lead Discover.
export const COLD_START_LIBRARY_SIZE = 5
export const RAIL_LIMIT = 16
export const DISCOVER_TTL_MS = 10 * 60_000
// A failed load is retried after a minute, not on every visit.
export const DISCOVER_RETRY_MS = 60_000
// A stale copy still beats an empty page while weeb.ltd is unreachable, up to a day old.
const STALE_LIMIT_MS = 24 * 60 * 60_000
const DISCOVER_TIMEOUT_MS = 6000
// Above this the cache stays in memory only: storage.local is small and shared with settings.
export const DISCOVER_CACHE_BUDGET = 256 * 1024
// The longest other name a quick-add message carries, in code units, as the message schema allows.
const MAX_ALT_TITLE_UNITS = 300
const MAX_ALT_TITLES = 8
const MAX_GENRES = 12
const MEDIA_TYPES = new Set<string>(["manga", "manhwa", "manhua", "webtoon", "novel", "book"])
const RAIL_IDS = new Set<string>(WEEB_RAILS)
const DEFAULT_LABEL: Record<WeebRailId, string> = {
    trending: "Trending",
    seasonal: "This season",
    staff: "Staff picks",
    community: "Community picks",
    genre: "Genre"
}

const clean = (value: unknown, max: number): string | null => sanitizePageText(value, max) || null

const anilistIdOf = (value: unknown): number | null | undefined =>
    value === null || value === undefined
        ? null
        : typeof value === "number" && Number.isSafeInteger(value) && value > 0
          ? value
          : undefined

const workIdOf = (value: unknown): string | null | undefined =>
    value === null || value === undefined ? null : isWorkId(value) ? value : undefined

// One rail item. An adult title, one with neither id, or one with no usable title is dropped; a bad
// cover, media type or other names just fall back to none.
export function parseDiscoverItem(raw: unknown): WeebDiscoverItem | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
    const r = raw as Record<string, unknown>
    if (r.isAdult !== undefined && r.isAdult !== false) return null
    const title = clean(r.title, 300)
    const anilistId = anilistIdOf(r.anilistId)
    const workId = workIdOf(r.workId)
    if (!title || anilistId === undefined || workId === undefined) return null
    if (anilistId === null && workId === null) return null
    return {
        anilistId,
        workId,
        title,
        altTitles: sanitizeTextList(r.altTitles, MAX_ALT_TITLES, 300, [title]),
        cover: publicCoverOrNull(r.cover),
        mediaType:
            typeof r.mediaType === "string" && MEDIA_TYPES.has(r.mediaType) ? (r.mediaType as CatalogMediaType) : null,
        genres: sanitizeTextList(r.genres, MAX_GENRES, 40),
        metric: clean(r.metric, 80) ?? ""
    }
}

const itemKey = (item: Pick<WeebDiscoverItem, "anilistId" | "workId">): string =>
    item.anilistId !== null ? `al:${item.anilistId}` : `w:${item.workId}`

function uniqueItems(raw: unknown[], parse: (raw: unknown) => WeebDiscoverItem | null, limit: number) {
    const seen = new Set<string>()
    const out: WeebDiscoverItem[] = []
    for (const entry of raw) {
        const item = parse(entry)
        if (!item || seen.has(itemKey(item))) continue
        seen.add(itemKey(item))
        out.push(item)
        if (out.length >= limit) break
    }
    return out
}

// A rail body from /api/public/discover. It must be the rail that was asked for.
export function parseDiscoverRail(body: unknown, rail: WeebRailId, limit = RAIL_LIMIT): WeebDiscoverRail | null {
    if (!body || typeof body !== "object") return null
    const b = body as Record<string, unknown>
    if (b.rail !== rail || !Array.isArray(b.items)) return null
    return {
        rail,
        label: clean(b.label, 60) ?? DEFAULT_LABEL[rail],
        note: clean(b.note, 120),
        genre: clean(b.genre, 40),
        items: uniqueItems(b.items, parseDiscoverItem, limit)
    }
}

async function getJson(deps: WeebDiscoverDeps, path: string): Promise<{ status: number; body: unknown } | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DISCOVER_TIMEOUT_MS)
    try {
        const res = await deps.fetch(`${deps.siteBase}${path}`, {
            headers: { Accept: "application/json" },
            credentials: "omit",
            signal: controller.signal
        })
        let body: unknown = null
        try {
            body = await res.json()
        } catch {
            body = null
        }
        return { status: res.status, body }
    } catch {
        return null
    } finally {
        clearTimeout(timer)
    }
}

export async function fetchDiscoverRail(
    deps: WeebDiscoverDeps,
    rail: WeebRailId,
    options: { genre?: string; limit?: number } = {}
): Promise<WeebRailResult> {
    const limit = Math.min(24, Math.max(1, Math.floor(options.limit ?? RAIL_LIMIT)))
    const params = new URLSearchParams({ rail, limit: String(limit), adult: "0" })
    if (rail === "genre") params.set("genre", sanitizePageText(options.genre ?? "", 40))
    const res = await getJson(deps, `/api/public/discover?${params}`)
    if (!res) return { ok: false, status: "unavailable" }
    if (res.status === 200) {
        const parsed = parseDiscoverRail(res.body, rail, limit)
        return parsed ? { ok: true, rail: parsed } : { ok: false, status: "unavailable" }
    }
    if (res.status === 404) {
        const genres = (res.body as { genres?: unknown } | null)?.genres
        // A 404 that lists the genres is weeb.ltd saying "no such genre"; any other 404 means the endpoint
        // is not there (not deployed yet).
        return Array.isArray(genres)
            ? { ok: false, status: "unknown-genre", genres: sanitizeTextList(genres, 60, 40) }
            : { ok: false, status: "missing" }
    }
    if (res.status === 400) return { ok: false, status: "bad-request" }
    if (res.status === 429) return { ok: false, status: "rate-limited" }
    return { ok: false, status: "unavailable" }
}

function parsePickItem(raw: unknown): WeebDiscoverItem | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
    const r = raw as Record<string, unknown>
    const anilistId = anilistIdOf(r.anilistId)
    const title = clean(r.title, 300)
    if (!title || typeof anilistId !== "number") return null
    return {
        anilistId,
        workId: null,
        title,
        altTitles: [],
        cover: publicCoverOrNull(r.coverUrl),
        mediaType: null,
        genres: [],
        metric: clean(r.metric, 80) ?? ""
    }
}

// The older /api/public/picks, mapped onto the same rails, for while /api/public/discover is not live.
export function parsePicks(body: unknown): WeebDiscoverRail[] | null {
    if (!body || typeof body !== "object") return null
    const b = body as Record<string, unknown>
    const rails: WeebDiscoverRail[] = []
    if (Array.isArray(b.trending)) {
        rails.push({
            rail: "trending",
            label: DEFAULT_LABEL.trending,
            note: null,
            genre: null,
            items: uniqueItems(b.trending, parsePickItem, RAIL_LIMIT)
        })
    }
    const community = b.community as Record<string, unknown> | null | undefined
    // While no votes are in, the community list is the trending list again.
    if (
        community &&
        typeof community === "object" &&
        Array.isArray(community.items) &&
        community.source !== "trending"
    ) {
        rails.push({
            rail: "community",
            label: DEFAULT_LABEL.community,
            note: clean(community.label, 120),
            genre: null,
            items: uniqueItems(community.items, parsePickItem, RAIL_LIMIT)
        })
    }
    return rails.length > 0 || Array.isArray(b.trending) ? rails : null
}

async function fetchPicks(deps: WeebDiscoverDeps): Promise<WeebDiscoverRail[] | null> {
    const res = await getJson(deps, "/api/public/picks")
    return res && res.status === 200 ? parsePicks(res.body) : null
}

// Rails worth showing: not empty, and not a community rail that only repeats Trending.
export function visibleRails(rails: readonly WeebDiscoverRail[]): WeebDiscoverRail[] {
    const trending = new Set(rails.find(r => r.rail === "trending")?.items.map(itemKey) ?? [])
    return rails.filter(
        rail =>
            rail.items.length > 0 &&
            !(rail.rail === "community" && trending.size > 0 && rail.items.every(item => trending.has(itemKey(item))))
    )
}

export async function loadWeebDiscover(deps: WeebDiscoverDeps, now: number): Promise<WeebDiscover> {
    const results = await Promise.all(MAIN_RAILS.map(rail => fetchDiscoverRail(deps, rail)))
    if (results.some(r => r.ok)) {
        const rails = results.flatMap(r => (r.ok ? [r.rail] : []))
        return { rails: visibleRails(rails), source: "discover", fetchedAt: now }
    }
    if (results.some(r => !r.ok && r.status === "rate-limited")) return { rails: [], source: "none", fetchedAt: now }
    const picks = await fetchPicks(deps)
    return picks
        ? { rails: visibleRails(picks), source: "picks", fetchedAt: now }
        : { rails: [], source: "none", fetchedAt: now }
}

type CacheEntry = { value: WeebDiscover; checkedAt: number }

export type WeebDiscoverStore = { read(): Promise<unknown>; write(entry: CacheEntry): Promise<void> }

function storedEntry(raw: unknown): CacheEntry | null {
    if (!raw || typeof raw !== "object") return null
    const e = raw as { value?: Partial<WeebDiscover>; checkedAt?: unknown }
    const v = e.value
    if (typeof e.checkedAt !== "number" || !v || typeof v.fetchedAt !== "number" || !Array.isArray(v.rails)) return null
    if (v.source !== "discover" && v.source !== "picks" && v.source !== "none") return null
    const rails = v.rails.flatMap(rail => {
        const parsed =
            rail && typeof rail === "object" && RAIL_IDS.has((rail as WeebDiscoverRail).rail)
                ? parseDiscoverRail(rail, (rail as WeebDiscoverRail).rail)
                : null
        return parsed ? [parsed] : []
    })
    return { value: { rails, source: v.source, fetchedAt: v.fetchedAt }, checkedAt: e.checkedAt }
}

// Rails are fetched at most once per ten minutes (a minute after a failure), kept in memory and in
// storage so a restarted background worker does not ask again, and one load is shared by every caller.
export function createWeebDiscoverSource(deps: WeebDiscoverDeps & { now: () => number; store: WeebDiscoverStore }) {
    let memory: CacheEntry | null = null
    let inflight: Promise<WeebDiscover> | null = null

    const fresh = (entry: CacheEntry, now: number) => {
        const age = now - entry.checkedAt
        const ttl = entry.value.rails.length > 0 && entry.value.source !== "none" ? DISCOVER_TTL_MS : DISCOVER_RETRY_MS
        return age >= 0 && age < ttl
    }

    async function refresh(previous: CacheEntry | null): Promise<WeebDiscover> {
        const now = deps.now()
        const loaded = await loadWeebDiscover(deps, now)
        const keepStale =
            loaded.rails.length === 0 &&
            previous !== null &&
            previous.value.rails.length > 0 &&
            now - previous.value.fetchedAt < STALE_LIMIT_MS
        const entry: CacheEntry = keepStale
            ? { value: previous.value, checkedAt: now - DISCOVER_TTL_MS + DISCOVER_RETRY_MS }
            : { value: loaded, checkedAt: now }
        memory = entry
        if (new TextEncoder().encode(JSON.stringify(entry)).length <= DISCOVER_CACHE_BUDGET) {
            await deps.store.write(entry).catch(() => undefined)
        }
        return entry.value
    }

    return {
        async get(force = false): Promise<WeebDiscover> {
            const now = deps.now()
            if (!force && memory && fresh(memory, now)) return memory.value
            if (inflight) return inflight
            inflight = (async () => {
                if (!memory) memory = storedEntry(await deps.store.read().catch(() => null))
                if (!force && memory && fresh(memory, deps.now())) return memory.value
                return refresh(memory)
            })().finally(() => {
                inflight = null
            })
            return inflight
        }
    }
}

export const isColdStartLibrary = (libraryCount: number): boolean => libraryCount < COLD_START_LIBRARY_SIZE

// The title page in the app takes a catalog title; a rail item is one with the facts it lacks left empty.
export function discoverItemAsTitle(item: WeebDiscoverItem): CatalogTitle {
    return {
        workId: item.workId,
        anilistId: item.anilistId,
        title: item.title,
        altTitles: item.altTitles,
        cover: item.cover,
        mediaType: item.mediaType,
        status: null,
        year: null,
        genres: item.genres,
        isAdult: false,
        readers: 0
    }
}

type OwnedEntry = {
    title: string
    anilistId?: number | undefined
    workId?: string | undefined
    altTitles?: readonly string[] | undefined
}

// Drops every item already in the library, by AniList id, Work id or any of its names, the same rule the
// search page uses for "In library". Rails left empty are dropped too.
export function withoutOwned<T extends OwnedEntry>(
    rails: readonly WeebDiscoverRail[],
    library: readonly T[]
): WeebDiscoverRail[] {
    // A title added from Discover keeps its other names, so it matches under any of them.
    const owned = indexLibrary(library)
    return rails
        .map(rail => ({
            ...rail,
            items: rail.items.filter(item => ownedEntry(discoverItemAsTitle(item), owned) === undefined)
        }))
        .filter(rail => rail.items.length > 0)
}

export type PlanToReadRequest = {
    type: "library:quick-add"
    anilistId?: number
    workId?: string
    title: string
    altTitles?: string[]
    coverUrl?: string
    genres?: string[]
    mediaType?: CatalogMediaType
    mode: "planning"
}

// "Add to library" on a title page: the existing quick-add with no site, as Plan to read. The AniList id
// keys the row when there is one, else the weeb.ltd Work id does; either way the Work id goes along so
// the row matches the catalog title later. Only plain arrays leave here, so no state proxy crosses the
// message boundary.
export function planToReadRequest(title: CatalogTitle): PlanToReadRequest | null {
    const workId = isWorkId(title.workId) ? title.workId : null
    if (title.anilistId === null && workId === null) return null
    const altTitles = title.altTitles
        .filter(name => name !== title.title && name.length <= MAX_ALT_TITLE_UNITS)
        .slice(0, 8)
    return {
        type: "library:quick-add",
        ...(title.anilistId !== null ? { anilistId: title.anilistId } : {}),
        ...(workId !== null ? { workId } : {}),
        title: title.title,
        ...(altTitles.length > 0 ? { altTitles: [...altTitles] } : {}),
        ...(isPublicCoverUrl(title.cover) ? { coverUrl: title.cover } : {}),
        ...(title.genres.length > 0 ? { genres: [...title.genres] } : {}),
        ...(title.mediaType ? { mediaType: title.mediaType } : {}),
        mode: "planning"
    }
}
