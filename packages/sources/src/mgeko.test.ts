import {
    createBoundedRequestClient,
    UNNUMBERED_SORT_KEY,
    type FetchFunction,
    type SourceContext
} from "@amr/source-sdk"
import { describe, expect, it } from "vitest"
import {
    CHAPTER_PATH,
    CHAPTER_SLUG,
    CHAPTER_URL,
    chapterHtml,
    COVER_URL,
    MANGA_PATH,
    MANGA_SLUG,
    MANGA_URL,
    mangaHtml,
    PAGE_URLS,
    SEARCH_PATH,
    SEARCH_QUERY,
    searchHtml
} from "./__fixtures__/mgeko"
import { mgekoAdapter } from "./mgeko"

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
            allowedOrigins: ["https://www.mgeko.cc"],
            maxRequests: 10,
            maxResponseBytes: 1_000_000,
            timeoutMs: 1000
        }),
        now: () => 1_700_000_000_000,
        logger: { debug: () => undefined, warn: () => undefined }
    }
}

function makeMangaStub(sourceMangaId: string) {
    return {
        manga: {
            id: `mgeko:manga:${sourceMangaId}`,
            title: "Test",
            normalizedTitle: "test",
            authors: [],
            status: "unknown" as const,
            addedAt: 0,
            updatedAt: 0
        },
        sourceId: "mgeko",
        sourceMangaId,
        url: MANGA_URL
    }
}

describe("mgekoAdapter.match", () => {
    it("classifies reader, manga, and foreign URLs", () => {
        expect(mgekoAdapter.match(new URL(CHAPTER_URL))).toBe("chapter")
        expect(mgekoAdapter.match(new URL("https://www.mgeko.cc/manga/some-manga/"))).toBe("manga")
        expect(mgekoAdapter.match(new URL("https://not-mgeko.cc/reader/en/x/"))).toBe("none")
    })

    it("recognizes a real mgeko.cc /manga/{slug}/ URL (site migrated off /comic/)", () => {
        expect(mgekoAdapter.match(new URL("https://www.mgeko.cc/manga/j3pu-shadow-slave/"))).toBe("manga")
        expect(mgekoAdapter.match(new URL("https://www.mgeko.cc/comic/j3pu-shadow-slave/"))).toBe("none")
    })
})

describe("mgekoAdapter.listChapters", () => {
    it("parses chapter list from manga page, sorted newest first", async () => {
        const requests: string[] = []
        const context = createContext({ [MANGA_PATH]: mangaHtml }, requests)
        const manga = makeMangaStub(MANGA_SLUG)

        const chapters = await mgekoAdapter.listChapters({ manga, limit: 500 }, context)

        expect(chapters).toHaveLength(3)
        expect(chapters[0]!.sortKey).toBe(52)
        expect(chapters[0]!.title).toBe("Chapter 52")
        expect(chapters[0]!.url).toBe(`https://www.mgeko.cc/reader/en/${MANGA_SLUG}-chapter-52-eng-li/`)
        expect(chapters[2]!.sortKey).toBe(1)
        expect(requests).toEqual([`GET https://www.mgeko.cc${MANGA_PATH}`])
    })

    it("returns empty array when no matching chapter links found", async () => {
        const requests: string[] = []
        const context = createContext({ [MANGA_PATH]: "<html><body>no chapters</body></html>" }, requests)
        const manga = makeMangaStub(MANGA_SLUG)

        const chapters = await mgekoAdapter.listChapters({ manga, limit: 500 }, context)
        expect(chapters).toHaveLength(0)
    })

    it("maps a -chapter- slug with no numeric token to UNNUMBERED_SORT_KEY, not 1", async () => {
        const html = `<ul class="chapter-list">
  <li><a href="/reader/en/${MANGA_SLUG}-chapter-extra-eng-li/">Extra</a></li>
  <li><a href="/reader/en/${MANGA_SLUG}-chapter-1-eng-li/">Chapter 1</a></li>
</ul>`
        const requests: string[] = []
        const context = createContext({ [MANGA_PATH]: html }, requests)
        const manga = makeMangaStub(MANGA_SLUG)

        const chapters = await mgekoAdapter.listChapters({ manga, limit: 500 }, context)
        const extra = chapters.find(c => c.sourceChapterId === `${MANGA_SLUG}-chapter-extra-eng-li`)
        const one = chapters.find(c => c.sourceChapterId === `${MANGA_SLUG}-chapter-1-eng-li`)

        expect(one!.sortKey).toBe(1)
        expect(extra!.sortKey).toBe(UNNUMBERED_SORT_KEY)
        expect(extra!.sortKey).not.toBe(1)
    })
})

describe("mgekoAdapter.search", () => {
    it("hits the real /search/?search= endpoint and parses results, skipping junk slugs", async () => {
        const requests: string[] = []
        const context = createContext({ [SEARCH_PATH]: searchHtml }, requests)

        const results = await mgekoAdapter.search!(SEARCH_QUERY, context)

        expect(results).toHaveLength(2)
        expect(results[0]!.sourceMangaId).toBe(MANGA_SLUG)
        expect(results[0]!.title).toBe("Barbarian's Adventure in a Fantasy World")
        expect(results[0]!.coverUrl).toBe("https://www.mgeko.cc/media/manga_covers/qYZJ01-m.jpg")
        expect(results[1]!.sourceMangaId).toBe("barbarian-quest")
        expect(requests[0]!).toContain("/search/?search=barbarian")
    })

    it("returns empty array for blank query", async () => {
        const requests: string[] = []
        const context = createContext({}, requests)
        const results = await mgekoAdapter.search!("   ", context)
        expect(results).toHaveLength(0)
        expect(requests).toHaveLength(0)
    })
})

