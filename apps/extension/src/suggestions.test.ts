import { normalizeTitle } from "@amr/normalize"
import { describe, it, expect } from "vitest"
import { ownsAnyName, scoreSuggestions, diversifyOrder, type CommunityRec, type Suggestion } from "./suggestions"
import type { LibraryManga } from "./database"
import type { RecCandidate } from "./metadata/recommendations"

function lib(partial: Partial<LibraryManga> & { title: string }): LibraryManga {
    return {
        id: `id:${partial.title}`,
        normalizedTitle: partial.title.toLocaleLowerCase("en"),
        authors: [],
        status: "unknown",
        addedAt: 0,
        updatedAt: 0,
        sourceId: "src",
        sourceUrl: "https://example.test",
        ...partial
    } as LibraryManga
}

function rec(anilistId: number, title: string, genres?: string[]): RecCandidate {
    return { anilistId, title, ...(genres ? { genres } : {}) }
}

describe("scoreSuggestions", () => {
    it("ranks a candidate recommended by many owned titles above one recommended by few", () => {
        const library = [lib({ title: "Owned One", anilistId: 1 }), lib({ title: "Owned Two", anilistId: 2 })]
        const anilistRecs = new Map<number, RecCandidate[]>([
            [1, [rec(100, "Popular"), rec(200, "Niche")]],
            [2, [rec(100, "Popular")]]
        ])

        const result = scoreSuggestions({ library, anilistRecs })

        expect(result[0]?.anilistId).toBe(100)
        expect(result[0]?.frequency).toBe(2)
        expect(result[0]?.reasons).toEqual(["Owned One", "Owned Two"])
        expect(result[1]?.anilistId).toBe(200)
        expect(result[1]?.frequency).toBe(1)
    })

    it("boosts a candidate whose genres overlap the library profile", () => {
        const library = [lib({ title: "Owned", anilistId: 1, genres: ["Action", "Horror"] })]
        const anilistRecs = new Map<number, RecCandidate[]>([
            [1, [rec(100, "No Overlap"), rec(200, "Genre Match", ["Action", "Horror"])]]
        ])

        const result = scoreSuggestions({ library, anilistRecs })

        expect(result[0]?.anilistId).toBe(200)
        expect(result[0]?.overlapScore).toBeGreaterThan(0)
        expect(result[1]?.anilistId).toBe(100)
        expect(result[1]?.overlapScore).toBe(0)
    })

    it("excludes candidates already in the library by anilistId", () => {
        const library = [lib({ title: "Owned", anilistId: 100 })]
        const anilistRecs = new Map<number, RecCandidate[]>([[999, [rec(100, "Owned Again"), rec(101, "New")]]])

        const result = scoreSuggestions({ library, anilistRecs })

        expect(result.map(s => s.anilistId)).toEqual([101])
    })

    it("excludes candidates already in the library by normalizedTitle", () => {
        const library = [lib({ title: "Chainsaw Man", normalizedTitle: "chainsaw man" })]
        const anilistRecs = new Map<number, RecCandidate[]>([
            [999, [rec(500, "Chainsaw Man"), rec(501, "Spy x Family")]]
        ])

        const result = scoreSuggestions({ library, anilistRecs })

        expect(result.map(s => s.anilistId)).toEqual([501])
    })

    it("returns an empty list for an empty library and no recs", () => {
        expect(scoreSuggestions({ library: [], anilistRecs: new Map() })).toEqual([])
    })

    it("handles owned titles with no anilistId (profile + title exclusion still apply)", () => {
        const library = [
            lib({ title: "No Id Title", genres: ["Action"] }),
            lib({ title: "Also Owned", normalizedTitle: "also owned" })
        ]
        const anilistRecs = new Map<number, RecCandidate[]>([
            [42, [rec(100, "Action Pick", ["Action"]), rec(200, "Also Owned")]]
        ])

        const result = scoreSuggestions({ library, anilistRecs })

        expect(result.map(s => s.anilistId)).toEqual([100])
        expect(result[0]?.overlapScore).toBeGreaterThan(0)
        expect(result[0]?.reasons).toEqual([])
    })

    it("boosts and badges a candidate that is also a community pick", () => {
        const library = [lib({ title: "Owned", anilistId: 1 })]
        const anilistRecs = new Map<number, RecCandidate[]>([[1, [rec(100, "Plain"), rec(200, "Community Fav")]]])
        const communityRecs: CommunityRec[] = [{ title: "Community Fav", sourceId: "src" }]

        const result = scoreSuggestions({ library, anilistRecs, communityRecs })

        expect(result[0]?.anilistId).toBe(200)
        expect(result[0]?.community).toBe(true)
        expect(result[1]?.community).toBe(false)
        expect(result[0]!.score).toBeGreaterThan(result[1]!.score)
    })

    it("breaks score ties deterministically by anilistId", () => {
        const library = [lib({ title: "Owned", anilistId: 1 })]
        const anilistRecs = new Map<number, RecCandidate[]>([[1, [rec(300, "C"), rec(100, "A"), rec(200, "B")]]])

        const result = scoreSuggestions({ library, anilistRecs })

        expect(result.map(s => s.anilistId)).toEqual([100, 200, 300])
    })
})

