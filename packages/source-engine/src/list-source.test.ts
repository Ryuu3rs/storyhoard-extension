import { createBoundedRequestClient, type FetchFunction, type SourceContext, type SourceManga } from "@amr/source-sdk"
import { describe, expect, it } from "vitest"
import { createAdapterFromProfile } from "./create-adapter-from-profile"
import { parseProfile, type SiteProfile } from "./profile-schema"

const ORIGIN = "https://reader.example"

const BASE = {
    profileFormat: 2,
    id: "reader.example",
    name: "Example Reader",
    engine: "generic",
    origin: ORIGIN,
    domains: ["reader.example"],
    languages: ["en"],
    capabilities: ["chapters", "manga"],
    requestRateLimit: { requests: 3, intervalMs: 1000 },
    origins: [`${ORIGIN}/*`],
    match: { manga: "^/manga/([^/]+)/?$", chapter: "^/manga/([^/]+)/chapter-(\\d+(?:\\.\\d+)?)/?$" },
    series: { titlePattern: "<title>(?<title>[^<]+)</title>" },
    list: { itemPattern: 'href="(?<chapterUrl>/manga/{slug}/chapter-(?<chapterNumber>[0-9.]+))"' }
}

function profile(extra: Record<string, unknown> = {}): SiteProfile {
    const parsed = parseProfile({ ...BASE, ...extra })
    if (!parsed.ok) throw new Error(parsed.error)
    return parsed.profile
}

const SERIES_URL = `${ORIGIN}/manga/demo-title`
const RENDERED = `<ul>
<li><a href="/manga/demo-title/chapter-3">Chapter 3</a></li>
<li><a href="/manga/demo-title/chapter-2">Chapter 2</a></li>
<li><a href="/manga/demo-title/chapter-1">Chapter 1</a></li>
<li><a href="/manga/other-title/chapter-9">Chapter 9</a></li>
<li><a href="https://evil.example/manga/demo-title/chapter-7">Chapter 7</a></li>
</ul>`

function manga(): SourceManga {
    return {
        manga: {
            id: "reader.example:manga:demo-title",
            title: "Demo Title",
            normalizedTitle: "demo title",
            authors: [],
            status: "unknown",
            addedAt: 1,
            updatedAt: 1
        },
        sourceId: "reader.example",
        sourceMangaId: "demo-title",
        url: SERIES_URL
    }
}

function context(pages: Record<string, string>): { context: SourceContext; requested: string[] } {
    const requested: string[] = []
    const fetch: FetchFunction = async url => {
        requested.push(url)
        const body = pages[new URL(url).pathname + new URL(url).search]
        return { ok: body !== undefined, status: body !== undefined ? 200 : 404, text: async () => body ?? "" }
    }
    return {
        requested,
        context: {
            request: createBoundedRequestClient({
                fetch,
                allowedOrigins: [`${ORIGIN}/*`],
                maxRequests: 20,
                maxResponseBytes: 1_000_000,
                timeoutMs: 1000
            }),
            now: () => 1,
            logger: { debug: () => undefined, warn: () => undefined }
        }
    }
}

describe("listSource and renderedSelectors in the profile schema", () => {
    it("accepts each list source and leaves it optional", () => {
        for (const listSource of ["fetch", "tab", "on-visit"]) {
            expect(parseProfile({ ...BASE, listSource }).ok).toBe(true)
        }
        expect(parseProfile(BASE).ok).toBe(true)
        expect(parseProfile({ ...BASE, listSource: "scrape" }).ok).toBe(false)
    })

    it("accepts plain CSS selectors for the rendered list", () => {
        const list = { ...BASE.list, renderedSelectors: { container: "ul.chapters", item: "li > a[href]" } }
        expect(parseProfile({ ...BASE, list }).ok).toBe(true)
    })

    it.each([
        ["braces", "ul{color:red}"],
        ["a closing brace", "ul}"],
        ["an angle bracket", "<script>"],
        ["an empty selector", ""],
        ["an over-long selector", "a".repeat(201)]
    ])("rejects a rendered selector with %s", (_name, bad) => {
        const list = { ...BASE.list, renderedSelectors: { container: bad } }
        expect(parseProfile({ ...BASE, list }).ok).toBe(false)
        expect(parseProfile({ ...BASE, list: { ...BASE.list, renderedSelectors: { item: bad } } }).ok).toBe(false)
    })

    it("rejects an unknown key under renderedSelectors", () => {
        const list = { ...BASE.list, renderedSelectors: { container: "ul", script: "x" } }
        expect(parseProfile({ ...BASE, list }).ok).toBe(false)
    })
})

