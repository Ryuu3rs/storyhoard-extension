import { normalizeTitle } from "@amr/normalize"
import type { LibraryManga } from "./database"
import type { RecCandidate } from "./metadata/recommendations"

// A ranked suggestion surfaced in the Suggestions tab. Pure output of scoreSuggestions:
// no covers are fetched here, the candidate's own coverUrl is carried through.
export type Suggestion = {
    anilistId: number
    title: string
    coverUrl?: string
    genres?: string[]
    // How many owned titles recommended this candidate (AniList co-recommendation count).
    frequency: number
    // Genre/author overlap against the library profile, normalized to [0, 1].
    overlapScore: number
    // True when the candidate is also a community "readers also read" pick (badge marker).
    community: boolean
    // Final weighted rank; higher is a stronger suggestion.
    score: number
    // Owned titles that led here, for the card's "because you read X, Y" line.
    reasons: string[]
    // AniList community rating (0-100) and popularity (users with it listed), passed through
    // for the "hidden gems" rail (highly rated, not widely read). Absent when AniList didn't
    // return them.
    averageScore?: number
    popularity?: number
    // Latin title variants (english/romaji/synonyms) to try when searching sources for this
    // title, best-first. A romaji-only Korean/Chinese title rarely matches scanlation sites.
    searchTitles?: string[]
}

export type CommunityRec = {
    title: string
    sourceId: string
}

export type SuggestionsInput = {
    library: LibraryManga[]
    anilistRecs: Map<number, RecCandidate[]>
    communityRecs?: CommunityRec[]
    // Per-seed influence, keyed by the seed's own anilistId. A highly-rated or completed
    // seed pushes its recommendations harder than a dropped or plan-to-read one. Absent
    // entries (and the whole map) default to weight 1, so scoring is unchanged without it.
    seedWeights?: Map<number, number>
    // Candidate anilistIds the user explicitly hid ("Not interested"). Excluded from output
    // exactly like an already-owned title, so a recompute never resurfaces them.
    hiddenIds?: Set<number>
}

// Rank weights. Frequency is the primary signal (AniList co-recommendation), overlap is
// a secondary content signal, community membership is a fixed boost. Overlap is scaled up
// because it is normalized to [0, 1] while frequency is a small integer count.
const WEIGHT_FREQUENCY = 1
const WEIGHT_OVERLAP = 3
const COMMUNITY_BOOST = 2
// Contribution of AniList recommendation strength, applied to a [0,1]-normalized strength
// (log-scaled, since edge ratings span single digits to hundreds). Modest, so a strongly
// endorsed edge nudges a candidate up without overriding how many owned titles led there.
const WEIGHT_STRENGTH = 1.5

// Map an unbounded edge rating to [0,1]: 0 -> 0, ~9 -> 0.5, >=99 -> 1. Deterministic.
function normalizeStrength(strength: number): number {
    if (strength <= 0) return 0
    return Math.min(1, Math.log10(1 + strength) / 2)
}

type Aggregate = {
    candidate: RecCandidate
    // Distinct owned titles that recommended this candidate - the integer shown on the card
    // ("because you read X, Y") and a tiebreak.
    frequency: number
    // Sum of the recommending seeds' weights - what the score actually uses, so a single
    // 5-star seed can outrank two lukewarm ones. Equals frequency when all weights are 1.
    weightedFrequency: number
    // Strongest single AniList endorsement across the seeds that recommended this candidate
    // (max of the edge ratings). One heavily-upvoted "readers also liked" edge is a better
    // signal than several weak ones, so max (not sum) is the right aggregate.
    maxStrength: number
    reasons: string[]
    seenOwners: Set<number>
}

// Sums a set of profile weights for the terms a candidate carries. Deterministic.
function overlap(terms: string[] | undefined, profile: Map<string, number>, total: number): number {
    if (!terms || terms.length === 0 || total === 0) return 0
    let sum = 0
    for (const term of terms) {
        sum += profile.get(term.toLocaleLowerCase("en")) ?? 0
    }
    return sum / total
}

// A series goes by several names (Demon Slayer, Kimetsu no Yaiba), and the library may hold any of
// them. A candidate is owned if any name AniList gives it is in the library.
export function ownsAnyName(
    ownedTitles: ReadonlySet<string>,
    candidate: { title: string; searchTitles?: readonly string[] | undefined }
): boolean {
    return [candidate.title, ...(candidate.searchTitles ?? [])].some(name => ownedTitles.has(normalizeTitle(name)))
}

