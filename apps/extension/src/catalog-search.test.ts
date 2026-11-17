import { describe, expect, it, vi } from "vitest"
import {
    fetchOfficialOffer,
    findWeebCover,
    mapAniListSearchMedia,
    parseCatalogTitle,
    searchCatalog,
    type CatalogSearchDeps
} from "./catalog-search"

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function deps(overrides: Partial<CatalogSearchDeps> = {}): CatalogSearchDeps {
    return {
        siteBase: "https://weeb.example",
        fetch: vi.fn(async () => jsonResponse({ results: [] })),
        aniList: vi.fn(async () => ({ Page: { media: [] } })),
        ...overrides
    }
}

const weebTitle = {
    workId: "w1",
    anilistId: 105398,
    title: "Solo Leveling",
    altTitles: ["Na Honjaman Level Up", "Solo Leveling"],
    cover: "https://s4.anilist.co/cover.jpg",
    mediaType: "manhwa",
    status: "finished",
    year: 2018,
    genres: ["Action"],
    isAdult: false,
    readers: 12
}

describe("parseCatalogTitle", () => {
    it("keeps a well-formed result and drops the title from its own other names", () => {
        expect(parseCatalogTitle(weebTitle)).toEqual({ ...weebTitle, altTitles: ["Na Honjaman Level Up"] })
    })

    it("drops an entry with no title, and refuses non-https covers and unknown enum values", () => {
        expect(parseCatalogTitle({ ...weebTitle, title: "  " })).toBeNull()
        const loose = parseCatalogTitle({
            ...weebTitle,
            cover: "http://x.example/c.jpg",
            mediaType: "comic",
            status: "done"
        })
        expect(loose).toMatchObject({ cover: null, mediaType: null, status: null })
    })
})

describe("mapAniListSearchMedia", () => {
    it("maps country and format onto the media type, and the English name onto the title", () => {
        const mapped = mapAniListSearchMedia({
            id: 1,
            title: { english: "Solo Leveling", romaji: "Na Honjaman Level Up", native: "나 혼자만 레벨업" },
            synonyms: ["Only I Level Up"],
            status: "FINISHED",
            format: "MANGA",
            countryOfOrigin: "KR",
            startDate: { year: 2018 },
            genres: ["Action", null],
            coverImage: { large: "https://s4.anilist.co/c.jpg" },
            isAdult: false
        })
        expect(mapped).toMatchObject({
            anilistId: 1,
            title: "Solo Leveling",
            altTitles: ["Na Honjaman Level Up", "나 혼자만 레벨업", "Only I Level Up"],
            mediaType: "manhwa",
            status: "finished",
            year: 2018,
            genres: ["Action"]
        })
        expect(mapAniListSearchMedia({ id: 2, format: "NOVEL", title: { romaji: "X" } })?.mediaType).toBe("novel")
        expect(mapAniListSearchMedia({ id: 3, countryOfOrigin: "CN", title: { romaji: "Y" } })?.mediaType).toBe(
            "manhua"
        )
    })
})

describe("fetchOfficialOffer", () => {
    it("returns the best offer's name and tracked link, and nothing for an unknown title or a bad link", async () => {
        const best = { name: "Tapas", format: "chapters", outUrl: "https://weeb.example/out/abc", store: "tapas" }
        const ok = {
            siteBase: "https://weeb.example",
            fetch: vi.fn(async (_url: string | URL | Request) => jsonResponse({ version: 1, best }))
        }
        expect(await fetchOfficialOffer(ok, 105398)).toEqual({ name: "Tapas", format: "chapters", outUrl: best.outUrl })
        expect(String(ok.fetch.mock.calls[0]![0])).toBe("https://weeb.example/api/work/105398/offers")

        const missing = {
            siteBase: "https://weeb.example",
            fetch: vi.fn(async () => jsonResponse({ error: "x" }, 404))
        }
        expect(await fetchOfficialOffer(missing, "w1")).toBeUndefined()

        const insecure = {
            siteBase: "https://weeb.example",
            fetch: vi.fn(async () => jsonResponse({ best: { ...best, outUrl: "javascript:alert(1)" } }))
        }
        expect(await fetchOfficialOffer(insecure, "w1")).toBeUndefined()
    })
})

describe("findWeebCover", () => {
    const site = (body: unknown, status = 200) => ({
        siteBase: "https://weeb.example",
        fetch: vi.fn(async (_url: string | URL | Request) => jsonResponse(body, status))
    })

    it("sends the title and AniList id and keeps a cover served by the site itself", async () => {
        const ok = site({ coverUrl: "https://weeb.example/api/cover?u=a&s=b", source: "mangaupdates" })
        expect(await findWeebCover(ok, { title: " Rare Webtoon ", anilistId: 4242 })).toBe(
            "https://weeb.example/api/cover?u=a&s=b"
        )
        expect(String(ok.fetch.mock.calls[0]![0])).toBe(
            "https://weeb.example/api/cover/find?title=Rare+Webtoon&anilistId=4242"
        )
        const relative = site({ coverUrl: "/api/cover?u=a&s=b" })
        expect(await findWeebCover(relative, { title: "X" })).toBe("https://weeb.example/api/cover?u=a&s=b")
    })

    it("refuses a cover on any other host, so nothing third party is fetched through it", async () => {
        for (const coverUrl of [
            "https://cdn.mangaupdates.com/image/x.jpg",
            "https://weeb.example.evil.io/c.jpg",
            "http://weeb.example/api/cover?u=a",
            "javascript:alert(1)"
        ]) {
            expect(await findWeebCover(site({ coverUrl }), { title: "X" }), coverUrl).toBeUndefined()
        }
    })

    it("answers nothing for no cover, an error, bad JSON, a blank title or a bogus AniList id", async () => {
        expect(await findWeebCover(site({ coverUrl: null, source: null }), { title: "X" })).toBeUndefined()
        expect(await findWeebCover(site({ error: "x" }, 429), { title: "X" })).toBeUndefined()
        const broken = { siteBase: "https://weeb.example", fetch: vi.fn(async () => new Response("<html>")) }
        expect(await findWeebCover(broken, { title: "X" })).toBeUndefined()
        const blank = site({ coverUrl: "https://weeb.example/c" })
        expect(await findWeebCover(blank, { title: "   " })).toBeUndefined()
        expect(blank.fetch).not.toHaveBeenCalled()
        const bogus = site({ coverUrl: null })
        await findWeebCover(bogus, { title: "X", anilistId: -1 })
        await findWeebCover(bogus, { title: "X", anilistId: 1.5 })
        for (const [url] of bogus.fetch.mock.calls) expect(String(url)).not.toContain("anilistId")
    })
})