describe("listChaptersFromHtml", () => {
    it("runs the same extraction as listChapters over html it is handed, with no request", async () => {
        const adapter = createAdapterFromProfile(profile())
        const fetched = context({ "/manga/demo-title": RENDERED })
        const viaFetch = await adapter.listChapters({ manga: manga() }, fetched.context)

        const viaHtml = adapter.listChaptersFromHtml!({ manga: manga() }, RENDERED)

        expect(viaHtml).toEqual(viaFetch)
        expect(viaHtml.map(chapter => chapter.sortKey).sort()).toEqual([1, 2, 3])
        expect(fetched.requested).toHaveLength(1)
    })

    it("keeps only this series' chapters on its own origins", () => {
        const adapter = createAdapterFromProfile(profile())
        const urls = adapter.listChaptersFromHtml!({ manga: manga() }, RENDERED).map(chapter => chapter.url)
        expect(urls.sort()).toEqual([
            `${ORIGIN}/manga/demo-title/chapter-1`,
            `${ORIGIN}/manga/demo-title/chapter-2`,
            `${ORIGIN}/manga/demo-title/chapter-3`
        ])
    })

    it("numbers a text-numbered profile from the link text", () => {
        const textual = profile({
            numberSource: "text",
            match: { manga: "^/manga/([^/]+)/?$", chapter: "^/manga/([^/]+)/read/(\\d+)/?$" },
            list: {
                itemPattern: 'href="(?<chapterUrl>/manga/{slug}/read/(?<chapterNumber>\\d+))"',
                itemTextPattern:
                    '<a\\b[^>]*?href="(?<chapterUrl>/manga/{slug}/read/\\d+)"[^>]*>\\s*(?<chapterText>[^<]{1,80})'
            }
        })
        const html = `<a href="/manga/demo-title/read/50001">Ch. 86</a><a href="/manga/demo-title/read/50002">Ch. 87</a>`
        const chapters = createAdapterFromProfile(textual).listChaptersFromHtml!({ manga: manga() }, html)
        expect(chapters.map(chapter => chapter.sortKey)).toEqual([86, 87])
    })

    it("returns nothing for a profile with no list", () => {
        const adapter = createAdapterFromProfile(profile({ list: undefined }))
        expect(adapter.listChaptersFromHtml!({ manga: manga() }, RENDERED)).toEqual([])
    })

    it("still paginates listChapters across fetched pages", async () => {
        const paged = profile({
            list: { ...BASE.list, pagination: { param: "page", maxPages: 5 } }
        })
        const adapter = createAdapterFromProfile(paged)
        const fetched = context({
            "/manga/demo-title?page=1": '<a href="/manga/demo-title/chapter-1">1</a>',
            "/manga/demo-title?page=2": '<a href="/manga/demo-title/chapter-2">2</a>',
            "/manga/demo-title?page=3": "<p>none</p>"
        })
        const chapters = await adapter.listChapters({ manga: manga() }, fetched.context)
        expect(chapters.map(chapter => chapter.sortKey)).toEqual([1, 2])
        expect(fetched.requested).toHaveLength(3)
    })
})

describe("tab list source", () => {
    it("asks for a tab render only when the profile says listSource tab", () => {
        expect(createAdapterFromProfile(profile({ listSource: "tab" })).chapterListViaMangaPageTab).toBe(true)
        expect(createAdapterFromProfile(profile({ listSource: "fetch" })).chapterListViaMangaPageTab).toBeUndefined()
        expect(createAdapterFromProfile(profile({ listSource: "on-visit" })).chapterListViaMangaPageTab).toBeUndefined()
        expect(createAdapterFromProfile(profile()).chapterListViaMangaPageTab).toBeUndefined()
    })

    it("renders the series page, or the list template page when the profile names one", () => {
        const plain = createAdapterFromProfile(profile({ listSource: "tab" }))
        expect(plain.chapterListRenderUrl!("demo-title", SERIES_URL)).toBe(SERIES_URL)

        const templated = createAdapterFromProfile(
            profile({ listSource: "tab", list: { ...BASE.list, urlTemplate: "/manga/{slug}/chapters" } })
        )
        expect(templated.chapterListRenderUrl!("demo-title", SERIES_URL)).toBe(`${ORIGIN}/manga/demo-title/chapters`)
    })
})
