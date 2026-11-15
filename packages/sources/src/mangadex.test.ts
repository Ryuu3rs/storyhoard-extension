import { createBoundedRequestClient, type FetchFunction, type SourceContext } from "@amr/source-sdk"
import { describe, expect, it } from "vitest"
import {
    atHomeFixture,
    CHAPTER_ID,
    chapterFeedFixture,
    chapterFixture,
    MANGA_ID,
    mangaFixture
} from "./__fixtures__/mangadex"
import { mangadexAdapter } from "./mangadex"

function createContext(fixtures: Readonly<Record<string, unknown>>, requests: string[]): SourceContext {
    const fetch: FetchFunction = async url => {
        requests.push(url)
        const parsed = new URL(url)
        const fixture = fixtures[parsed.pathname]
        return {
            ok: fixture !== undefined,
            status: fixture === undefined ? 404 : 200,
            text: async () => JSON.stringify(fixture ?? { result: "error" })
        }
    }

    return {
        request: createBoundedRequestClient({
            fetch,
            allowedOrigins: ["https://api.mangadex.org"],
            maxRequests: 10,
            maxResponseBytes: 100_000,
            timeoutMs: 1000
        }),
        now: () => 1_700_000_000_000,
        logger: {
            debug: () => undefined,
            warn: () => undefined
        }
    }
}

describe("mangadexAdapter.match", () => {
    it("matches manga and chapter URLs without accepting lookalikes", () => {
        expect(mangadexAdapter.match(new URL(`https://mangadex.org/title/${MANGA_ID}/test-manga`))).toBe("manga")
        expect(mangadexAdapter.match(new URL(`https://www.mangadex.org/chapter/${CHAPTER_ID}`))).toBe("chapter")
        expect(mangadexAdapter.match(new URL(`https://fake-mangadex.org/title/${MANGA_ID}`))).toBe("none")
        expect(mangadexAdapter.match(new URL("https://mangadex.org/title/not-a-uuid"))).toBe("none")
    })
})

