import { createBoundedRequestClient, type FetchFunction, type SourceContext } from "@amr/source-sdk"
import { describe, expect, it } from "vitest"
import {
    CHAPTER_HIGH_SLUGNUM_PATH,
    CHAPTER_HIGH_SLUGNUM_URL,
    CHAPTER_LIST_PATH,
    CHAPTER_LIST_SLUG,
    CHAPTER_LIST_URL,
    CHAPTER_LOW_SLUGNUM_PATH,
    CHAPTER_LOW_SLUGNUM_URL,
    CHAPTER_PATH,
    CHAPTER_URL,
    chapterListHtml,
    chapterListHtmlSwappedOrder,
    chapterListNoRealAnchorsHtml,
    chapterPageHtml,
    chapterPageNoTitleNumberHtml,
    chapterPageRedirectedHtml,
    COVER_PATH,
    COVER_SLUG,
    COVER_URL,
    EMPTY_REAL_CHAPTER_LIST_PATH,
    EMPTY_REAL_CHAPTER_LIST_SLUG,
    EMPTY_REAL_CHAPTER_LIST_URL,
    FOREIGN_SLUG,
    mangaDetailHtml,
    SEARCH_DECOY_SLUG,
    SEARCH_PATH_PAGE_1,
    SEARCH_PATH_PAGE_2,
    SEARCH_PATH_PAGE_3,
    SEARCH_QUERY,
    searchDecoyChapterNumberHtml,
    searchEmptyHtml,
    searchPage1Html,
    searchPage2Html,
    SHORT_REAL_CHAPTER_LIST_PATH,
    SHORT_REAL_CHAPTER_LIST_SLUG,
    SHORT_REAL_CHAPTER_LIST_URL,
    shortRealChapterListHtml
} from "./__fixtures__/mangahub"
import { mangahubAdapter } from "./mangahub"

function makeMangaStub(sourceMangaId: string, url: string) {
    return {
        manga: {
            id: `mangahub:manga:${sourceMangaId}`,
            title: "Test",
            normalizedTitle: "test",
            authors: [],
            status: "unknown" as const,
            addedAt: 0,
            updatedAt: 0
        },
        sourceId: "mangahub",
        sourceMangaId,
        url
    }
}

function createContext(fixtures: Readonly<Record<string, string>>, requests: string[]): SourceContext {
    const fetch: FetchFunction = async (url, init) => {
        requests.push(`${init.method} ${url}`)
        const parsed = new URL(url)
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
            allowedOrigins: ["https://mangahub.io"],
            maxRequests: 10,
            maxResponseBytes: 1_000_000,
            timeoutMs: 1000
        }),
        now: () => 1_700_000_000_000,
        logger: { debug: () => undefined, warn: () => undefined }
    }
}

describe("mangahubAdapter.parseMangaUrl", () => {
    it("maps a chapter URL to the manga slug instead of the literal 'chapter' path segment", () => {
        const r = mangahubAdapter.parseMangaUrl!(new URL("https://mangahub.io/chapter/solo-leveling_105/chapter-42"))
        // Must NOT be "chapter" (the first path segment) - that produced mangahub:manga:chapter.
        expect(r).toEqual({ sourceMangaId: "solo-leveling", mangaUrl: "https://mangahub.io/manga/solo-leveling" })
    })

    it("keeps a chapter slug with no _<n> suffix as-is", () => {
        const r = mangahubAdapter.parseMangaUrl!(new URL("https://mangahub.io/chapter/one-piece/chapter-1100"))
        expect(r).toEqual({ sourceMangaId: "one-piece", mangaUrl: "https://mangahub.io/manga/one-piece" })
    })

    it("maps a manga URL directly", () => {
        const r = mangahubAdapter.parseMangaUrl!(new URL("https://mangahub.io/manga/berserk"))
        expect(r).toEqual({ sourceMangaId: "berserk", mangaUrl: "https://mangahub.io/manga/berserk" })
    })

    it("returns null for a non-mangahub or unrecognised URL", () => {
        expect(mangahubAdapter.parseMangaUrl!(new URL("https://example.com/chapter/x/chapter-1"))).toBeNull()
        expect(mangahubAdapter.parseMangaUrl!(new URL("https://mangahub.io/search/page/1"))).toBeNull()
    })
})

