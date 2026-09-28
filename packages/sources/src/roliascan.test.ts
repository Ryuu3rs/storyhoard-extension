import { createBoundedRequestClient, type FetchFunction, type SourceContext } from "@amr/source-sdk"
import { describe, expect, it } from "vitest"
import { roliascanAdapter } from "./roliascan"

const ORIGIN = "https://roliascan.com"
const SLUG = "the-dignity-of-a-chaebol"

const seriesHtml = `<!doctype html><html><head>
<meta property="og:title" content="The Dignity of a Chaebol Manhwa | Read Online Free at roliascan.com" />
<meta property="og:image" content="https://roliascan.com/content/media/manga-274419-cover-1784407536.jpg" />
</head><body>
<div class="chapter-list" data-manga-id="274419" data-status="Ongoing">Loading chapters...</div>
</body></html>`

const chaptersJson = JSON.stringify({
    success: true,
    chapters: [
        { id: "274927", chapter: "1", title: "N/A", url: `${ORIGIN}/read/${SLUG}/ch1-274927/` },
        { id: "274926", chapter: "2", title: "The Meeting", url: `${ORIGIN}/read/${SLUG}/ch2-274926/` }
    ],
    total: 2
})

const contentJson = JSON.stringify({
    success: true,
    images: [
        "https://roliascan.org/storage/chapters/manhwa_274419_1/001.webp",
        "https://roliascan.org/storage/chapters/manhwa_274419_1/002.webp",
        "https://roliascan.org/storage/rolia-end.webp"
    ]
})

const searchJson = JSON.stringify({
    success: true,
    results: [
        {
            id: 274419,
            title: "The Dignity of a Chaebol",
            slug: SLUG,
            permalink: `${ORIGIN}/manga/${SLUG}`,
            thumbnail: "https://roliascan.org/content/media/manga-274419-cover.jpg",
            alt_titles: ["재벌의 품격 | The Dignity of a Chaebol"]
        }
    ]
})

function createContext(fixtures: Readonly<Record<string, string>>, requests: string[]): SourceContext {
    const fetch: FetchFunction = async (url, init) => {
        requests.push(`${init.method} ${url}`)
        const body = fixtures[new URL(url).pathname]
        return { ok: body !== undefined, status: body === undefined ? 404 : 200, text: async () => body ?? "" }
    }
    return {
        request: createBoundedRequestClient({
            fetch,
            allowedOrigins: [ORIGIN],
            maxRequests: 20,
            maxResponseBytes: 1_000_000,
            timeoutMs: 1000
        }),
        now: () => 1_700_000_000_000,
        logger: { debug: () => undefined, warn: () => undefined }
    }
}

const fixtures = {
    [`/manga/${SLUG}/`]: seriesHtml,
    "/auth/manga-chapters": chaptersJson,
    "/auth/chapter-content": contentJson,
    "/auth/search": searchJson
}

function mangaStub() {
    return {
        manga: {
            id: `roliascan:manga:${SLUG}`,
            title: "x",
            normalizedTitle: "x",
            authors: [],
            status: "unknown" as const,
            addedAt: 0,
            updatedAt: 0
        },
        sourceId: "roliascan",
        sourceMangaId: SLUG,
        url: `${ORIGIN}/manga/${SLUG}`
    }
}

describe("roliascan adapter", () => {
    it("matches manga and chapter URLs", () => {
        expect(roliascanAdapter.match(new URL(`${ORIGIN}/manga/${SLUG}`))).toBe("manga")
        expect(roliascanAdapter.match(new URL(`${ORIGIN}/read/${SLUG}/ch1-274927/`))).toBe("chapter")
        expect(roliascanAdapter.match(new URL(`${ORIGIN}/browse`))).toBe("none")
        expect(roliascanAdapter.match(new URL("https://example.com/manga/x"))).toBe("none")
    })

    it("resolves a series title, cover and id", async () => {
        const ctx = createContext(fixtures, [])
        const res = await roliascanAdapter.resolveManga({ url: new URL(`${ORIGIN}/manga/${SLUG}`) }, ctx)
        expect(res.manga.title).toBe("The Dignity of a Chaebol")
        expect(res.manga.coverUrl).toBe("https://roliascan.com/content/media/manga-274419-cover-1784407536.jpg")
        expect(res.sourceMangaId).toBe(SLUG)
    })

    it("lists chapters via the token-signed API (using the series manga-id)", async () => {
        const requests: string[] = []
        const ctx = createContext(fixtures, requests)
        const chapters = await roliascanAdapter.listChapters({ manga: mangaStub() }, ctx)
        expect(chapters).toHaveLength(2)
        expect(chapters[0]).toMatchObject({ sourceChapterId: "1", sortKey: 1, title: "Ch.1" })
        expect(chapters[1]).toMatchObject({ sourceChapterId: "2", sortKey: 2, title: "Ch.2 - The Meeting" })
        // The chapter request carries the numeric manga_id + an md5 token.
        const chReq = requests.find(r => r.includes("/auth/manga-chapters"))
        expect(chReq).toMatch(/manga_id=274419/)
        expect(chReq).toMatch(/_t=[a-f0-9]{16}/)
        expect(chReq).toMatch(/_ts=\d+/)
    })

    it("resolves chapter pages and drops the end-card", async () => {
        const ctx = createContext(fixtures, [])
        const res = await roliascanAdapter.resolveChapter({ url: new URL(`${ORIGIN}/read/${SLUG}/ch1-274927/`) }, ctx)
        expect(res.pages).toHaveLength(2)
        expect(res.pages[0]!.url).toBe("https://roliascan.org/storage/chapters/manhwa_274419_1/001.webp")
        expect(res.pages.some(p => /rolia-end/.test(p.url))).toBe(false)
        expect(res.chapter.sourceChapterId).toBe("1")
        expect(res.manga.manga.title).toBe("The Dignity of a Chaebol")
    })

    it("searches and maps results with alt titles", async () => {
        const ctx = createContext(fixtures, [])
        const results = await roliascanAdapter.search!("chaebol", ctx)
        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({
            sourceId: "roliascan",
            sourceMangaId: SLUG,
            title: "The Dignity of a Chaebol",
            url: `${ORIGIN}/manga/${SLUG}`
        })
        expect(results[0]!.altTitles).toContain("재벌의 품격")
    })
})