describe("scoreSuggestions - seed weighting", () => {
    it("ranks a candidate from a heavily-weighted seed above one from a light seed", () => {
        const library = [lib({ title: "Loved", anilistId: 1 }), lib({ title: "Meh", anilistId: 2 })]
        // Each candidate is recommended by exactly one seed, so without weighting they tie on
        // frequency and fall back to anilistId order (100 before 200). Weighting seed 2 far
        // above seed 1 must flip that.
        const anilistRecs = new Map<number, RecCandidate[]>([
            [1, [rec(100, "From Loved")]],
            [2, [rec(200, "From Meh")]]
        ])
        const seedWeights = new Map<number, number>([
            [1, 0.3],
            [2, 1.5]
        ])

        const result = scoreSuggestions({ library, anilistRecs, seedWeights })

        expect(result[0]?.anilistId).toBe(200)
        expect(result[1]?.anilistId).toBe(100)
    })

    it("defaults every seed to weight 1 when no map is given (unchanged behaviour)", () => {
        const library = [lib({ title: "A", anilistId: 1 }), lib({ title: "B", anilistId: 2 })]
        const anilistRecs = new Map<number, RecCandidate[]>([
            [1, [rec(100, "Shared")]],
            [2, [rec(100, "Shared")]]
        ])

        const result = scoreSuggestions({ library, anilistRecs })

        expect(result[0]?.frequency).toBe(2)
        // weightedFrequency (2 * 1) drives a score of 2 with no overlap/community.
        expect(result[0]?.score).toBe(2)
    })
})

describe("scoreSuggestions - AniList rec strength", () => {
    it("ranks a strongly-endorsed edge above a weak one at equal frequency", () => {
        const library = [lib({ title: "Seed", anilistId: 1 })]
        const anilistRecs = new Map<number, RecCandidate[]>([
            [
                1,
                [
                    { anilistId: 100, title: "Weak edge", recStrength: 0 },
                    { anilistId: 200, title: "Strong edge", recStrength: 120 }
                ]
            ]
        ])

        const result = scoreSuggestions({ library, anilistRecs })

        expect(result[0]?.anilistId).toBe(200)
        expect(result[1]?.anilistId).toBe(100)
    })

    it("passes averageScore and popularity through to the suggestion", () => {
        const library = [lib({ title: "Seed", anilistId: 1 })]
        const anilistRecs = new Map<number, RecCandidate[]>([
            [1, [{ anilistId: 100, title: "Gem", averageScore: 90, popularity: 4000 }]]
        ])

        const result = scoreSuggestions({ library, anilistRecs })

        expect(result[0]?.averageScore).toBe(90)
        expect(result[0]?.popularity).toBe(4000)
    })
})

describe("scoreSuggestions - hidden candidates", () => {
    it("excludes a candidate whose anilistId is in hiddenIds", () => {
        const library = [lib({ title: "Owned", anilistId: 1 })]
        const anilistRecs = new Map<number, RecCandidate[]>([[1, [rec(100, "Hidden"), rec(101, "Shown")]]])

        const result = scoreSuggestions({ library, anilistRecs, hiddenIds: new Set([100]) })

        expect(result.map(s => s.anilistId)).toEqual([101])
    })
})

describe("diversifyOrder", () => {
    function sug(anilistId: number, score: number, genres: string[]): Suggestion {
        return {
            anilistId,
            title: `t${anilistId}`,
            genres,
            frequency: 1,
            overlapScore: 0,
            community: false,
            score,
            reasons: []
        }
    }

    it("breaks up a run of the same genre near the top", () => {
        // Four isekai then one romance, all close in score. A pure sort keeps the romance
        // last; diversify must pull it up so the opening isn't four identical-genre picks.
        const list = [
            sug(1, 5.0, ["Isekai"]),
            sug(2, 4.9, ["Isekai"]),
            sug(3, 4.8, ["Isekai"]),
            sug(4, 4.7, ["Isekai"]),
            sug(5, 4.6, ["Romance"])
        ]

        const out = diversifyOrder(list)

        expect(out[0]?.anilistId).toBe(1)
        // The romance should no longer be dead last - it jumps ahead of at least one isekai.
        expect(out.findIndex(s => s.anilistId === 5)).toBeLessThan(4)
    })

    it("leaves a clearly stronger pick on top (small penalty only reshuffles near-ties)", () => {
        const list = [sug(1, 100, ["Isekai"]), sug(2, 5, ["Isekai"]), sug(3, 4, ["Romance"])]

        expect(diversifyOrder(list)[0]?.anilistId).toBe(1)
    })

    it("is a no-op for lists shorter than 3", () => {
        const list = [sug(1, 5, ["A"]), sug(2, 4, ["A"])]
        expect(diversifyOrder(list).map(s => s.anilistId)).toEqual([1, 2])
    })
})

describe("scoreSuggestions - bughunt regressions", () => {
    it("excludes an owned title stored with a weaker (non-collapsed) normalizedTitle", () => {
        const owned = lib({ title: "Solo  Leveling", normalizedTitle: "solo  leveling", sourceId: "s" })
        const seed = lib({ title: "Attack on Titan", anilistId: 1 })
        const anilistRecs = new Map([[1, [rec(99, "Solo Leveling")]]])
        const out = scoreSuggestions({ library: [seed, owned], anilistRecs })
        expect(out.find(s => s.anilistId === 99)).toBeUndefined()
    })
})

describe("ownsAnyName", () => {
    const owned = new Set([normalizeTitle("Kimetsu no Yaiba")])

    it("spots a title held under another of its names", () => {
        const candidate = { title: "Demon Slayer", searchTitles: ["Demon Slayer", "Kimetsu no Yaiba"] }
        expect(ownsAnyName(owned, candidate)).toBe(true)
    })

    it("leaves a title alone when none of its names are held", () => {
        expect(ownsAnyName(owned, { title: "Solo Leveling", searchTitles: ["Na Honjaman Level Up"] })).toBe(false)
    })

    it("works for a cached candidate saved without its other names", () => {
        expect(ownsAnyName(owned, { title: "Kimetsu no Yaiba" })).toBe(true)
        expect(ownsAnyName(owned, { title: "Demon Slayer" })).toBe(false)
    })
})
