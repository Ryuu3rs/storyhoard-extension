import { normalizeTitle } from "@amr/normalize"
import { db, type LibraryManga } from "../database"
import { anilistProvider } from "../metadata/anilist"
import type { RecCandidate } from "../metadata/recommendations"
import { ownsAnyName, scoreSuggestions, diversifyOrder, type CommunityRec, type Suggestion } from "../suggestions"
import { communityConfigured, getCommunityProfile } from "../community"
import { effectiveReadingStatus, neverRead } from "../reading-status"
import { getSettings } from "../settings"
import type { HandlerMap } from "../background/handler-types"

const SUGGESTIONS_KEY = "suggestions"
// Cached "continue the series" rail (same {suggestions, updatedAt} shape as SUGGESTIONS_KEY).
const NEXT_KEY = "nextInSeries"

// Stale-while-revalidate window: a fresh cache is returned as-is, an older one is
// recomputed on the next request (or immediately when force is set).
const STALE_MS = 6 * 60 * 60 * 1000

// Bounds the AniList fan-out: one recommendations query per seed title, run one at a
// time. The provider rate-limits internally; capping the seed set keeps a large library
// from queuing dozens of calls per refresh.
const MAX_SEED_TITLES = 60

// Upper bound on how many suggestions are surfaced/cached at once. Kept generous so the
// Discover grid has real depth to lazy-load through; the podium takes the top 3 and the
// rest paginate.
const MAX_SUGGESTIONS = 120

type SuggestionsCache = {
    suggestions: Suggestion[]
    updatedAt: number
}

async function getSuggestionsCache(): Promise<SuggestionsCache | null> {
    const stored = await browser.storage.local.get(SUGGESTIONS_KEY)
    return (stored[SUGGESTIONS_KEY] as SuggestionsCache | undefined) ?? null
}

async function setSuggestionsCache(cache: SuggestionsCache): Promise<void> {
    await browser.storage.local.set({ [SUGGESTIONS_KEY]: cache })
}

// Per-seed AniList recommendations cache. AniList "readers also liked" lists are very
// stable, so caching each seed's recs for two weeks means a recompute (a Discover open, a
// mark-as-read, a background revalidate) only calls AniList for seeds it hasn't seen or that
// have expired - instead of re-fetching every seed every time. This is the difference
// between ~60 AniList requests per recompute and ~0 once warm.
const REC_CACHE_KEY = "anilistRecCache"
const REC_CACHE_TTL = 14 * 24 * 60 * 60 * 1000
const REC_CACHE_MAX = 300

type RecCacheEntry = { recs: RecCandidate[]; fetchedAt: number }
type RecCache = Record<string, RecCacheEntry>

async function getRecCache(): Promise<RecCache> {
    const stored = await browser.storage.local.get(REC_CACHE_KEY)
    const raw = stored[REC_CACHE_KEY] as RecCache | undefined
    return raw && typeof raw === "object" ? raw : {}
}

async function setRecCache(cache: RecCache): Promise<void> {
    let toStore = cache
    const keys = Object.keys(cache)
    if (keys.length > REC_CACHE_MAX) {
        // Keep the most-recently-fetched entries; drop the oldest.
        const kept = Object.entries(cache)
            .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
            .slice(0, REC_CACHE_MAX)
        toStore = Object.fromEntries(kept)
    }
    try {
        await browser.storage.local.set({ [REC_CACHE_KEY]: toStore })
    } catch (error) {
        console.warn("[AMR] AniList rec cache write failed", error)
    }
}

// Genre-fill: when the library is too small/niche for AniList co-recommendations to fill the
// page, backfill with the highest-rated titles in the user's top genres. Only fires when the
// scored pool is below MIN_POOL, so a rich library never triggers it (and never pays the
// extra calls). Cached per genre for a week; top genres change slowly.
const GENRE_FILL_CACHE_KEY = "anilistGenreFillCache"
const GENRE_FILL_TTL = 7 * 24 * 60 * 60 * 1000
const MIN_POOL = 24
const GENRE_FILL_GENRES = 4
const GENRE_FILL_PER_GENRE = 20

type GenreFillEntry = { candidates: RecCandidate[]; fetchedAt: number }
type GenreFillCache = Record<string, GenreFillEntry>

async function getGenreFillCache(): Promise<GenreFillCache> {
    const stored = await browser.storage.local.get(GENRE_FILL_CACHE_KEY)
    const raw = stored[GENRE_FILL_CACHE_KEY] as GenreFillCache | undefined
    return raw && typeof raw === "object" ? raw : {}
}

