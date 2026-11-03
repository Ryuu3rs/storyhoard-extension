import {
    createBoundedRequestClient,
    SourceChallengeError,
    type FetchFunction,
    type SourceContext
} from "@amr/source-sdk"
import { describe, expect, it } from "vitest"
import {
    API_ORIGIN,
    CHAPTER_ID,
    CHAPTER_URL,
    cloudflareChallengeHtml,
    COVER_URL,
    INTEGRITY_PATH,
    integrityResponseJson,
    MANIFEST_API_PATH,
    manifestResponseJson,
    ORIGIN,
    OTHER_CHAPTER_ID,
    PAGE_URLS,
    SEARCH_API_PATH,
    searchResponseJson,
    searchResponseNoLatestChaptersJson,
    SERIES_API_PATH,
    SERIES_ID,
    SERIES_URL,
    seriesDetailJson,
    seriesPageHtml
} from "./__fixtures__/kagane"
import { kaganeAdapter as adapter } from "./kagane"

function createContext(fixtures: Readonly<Record<string, string>>, requests: string[] = []): SourceContext {
    const fetch: FetchFunction = async (url, init) => {
        const parsed = new URL(url)
        requests.push(`${init.method} ${parsed.pathname}`)
        const body = fixtures[parsed.pathname]
        return {
            ok: body !== undefined,
            status: body === undefined ? 404 : 200,
            text: async () => body ?? ""
        }
    }
    return {
        request: createBoundedRequestClient({
            fetch,
            allowedOrigins: [ORIGIN, API_ORIGIN],
            maxRequests: 20,
            maxResponseBytes: 5_000_000,
            timeoutMs: 1000
        }),
        now: () => 1_700_000_000_000,
        logger: { debug: () => undefined, warn: () => undefined }
    }
}

function makeMangaStub(sourceMangaId: string) {
    return {
        manga: {
            id: `kagane:manga:${sourceMangaId}`,
            title: "Test",
            normalizedTitle: "test",
            authors: [],
            status: "unknown" as const,
            addedAt: 0,
            updatedAt: 0
        },
        sourceId: "kagane",
        sourceMangaId,
        url: SERIES_URL
    }
}

describe("kaganeAdapter.match", () => {
    it("classifies series and reader URLs", () => {
        expect(adapter.match(new URL(SERIES_URL))).toBe("manga")
        expect(adapter.match(new URL(CHAPTER_URL))).toBe("chapter")
        expect(adapter.match(new URL("https://kagane.to/search"))).toBe("none")
        expect(adapter.match(new URL(`https://not-kagane.to/series/${SERIES_ID}`))).toBe("none")
    })
})

describe("kaganeAdapter.resolveManga", () => {
    it("fetches series metadata from the (non-gated) API host", async () => {
        const context = createContext({ [SERIES_API_PATH]: seriesDetailJson })
        const manga = await adapter.resolveManga({ url: new URL(SERIES_URL) }, context)
        expect(manga.sourceMangaId).toBe(SERIES_ID)
        expect(manga.manga.title).toBe("The Glutton: Devourer of Kings")
        expect(manga.manga.status).toBe("ongoing")
        expect(manga.manga.coverUrl).toBe(COVER_URL)
    })

    it("accepts a bare sourceMangaId", async () => {
        const context = createContext({ [SERIES_API_PATH]: seriesDetailJson })
        const manga = await adapter.resolveManga({ sourceMangaId: SERIES_ID }, context)
        expect(manga.sourceMangaId).toBe(SERIES_ID)
    })
})

describe("kaganeAdapter.listChapters", () => {
    it("parses the full chapter list from the series page's embedded RSC data", async () => {
        const context = createContext({ [`/series/${SERIES_ID}`]: seriesPageHtml })
        const chapters = await adapter.listChapters({ manga: makeMangaStub(SERIES_ID) }, context)

        expect(chapters).toHaveLength(2)
        expect(chapters[0]!.sortKey).toBe(1)
        expect(chapters[0]!.sourceChapterId).toBe(OTHER_CHAPTER_ID)
        expect(chapters[1]!.sortKey).toBe(21)
        expect(chapters[1]!.title).toBe("Ch. 21")
        expect(chapters[1]!.chapterNumber).toBe(21)
        expect(chapters[1]!.url).toBe(CHAPTER_URL)
    })

    it("reports a challenge, not an empty list, when the series page is Cloudflare's challenge page", async () => {
        const context = createContext({ [`/series/${SERIES_ID}`]: cloudflareChallengeHtml })
        await expect(adapter.listChapters({ manga: makeMangaStub(SERIES_ID) }, context)).rejects.toBeInstanceOf(
            SourceChallengeError
        )
    })

    // Regression test for the reconcile-search bug: a real background-context
    // fetch to the (gated) series page doesn't come back 200-with-challenge-html
    // like the fixture mock above defaults to - it comes back a bare 403 (verified
    // live against kagane.to). listChapters() now lets that SourceRequestError
    // propagate instead of swallowing it, so library:switch's isBotBlocked()
    // check can detect the Cloudflare block and trigger a tab-render fallback
    // rather than the mirror being reported as having no chapters at all.
    it("rejects with a SourceRequestError(status: 403) when the series page fetch itself is rejected with 403", async () => {
        const fetch: FetchFunction = async () => ({
            ok: false,
            status: 403,
            text: async () => "<html>cf challenge</html>"
        })
        const context: SourceContext = {
            request: createBoundedRequestClient({
                fetch,
                allowedOrigins: [ORIGIN, API_ORIGIN],
                maxRequests: 20,
                maxResponseBytes: 5_000_000,
                timeoutMs: 1000,
                maxRetries: 0
            }),
            now: () => 1_700_000_000_000,
            logger: { debug: () => undefined, warn: () => undefined }
        }
        await expect(adapter.listChapters({ manga: makeMangaStub(SERIES_ID) }, context)).rejects.toMatchObject({
            status: 403
        })
    })
})

