import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LibraryManga } from "../database"
import type { RecCandidate } from "../metadata/recommendations"
import type { Suggestion } from "../suggestions"

vi.stubGlobal("browser", fakeBrowser)

vi.mock("../metadata/anilist", () => ({
    anilistProvider: { getRecommendations: vi.fn(), browseByGenre: vi.fn() }
}))

vi.mock("../community", async () => {
    const actual = await vi.importActual<typeof import("../community")>("../community")
    return {
        ...actual,
        communityConfigured: true,
        getCommunityProfile: vi.fn()
    }
})

const { db } = await import("../database")
const { anilistProvider } = await import("../metadata/anilist")
const getRecommendations = vi.mocked(anilistProvider.getRecommendations!)
const browseByGenre = vi.mocked(anilistProvider.browseByGenre!)
const community = await import("../community")
const getCommunityProfile = vi.mocked(community.getCommunityProfile)
const { suggestionsHandlers } = await import("./suggestions")

const ctx = { sender: {} as never }

function ownedManga(overrides: Partial<LibraryManga> & Pick<LibraryManga, "id" | "title">): LibraryManga {
    return {
        sourceId: "mangadex",
        sourceUrl: `https://mangadex.org/title/${overrides.id}`,
        normalizedTitle: overrides.title.toLowerCase(),
        authors: [],
        status: "ongoing",
        addedAt: 1,
        updatedAt: 1,
        ...overrides
    }
}

const disabledProfile = {
    enabled: false,
    username: "",
    userId: "",
    secret: "",
    lastSyncAt: 0,
    communityRank: null,
    recommendations: [],
    newAchievements: [],
    communityStats: null,
    consentVersion: 0,
    consentAt: 0,
    declined: false
}

async function getSuggestions(force?: boolean): Promise<Suggestion[]> {
    const result = await suggestionsHandlers["suggestions:get"]!(
        { type: "suggestions:get", ...(force !== undefined ? { force } : {}) },
        ctx
    )
    return result as Suggestion[]
}

beforeEach(async () => {
    fakeBrowser.reset()
    vi.clearAllMocks()
    getRecommendations.mockReset()
    browseByGenre.mockReset()
    await db.manga.clear()
    getRecommendations.mockResolvedValue([])
    browseByGenre.mockResolvedValue([])
    getCommunityProfile.mockResolvedValue(disabledProfile)
})