async function setGenreFillCache(cache: GenreFillCache): Promise<void> {
    try {
        await browser.storage.local.set({ [GENRE_FILL_CACHE_KEY]: cache })
    } catch (error) {
        console.warn("[AMR] Genre-fill cache write failed", error)
    }
}

// The user's most-common genres, most-frequent first.
function topGenres(library: LibraryManga[], limit: number): string[] {
    const counts = new Map<string, { name: string; count: number }>()
    for (const manga of library) {
        const seen = new Set<string>()
        for (const genre of manga.genres ?? []) {
            const key = genre.toLocaleLowerCase("en")
            if (seen.has(key)) continue
            seen.add(key)
            const entry = counts.get(key)
            if (entry) entry.count += 1
            else counts.set(key, { name: genre, count: 1 })
        }
    }
    return [...counts.values()]
        .sort((a, b) => b.count - a.count)
        .map(e => e.name)
        .slice(0, limit)
}

// "Not interested" set: candidate anilistIds the user hid from Discover. Persisted so a
// recompute (and the score engine) permanently excludes them - a hidden pick never comes
// back. Bounded so a user who hides hundreds doesn't grow storage without limit; the oldest
// hides fall off first (they're the least likely to resurface as a top candidate anyway).
const HIDDEN_KEY = "hiddenSuggestions"
const HIDDEN_MAX = 1000

async function getHiddenIds(): Promise<Set<number>> {
    const stored = await browser.storage.local.get(HIDDEN_KEY)
    const raw = stored[HIDDEN_KEY]
    return new Set(Array.isArray(raw) ? raw.filter((n): n is number => typeof n === "number") : [])
}

async function setHiddenIds(ids: Set<number>): Promise<void> {
    const arr = [...ids]
    const trimmed = arr.length > HIDDEN_MAX ? arr.slice(arr.length - HIDDEN_MAX) : arr
    await browser.storage.local.set({ [HIDDEN_KEY]: trimmed })
}

// How much a seed's recommendations count, from how the user actually engaged that seed.
// A title they rated highly or finished is a stronger taste signal than one they dropped or
// only plan to read. Multiplicative around a neutral 1.0 so an unrated, actively-read seed
// behaves exactly as before this weighting existed.
function seedWeight(manga: LibraryManga, now: number): number {
    const ratingFactor = manga.rating && manga.rating > 0 ? 0.5 + manga.rating / 5 : 1
    const status = effectiveReadingStatus(manga, { autoPauseDays: 0, now })
    const statusFactor =
        status === "dropped"
            ? 0.3
            : status === "on-hold"
              ? 0.7
              : status === "planning"
                ? 0.5
                : status === "completed"
                  ? 1.2
                  : 1
    return ratingFactor * statusFactor
}

// Per-seed sequel cache. Media relations almost never change, so a long TTL means the
// "continue the series" rail costs at most one AniList call per read title, once. Only READ
// titles are checked (planning/unread have nothing to continue), capped so a huge library
// doesn't fan out - "what to read next" matters most for what you're actively reading.
const SEQUEL_CACHE_KEY = "anilistSequelCache"
const SEQUEL_CACHE_TTL = 30 * 24 * 60 * 60 * 1000
const SEQUEL_CACHE_MAX = 300
const MAX_SEQUEL_SEEDS = 25

type SequelCacheEntry = { sequels: RecCandidate[]; fetchedAt: number }
type SequelCache = Record<string, SequelCacheEntry>

async function getSequelCache(): Promise<SequelCache> {
    const stored = await browser.storage.local.get(SEQUEL_CACHE_KEY)
    const raw = stored[SEQUEL_CACHE_KEY] as SequelCache | undefined
    return raw && typeof raw === "object" ? raw : {}
}

async function setSequelCache(cache: SequelCache): Promise<void> {
    let toStore = cache
    const keys = Object.keys(cache)
    if (keys.length > SEQUEL_CACHE_MAX) {
        toStore = Object.fromEntries(
            Object.entries(cache)
                .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
                .slice(0, SEQUEL_CACHE_MAX)
        )
    }
    try {
        await browser.storage.local.set({ [SEQUEL_CACHE_KEY]: toStore })
    } catch (error) {
        console.warn("[AMR] AniList sequel cache write failed", error)
    }
}

