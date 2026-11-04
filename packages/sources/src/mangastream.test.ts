import { createBoundedRequestClient, type FetchFunction, type SourceContext } from "@amr/source-sdk"
import { describe, expect, it } from "vitest"
import { createMangaStreamAdapter } from "./mangastream"

const adapter = createMangaStreamAdapter({
    id: "teststream",
    name: "Test Stream",
    origin: "https://test-stream.example",
    domains: ["test-stream.example"]
})

const CHAPTER_URL = "https://test-stream.example/cool-manga-chapter-12/"

const chapterHtml = `<!DOCTYPE html><html><head>
<title>Cool Manga Chapter 12 - Test Stream</title>
<meta property="og:image" content="https://test-stream.example/cover.jpg" /></head><body>
<script>
ts_reader.run({"post_id":42,"sources":[{"source":"Main","images":["https://cdn.example/1.jpg","https://cdn.example/2.jpg"]}]});
</script>
</body></html>`

// Title with an isolated single-digit token ("2") before the real " - " separator. The old
// `[--|]` character class was a RANGE from "-" to "|" (matches digits/letters/punctuation in
// that code-point span), so `.split()` incorrectly split on the isolated "2" instead of the
// intended " - " boundary, truncating the title to "Chainsaw Man Part".
const isolatedDigitTitleHtml = `<!DOCTYPE html><html><head>
<title>Chainsaw Man Part 2 - Read Free Manga Online</title>
<meta property="og:image" content="https://test-stream.example/cover.jpg" /></head><body>
<script>
ts_reader.run({"post_id":42,"sources":[{"source":"Main","images":["https://cdn.example/1.jpg","https://cdn.example/2.jpg"]}]});
</script>
</body></html>`

function createContext(fixtures: Readonly<Record<string, string>>): SourceContext {
    const fetch: FetchFunction = async url => {
        const body = fixtures[new URL(url).pathname]
        return { ok: body !== undefined, status: body === undefined ? 404 : 200, text: async () => body ?? "" }
    }
    return {
        request: createBoundedRequestClient({
            fetch,
            allowedOrigins: ["https://test-stream.example"],
            maxRequests: 10,
            maxResponseBytes: 1_000_000,
            timeoutMs: 1000
        }),
        now: () => 1_700_000_000_000,
        logger: { debug: () => undefined, warn: () => undefined }
    }
}

