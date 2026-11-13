import { normalizeTitle } from "@amr/normalize"
import type { MangaStatus, MetadataProvider, MetadataQuery, MetadataResult } from "./provider"
import {
    buildSearchTitles,
    mapRecommendations,
    RECOMMENDATIONS_QUERY,
    type RecCandidate,
    type RecommendationsResponse
} from "./recommendations"
import { mapSequels, RELATIONS_QUERY, type RelationsResponse } from "./relations"
import { mapBrowse, BROWSE_QUERY, type BrowseResponse } from "./browse"

const ANILIST_GRAPHQL = "https://graphql.anilist.co"
const MIN_INTERVAL_MS = 700 // ~85 req/min, under AniList's 90/min limit

let lastRequest = 0
let requestChain: Promise<unknown> = Promise.resolve()

// Serializes every AniList query behind a single promise chain with a minimum gap
// between requests. The covers backfill runs four concurrent source groups whose
// metadata fallbacks all land here; without this they burst past AniList's rate
// limit and the 429s silently degrade to "no cover".
function rateLimited<T>(fn: () => Promise<T>): Promise<T> {
    const run = requestChain.then(async () => {
        const wait = MIN_INTERVAL_MS - (Date.now() - lastRequest)
        if (wait > 0) await new Promise(r => setTimeout(r, wait))
        lastRequest = Date.now()
        return fn()
    })
    requestChain = run.then(
        () => undefined,
        () => undefined
    )
    return run
}

// AniList Media.status (MANGA) -> our publication-status enum.
function mapStatus(status: string | null | undefined): MangaStatus {
    switch (status) {
        case "RELEASING":
            return "ongoing"
        case "FINISHED":
            return "completed"
        case "HIATUS":
            return "hiatus"
        case "CANCELLED":
            return "cancelled"
        default:
            // NOT_YET_RELEASED / null / anything unexpected
            return "unknown"
    }
}

type AniListMedia = {
    id: number
    title?: { romaji?: string | null; english?: string | null; native?: string | null } | null
    synonyms?: (string | null)[] | null
    popularity?: number | null
    status?: string | null
    format?: string | null
    genres?: (string | null)[] | null
    tags?: ({ name?: string | null } | null)[] | null
    coverImage?: { extraLarge?: string | null; large?: string | null } | null
}

// Pure mapping - exported for tests, no network.
export function mapAniListMedia(media: AniListMedia): MetadataResult {
    const genres = (media.genres ?? []).filter((g): g is string => typeof g === "string" && g.length > 0)
    const tags = (media.tags ?? []).map(t => t?.name).filter((n): n is string => typeof n === "string" && n.length > 0)
    const coverUrl = media.coverImage?.extraLarge ?? media.coverImage?.large ?? undefined
    const title = media.title?.english ?? media.title?.romaji ?? media.title?.native ?? undefined
    return {
        anilistId: media.id,
        ...(title ? { title } : {}),
        status: mapStatus(media.status),
        ...(coverUrl ? { coverUrl } : {}),
        ...(genres.length > 0 ? { genres } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        isOneshot: media.format === "ONE_SHOT"
    }
}

const MEDIA_FIELDS = `
    id
    title { romaji english native }
    synonyms
    status
    format
    genres
    tags { name }
    coverImage { extraLarge large }
`

// Every AniList request waits in one queue, so one that never answers would stall all the rest (and the
// search popover with them). It is abandoned after this long.
export const ANILIST_TIMEOUT_MS = 10_000

function query<T>(gql: string, variables: Record<string, unknown>): Promise<T | null> {
    return rateLimited(async () => {
        const res = await fetch(ANILIST_GRAPHQL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ query: gql, variables }),
            signal: AbortSignal.timeout(ANILIST_TIMEOUT_MS)
        })
        if (!res.ok) return null
        const json = (await res.json()) as { data?: T }
        return json.data ?? null
    })
}

// The rate-limited query for other modules (the search popover's title search).
export function aniListQuery<T>(gql: string, variables: Record<string, unknown>): Promise<T | null> {
    return query<T>(gql, variables)
}