// "Continue the series": for the titles the user has actually read, find their direct sequels
// that aren't already owned. Returned as Suggestion-shaped rows so the Discover rail can reuse
// the same card. Bounded + long-cached (see the constants above) so it's near-free once warm.
async function computeNextInSeries(): Promise<Suggestion[]> {
    const fetchSequels = anilistProvider.getSequels?.bind(anilistProvider)
    if (!fetchSequels) return []

    const library = await db.manga.toArray()
    const ownedAnilistIds = new Set<number>()
    const ownedTitles = new Set<string>()
    for (const manga of library) {
        if (typeof manga.anilistId === "number") ownedAnilistIds.add(manga.anilistId)
        ownedTitles.add(normalizeTitle(manga.title))
    }

    const readSeeds = library
        .filter(m => typeof m.anilistId === "number" && !neverRead(m))
        .sort((a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0))
        .slice(0, MAX_SEQUEL_SEEDS)

    const cache = await getSequelCache()
    const now = Date.now()
    let cacheDirty = false
    const out: Suggestion[] = []
    const emitted = new Set<number>()

    for (const seed of readSeeds) {
        const anilistId = seed.anilistId as number
        let entry = cache[anilistId]
        if (!entry || now - entry.fetchedAt >= SEQUEL_CACHE_TTL) {
            entry = { sequels: await fetchSequels(anilistId), fetchedAt: now }
            cache[anilistId] = entry
            cacheDirty = true
        }
        for (const sequel of entry.sequels) {
            if (ownedAnilistIds.has(sequel.anilistId)) continue
            if (ownsAnyName(ownedTitles, sequel)) continue
            if (emitted.has(sequel.anilistId)) continue
            emitted.add(sequel.anilistId)
            out.push({
                anilistId: sequel.anilistId,
                title: sequel.title,
                ...(sequel.coverUrl ? { coverUrl: sequel.coverUrl } : {}),
                ...(sequel.genres ? { genres: sequel.genres } : {}),
                frequency: 1,
                overlapScore: 0,
                community: false,
                score: 0,
                reasons: [seed.title]
            })
        }
    }
    if (cacheDirty) await setSequelCache(cache)
    return out
}

// Owned titles carrying an anilistId, deduped to the most recently read entry per id
// and capped to the most-recent MAX_SEED_TITLES so the fan-out stays bounded.
function selectSeedTitles(library: LibraryManga[]): LibraryManga[] {
    const byAnilistId = new Map<number, LibraryManga>()
    for (const manga of library) {
        if (typeof manga.anilistId !== "number") continue
        const existing = byAnilistId.get(manga.anilistId)
        if (!existing || (manga.lastReadAt ?? 0) > (existing.lastReadAt ?? 0)) {
            byAnilistId.set(manga.anilistId, manga)
        }
    }
    return [...byAnilistId.values()].sort((a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0)).slice(0, MAX_SEED_TITLES)
}

// Community co-read picks fold into the engine only when the profile is opted in and
// carries recs; otherwise suggestions degrade to the content-based signal.
async function loadCommunityRecs(): Promise<CommunityRec[] | undefined> {
    if (!communityConfigured) return undefined
    const profile = await getCommunityProfile()
    if (!profile.enabled) return undefined
    const recs = profile.recommendations ?? []
    if (recs.length === 0) return undefined
    return recs.map(rec => ({ title: rec.title, sourceId: rec.sourceId }))
}

async function computeSuggestions(): Promise<Suggestion[]> {
    const library = await db.manga.toArray()
    const seeds = selectSeedTitles(library)
    const now = Date.now()
    const seedWeights = new Map<number, number>()
    for (const seed of seeds) {
        if (typeof seed.anilistId === "number") seedWeights.set(seed.anilistId, seedWeight(seed, now))
    }
    const hiddenIds = await getHiddenIds()

    const anilistRecs = new Map<number, RecCandidate[]>()
    const fetchRecs = anilistProvider.getRecommendations?.bind(anilistProvider)
    if (fetchRecs) {
        const recCache = await getRecCache()
        let cacheDirty = false
        for (const seed of seeds) {
            const anilistId = seed.anilistId
            if (typeof anilistId !== "number" || anilistRecs.has(anilistId)) continue
            const cached = recCache[anilistId]
            if (cached && now - cached.fetchedAt < REC_CACHE_TTL) {
                // Fresh cache hit - no AniList call. (Empty recs are cached too, so a
                // no-recommendation title isn't re-fetched on every recompute.)
                if (cached.recs.length > 0) anilistRecs.set(anilistId, cached.recs)
                continue
            }
            const recs = await fetchRecs(anilistId)
            recCache[anilistId] = { recs, fetchedAt: now }
            cacheDirty = true
            if (recs.length > 0) anilistRecs.set(anilistId, recs)
        }
        if (cacheDirty) await setRecCache(recCache)
    }

    const communityRecs = await loadCommunityRecs()
    const scored = scoreSuggestions({
        library,
        anilistRecs,
        seedWeights,
        hiddenIds,
        ...(communityRecs ? { communityRecs } : {})
    })

    // Backfill a thin pool with top-rated titles in the user's genres. Skipped entirely once
    // there are already enough real recommendations, so a rich library pays nothing for it.
    const filled = scored.length < MIN_POOL ? await genreFill(library, scored, hiddenIds) : scored

    // Cap the surfaced list - a large library can aggregate 100+ candidates, which is slow
    // to render and more than anyone browses. The top slice by score is what matters.
    return filled.slice(0, MAX_SUGGESTIONS)
}