describe("mangahubAdapter.search", () => {
    it("fetches pages in order, dedupes across pages, and stops once a page is empty", async () => {
        const requests: string[] = []
        const context = createContext(
            {
                [SEARCH_PATH_PAGE_1]: searchPage1Html,
                [SEARCH_PATH_PAGE_2]: searchPage2Html,
                [SEARCH_PATH_PAGE_3]: searchEmptyHtml
            },
            requests
        )

        const results = await mangahubAdapter.search!(SEARCH_QUERY, context)

        // 2 unique results from page 1 + 1 new from page 2 (its repeat of
        // solo-leveling_105 is dropped by cross-page dedupe).
        expect(results.map(r => r.sourceMangaId)).toEqual([
            "solo-leveling_105",
            "solo-slime-s-ascension",
            "solo-max-level-newbie"
        ])

        // Trailing "Popular Manga Updates" slider markup after the last card
        // on page 1 must not leak into a result.
        expect(results.some(r => r.sourceMangaId === "unrelated-slider-item")).toBe(false)

        expect(results[0]).toMatchObject({
            sourceId: "mangahub",
            title: "Solo Leveling",
            url: "https://mangahub.io/manga/solo-leveling_105",
            coverUrl: "https://thumb.mghcdn.com/mh/solo-leveling.jpg",
            latestChapter: "200.5"
        })
        // Hex-entity decoding (&#x27;) in the heading text.
        expect(results[1]!.title).toBe("Solo Slime's Ascension")

        // All three pages are requested (page 3 comes back empty, ending the loop).
        expect(requests).toHaveLength(3)
        for (const [i, path] of [SEARCH_PATH_PAGE_1, SEARCH_PATH_PAGE_2, SEARCH_PATH_PAGE_3].entries()) {
            const url = new URL(requests[i]!.replace("GET ", ""))
            expect(url.pathname).toBe(path)
            expect(url.searchParams.get("q")).toBe(SEARCH_QUERY)
            expect(url.searchParams.get("order")).toBe("POPULAR")
            expect(url.searchParams.get("genre")).toBe("all")
        }
    })

    it("stops after the first page when it returns zero results", async () => {
        const requests: string[] = []
        const context = createContext({ [SEARCH_PATH_PAGE_1]: searchEmptyHtml }, requests)

        const results = await mangahubAdapter.search!("zzzznonexistentquery9999", context)

        expect(results).toHaveLength(0)
        expect(requests).toHaveLength(1)
    })

    it("returns empty array for a blank query without making requests", async () => {
        const requests: string[] = []
        const context = createContext({}, requests)

        const results = await mangahubAdapter.search!("   ", context)

        expect(results).toHaveLength(0)
        expect(requests).toHaveLength(0)
    })

    it("takes latestChapter from the chapter-link anchor, not a coincidental chapter-N elsewhere in the card", async () => {
        const requests: string[] = []
        const context = createContext(
            { [SEARCH_PATH_PAGE_1]: searchDecoyChapterNumberHtml, [SEARCH_PATH_PAGE_2]: searchEmptyHtml },
            requests
        )

        const results = await mangahubAdapter.search!("decoy", context)

        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({ sourceMangaId: SEARCH_DECOY_SLUG, latestChapter: "52" })
    })
})