describe("kaganeAdapter.resolveCover", () => {
    it("builds the cover URL from the series' first cover image id", async () => {
        const context = createContext({ [SERIES_API_PATH]: seriesDetailJson })
        const cover = await adapter.resolveCover!({ sourceMangaId: SERIES_ID }, context)
        expect(cover).toBe(COVER_URL)
    })

    it("returns undefined on failure instead of throwing", async () => {
        const context = createContext({})
        const cover = await adapter.resolveCover!({ sourceMangaId: SERIES_ID }, context)
        expect(cover).toBeUndefined()
    })
})

describe("kaganeAdapter.resolveGenres", () => {
    it("returns genre names", async () => {
        const context = createContext({ [SERIES_API_PATH]: seriesDetailJson })
        const genres = await adapter.resolveGenres!({ sourceMangaId: SERIES_ID }, context)
        expect(genres).toEqual(["Drama", "Fantasy"])
    })
})

describe("kaganeAdapter.search", () => {
    it("maps search results", async () => {
        const context = createContext({ [SEARCH_API_PATH]: searchResponseJson })
        const results = await adapter.search!("glutton", context)
        expect(results).toHaveLength(1)
        expect(results[0]!.sourceMangaId).toBe(SERIES_ID)
        expect(results[0]!.coverUrl).toBe(COVER_URL)
        expect(results[0]!.latestChapter).toBe("21")
        expect(results[0]!.altTitles).toEqual(["Baoshi Zhe", "The Glutton"])
    })

    it("falls back to current_books for latestChapter when latest_chapters is empty", async () => {
        const context = createContext({ [SEARCH_API_PATH]: searchResponseNoLatestChaptersJson })
        const results = await adapter.search!("glutton", context)
        expect(results).toHaveLength(1)
        expect(results[0]!.latestChapter).toBe("36")
    })

    it("returns [] for a blank query without making a request", async () => {
        const requests: string[] = []
        const context = createContext({}, requests)
        const results = await adapter.search!("   ", context)
        expect(results).toEqual([])
        expect(requests).toEqual([])
    })
})

describe("kaganeAdapter.parseMangaUrl", () => {
    it("derives the series id and URL from a chapter URL", () => {
        expect(adapter.parseMangaUrl!(new URL(CHAPTER_URL))).toEqual({
            sourceMangaId: SERIES_ID,
            mangaUrl: SERIES_URL
        })
    })

    it("returns null for a series URL (not a chapter URL)", () => {
        expect(adapter.parseMangaUrl!(new URL(SERIES_URL))).toBeNull()
    })
})

describe("kaganeAdapter.resolveChapter", () => {
    it("resolves manga, chapter, and page URLs via the integrity + manifest handshake", async () => {
        const context = createContext({
            [SERIES_API_PATH]: seriesDetailJson,
            [`/series/${SERIES_ID}`]: seriesPageHtml,
            [INTEGRITY_PATH]: integrityResponseJson,
            [MANIFEST_API_PATH]: manifestResponseJson
        })

        const result = await adapter.resolveChapter({ url: new URL(CHAPTER_URL) }, context)

        expect(result.manga.sourceMangaId).toBe(SERIES_ID)
        expect(result.chapter.sourceChapterId).toBe(CHAPTER_ID)
        expect(result.chapter.title).toBe("Ch. 21")
        expect(result.chapter.sortKey).toBe(21)
        expect(result.pages.map(p => p.url)).toEqual(PAGE_URLS)
        expect(result.pages[0]!.id).toBe(`kagane:chapter:${CHAPTER_ID}:page:1`)
    })

    it("propagates a blocked integrity fetch as a request error (Cloudflare-blocked)", async () => {
        const context = createContext({
            [SERIES_API_PATH]: seriesDetailJson,
            [`/series/${SERIES_ID}`]: seriesPageHtml
            // INTEGRITY_PATH deliberately missing -> the fixture fetch returns 404,
            // mirroring the 403 Cloudflare returns to a background-context fetch.
        })

        await expect(adapter.resolveChapter({ url: new URL(CHAPTER_URL) }, context)).rejects.toThrow()
    })

    it("rejects a chapter URL from a foreign domain", async () => {
        const context = createContext({})
        await expect(
            adapter.resolveChapter({ url: new URL("https://example.com/series/x/reader/y") }, context)
        ).rejects.toThrow()
    })

    // Regression test: when fetchChapterListSafe can't find this chapter in the scraped
    // list (series page fetch failed, or the chapter just isn't in it yet) while the
    // integrity/manifest handshake still succeeds, resolveChapter falls back to a stub
    // chapter record. That stub must not sort before every real chapter (the dynasty-scans
    // bug class, fixed here the same way): sortKey should be +Infinity, not 0.
    it("falls back to a stub chapter with sortKey Infinity when the chapter is missing from the list", async () => {
        const context = createContext({
            [SERIES_API_PATH]: seriesDetailJson,
            // [`/series/${SERIES_ID}`] deliberately omitted -> fetchChapterListSafe's
            // getText call fails and it returns [], so chapterList.find comes up empty.
            [INTEGRITY_PATH]: integrityResponseJson,
            [MANIFEST_API_PATH]: manifestResponseJson
        })

        const result = await adapter.resolveChapter({ url: new URL(CHAPTER_URL) }, context)

        expect(result.chapter.sourceChapterId).toBe(CHAPTER_ID)
        expect(result.chapter.sortKey).toBe(Number.POSITIVE_INFINITY)
        expect(result.pages.map(p => p.url)).toEqual(PAGE_URLS)
    })
})