// Append genre-fill candidates to a thin scored pool. Fill picks score below real
// recommendations (a fixed base plus a small rating nudge) so they sit beneath anything the
// co-recommendation engine surfaced, and are deduped against owned/hidden/already-scored.
async function genreFill(library: LibraryManga[], scored: Suggestion[], hiddenIds: Set<number>): Promise<Suggestion[]> {
    const browse = anilistProvider.browseByGenre?.bind(anilistProvider)
    const genres = topGenres(library, GENRE_FILL_GENRES)
    if (!browse || genres.length === 0) return scored

    const ownedAnilistIds = new Set<number>()
    const ownedTitles = new Set<string>()
    for (const manga of library) {
        if (typeof manga.anilistId === "number") ownedAnilistIds.add(manga.anilistId)
        ownedTitles.add(normalizeTitle(manga.title))
    }
    const present = new Set(scored.map(s => s.anilistId))

    const cache = await getGenreFillCache()
    const now = Date.now()
    let cacheDirty = false
    const out = [...scored]

    for (const genre of genres) {
        const key = genre.toLocaleLowerCase("en")
        let entry = cache[key]
        if (!entry || now - entry.fetchedAt >= GENRE_FILL_TTL) {
            entry = { candidates: await browse(genre, GENRE_FILL_PER_GENRE), fetchedAt: now }
            cache[key] = entry
            cacheDirty = true
        }
        for (const candidate of entry.candidates) {
            if (present.has(candidate.anilistId)) continue
            if (ownedAnilistIds.has(candidate.anilistId)) continue
            if (hiddenIds.has(candidate.anilistId)) continue
            if (ownsAnyName(ownedTitles, candidate)) continue
            present.add(candidate.anilistId)
            out.push({
                anilistId: candidate.anilistId,
                title: candidate.title,
                ...(candidate.coverUrl ? { coverUrl: candidate.coverUrl } : {}),
                ...(candidate.genres ? { genres: candidate.genres } : {}),
                frequency: 0,
                overlapScore: 0,
                community: false,
                score: 0.5 + ((candidate.averageScore ?? 0) / 100) * 0.4,
                reasons: [],
                ...(candidate.averageScore !== undefined ? { averageScore: candidate.averageScore } : {}),
                ...(candidate.popularity !== undefined ? { popularity: candidate.popularity } : {}),
                ...(candidate.searchTitles && candidate.searchTitles.length > 0
                    ? { searchTitles: candidate.searchTitles }
                    : {})
            })
            if (out.length >= MAX_SUGGESTIONS) break
        }
        if (out.length >= MAX_SUGGESTIONS) break
    }
    if (cacheDirty) await setGenreFillCache(cache)
    // Keep the whole pool ordered by score so fills interleave correctly beneath real recs.
    return out.sort((a, b) => b.score - a.score || a.anilistId - b.anilistId)
}

// Shared across concurrent suggestions:get calls so the AniList fan-out runs once, not
// once per request (two popup/tab contexts or an alarm + a popup all hit the same SW).
let inflightCompute: Promise<Suggestion[]> | null = null

async function computeAndCache(prevCache: SuggestionsCache | null): Promise<Suggestion[]> {
    const suggestions = await computeSuggestions()
    // A recompute that yields nothing (AniList unreachable, no anilistId titles) must not
    // overwrite a good cache - fall back to it instead.
    if (suggestions.length === 0 && prevCache) return prevCache.suggestions
    try {
        await setSuggestionsCache({ suggestions, updatedAt: Date.now() })
    } catch (error) {
        // A persist failure (quota/IO) must not throw away a good in-hand result.
        console.warn("[AMR] Suggestions cache write failed", error)
    }
    return suggestions
}