describe("searchCatalog", () => {
    it("answers from the shared catalog when it has results, without asking AniList", async () => {
        const d = deps({ fetch: vi.fn(async () => jsonResponse({ results: [weebTitle] })) })
        const result = await searchCatalog(d, "  solo leveling ")
        expect(result.source).toBe("weeb")
        expect(result.results.map(r => r.title)).toEqual(["Solo Leveling"])
        expect(String(vi.mocked(d.fetch).mock.calls[0]![0])).toBe(
            "https://weeb.example/api/public/search?q=solo+leveling&limit=20&adult=0"
        )
        expect(d.aniList).not.toHaveBeenCalled()
    })

    it("falls back to AniList when the catalog is not there yet or fails", async () => {
        for (const failing of [
            vi.fn(async () => jsonResponse({ error: "not found" }, 404)),
            vi.fn(async () => {
                throw new TypeError("offline")
            }),
            vi.fn(async () => jsonResponse({ unexpected: true }))
        ]) {
            const d = deps({
                fetch: failing,
                aniList: vi.fn(async () => ({ Page: { media: [{ id: 7, title: { english: "Found On AniList" } }] } }))
            })
            const result = await searchCatalog(d, "found")
            expect(result).toMatchObject({ source: "anilist", results: [{ anilistId: 7, title: "Found On AniList" }] })
        }
    })

    it("never returns adult titles, from either source", async () => {
        const fromWeeb = await searchCatalog(
            deps({ fetch: vi.fn(async () => jsonResponse({ results: [{ ...weebTitle, isAdult: true }] })) }),
            "anything"
        )
        expect(fromWeeb.results).toEqual([])

        const d = deps({
            fetch: vi.fn(async () => jsonResponse({ error: "down" }, 503)),
            aniList: vi.fn(async () => ({
                Page: {
                    media: [
                        { id: 9, title: { english: "Adult" }, isAdult: true },
                        { id: 10, title: { english: "Fine" } }
                    ]
                }
            }))
        })
        const result = await searchCatalog(d, "anything")
        expect(result.results.map(r => r.title)).toEqual(["Fine"])
        expect(vi.mocked(d.aniList).mock.calls[0]![1]).toMatchObject({ adult: false })
    })

    it("takes an empty answer from the shared catalog as final (it already asked AniList)", async () => {
        const d = deps({ fetch: vi.fn(async () => jsonResponse({ results: [], source: "catalog+anilist" })) })
        expect(await searchCatalog(d, "nothing like this")).toEqual({ results: [], source: "weeb" })
        expect(d.aniList).not.toHaveBeenCalled()
    })

    it("says unavailable, not 'no match', when neither service answers", async () => {
        const down = vi.fn(async () => {
            throw new TypeError("Failed to fetch")
        })
        for (const aniList of [
            vi.fn(async () => null),
            vi.fn(async () => {
                throw new Error("timeout")
            })
        ]) {
            expect(await searchCatalog(deps({ fetch: down, aniList }), "solo")).toEqual({
                results: [],
                source: "none",
                unavailable: true
            })
        }
    })

    it("does nothing for an empty term", async () => {
        const d = deps()
        expect(await searchCatalog(d, "   ")).toEqual({ results: [], source: "weeb" })
        expect(d.fetch).not.toHaveBeenCalled()
    })
})

describe("hostile catalog numbers", () => {
    it("drops a non-finite reader count and badly typed AniList ids and years", () => {
        expect(parseCatalogTitle({ ...weebTitle, readers: Number.POSITIVE_INFINITY })?.readers).toBe(0)
        const media = { id: 7, title: { english: "Seven" }, startDate: { year: "2020" } }
        expect(mapAniListSearchMedia(media as never)?.year).toBeNull()
        expect(mapAniListSearchMedia({ ...media, id: "7" } as never)).toBeNull()
    })
})

describe("weeb.ltd lookups carry no cookies", () => {
    it("search, offers and cover find all omit credentials, so none can be tied to a signed-in session", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ results: [] }))
        const d = deps({ fetch })
        await searchCatalog(d, "solo")
        await fetchOfficialOffer(d, 105398)
        await findWeebCover(d, { title: "Solo Leveling", anilistId: 105398 })
        expect(fetch).toHaveBeenCalledTimes(3)
        for (const [, init] of fetch.mock.calls) expect(init?.credentials).toBe("omit")
    })
})