describe("suggestions:get", () => {
    it("excludes owned titles and surfaces new recommendations", async () => {
        await db.manga.put(ownedManga({ id: "m1", title: "Owned One", anilistId: 100, genres: ["Action"] }))
        await db.manga.put(ownedManga({ id: "m2", title: "Owned Two", anilistId: 200, genres: ["Comedy"] }))

        const candidates: RecCandidate[] = [
            { anilistId: 200, title: "Owned Two", genres: ["Comedy"] },
            { anilistId: 999, title: "Fresh Pick", genres: ["Action"] }
        ]
        getRecommendations.mockResolvedValueOnce(candidates).mockResolvedValueOnce([])

        const suggestions = await getSuggestions()

        expect(suggestions.map(s => s.anilistId)).toEqual([999])
        expect(suggestions[0]!.title).toBe("Fresh Pick")
    })

    it("caches the computed list with a timestamp in storage.local", async () => {
        await db.manga.put(ownedManga({ id: "m1", title: "Owned One", anilistId: 100 }))
        getRecommendations.mockResolvedValueOnce([{ anilistId: 999, title: "Fresh Pick" }])

        await getSuggestions()

        const stored = await fakeBrowser.storage.local.get("suggestions")
        const cache = stored["suggestions"] as { suggestions: Suggestion[]; updatedAt: number }
        expect(cache.suggestions.map(s => s.anilistId)).toEqual([999])
        expect(cache.updatedAt).toBeGreaterThan(0)
    })

    it("returns the fresh cache without recomputing", async () => {
        await db.manga.put(ownedManga({ id: "m1", title: "Owned One", anilistId: 100 }))
        getRecommendations.mockResolvedValueOnce([{ anilistId: 999, title: "Fresh Pick" }])

        await getSuggestions()
        expect(getRecommendations).toHaveBeenCalledTimes(1)

        const second = await getSuggestions()
        expect(getRecommendations).toHaveBeenCalledTimes(1)
        expect(second.map(s => s.anilistId)).toEqual([999])
    })

    it("recomputes on force but reuses the cached AniList recs (no re-fetch)", async () => {
        await db.manga.put(ownedManga({ id: "m1", title: "Owned One", anilistId: 100 }))
        getRecommendations.mockResolvedValue([{ anilistId: 999, title: "Fresh Pick" }])

        await getSuggestions()
        expect(getRecommendations).toHaveBeenCalledTimes(1)

        // Force bypasses the 6h suggestions cache and re-scores, but the per-seed rec cache is
        // still fresh - so AniList is NOT hit again. This is the point of the rec cache: a
        // recompute (Discover open, mark-as-read, revalidate) costs ~0 AniList calls once warm.
        const forced = await getSuggestions(true)
        expect(getRecommendations).toHaveBeenCalledTimes(1)
        expect(forced.map(s => s.anilistId)).toEqual([999])
    })

    it("only calls AniList for a newly-added seed, not the whole cached set", async () => {
        await db.manga.put(ownedManga({ id: "m1", title: "One", anilistId: 100 }))
        getRecommendations.mockResolvedValue([{ anilistId: 999, title: "Pick" }])
        await getSuggestions()
        expect(getRecommendations).toHaveBeenCalledTimes(1)

        // Add a second seed and force: only the new seed (200) is fetched; 100 is served
        // from the rec cache.
        await db.manga.put(ownedManga({ id: "m2", title: "Two", anilistId: 200 }))
        await getSuggestions(true)
        expect(getRecommendations).toHaveBeenCalledTimes(2)
        expect(getRecommendations).toHaveBeenLastCalledWith(200)
    })

    it("returns an empty list for an empty library without calling AniList", async () => {
        const suggestions = await getSuggestions()

        expect(suggestions).toEqual([])
        expect(getRecommendations).not.toHaveBeenCalled()
    })

    it("skips owned titles that have no anilistId", async () => {
        await db.manga.put(ownedManga({ id: "m1", title: "No Anilist" }))

        const suggestions = await getSuggestions()

        expect(getRecommendations).not.toHaveBeenCalled()
        expect(suggestions).toEqual([])
    })

    it("falls back to the previous cache when a later recompute yields nothing", async () => {
        await db.manga.put(ownedManga({ id: "m1", title: "Owned One", anilistId: 100 }))
        getRecommendations.mockResolvedValueOnce([{ anilistId: 999, title: "Fresh Pick" }])
        await getSuggestions()

        getRecommendations.mockResolvedValue([])
        const degraded = await getSuggestions(true)

        expect(degraded.map(s => s.anilistId)).toEqual([999])
    })

    it("never throws when the library read fails, returning any cached list", async () => {
        await db.manga.put(ownedManga({ id: "m1", title: "Owned One", anilistId: 100 }))
        getRecommendations.mockResolvedValueOnce([{ anilistId: 999, title: "Fresh Pick" }])
        await getSuggestions()

        vi.spyOn(console, "warn").mockImplementation(() => {})
        const toArray = vi.spyOn(db.manga, "toArray").mockRejectedValueOnce(new Error("db down"))

        const result = await getSuggestions(true)

        expect(result.map(s => s.anilistId)).toEqual([999])
        toArray.mockRestore()
    })

    it("folds in community co-read picks when the profile is opted in", async () => {
        await db.manga.put(ownedManga({ id: "m1", title: "Owned One", anilistId: 100 }))
        getRecommendations.mockResolvedValueOnce([{ anilistId: 999, title: "Fresh Pick" }])
        getCommunityProfile.mockResolvedValue({
            ...disabledProfile,
            enabled: true,
            userId: "user-1",
            secret: "",
            recommendations: [{ title: "Fresh Pick", sourceId: "mangadex" }]
        })

        const suggestions = await getSuggestions()

        expect(suggestions[0]!.community).toBe(true)
    })

    it("degrades to content-based when the community profile is disabled", async () => {
        await db.manga.put(ownedManga({ id: "m1", title: "Owned One", anilistId: 100 }))
        getRecommendations.mockResolvedValueOnce([{ anilistId: 999, title: "Fresh Pick" }])

        const suggestions = await getSuggestions()

        expect(suggestions[0]!.community).toBe(false)
    })
})

