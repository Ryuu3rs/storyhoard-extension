// Title search for the search popover: "which title do you mean", before "where can I read it".
// The shared weeb.ltd catalog search answers first; while it is unavailable (not deployed yet, offline,
// rate limited) AniList answers instead, mapped to the same shape. Neither ever returns a reader site:
// where to read is worked out afterwards on the user's own sites.

export type CatalogMediaType = "manga" | "manhwa" | "manhua" | "webtoon" | "novel" | "book"
export type CatalogStatus = "releasing" | "finished" | "hiatus" | "cancelled" | "upcoming"

export type CatalogTitle = {
    workId: string | null
    anilistId: number | null
    title: string
    altTitles: string[]
    cover: string | null
    mediaType: CatalogMediaType | null
    status: CatalogStatus | null
    year: number | null
    genres: string[]
    isAdult: boolean
    readers: number
}

// `unavailable` when neither service could answer, so the popover says so instead of "No titles found".
export type CatalogSearchResult = {
    results: CatalogTitle[]
    source: "weeb" | "anilist" | "none"
    unavailable?: boolean
}

const MEDIA_TYPES = new Set<string>(["manga", "manhwa", "manhua", "webtoon", "novel", "book"])
const STATUSES = new Set<string>(["releasing", "finished", "hiatus", "cancelled", "upcoming"])
const MAX_ALT_TITLES = 10
const WEEB_TIMEOUT_MS = 6000

// Capped by whole characters, never mid-emoji: half a surrogate pair breaks encodeURIComponent later.
const text = (value: unknown, max: number): string | null => {
    if (typeof value !== "string") return null
    const trimmed = value.trim()
    if (trimmed.length === 0) return null
    return trimmed.length <= max ? trimmed : Array.from(trimmed).slice(0, max).join("")
}

const httpsUrl = (value: unknown): string | null => {
    const raw = text(value, 2048)
    if (!raw) return null
    try {
        return new URL(raw).protocol === "https:" ? raw : null
    } catch {
        return null
    }
}

const strings = (value: unknown, max: number, each: number): string[] =>
    Array.isArray(value)
        ? value
              .map(v => text(v, each))
              .filter((v): v is string => v !== null)
              .slice(0, max)
        : []

// Validates one weeb.ltd result. Page-controlled text is capped; an entry without a title is dropped.
export function parseCatalogTitle(raw: unknown): CatalogTitle | null {
    if (!raw || typeof raw !== "object") return null
    const r = raw as Record<string, unknown>
    const title = text(r.title, 300)
    if (!title) return null
    const anilistId = typeof r.anilistId === "number" && Number.isInteger(r.anilistId) ? r.anilistId : null
    const year = typeof r.year === "number" && Number.isInteger(r.year) ? r.year : null
    return {
        workId: text(r.workId, 100),
        anilistId,
        title,
        altTitles: strings(r.altTitles, MAX_ALT_TITLES, 300).filter(alt => alt !== title),
        cover: httpsUrl(r.cover),
        mediaType:
            typeof r.mediaType === "string" && MEDIA_TYPES.has(r.mediaType) ? (r.mediaType as CatalogMediaType) : null,
        status: typeof r.status === "string" && STATUSES.has(r.status) ? (r.status as CatalogStatus) : null,
        year,
        genres: strings(r.genres, 12, 40),
        isAdult: r.isAdult === true,
        readers: typeof r.readers === "number" && r.readers > 0 ? Math.floor(r.readers) : 0
    }
}

export type AniListSearchMedia = {
    id: number
    title?: { romaji?: string | null; english?: string | null; native?: string | null } | null
    synonyms?: (string | null)[] | null
    status?: string | null
    format?: string | null
    countryOfOrigin?: string | null
    startDate?: { year?: number | null } | null
    genres?: (string | null)[] | null
    coverImage?: { extraLarge?: string | null; large?: string | null } | null
    isAdult?: boolean | null
}

function aniListMediaType(media: AniListSearchMedia): CatalogMediaType {
    if (media.format === "NOVEL") return "novel"
    if (media.countryOfOrigin === "KR") return "manhwa"
    if (media.countryOfOrigin === "CN" || media.countryOfOrigin === "TW") return "manhua"
    return "manga"
}

function aniListStatus(status: string | null | undefined): CatalogStatus | null {
    switch (status) {
        case "RELEASING":
            return "releasing"
        case "FINISHED":
            return "finished"
        case "HIATUS":
            return "hiatus"
        case "CANCELLED":
            return "cancelled"
        case "NOT_YET_RELEASED":
            return "upcoming"
        default:
            return null
    }
}