export function scoreSuggestions(input: SuggestionsInput): Suggestion[] {
    const { library, anilistRecs, communityRecs, seedWeights, hiddenIds } = input

    const ownedAnilistIds = new Set<number>()
    const ownedTitles = new Set<string>()
    const ownerTitleById = new Map<number, string>()
    const genreProfile = new Map<string, number>()
    const authorProfile = new Map<string, number>()
    let genreTotal = 0
    let authorTotal = 0

    for (const manga of library) {
        if (typeof manga.anilistId === "number") {
            ownedAnilistIds.add(manga.anilistId)
            if (!ownerTitleById.has(manga.anilistId)) ownerTitleById.set(manga.anilistId, manga.title)
        }
        // Always recompute the key rather than trusting the stored normalizedTitle: some
        // add/relink paths store it under a weaker rule (no whitespace-collapse/trim), so
        // an owned title could otherwise slip past this guard and be recommended back.
        ownedTitles.add(normalizeTitle(manga.title))
        for (const genre of manga.genres ?? []) {
            const key = genre.toLocaleLowerCase("en")
            genreProfile.set(key, (genreProfile.get(key) ?? 0) + 1)
            genreTotal += 1
        }
        for (const author of manga.authors ?? []) {
            const key = author.toLocaleLowerCase("en")
            authorProfile.set(key, (authorProfile.get(key) ?? 0) + 1)
            authorTotal += 1
        }
    }

    const communityTitles = new Set((communityRecs ?? []).map(rec => normalizeTitle(rec.title)))

    const aggregates = new Map<number, Aggregate>()
    for (const [ownerId, candidates] of anilistRecs) {
        const ownerTitle = ownerTitleById.get(ownerId)
        const ownerWeight = seedWeights?.get(ownerId) ?? 1
        for (const candidate of candidates) {
            const strength = candidate.recStrength ?? 0
            const existing = aggregates.get(candidate.anilistId)
            if (existing) {
                if (strength > existing.maxStrength) existing.maxStrength = strength
                if (!existing.seenOwners.has(ownerId)) {
                    existing.seenOwners.add(ownerId)
                    existing.frequency += 1
                    existing.weightedFrequency += ownerWeight
                    if (ownerTitle && !existing.reasons.includes(ownerTitle)) existing.reasons.push(ownerTitle)
                }
                continue
            }
            aggregates.set(candidate.anilistId, {
                candidate,
                frequency: 1,
                weightedFrequency: ownerWeight,
                maxStrength: strength,
                reasons: ownerTitle ? [ownerTitle] : [],
                seenOwners: new Set([ownerId])
            })
        }
    }

    const suggestions: Suggestion[] = []
    for (const agg of aggregates.values()) {
        const { candidate } = agg
        if (ownedAnilistIds.has(candidate.anilistId)) continue
        if (hiddenIds?.has(candidate.anilistId)) continue
        if (ownsAnyName(ownedTitles, candidate)) continue

        const genreOverlap = overlap(candidate.genres, genreProfile, genreTotal)
        const authorOverlap = overlap(candidate.authors, authorProfile, authorTotal)
        const overlapScore = Math.min(1, genreOverlap + authorOverlap)
        const community = communityTitles.has(normalizeTitle(candidate.title))
        const score =
            agg.weightedFrequency * WEIGHT_FREQUENCY +
            overlapScore * WEIGHT_OVERLAP +
            normalizeStrength(agg.maxStrength) * WEIGHT_STRENGTH +
            (community ? COMMUNITY_BOOST : 0)

        suggestions.push({
            anilistId: candidate.anilistId,
            title: candidate.title,
            ...(candidate.coverUrl ? { coverUrl: candidate.coverUrl } : {}),
            ...(candidate.genres ? { genres: candidate.genres } : {}),
            frequency: agg.frequency,
            overlapScore,
            community,
            score,
            reasons: agg.reasons,
            ...(candidate.averageScore !== undefined ? { averageScore: candidate.averageScore } : {}),
            ...(candidate.popularity !== undefined ? { popularity: candidate.popularity } : {}),
            ...(candidate.searchTitles && candidate.searchTitles.length > 0
                ? { searchTitles: candidate.searchTitles }
                : {})
        })
    }

    suggestions.sort(
        (a, b) =>
            b.score - a.score ||
            b.frequency - a.frequency ||
            a.anilistId - b.anilistId ||
            a.title.localeCompare(b.title)
    )
    return suggestions
}

// How hard "mix it up" pushes back on genre repetition. A small value: it only reshuffles
// near-ties, never buries a clearly stronger pick under a weaker off-genre one.
const DIVERSITY_PENALTY = 0.5

// Re-order an already-scored list to break up runs of the same genre, so the grid doesn't
// open with fifteen isekai in a row when that's the biggest slice of someone's library.
// Greedy: repeatedly take the highest score MINUS a penalty for each already-picked title
// sharing a genre. Pure and deterministic (ties fall back to the incoming order, which
// scoreSuggestions already made total), so it's a stable, testable transform over the
// output rather than a change to the scoring itself.
export function diversifyOrder(suggestions: Suggestion[]): Suggestion[] {
    if (suggestions.length < 3) return suggestions.slice()
    const remaining = suggestions.slice()
    const picked: Suggestion[] = []
    const genreUse = new Map<string, number>()
    while (remaining.length > 0) {
        let bestIdx = 0
        let bestAdjusted = -Infinity
        for (let i = 0; i < remaining.length; i++) {
            const candidate = remaining[i]!
            let penalty = 0
            for (const genre of candidate.genres ?? []) {
                penalty += genreUse.get(genre.toLocaleLowerCase("en")) ?? 0
            }
            const adjusted = candidate.score - penalty * DIVERSITY_PENALTY
            if (adjusted > bestAdjusted) {
                bestAdjusted = adjusted
                bestIdx = i
            }
        }
        const [chosen] = remaining.splice(bestIdx, 1)
        picked.push(chosen!)
        for (const genre of chosen!.genres ?? []) {
            const key = genre.toLocaleLowerCase("en")
            genreUse.set(key, (genreUse.get(key) ?? 0) + 1)
        }
    }
    return picked
}