// Read-time view transform applied to every returned list, cached or freshly computed:
// drop anything the user has since hidden (so a hide takes effect instantly without waiting
// for a recompute), then optionally re-order for genre variety. Kept out of the cached
// payload so toggling "mix it up" or hiding a title reflects immediately - the stored list
// stays a pure highest-score-first ordering.
async function present(list: Suggestion[]): Promise<Suggestion[]> {
    const [hiddenIds, settings] = await Promise.all([getHiddenIds(), getSettings()])
    const visible = hiddenIds.size > 0 ? list.filter(s => !hiddenIds.has(s.anilistId)) : list
    return settings.discoverDiversify ? diversifyOrder(visible) : visible
}

export const suggestionsHandlers: HandlerMap = {
    "suggestions:get": async request => {
        let cache: SuggestionsCache | null = null
        try {
            // Inside the try so a cache-read failure degrades to [] like any other failure
            // instead of rejecting (the never-throw contract this handler advertises).
            cache = await getSuggestionsCache()
            if (cache && Date.now() - cache.updatedAt < STALE_MS && !request.force) {
                return await present(cache.suggestions)
            }

            // A force must always run a FRESH compute reflecting the current library. If a
            // non-force background revalidate is in flight it was computed from the PRE-change
            // snapshot, so force starts (and adopts) a new compute rather than reusing it. The
            // .finally guard only nulls out the promise that is still current, so a stale
            // revalidate resolving later can't clobber a newer inflight compute.
            if (!inflightCompute || request.force) {
                const thisPromise = computeAndCache(cache).finally(() => {
                    if (inflightCompute === thisPromise) inflightCompute = null
                })
                inflightCompute = thisPromise
            }
            // Stale-while-revalidate: if we hold ANY cached list and the caller didn't
            // force a refresh, return it instantly and let the (slow, AniList-rate-limited)
            // recompute finish in the background - the fresh list is served on the next
            // request. Only a cold start (no cache) or an explicit force waits for it.
            if (cache && !request.force) {
                void inflightCompute.catch(() => {})
                return await present(cache.suggestions)
            }
            return await present(await inflightCompute)
        } catch (error) {
            console.warn("[AMR] Suggestions computation failed", error)
            return cache ? await present(cache.suggestions).catch(() => cache!.suggestions) : []
        }
    },
    // "Not interested": permanently exclude a candidate. Returns the new hidden-set size so
    // the UI can confirm. Also drops it from the cached list right away so the grid updates
    // even before the next recompute reaches the score engine's exclusion.
    "suggestions:hide": async request => {
        const hidden = await getHiddenIds()
        hidden.add(request.anilistId)
        await setHiddenIds(hidden)
        const cache = await getSuggestionsCache()
        if (cache) {
            const pruned = cache.suggestions.filter(s => s.anilistId !== request.anilistId)
            if (pruned.length !== cache.suggestions.length) {
                await setSuggestionsCache({ ...cache, suggestions: pruned })
            }
        }
        return { hidden: hidden.size }
    },
    // Undo a hide (the toast's "Undo"). The title reappears on the next recompute; there's
    // no need to re-inject it into the cache since a force/stale refresh will pick it up.
    "suggestions:unhide": async request => {
        const hidden = await getHiddenIds()
        if (hidden.delete(request.anilistId)) await setHiddenIds(hidden)
        return { hidden: hidden.size }
    },
    // "Continue the series" rail: sequels of read titles the user doesn't own yet. Same
    // stale-while-revalidate discipline as suggestions:get - a fresh cache paints instantly,
    // a stale one is returned while a background recompute refreshes it. Hidden titles are
    // filtered here too so "Not interested" also suppresses a sequel.
    "suggestions:continue": async () => {
        let cache: SuggestionsCache | null = null
        try {
            const stored = await browser.storage.local.get(NEXT_KEY)
            cache = (stored[NEXT_KEY] as SuggestionsCache | undefined) ?? null
            const hidden = await getHiddenIds()
            const filterHidden = (list: Suggestion[]) =>
                hidden.size > 0 ? list.filter(s => !hidden.has(s.anilistId)) : list

            if (cache && Date.now() - cache.updatedAt < STALE_MS) {
                return filterHidden(cache.suggestions)
            }
            const compute = computeNextInSeries().then(async suggestions => {
                if (suggestions.length === 0 && cache) return cache.suggestions
                try {
                    await browser.storage.local.set({ [NEXT_KEY]: { suggestions, updatedAt: Date.now() } })
                } catch (error) {
                    console.warn("[AMR] Continue-series cache write failed", error)
                }
                return suggestions
            })
            if (cache) {
                void compute.catch(() => {})
                return filterHidden(cache.suggestions)
            }
            return filterHidden(await compute)
        } catch (error) {
            console.warn("[AMR] Continue-series computation failed", error)
            return cache?.suggestions ?? []
        }
    }
}