describe("createMangaStreamAdapter", () => {
    it("parseMangaUrl resolves a series URL, and returns null for a flat chapter URL (slug not in the URL)", () => {
        expect(adapter.parseMangaUrl!(new URL("https://test-stream.example/manga/cool-manga/"))).toEqual({
            sourceMangaId: "cool-manga",
            mangaUrl: "https://test-stream.example/manga/cool-manga/"
        })
        // Flat chapter URL: the manga slug genuinely isn't in the path, so don't guess.
        expect(adapter.parseMangaUrl!(new URL(CHAPTER_URL))).toBeNull()
        expect(adapter.parseMangaUrl!(new URL("https://other.example/manga/x/"))).toBeNull()
    })

    it("parseMangaUrl resolves the manga slug from a hierarchical chapter URL", () => {
        const hierAdapter = createMangaStreamAdapter({
            id: "teststream-h",
            name: "Test Stream H",
            origin: "https://test-stream.example",
            domains: ["test-stream.example"],
            chapterFormat: "hierarchical"
        })
        expect(hierAdapter.parseMangaUrl!(new URL("https://test-stream.example/manga/cool-manga/12/"))).toEqual({
            sourceMangaId: "cool-manga",
            mangaUrl: "https://test-stream.example/manga/cool-manga/"
        })
    })

    it("classifies chapter (root slug) and manga URLs", () => {
        expect(adapter.match(new URL(CHAPTER_URL))).toBe("chapter")
        expect(adapter.match(new URL("https://test-stream.example/manga/cool-manga/"))).toBe("manga")
        expect(adapter.match(new URL("https://test-stream.example/random-page/"))).toBe("none")
    })

    it("resolves chapter images from the ts_reader blob", async () => {
        const context = createContext({ "/cool-manga-chapter-12/": chapterHtml })
        const result = await adapter.resolveChapter({ url: new URL(CHAPTER_URL) }, context)
        expect(result.pages.map(p => p.url)).toEqual(["https://cdn.example/1.jpg", "https://cdn.example/2.jpg"])
        expect(result.chapter.sortKey).toBe(12)
        expect(result.manga.manga.coverUrl).toBe("https://test-stream.example/cover.jpg")
    })

    it("search keeps real cards and drops nav/sidebar junk", async () => {
        const searchHtml = `<html><body>
<nav><a href="https://test-stream.example/manga/popular/" title="Popular">Popular</a>
<a href="https://test-stream.example/manga/latest/" title="Latest">Latest</a></nav>
<div class="listupd">
  <div class="bsx"><a href="https://test-stream.example/manga/buried-injustice/" title="Buried Injustice"><img src="x.jpg"/></a></div>
  <div class="bsx"><a href="https://test-stream.example/manga/sir-dont-show-off/" title="Sir, Don&#039;t Show Off"></a></div>
</div></body></html>`
        const context = createContext({ "/": searchHtml })
        const results = await adapter.search!("anything", context)
        expect(results.map(r => r.title)).toEqual(["Buried Injustice", "Sir, Don't Show Off"])
        expect(results.every(r => r.sourceMangaId !== "popular" && r.sourceMangaId !== "latest")).toBe(true)
    })

    it("falls back to #readerarea images", async () => {
        const html = `<html><body><div id="readerarea">
<img src="https://cdn.example/a.jpg" /><img src="https://cdn.example/b.png" />
</div></div></body></html>`
        const context = createContext({ "/cool-manga-chapter-3/": html })
        const result = await adapter.resolveChapter(
            { url: new URL("https://test-stream.example/cool-manga-chapter-3/") },
            context
        )
        expect(result.pages.map(p => p.url)).toEqual(["https://cdn.example/a.jpg", "https://cdn.example/b.png"])
    })

    it("extracts the full manga title when the <title> tag has an isolated digit before the real separator", async () => {
        // Regression guard for the malformed `[--|]` character class (parsed as a code-point
        // RANGE, not "hyphen or pipe") which truncated titles at any isolated char in that range.
        const context = createContext({ "/cool-manga-chapter-12/": isolatedDigitTitleHtml })
        const result = await adapter.resolveChapter({ url: new URL(CHAPTER_URL) }, context)
        expect(result.manga.manga.title).toBe("Chainsaw Man Part 2")
    })

    it("still splits on a real hyphen separator (regression guard)", async () => {
        const context = createContext({ "/cool-manga-chapter-12/": chapterHtml })
        const result = await adapter.resolveChapter({ url: new URL(CHAPTER_URL) }, context)
        expect(result.manga.manga.title).toBe("Cool Manga")
    })

    it("cleans a title whose separator is an encoded dash", async () => {
        const html = chapterHtml.replace(
            "<title>Cool Manga Chapter 12 - Test Stream</title>",
            "<title>Cool Manga Chapter 12.5 &#8211; Test Stream</title>"
        )
        const context = createContext({ "/cool-manga-chapter-12/": html })
        const result = await adapter.resolveChapter({ url: new URL(CHAPTER_URL) }, context)
        expect(result.manga.manga.title).toBe("Cool Manga")
    })

    describe("a series the site renamed, keeping its old chapter addresses", () => {
        const movedChapter = chapterHtml.replace(
            "</head>",
            `</head><div class="allc">All chapters are in <a href="https://test-stream.example/manga/cooler-manga/">Cooler &amp; Manga</a></div>`
        )

        it("files a chapter under the series its page names, and says what it may be saved as", async () => {
            const context = createContext({ "/cool-manga-chapter-12/": movedChapter })
            const { manga, chapter } = await adapter.resolveChapter({ url: new URL(CHAPTER_URL) }, context)
            expect(manga.sourceMangaId).toBe("cooler-manga")
            expect(manga.url).toBe("https://test-stream.example/manga/cooler-manga/")
            expect(manga.manga.title).toBe("Cooler & Manga")
            expect(manga.formerSourceMangaIds).toEqual(["cool-manga"])
            expect(chapter.mangaId).toBe(manga.manga.id)
        })

        it("names no former id when the address already matches the series", async () => {
            const same = movedChapter.replace("/manga/cooler-manga/", "/manga/cool-manga/")
            const context = createContext({ "/cool-manga-chapter-12/": same })
            const { manga } = await adapter.resolveChapter({ url: new URL(CHAPTER_URL) }, context)
            expect(manga.sourceMangaId).toBe("cool-manga")
            expect(manga.formerSourceMangaIds).toBeUndefined()
        })

        it("ignores a series link that leaves the site", async () => {
            const foreign = movedChapter.replace("test-stream.example/manga/cooler-manga", "evil.example/manga/x")
            const context = createContext({ "/cool-manga-chapter-12/": foreign })
            const { manga } = await adapter.resolveChapter({ url: new URL(CHAPTER_URL) }, context)
            expect(manga.sourceMangaId).toBe("cool-manga")
        })

        it("finds the new address from a chapter page, skipping one that is gone", async () => {
            const context = createContext({ "/cool-manga-chapter-12/": movedChapter })
            const moved = await adapter.findMovedSeries?.(
                {
                    sourceMangaId: "cool-manga",
                    title: "Cool Manga",
                    chapterUrls: [new URL("https://test-stream.example/cool-manga-chapter-13/"), new URL(CHAPTER_URL)]
                },
                context
            )
            expect(moved).toEqual({
                sourceMangaId: "cooler-manga",
                mangaUrl: "https://test-stream.example/manga/cooler-manga/",
                title: "Cooler & Manga"
            })
        })

        it("answers null when no chapter page says", async () => {
            const context = createContext({})
            const moved = await adapter.findMovedSeries?.(
                { sourceMangaId: "cool-manga", title: "Cool Manga", chapterUrls: [new URL(CHAPTER_URL)] },
                context
            )
            expect(moved).toBeNull()
        })
    })

    describe("a series page with no share tags", () => {
        const cover = (attrs: string) =>
            `<html><div class="thumb" itemprop="image" itemscope><img width="1" src="https://test-stream.example/c.jpg" ${attrs}></div></html>`

        it("reads the cover the page marks as its own", async () => {
            const context = createContext({ "/manga/cool-manga/": cover("") })
            const url = await adapter.resolveCover?.({ sourceMangaId: "cool-manga" }, context)
            expect(url).toBe("https://test-stream.example/c.jpg")
        })

        it("does not take a related series' thumbnail for it", async () => {
            const html = `<html><div class="thumb"><img src="https://test-stream.example/other.jpg"></div></html>`
            const context = createContext({ "/manga/cool-manga/": html })
            expect(await adapter.resolveCover?.({ sourceMangaId: "cool-manga" }, context)).toBeUndefined()
        })
    })

    it("recovers a chapter list rendered as bare /chapter/ anchors when the <li> markup is gone", async () => {
        // Spider Scans and similar ts-theme variants dropped the <li data-num> #chapterlist
        // block and now render chapters as plain <a href> cards under a separate /chapter/
        // root. The <li> pass finds nothing; the anchor fallback must recover the list, and
        // dedup the Start-Reading / First nav buttons that point at the same chapter URLs.
        const listHtml = `<html><body>
<div class="detail-actions">
  <a href="https://test-stream.example/chapter/cool-manga-chapter-3/" class="btn">Start Reading</a>
  <a href="https://test-stream.example/chapter/cool-manga-chapter-1/" class="btn">First</a>
</div>
<div class="chapter-cards">
  <a href="https://test-stream.example/chapter/cool-manga-chapter-1/">Chapter 1</a>
  <a href="https://test-stream.example/chapter/cool-manga-chapter-2/">Chapter 2</a>
  <a href="https://test-stream.example/chapter/cool-manga-chapter-3/">Chapter 3</a>
  <a href="https://other.example/chapter/unrelated-chapter-9/">off-domain, must skip</a>
  <a href="https://test-stream.example/manga/related-series/">related, not a chapter</a>
</div></body></html>`
        const context = createContext({ "/manga/cool-manga/": listHtml })
        const chapters = await adapter.listChapters({ manga: { sourceMangaId: "cool-manga" } as never }, context)
        expect(chapters.map(c => c.sortKey)).toEqual([1, 2, 3])
        expect(chapters.map(c => c.title)).toEqual(["Chapter 1", "Chapter 2", "Chapter 3"])
        expect(chapters.every(c => c.url.startsWith("https://test-stream.example/chapter/"))).toBe(true)
    })

    it("anchor fallback must not swallow OTHER series' chapter links from page widgets", async () => {
        // ts pages carry "Latest Update"/recommended widgets linking to other series' chapters
        // on the same domain. Those must NOT be admitted as chapters of the series being listed
        // (they invented foreign chapters + fired false "new chapter" notifications).
        const listHtml = `<html><body>
<div class="chapter-cards">
  <a href="https://test-stream.example/chapter/cool-manga-chapter-1/">Chapter 1</a>
  <a href="https://test-stream.example/chapter/cool-manga-chapter-2/">Chapter 2</a>
</div>
<aside class="widget latest-update">
  <a href="https://test-stream.example/chapter/solo-leveling-chapter-200/">Solo Leveling 200</a>
  <a href="https://test-stream.example/naruto-chapter-700/">Naruto 700</a>
  <a href="https://test-stream.example/how-to-read-chapter-guide/">guide</a>
</aside></body></html>`
        const context = createContext({ "/manga/cool-manga/": listHtml })
        const chapters = await adapter.listChapters({ manga: { sourceMangaId: "cool-manga" } as never }, context)
        expect(chapters.map(c => c.sortKey)).toEqual([1, 2])
        expect(chapters.every(c => c.url.includes("cool-manga"))).toBe(true)
    })

    it("anchor fallback keeps a legit special/extra chapter of THIS series (intervening token)", async () => {
        // The slug-scope gate must allow a token between the series slug and 'chapter'
        // (specials/extras/seasons) while still excluding other series.
        const listHtml = `<html><body>
<div class="chapter-cards">
  <a href="https://test-stream.example/chapter/cool-manga-chapter-1/">Chapter 1</a>
  <a href="https://test-stream.example/chapter/cool-manga-extra-chapter-1/">Extra</a>
  <a href="https://test-stream.example/chapter/solo-leveling-chapter-200/">Solo Leveling</a>
</div></body></html>`
        const context = createContext({ "/manga/cool-manga/": listHtml })
        const chapters = await adapter.listChapters({ manga: { sourceMangaId: "cool-manga" } as never }, context)
        expect(chapters.some(c => c.url.includes("cool-manga-extra-chapter-1"))).toBe(true)
        expect(chapters.some(c => c.url.includes("solo-leveling"))).toBe(false)
    })
})