export function mapAniListSearchMedia(media: AniListSearchMedia): CatalogTitle | null {
    const names = [media.title?.english, media.title?.romaji, media.title?.native, ...(media.synonyms ?? [])]
        .map(name => text(name, 300))
        .filter((name): name is string => name !== null)
    const title = names[0]
    if (!title) return null
    return {
        workId: null,
        anilistId: media.id,
        title,
        altTitles: [...new Set(names.slice(1))].filter(name => name !== title).slice(0, MAX_ALT_TITLES),
        cover: httpsUrl(media.coverImage?.large ?? media.coverImage?.extraLarge),
        mediaType: aniListMediaType(media),
        status: aniListStatus(media.status),
        year: media.startDate?.year ?? null,
        genres: strings(media.genres, 12, 40),
        isAdult: media.isAdult === true,
        readers: 0
    }
}

export const ANILIST_SEARCH_QUERY = `query ($search: String, $perPage: Int, $adult: Boolean) {
  Page(perPage: $perPage) {
    media(search: $search, type: MANGA, isAdult: $adult, sort: [SEARCH_MATCH, POPULARITY_DESC]) {
      id title { romaji english native } synonyms status format countryOfOrigin
      startDate { year } genres coverImage { extraLarge large } isAdult
    }
  }
}`

export type CatalogSearchDeps = {
    siteBase: string
    fetch: typeof fetch
    aniList: (
        gql: string,
        variables: Record<string, unknown>
    ) => Promise<{ Page?: { media?: AniListSearchMedia[] } | null } | null>
}

async function searchWeeb(
    deps: CatalogSearchDeps,
    term: string,
    limit: number,
    adult: boolean
): Promise<CatalogTitle[] | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), WEEB_TIMEOUT_MS)
    try {
        const params = new URLSearchParams({ q: term, limit: String(limit), adult: adult ? "1" : "0" })
        const res = await deps.fetch(`${deps.siteBase}/api/public/search?${params}`, {
            headers: { Accept: "application/json" },
            signal: controller.signal
        })
        if (!res.ok) return null
        const body = (await res.json()) as { results?: unknown }
        if (!Array.isArray(body.results)) return null
        return body.results.map(parseCatalogTitle).filter((t): t is CatalogTitle => t !== null && (adult || !t.isAdult))
    } catch {
        return null
    } finally {
        clearTimeout(timer)
    }
}

export type OfficialOffer = { name: string; format: string | null; outUrl: string }

// The best legal place to read or buy a title, from weeb.ltd's offers for a work (by workId or AniList
// id). Undefined when there is none, the title is unknown or adult (404), or the lookup fails. Only the
// tracked outUrl is ever opened.
export async function fetchOfficialOffer(
    deps: Pick<CatalogSearchDeps, "siteBase" | "fetch">,
    id: string | number
): Promise<OfficialOffer | undefined> {
    try {
        const res = await deps.fetch(`${deps.siteBase}/api/work/${encodeURIComponent(String(id))}/offers`, {
            headers: { Accept: "application/json" }
        })
        if (!res.ok) return undefined
        const body = (await res.json()) as { best?: Record<string, unknown> | null }
        const best = body.best
        if (!best) return undefined
        const outUrl = httpsUrl(best.outUrl)
        const name = text(best.name, 80) ?? text(best.store, 80)
        if (!outUrl || !name) return undefined
        return { name, format: text(best.format, 30), outUrl }
    } catch {
        return undefined
    }
}

export async function searchCatalog(
    deps: CatalogSearchDeps,
    rawTerm: string,
    options: { limit?: number; adult?: boolean } = {}
): Promise<CatalogSearchResult> {
    const term = rawTerm.trim().slice(0, 200)
    if (!term) return { results: [], source: "weeb" }
    const limit = Math.min(30, Math.max(1, options.limit ?? 20))
    const adult = options.adult === true
    // An answer from weeb.ltd is final, even an empty one: it already tops up from AniList itself.
    const fromWeeb = await searchWeeb(deps, term, limit, adult)
    if (fromWeeb) return { results: fromWeeb.slice(0, limit), source: "weeb" }
    try {
        const data = await deps.aniList(ANILIST_SEARCH_QUERY, {
            search: term,
            perPage: limit,
            ...(adult ? {} : { adult: false })
        })
        // A rate-limited or failed AniList request answers null: that is "unavailable", not "no match".
        if (!data) return { results: [], source: "none", unavailable: true }
        const results = (data.Page?.media ?? [])
            .map(mapAniListSearchMedia)
            .filter((t): t is CatalogTitle => t !== null && (adult || !t.isAdult))
        return { results, source: "anilist" }
    } catch {
        return { results: [], source: "none", unavailable: true }
    }
}
