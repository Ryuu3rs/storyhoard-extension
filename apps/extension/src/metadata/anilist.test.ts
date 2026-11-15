import { describe, it, expect, vi, afterEach } from "vitest"
import { aniListQuery, anilistProvider, mapAniListMedia } from "./anilist"

describe("mapAniListMedia", () => {
    it("maps a full media object", () => {
        const result = mapAniListMedia({
            id: 30002,
            title: { romaji: "Berserk", english: "Berserk", native: "ベルセルク" },
            status: "RELEASING",
            format: "MANGA",
            genres: ["Action", "Horror", null],
            tags: [{ name: "Dark Fantasy" }, { name: null }, null],
            coverImage: { extraLarge: "https://img/xl.jpg", large: "https://img/l.jpg" }
        })
        expect(result).toEqual({
            anilistId: 30002,
            title: "Berserk",
            status: "ongoing",
            coverUrl: "https://img/xl.jpg",
            genres: ["Action", "Horror"],
            tags: ["Dark Fantasy"],
            isOneshot: false
        })
    })

    it("maps each AniList status to the publication enum", () => {
        const s = (status: string) => mapAniListMedia({ id: 1, status }).status
        expect(s("RELEASING")).toBe("ongoing")
        expect(s("FINISHED")).toBe("completed")
        expect(s("HIATUS")).toBe("hiatus")
        expect(s("CANCELLED")).toBe("cancelled")
        expect(s("NOT_YET_RELEASED")).toBe("unknown")
    })

    it("flags a ONE_SHOT format", () => {
        expect(mapAniListMedia({ id: 1, format: "ONE_SHOT" }).isOneshot).toBe(true)
    })

    it("falls back romaji -> native for the title and large -> nothing for cover", () => {
        const r = mapAniListMedia({
            id: 1,
            title: { romaji: "Solo Leveling" },
            coverImage: { large: "https://img/l.jpg" }
        })
        expect(r.title).toBe("Solo Leveling")
        expect(r.coverUrl).toBe("https://img/l.jpg")
    })
})

describe("anilistProvider.resolve", () => {
    afterEach(() => vi.unstubAllGlobals())

    it("returns mapped metadata for a search hit", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    data: { Media: { id: 105398, title: { english: "Chainsaw Man" }, status: "FINISHED" } }
                })
            })
        )
        const result = await anilistProvider.resolve({ title: "Chainsaw Man" })
        expect(result?.anilistId).toBe(105398)
        expect(result?.status).toBe("completed")
    })

    it("returns null on no match", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { Media: null } }) }))
        expect(await anilistProvider.resolve({ title: "nonexistent" })).toBeNull()
    })

    it("returns null on a network error", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))
        expect(await anilistProvider.resolve({ title: "x" })).toBeNull()
    })

    it("returns null on a non-ok response", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }))
        expect(await anilistProvider.resolve({ title: "x" })).toBeNull()
    })

    it("returns null for an empty title without calling fetch", async () => {
        const fetchMock = vi.fn()
        vi.stubGlobal("fetch", fetchMock)
        expect(await anilistProvider.resolve({ title: "   " })).toBeNull()
        expect(fetchMock).not.toHaveBeenCalled()
    })
})

describe("aniListQuery", () => {
    afterEach(() => vi.unstubAllGlobals())

    it("gives every request a timeout, and a request that times out does not stall the next one", async () => {
        const fetchMock = vi
            .fn()
            .mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"))
            .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { ok: 1 } }) })
        vi.stubGlobal("fetch", fetchMock)
        await expect(aniListQuery("query { a }", {})).rejects.toThrow()
        expect(await aniListQuery("query { b }", {})).toEqual({ ok: 1 })
        for (const call of fetchMock.mock.calls) expect((call[1] as RequestInit).signal).toBeInstanceOf(AbortSignal)
    })
})

describe("anilistProvider.resolveSearchTitles", () => {
    afterEach(() => vi.unstubAllGlobals())

    function stubMedia(media: unknown) {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { Media: media } }) }))
    }

    it("derives best-first Latin variants from english, romaji then synonyms, deduped", async () => {
        stubMedia({
            id: 105398,
            title: { english: "Solo Leveling", romaji: "Na Honjaman Level Up", native: "나 혼자만 레벨업" },
            synonyms: ["Only I Level Up", "solo leveling", "나 혼자만 레벨업", null]
        })
        // english first, then romaji, then the one new Latin synonym; the case-only
        // duplicate of the english title and the pure-Hangul synonym are dropped.
        expect(await anilistProvider.resolveSearchTitles!(105398)).toEqual([
            "Solo Leveling",
            "Na Honjaman Level Up",
            "Only I Level Up"
        ])
    })

    it("falls back to romaji when there is no english title", async () => {
        stubMedia({ id: 1, title: { romaji: "Kagurabachi", native: "カグラバチ" }, synonyms: [] })
        expect(await anilistProvider.resolveSearchTitles!(1)).toEqual(["Kagurabachi"])
    })

    it("returns [] on no match", async () => {
        stubMedia(null)
        expect(await anilistProvider.resolveSearchTitles!(999)).toEqual([])
    })

    it("returns [] on a network error", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))
        expect(await anilistProvider.resolveSearchTitles!(1)).toEqual([])
    })
})

describe("anilistProvider rate limiting", () => {
    afterEach(() => vi.unstubAllGlobals())

    it("serializes concurrent queries instead of firing them all at once", async () => {
        let inFlight = 0
        let maxInFlight = 0
        const fetchMock = vi.fn(async () => {
            inFlight += 1
            maxInFlight = Math.max(maxInFlight, inFlight)
            await Promise.resolve()
            inFlight -= 1
            return {
                ok: true,
                json: async () => ({ data: { Media: { id: 1, title: { english: "X" }, status: "FINISHED" } } })
            }
        })
        vi.stubGlobal("fetch", fetchMock)

        await Promise.all([
            anilistProvider.resolve({ title: "a" }),
            anilistProvider.resolve({ title: "b" }),
            anilistProvider.resolve({ title: "c" })
        ])

        expect(fetchMock).toHaveBeenCalledTimes(3)
        // The limiter chains every query, so no two fetches ever overlap; without it
        // all three would fire together and maxInFlight would be 3.
        expect(maxInFlight).toBe(1)
    })
})