describe("suggestions:get - bughunt regressions", () => {
    it("shares one AniList fan-out across concurrent cold requests", async () => {
        await db.manga.put(ownedManga({ id: "m1", title: "Owned One", anilistId: 100, genres: ["Action"] }))
        getRecommendations.mockImplementation(
            () =>
                new Promise<RecCandidate[]>(resolve =>
                    setTimeout(() => resolve([{ anilistId: 999, title: "Fresh Pick", genres: ["Action"] }]), 20)
                )
        )

        const [a, b] = await Promise.all([getSuggestions(), getSuggestions()])

        expect(a.map(s => s.anilistId)).toEqual([999])
        expect(b.map(s => s.anilistId)).toEqual([999])
        expect(getRecommendations).toHaveBeenCalledTimes(1)
    })

    it("does not reject when the cache read throws (never-throw contract)", async () => {
        await db.manga.put(ownedManga({ id: "m1", title: "Owned One", anilistId: 100 }))
        vi.spyOn(console, "warn").mockImplementation(() => {})
        vi.spyOn(fakeBrowser.storage.local, "get").mockRejectedValueOnce(new Error("storage unavailable"))
        await expect(getSuggestions()).resolves.toEqual([])
    })

    it("returns freshly-computed suggestions even when the cache write fails", async () => {
        await db.manga.put(ownedManga({ id: "m1", title: "Owned One", anilistId: 100, genres: ["Action"] }))
        getRecommendations.mockResolvedValueOnce([{ anilistId: 999, title: "Fresh Pick", genres: ["Action"] }])
        vi.spyOn(console, "warn").mockImplementation(() => {})
        vi.spyOn(fakeBrowser.storage.local, "set").mockRejectedValueOnce(new Error("quota / io error"))

        const result = await getSuggestions()
        expect(result.map(s => s.anilistId)).toEqual([999])
    })

    it("force runs a fresh compute over the current library, not a stale in-flight revalidate", async () => {
        // A stale cache drives the non-force path into a background revalidate. That
        // revalidate captures a snapshot of the library BEFORE the new seed is added; a
        // force arriving while it is in flight must not reuse it, it must recompute over
        // the current library and surface the newly-added seed's recommendation.
        await db.manga.put(ownedManga({ id: "m1", title: "Seed A", anilistId: 100, lastReadAt: 2 }))
        await fakeBrowser.storage.local.set({
            suggestions: { suggestions: [], updatedAt: Date.now() - 7 * 60 * 60 * 1000 }
        })

        let signalFirstCall!: () => void
        const firstCalled = new Promise<void>(resolve => {
            signalFirstCall = resolve
        })
        // The parked revalidate's getRecommendations(100) never resolves, keeping that
        // compute in flight. Every later call resolves so the force compute can finish.
        getRecommendations.mockImplementationOnce(() => {
            signalFirstCall()
            return new Promise<RecCandidate[]>(() => {})
        })
        getRecommendations.mockImplementation(async anilistId =>
            anilistId === 200 ? [{ anilistId: 999, title: "Fresh Pick" }] : []
        )

        // Non-force: returns the stale cache instantly and starts the parked revalidate.
        const stale = await getSuggestions(false)
        expect(stale).toEqual([])
        await firstCalled

        // Library changes after the stale revalidate captured its snapshot.
        await db.manga.put(ownedManga({ id: "m2", title: "Seed B", anilistId: 200, lastReadAt: 3 }))

        const forced = await getSuggestions(true)
        expect(forced.map(s => s.anilistId)).toEqual([999])

        const stored = await fakeBrowser.storage.local.get("suggestions")
        const cache = stored["suggestions"] as { suggestions: Suggestion[] }
        expect(cache.suggestions.map(s => s.anilistId)).toEqual([999])
    })
})

describe("suggestions:get - genre fill", () => {
    it("backfills a thin pool with top-genre browse picks, excluding owned", async () => {
        await db.manga.put(ownedManga({ id: "m1", title: "Owned Action", anilistId: 100, genres: ["Action"] }))
        // Only one weak rec -> pool is under MIN_POOL, so genre-fill kicks in.
        getRecommendations.mockResolvedValue([{ anilistId: 999, title: "Rec Pick", genres: ["Action"] }])
        browseByGenre.mockResolvedValue([
            { anilistId: 100, title: "Owned Action", genres: ["Action"] }, // owned -> excluded
            { anilistId: 999, title: "Rec Pick", genres: ["Action"] }, // already scored -> excluded
            { anilistId: 555, title: "Genre Fill", genres: ["Action"], averageScore: 80 }
        ])

        const result = await getSuggestions()
        const ids = result.map(s => s.anilistId)

        expect(browseByGenre).toHaveBeenCalledWith("Action", expect.any(Number))
        expect(ids).toContain(555)
        expect(ids).toContain(999)
        expect(ids).not.toContain(100)
        // The real recommendation outranks the genre-fill pick.
        expect(ids.indexOf(999)).toBeLessThan(ids.indexOf(555))
    })

    it("does not browse when the pool is already large enough", async () => {
        await db.manga.put(ownedManga({ id: "m1", title: "Owned", anilistId: 100, genres: ["Action"] }))
        const many: RecCandidate[] = Array.from({ length: 30 }, (_, i) => ({
            anilistId: 1000 + i,
            title: `Rec ${i}`
        }))
        getRecommendations.mockResolvedValue(many)

        await getSuggestions()

        expect(browseByGenre).not.toHaveBeenCalled()
    })
})