describe("mangahubAdapter.listChapters", () => {
    it("dedupes canonical + id-slug anchors by true chapter number and excludes foreign slider anchors", async () => {
        const requests: string[] = []
        const context = createContext({ [CHAPTER_LIST_PATH]: chapterListHtml }, requests)
        const manga = makeMangaStub(CHAPTER_LIST_SLUG, CHAPTER_LIST_URL)

        const chapters = await mangahubAdapter.listChapters({ manga }, context)

        expect(chapters).toHaveLength(4)
        expect(chapters.map(c => c.sortKey)).toEqual([1, 2, 3, 4])
        // Every surviving sortKey is a real chapter number, never a site-wide internal id.
        for (const c of chapters) expect(c.sortKey).toBeLessThan(100_000)

        // ch2 and ch3 both had a canonical + id-slug duplicate (in opposite document
        // orders) - the canonical URL must win regardless of which came first.
        expect(chapters.find(c => c.sortKey === 1)!.url).toBe(
            `https://mangahub.io/chapter/${CHAPTER_LIST_SLUG}/chapter-1`
        )
        expect(chapters.find(c => c.sortKey === 2)!.url).toBe(
            `https://mangahub.io/chapter/${CHAPTER_LIST_SLUG}/chapter-2`
        )
        expect(chapters.find(c => c.sortKey === 3)!.url).toBe(
            `https://mangahub.io/chapter/${CHAPTER_LIST_SLUG}/chapter-3`
        )
        // ch4 only ever appeared as an id-slug anchor - falls back to that URL.
        expect(chapters.find(c => c.sortKey === 4)!.url).toBe(
            `https://mangahub.io/chapter/${CHAPTER_LIST_SLUG}/chapter-2650004`
        )

        // Foreign "you might also like" slider anchors (different slug) must be
        // completely absent - none of their real chapter numbers (15, 16, 17) leaked in,
        // and nothing in the output references FOREIGN_SLUG.
        expect(chapters.some(c => c.sortKey === 15 || c.sortKey === 16 || c.sortKey === 17)).toBe(false)
        expect(chapters.some(c => c.url.includes(FOREIGN_SLUG))).toBe(false)
    })

    it("discards an id-slug anchor with no visible chapter number and an internal-id-range href", async () => {
        const requests: string[] = []
        const context = createContext({ [CHAPTER_LIST_PATH]: chapterListHtml }, requests)
        const manga = makeMangaStub(CHAPTER_LIST_SLUG, CHAPTER_LIST_URL)

        const chapters = await mangahubAdapter.listChapters({ manga }, context)

        // chapter-2650099 (no visible "#N" text) never produces a chapter record.
        expect(chapters.some(c => c.url.includes("chapter-2650099"))).toBe(false)
    })

    it("produces the identical correct result regardless of canonical/id-slug anchor order", async () => {
        const requests: string[] = []
        const context = createContext({ [CHAPTER_LIST_PATH]: chapterListHtml }, requests)
        const swappedContext = createContext({ [CHAPTER_LIST_PATH]: chapterListHtmlSwappedOrder }, requests)
        const manga = makeMangaStub(CHAPTER_LIST_SLUG, CHAPTER_LIST_URL)

        const chapters = await mangahubAdapter.listChapters({ manga }, context)
        const swappedChapters = await mangahubAdapter.listChapters({ manga }, swappedContext)

        expect(swappedChapters).toEqual(chapters)
    })

    it("prefers the manga's own known slug over a higher-count foreign slug from the recommendation widget", async () => {
        const requests: string[] = []
        const context = createContext({ [SHORT_REAL_CHAPTER_LIST_PATH]: shortRealChapterListHtml }, requests)
        const manga = makeMangaStub(SHORT_REAL_CHAPTER_LIST_SLUG, SHORT_REAL_CHAPTER_LIST_URL)

        const chapters = await mangahubAdapter.listChapters({ manga }, context)

        // FOREIGN_SLUG has 5 anchors vs only 2 for the real manga, and appears first in
        // document order - a raw frequency vote (or a first-encountered tiebreak) would
        // pick FOREIGN_SLUG, but the cross-check against manga.sourceMangaId must win.
        expect(chapters).toHaveLength(2)
        expect(chapters.map(c => c.sortKey)).toEqual([1, 2])
        expect(chapters.every(c => c.url.includes(SHORT_REAL_CHAPTER_LIST_SLUG))).toBe(true)
        expect(chapters.some(c => c.url.includes(FOREIGN_SLUG))).toBe(false)
    })

    it("returns an empty list when the manga's own slug has zero matched anchors, instead of falling back to a foreign slug", async () => {
        const requests: string[] = []
        const context = createContext({ [EMPTY_REAL_CHAPTER_LIST_PATH]: chapterListNoRealAnchorsHtml }, requests)
        const manga = makeMangaStub(EMPTY_REAL_CHAPTER_LIST_SLUG, EMPTY_REAL_CHAPTER_LIST_URL)

        const chapters = await mangahubAdapter.listChapters({ manga }, context)

        expect(chapters).toHaveLength(0)
    })
})

describe("mangahubAdapter.resolveChapter", () => {
    it("derives the chapter number from the page title for a normal canonical chapter", async () => {
        const requests: string[] = []
        const context = createContext({ [CHAPTER_PATH]: chapterPageHtml }, requests)

        const result = await mangahubAdapter.resolveChapter!({ url: new URL(CHAPTER_URL) }, context)

        expect(result.chapter.sortKey).toBe(52)
        expect(result.chapter.title).toBe("Chapter 52")
    })

    it("falls back to the URL slug number when the title has no chapter number but the slug number is real", async () => {
        const requests: string[] = []
        const context = createContext({ [CHAPTER_LOW_SLUGNUM_PATH]: chapterPageNoTitleNumberHtml }, requests)

        const result = await mangahubAdapter.resolveChapter!({ url: new URL(CHAPTER_LOW_SLUGNUM_URL) }, context)

        expect(result.chapter.sortKey).toBe(42)
    })

    it("throws instead of returning a chapter 0 record when neither the title nor a real slug number is available", async () => {
        const requests: string[] = []
        const context = createContext({ [CHAPTER_HIGH_SLUGNUM_PATH]: chapterPageRedirectedHtml }, requests)

        await expect(
            mangahubAdapter.resolveChapter!({ url: new URL(CHAPTER_HIGH_SLUGNUM_URL) }, context)
        ).rejects.toMatchObject({ code: "invalid-response" })
    })

    it("collects lazy pages via data-src and the imgx.mghubcdn.com CDN host, not just eager src", async () => {
        const path = "/chapter/hero-returns/chapter-7"
        const html =
            `<!doctype html><html><head><title>Hero Returns Chapter 7</title>` +
            `<meta property="og:title" content="Hero Returns Chapter 7"/></head><body>` +
            `<img src="data:image/gif;base64,placeholder" data-src="https://imgx.mghubcdn.com/mh/hero-returns/7/1.webp"/>` +
            `<img data-src="https://imgx.mghubcdn.com/mh/hero-returns/7/2.webp"/>` +
            `<img src="https://imgx.mghubcdn.com/mh/hero-returns/7/3.webp"/>` +
            `</body></html>`
        const requests: string[] = []
        const context = createContext({ [path]: html }, requests)

        const result = await mangahubAdapter.resolveChapter!({ url: new URL(`https://mangahub.io${path}`) }, context)

        expect(result.pages.map(p => p.url)).toEqual([
            "https://imgx.mghubcdn.com/mh/hero-returns/7/1.webp",
            "https://imgx.mghubcdn.com/mh/hero-returns/7/2.webp",
            "https://imgx.mghubcdn.com/mh/hero-returns/7/3.webp"
        ])
    })
})