// All the names a result goes by.
function namesOf(media: AniListMedia): string[] {
    return [media.title?.english, media.title?.romaji, media.title?.native, ...(media.synonyms ?? [])].filter(
        (name): name is string => typeof name === "string" && name.trim().length > 0
    )
}

// The other names a typed search term goes by, or [] when no result really is that title. AniList's search
// is fuzzy and its top hit can be another series that merely contains the words ("Demon Slayer Mother"), so
// sharing words is not enough: the term has to be one of the names, or a whole part of one ("Demon Slayer"
// for "Demon Slayer: Kimetsu no Yaiba"). A part can fit a spin-off too, so the most read series wins it.
// Pure, exported for tests.
export function otherNamesFrom(results: readonly AniListMedia[], term: string): string[] {
    const wanted = normalizeTitle(term)
    const exact = results.find(media => namesOf(media).some(name => normalizeTitle(name) === wanted))
    const partly = results
        .filter(media =>
            namesOf(media).some(name => name.split(/:|\s-\s/).some(part => normalizeTitle(part) === wanted))
        )
        .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))[0]
    const match = exact ?? partly
    return match ? buildSearchTitles(match).filter(name => normalizeTitle(name) !== wanted) : []
}

export async function findOtherNames(term: string): Promise<string[]> {
    try {
        const data = await query<{ Page: { media: AniListMedia[] } | null }>(
            `query ($search: String) { Page(perPage: 8) { media(search: $search, type: MANGA) { id popularity title { romaji english native } synonyms } } }`,
            { search: term }
        )
        return otherNamesFrom(data?.Page?.media ?? [], term)
    } catch {
        return []
    }
}

// AniList metadata provider - queries the public GraphQL API directly. Used as the
// fallback behind the VPS catalog (and, until the VPS service is deployed, the only
// provider). Returns null on no match or any network/parse failure so the caller can
// fall through or skip cleanly.
export const anilistProvider: MetadataProvider = {
    name: "anilist",

    async resolve(q: MetadataQuery): Promise<MetadataResult | null> {
        const title = q.title.trim()
        if (!title) return null
        try {
            const data = await query<{ Media: AniListMedia | null }>(
                `query ($search: String) { Media(search: $search, type: MANGA) { ${MEDIA_FIELDS} } }`,
                { search: title }
            )
            return data?.Media ? mapAniListMedia(data.Media) : null
        } catch {
            return null
        }
    },

    async getByAnilistId(id: number): Promise<MetadataResult | null> {
        try {
            const data = await query<{ Media: AniListMedia | null }>(
                `query ($id: Int) { Media(id: $id, type: MANGA) { ${MEDIA_FIELDS} } }`,
                { id }
            )
            return data?.Media ? mapAniListMedia(data.Media) : null
        } catch {
            return null
        }
    },

    async resolveSearchTitles(anilistId: number): Promise<string[]> {
        try {
            const data = await query<{ Media: AniListMedia | null }>(
                `query ($id: Int) { Media(id: $id, type: MANGA) { id title { romaji english native } synonyms } }`,
                { id: anilistId }
            )
            return data?.Media ? buildSearchTitles(data.Media) : []
        } catch {
            return []
        }
    },

    async getRecommendations(id: number): Promise<RecCandidate[]> {
        try {
            const data = await query<{ Media: RecommendationsResponse }>(RECOMMENDATIONS_QUERY, { id })
            return data?.Media ? mapRecommendations(data.Media) : []
        } catch {
            return []
        }
    },

    async getSequels(id: number): Promise<RecCandidate[]> {
        try {
            const data = await query<{ Media: RelationsResponse }>(RELATIONS_QUERY, { id })
            return data?.Media ? mapSequels(data.Media) : []
        } catch {
            return []
        }
    },

    async browseByGenre(genre: string, perPage = 20): Promise<RecCandidate[]> {
        try {
            const data = await query<BrowseResponse>(BROWSE_QUERY, { genre, perPage })
            return data ? mapBrowse(data) : []
        } catch {
            return []
        }
    }
}