describe("mangadexAdapter", () => {
    it("resolves manga metadata with deterministic IDs", async () => {
        const requests: string[] = []
        const context = createContext({ [`/manga/${MANGA_ID}`]: mangaFixture }, requests)

        const result = await mangadexAdapter.resolveManga(
            { url: new URL(`https://mangadex.org/title/${MANGA_ID}/test-manga`) },
            context
        )

        expect(result).toEqual({
            manga: {
                id: `mangadex:manga:${MANGA_ID}`,
                title: "Test Manga",
                normalizedTitle: "test manga",
                coverUrl: `https://uploads.mangadex.org/covers/${MANGA_ID}/cover.jpg.256.jpg`,
                authors: [],
                status: "ongoing",
                addedAt: Date.parse("2024-01-02T03:04:05+00:00"),
                updatedAt: Date.parse("2025-02-03T04:05:06+00:00")
            },
            sourceId: "mangadex",
            sourceMangaId: MANGA_ID,
            url: `https://mangadex.org/title/${MANGA_ID}`
        })
        expect(requests[0]).toContain("includes%5B%5D=cover_art")
    })

    it("lists validated chapters with language filters", async () => {
        const requests: string[] = []
        const context = createContext({ [`/manga/${MANGA_ID}/feed`]: chapterFeedFixture }, requests)
        const manga = {
            manga: {
                id: `mangadex:manga:${MANGA_ID}`,
                title: "Test Manga",
                normalizedTitle: "test manga",
                authors: [],
                status: "unknown" as const,
                addedAt: 0,
                updatedAt: 0
            },
            sourceId: "mangadex",
            sourceMangaId: MANGA_ID,
            url: `https://mangadex.org/title/${MANGA_ID}`
        }

        const chapters = await mangadexAdapter.listChapters({ manga, languages: ["en"] }, context)

        expect(chapters).toHaveLength(2)
        expect(chapters[0]).toMatchObject({
            id: `mangadex:chapter:${CHAPTER_ID}`,
            mangaId: `mangadex:manga:${MANGA_ID}`,
            title: "Chapter 1: Arrival",
            sortKey: 1,
            language: "en",
            publishedAt: Date.parse("2025-01-01T00:00:00+00:00")
        })
        expect(chapters[1]?.sortKey).toBe(2.5)
        expect(chapters[1]?.publishedAt).toBe(Date.parse("2025-01-02T00:00:00+00:00"))
        expect(requests[0]).toContain("translatedLanguage%5B%5D=en")
    })

    it("keeps the NEWEST chapters when a series exceeds MAX_CHAPTERS", async () => {
        const TOTAL = 600
        const requests: string[] = []
        // Faithful oldest-first feed: offset N yields chapters N+1..N+limit (the real
        // API's order[chapter]=asc). The adapter must page from the tail to keep 101..600.
        const fetch: FetchFunction = async url => {
            requests.push(url)
            const parsed = new URL(url)
            const offset = Number(parsed.searchParams.get("offset") ?? "0")
            const limit = Number(parsed.searchParams.get("limit") ?? "100")
            const data = []
            for (let n = offset + 1; n <= Math.min(offset + limit, TOTAL); n++) {
                data.push({
                    id: `chapter-${n}`,
                    type: "chapter",
                    attributes: { chapter: String(n), title: null, translatedLanguage: "en" }
                })
            }
            const body = { result: "ok", data, limit, offset, total: TOTAL }
            return { ok: true, status: 200, text: async () => JSON.stringify(body) }
        }
        const context: SourceContext = {
            request: createBoundedRequestClient({
                fetch,
                allowedOrigins: ["https://api.mangadex.org"],
                maxRequests: 20,
                maxResponseBytes: 1_000_000,
                timeoutMs: 1000
            }),
            now: () => 1_700_000_000_000,
            logger: { debug: () => undefined, warn: () => undefined }
        }
        const manga = {
            manga: {
                id: `mangadex:manga:${MANGA_ID}`,
                title: "Long Series",
                normalizedTitle: "long series",
                authors: [],
                status: "ongoing" as const,
                addedAt: 0,
                updatedAt: 0
            },
            sourceId: "mangadex",
            sourceMangaId: MANGA_ID,
            url: `https://mangadex.org/title/${MANGA_ID}`
        }

        const chapters = await mangadexAdapter.listChapters({ manga, languages: ["en"] }, context)

        // The 500 NEWEST chapters (101..600), returned in ascending sortKey order.
        expect(chapters).toHaveLength(500)
        expect(chapters[0]?.sortKey).toBe(101)
        expect(chapters[chapters.length - 1]?.sortKey).toBe(600)
        expect(chapters.some(c => c.sortKey === 600)).toBe(true)
        expect(chapters.some(c => c.sortKey === 1)).toBe(false)
    })

    it("collapses duplicate chapter numbers to one row, preferring language then newest", async () => {
        const data = [
            {
                id: "c1-pt",
                type: "chapter",
                attributes: {
                    chapter: "1",
                    title: null,
                    translatedLanguage: "pt-br",
                    readableAt: "2024-02-01T00:00:00Z"
                }
            },
            {
                id: "c1-en",
                type: "chapter",
                attributes: { chapter: "1", title: null, translatedLanguage: "en", readableAt: "2024-01-01T00:00:00Z" }
            },
            {
                id: "c2-en-old",
                type: "chapter",
                attributes: { chapter: "2", title: null, translatedLanguage: "en", readableAt: "2024-01-01T00:00:00Z" }
            },
            {
                id: "c2-en-new",
                type: "chapter",
                attributes: { chapter: "2", title: null, translatedLanguage: "en", readableAt: "2024-03-01T00:00:00Z" }
            }
        ]
        // The mock ignores the language filter and returns every upload, so the adapter's
        // own dedup (not the feed query) is what must collapse them.
        const fetch: FetchFunction = async url => {
            const parsed = new URL(url)
            const offset = Number(parsed.searchParams.get("offset") ?? "0")
            const body = {
                result: "ok",
                data: offset === 0 ? data : [],
                limit: 100,
                offset,
                total: data.length
            }
            return { ok: true, status: 200, text: async () => JSON.stringify(body) }
        }
        const context: SourceContext = {
            request: createBoundedRequestClient({
                fetch,
                allowedOrigins: ["https://api.mangadex.org"],
                maxRequests: 20,
                maxResponseBytes: 1_000_000,
                timeoutMs: 1000
            }),
            now: () => 1_700_000_000_000,
            logger: { debug: () => undefined, warn: () => undefined }
        }
        const manga = {
            manga: {
                id: `mangadex:manga:${MANGA_ID}`,
                title: "Dup Series",
                normalizedTitle: "dup series",
                authors: [],
                status: "ongoing" as const,
                addedAt: 0,
                updatedAt: 0
            },
            sourceId: "mangadex",
            sourceMangaId: MANGA_ID,
            url: `https://mangadex.org/title/${MANGA_ID}`
        }

        const chapters = await mangadexAdapter.listChapters({ manga, languages: ["en"] }, context)

        expect(chapters).toHaveLength(2)
        // Preferred language (en) wins over a newer pt-br upload of the same number.
        expect(chapters.find(c => c.sortKey === 1)?.id).toBe("mangadex:chapter:c1-en")
        // Same language: the most recently readable upload wins.
        expect(chapters.find(c => c.sortKey === 2)?.id).toBe("mangadex:chapter:c2-en-new")
    })

    it("resolves chapter pages from the at-home manifest", async () => {
        const requests: string[] = []
        const context = createContext(
            {
                [`/chapter/${CHAPTER_ID}`]: chapterFixture,
                [`/manga/${MANGA_ID}`]: mangaFixture,
                [`/at-home/server/${CHAPTER_ID}`]: atHomeFixture
            },
            requests
        )

        const result = await mangadexAdapter.resolveChapter({ sourceChapterId: CHAPTER_ID }, context)

        expect(result.chapter.id).toBe(`mangadex:chapter:${CHAPTER_ID}`)
        expect(result.manga.sourceMangaId).toBe(MANGA_ID)
        expect(result.pages).toEqual([
            {
                id: `mangadex:chapter:${CHAPTER_ID}:page:1`,
                url: "https://uploads.example.test/data/chapter-hash/001.jpg"
            },
            {
                id: `mangadex:chapter:${CHAPTER_ID}:page:2`,
                url: "https://uploads.example.test/data/chapter-hash/002%20image.jpg"
            }
        ])
        expect(requests).toHaveLength(3)
    })

    it("searches and surfaces the latest chapter", async () => {
        const searchFixture = {
            result: "ok",
            data: [
                {
                    id: MANGA_ID,
                    type: "manga",
                    attributes: {
                        title: { en: "Test Manga" },
                        altTitles: [],
                        status: "ongoing",
                        lastChapter: "152",
                        createdAt: "2024-01-02T03:04:05+00:00",
                        updatedAt: "2025-02-03T04:05:06+00:00"
                    },
                    relationships: [{ id: "c", type: "cover_art", attributes: { fileName: "cover.jpg" } }]
                }
            ]
        }
        const requests: string[] = []
        const context = createContext({ "/manga": searchFixture }, requests)

        const results = await mangadexAdapter.search!("test", context)
        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({
            sourceId: "mangadex",
            sourceMangaId: MANGA_ID,
            title: "Test Manga",
            latestChapter: "152"
        })
        expect(requests[0]).toContain("title=test")
    })

    it("surfaces alt titles from search results as a flat string array", async () => {
        const searchFixture = {
            result: "ok",
            data: [
                {
                    id: MANGA_ID,
                    type: "manga",
                    attributes: {
                        title: { en: "Test Manga" },
                        altTitles: [
                            { ja: "テストマンガ" },
                            { "ja-ro": "Tesuto Manga" },
                            { en: "" },
                            { fr: "Tesuto Manga" }
                        ],
                        status: "ongoing",
                        lastChapter: "152",
                        createdAt: "2024-01-02T03:04:05+00:00",
                        updatedAt: "2025-02-03T04:05:06+00:00"
                    },
                    relationships: [{ id: "c", type: "cover_art", attributes: { fileName: "cover.jpg" } }]
                }
            ]
        }
        const requests: string[] = []
        const context = createContext({ "/manga": searchFixture }, requests)

        const results = await mangadexAdapter.search!("test", context)

        expect(results).toHaveLength(1)
        expect(results[0]?.altTitles).toEqual(["テストマンガ", "Tesuto Manga"])
    })

    it("omits altTitles entirely when the source has none", async () => {
        const searchFixture = {
            result: "ok",
            data: [
                {
                    id: MANGA_ID,
                    type: "manga",
                    attributes: {
                        title: { en: "Test Manga" },
                        altTitles: [],
                        status: "ongoing",
                        createdAt: "2024-01-02T03:04:05+00:00",
                        updatedAt: "2025-02-03T04:05:06+00:00"
                    },
                    relationships: []
                }
            ]
        }
        const context = createContext({ "/manga": searchFixture }, [])

        const results = await mangadexAdapter.search!("test", context)

        expect(results[0]).not.toHaveProperty("altTitles")
    })

    it("rejects malformed API responses", async () => {
        const context = createContext(
            {
                [`/manga/${MANGA_ID}`]: {
                    ...mangaFixture,
                    data: { ...mangaFixture.data, attributes: { title: {} } }
                }
            },
            []
        )

        await expect(mangadexAdapter.resolveManga({ sourceMangaId: MANGA_ID }, context)).rejects.toMatchObject({
            code: "invalid-response"
        })
    })
})