describe("mangahubAdapter.resolveCover", () => {
    it("fetches the manga detail page and returns the og:image cover URL", async () => {
        const requests: string[] = []
        const context = createContext({ [COVER_PATH]: mangaDetailHtml }, requests)

        const cover = await mangahubAdapter.resolveCover!({ sourceMangaId: COVER_SLUG }, context)

        expect(cover).toBe(COVER_URL)
        expect(requests).toHaveLength(1)
        expect(requests[0]).toBe(`GET https://mangahub.io${COVER_PATH}`)
    })

    it("returns undefined when the fetch fails", async () => {
        const requests: string[] = []
        const context = createContext({}, requests)

        const cover = await mangahubAdapter.resolveCover!({ sourceMangaId: "nonexistent-manga" }, context)

        expect(cover).toBeUndefined()
    })
})

describe("mangahubAdapter with the site's numeric id suffix", () => {
    const anchor = (slug: string, n: number) =>
        `<a href="https://mangahub.io/chapter/${slug}/chapter-${n}"><span>#<!-- -->${n}</span></a>`
    const page = (...anchors: string[]) => `<html><body>${anchors.join("")}</body></html>`
    const contextFor = (html: string): SourceContext => ({
        request: createBoundedRequestClient({
            fetch: (async () => ({ ok: true, status: 200, text: async () => html })) as FetchFunction,
            allowedOrigins: ["https://mangahub.io"],
            maxRequests: 10,
            maxResponseBytes: 1_000_000,
            timeoutMs: 1000
        }),
        now: () => 1,
        logger: { debug: () => undefined, warn: () => undefined }
    })
    const list = (sourceMangaId: string, html: string) =>
        mangahubAdapter.listChapters(
            {
                manga: {
                    manga: {
                        id: `mangahub:manga:${sourceMangaId}`,
                        title: sourceMangaId,
                        normalizedTitle: sourceMangaId,
                        authors: [],
                        status: "unknown",
                        addedAt: 1,
                        updatedAt: 1
                    },
                    sourceId: "mangahub",
                    sourceMangaId,
                    url: `https://mangahub.io/manga/${sourceMangaId}`
                }
            },
            contextFor(html)
        )

    it("lists the chapters of a title saved without the suffix, as a chapter page saves it", async () => {
        const html = page(anchor("black-clover_138", 1), anchor("black-clover_138", 2), anchor("against-the-gods", 806))
        const chapters = await list("black-clover", html)
        expect(chapters.map(c => c.sortKey)).toEqual([1, 2])
        expect(chapters[0]?.url).toBe("https://mangahub.io/chapter/black-clover_138/chapter-1")
        expect(chapters[0]?.mangaId).toBe("mangahub:manga:black-clover")
    })

    it("still keeps out another series in the page's slider", async () => {
        const html = page(anchor("eleceed", 1), anchor("against-the-gods", 806), anchor("against-the-gods", 807))
        expect((await list("eleceed", html)).map(c => c.sortKey)).toEqual([1])
    })

    it("prefers an exact id over a series that only shares the base name", async () => {
        const html = page(anchor("the-gamer_102", 5), anchor("the-gamer_200", 9))
        expect((await list("the-gamer_102", html)).map(c => c.sortKey)).toEqual([5])
    })

    it("treats the suffixed and plain ids as one series", () => {
        expect(mangahubAdapter.normalizeSourceMangaId?.("black-clover_138")).toBe("black-clover")
        expect(mangahubAdapter.normalizeSourceMangaId?.("eleceed")).toBe("eleceed")
    })
})