describe("mgekoAdapter.resolveChapter", () => {
    it("extracts page URLs from the chapImages JS array", async () => {
        const requests: string[] = []
        const context = createContext({ [CHAPTER_PATH]: chapterHtml }, requests)

        const result = await mgekoAdapter.resolveChapter({ url: new URL(CHAPTER_URL) }, context)

        expect(result.pages.map(p => p.url)).toEqual(PAGE_URLS)
        expect(result.chapter.title).toBe("Chapter 52")
        expect(result.chapter.sortKey).toBe(52)
        expect(result.chapter.sourceChapterId).toBe(CHAPTER_SLUG)
        expect(result.manga.manga.coverUrl).toBe(COVER_URL)
    })

    it("throws a descriptive error when no images are found", async () => {
        const requests: string[] = []
        const context = createContext({ [CHAPTER_PATH]: "<html><body>no images here</body></html>" }, requests)

        await expect(mgekoAdapter.resolveChapter({ url: new URL(CHAPTER_URL) }, context)).rejects.toMatchObject({
            code: "invalid-response"
        })
    })
})

describe("mgekoAdapter with a series the site renamed", () => {
    const CHAPTER = "/reader/en/old-name-chapter-3-eng-li/"
    const chapterPage = `<script>var chapImages = ['https://cdn.example/1.jpg'];
</script>
<header class="chapter-header"><div class="titles"><h1><a href="/manga/new-name/" title="New &amp; Name">New</a></h1></div></header>`

    it("files a chapter under the series its page names, and says what it may be saved as", async () => {
        const context = createContext({ [CHAPTER]: chapterPage }, [])
        const { manga, chapter } = await mgekoAdapter.resolveChapter(
            { url: new URL(`https://www.mgeko.cc${CHAPTER}`) },
            context
        )
        expect(manga.sourceMangaId).toBe("new-name")
        expect(manga.manga.title).toBe("New & Name")
        expect(manga.formerSourceMangaIds).toEqual(["old-name"])
        expect(chapter.mangaId).toBe(manga.manga.id)
    })

    it("lists chapters filed under either name, but only from the series' own list", async () => {
        const page = `<a id="readchapterbtn" href="/reader/en/old-name-chapter-1-eng-li/">first</a>
<ul class="chapter-list"><li><a href="/reader/en/new-name-chapter-4-eng-li/">4</a></li>
<li><a href="/reader/en/old-name-chapter-3-eng-li/">3</a></li></ul>
<a href="/reader/en/another-series-chapter-9-eng-li/">recommended</a>`
        const context = createContext({ "/manga/new-name/": page }, [])
        const resolved = await mgekoAdapter.resolveManga({ sourceMangaId: "new-name" }, context)
        const chapters = await mgekoAdapter.listChapters({ manga: resolved, languages: ["en"] }, context)
        expect(chapters.map(c => c.sortKey).sort((a, b) => a - b)).toEqual([3, 4])
    })

    it("finds the new address from a chapter page", async () => {
        const context = createContext({ [CHAPTER]: chapterPage }, [])
        const moved = await mgekoAdapter.findMovedSeries?.(
            { sourceMangaId: "old-name", title: "Old", chapterUrls: [new URL(`https://www.mgeko.cc${CHAPTER}`)] },
            context
        )
        expect(moved).toEqual({
            sourceMangaId: "new-name",
            mangaUrl: "https://www.mgeko.cc/manga/new-name/",
            title: "New & Name"
        })
    })

    const searchPage = (slug: string, title: string) =>
        `<ul><li class="novel-item"><a href="/manga/${slug}/" title="${title}"><img src="/c.jpg"></a></li></ul>`

    it("falls back to a search when the code in front of the id changed, matching the id exactly", async () => {
        const requests: string[] = []
        const context = createContext({ "/search/": searchPage("tmd9-mr-kim-rich", "Mr. Kim Rich") }, requests)
        const moved = await mgekoAdapter.findMovedSeries?.(
            { sourceMangaId: "dz91-mr-kim-rich", title: "Dz91 Mr Kim Rich", chapterUrls: [] },
            context
        )
        expect(moved?.sourceMangaId).toBe("tmd9-mr-kim-rich")
        expect(requests.some(url => url.includes("search=mr+kim+rich"))).toBe(true)
    })

    it("treats a trailing marker the same way", async () => {
        const context = createContext({ "/search/": searchPage("the-raised-mg1", "The Raised") }, [])
        const moved = await mgekoAdapter.findMovedSeries?.(
            { sourceMangaId: "the-raised", title: "The Raised", chapterUrls: [] },
            context
        )
        expect(moved?.sourceMangaId).toBe("the-raised-mg1")
    })

    it("never takes a series that only looks alike", async () => {
        const context = createContext({ "/search/": searchPage("mr-kim-rich-again", "Mr Kim Rich Again") }, [])
        const moved = await mgekoAdapter.findMovedSeries?.(
            { sourceMangaId: "dz91-mr-kim-rich", title: "Mr Kim Rich", chapterUrls: [] },
            context
        )
        expect(moved).toBeNull()
    })
})
