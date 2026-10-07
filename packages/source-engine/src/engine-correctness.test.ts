import { createBoundedRequestClient, type FetchFunction, type SourceContext } from "@amr/source-sdk"
import { describe, expect, it, vi } from "vitest"
import { createAdapterFromProfile } from "./create-adapter-from-profile"
import { deriveChapterShape, draftProfileFromChapterPage } from "./draft"
import { interpolate, InterpolationError } from "./interpolate"
import { parseProfile } from "./profile-schema"
import { slugPattern } from "./slug"

const ORIGIN = "https://reader.example"

function makeContext(
    pages: Record<string, string>,
    requested: string[] = [],
    warn: (message: string, details?: Readonly<Record<string, unknown>>) => void = () => undefined
): SourceContext {
    const fetch: FetchFunction = async url => {
        requested.push(new URL(url).pathname)
        const body = pages[new URL(url).pathname]
        return { ok: body !== undefined, status: body === undefined ? 404 : 200, text: async () => body ?? "" }
    }
    return {
        request: createBoundedRequestClient({
            fetch,
            allowedOrigins: [ORIGIN],
            maxRequests: 20,
            maxResponseBytes: 8_000_000,
            timeoutMs: 1000
        }),
        now: () => 1_700_000_000_000,
        logger: { debug: () => undefined, warn }
    }
}

function adapterFor(chapterPath: string) {
    const draft = draftProfileFromChapterPage({ url: `${ORIGIN}${chapterPath}`, links: [], images: [] })
    if (!draft) throw new Error("no draft")
    const parsed = parseProfile(draft.profile)
    if (!parsed.ok) throw new Error(parsed.error)
    return { adapter: createAdapterFromProfile(parsed.profile), draft }
}

async function listFor(chapterPath: string, seriesPath: string, html: string, requested: string[] = []) {
    const { adapter } = adapterFor(chapterPath)
    const ctx = makeContext({ [seriesPath]: html }, requested)
    const manga = await adapter.resolveManga({ url: new URL(`${ORIGIN}${seriesPath}`) }, ctx)
    return { chapters: await adapter.listChapters({ manga }, ctx), manga }
}

describe("a percent-encoded (non-ASCII) series slug", () => {
    const encoded = "%E3%81%82"
    const seriesPath = `/manga/${encoded}`
    const chapterPath = `/manga/${encoded}/chapter-2`

    it("is fetched under its once-encoded url, not double-encoded", async () => {
        const requested: string[] = []
        const { chapters } = await listFor(
            chapterPath,
            seriesPath,
            `<a href="/manga/${encoded}/chapter-1">1</a><a href="/manga/${encoded}/chapter-2">2</a>`,
            requested
        )
        expect(requested.every(path => !path.includes("%25"))).toBe(true)
        expect(chapters.map(c => c.sortKey)).toEqual([1, 2])
    })

    it("lists chapters whose links write the slug raw", async () => {
        const { chapters } = await listFor(chapterPath, seriesPath, `<a href="/manga/あ/chapter-1">1</a>`)
        expect(chapters.map(c => c.sortKey)).toEqual([1])
    })

    it("lists chapters whose links write the slug with lower-case hex", async () => {
        const { chapters } = await listFor(
            "/manga/%E3%81%82%E3%81%8A/chapter-2",
            "/manga/%E3%81%82%E3%81%8A",
            `<a href="/manga/%e3%81%82%e3%81%8a/chapter-1">1</a>`
        )
        expect(chapters.map(c => c.sortKey)).toEqual([1])
    })

    it("lists chapters whose links write the slug as numeric entities", async () => {
        const { chapters } = await listFor(
            chapterPath,
            seriesPath,
            `<a href="/manga/&#12354;/chapter-1">1</a><a href="/manga/&#x3042;/chapter-2">2</a>`
        )
        expect(chapters.map(c => c.sortKey)).toEqual([1, 2])
    })

    it("still ignores another series' chapters", async () => {
        const { chapters } = await listFor(
            chapterPath,
            seriesPath,
            `<a href="/manga/%E3%81%84/chapter-9">other</a><a href="/manga/${encoded}/chapter-1">1</a>`
        )
        expect(chapters.map(c => c.sortKey)).toEqual([1])
    })

    it("interpolates a path-lifted slug exactly once", () => {
        expect(interpolate("/manga/{slug}", { slug: encoded })).toBe(`/manga/${encoded}`)
        expect(interpolate("/manga/{slug}", { slug: "plain-slug" })).toBe("/manga/plain-slug")
        expect(interpolate("/search?q={query}", { query: "%E3" })).toBe("/search?q=%25E3")
    })

    it("keeps an ASCII slug pattern exactly as an escaped literal", () => {
        expect(slugPattern("demo-title")).toBe("demo-title")
        expect(slugPattern("a.b")).toBe("a\\.b")
    })
})

describe("interpolate error handling", () => {
    it("reports a lone surrogate as an InterpolationError, not a bare URIError", () => {
        expect(() => interpolate("/search?q={query}", { query: "ab\ud800" })).toThrow(InterpolationError)
    })
})

describe("a decimal chapter written with a dash (chapter-10-5 is 10.5)", () => {
    const html = [
        "/manga/demo-title/chapter-9",
        "/manga/demo-title/chapter-10-5",
        "/manga/demo-title/chapter-11",
        "/manga/demo-title/chapter-12-5"
    ]
        .map(href => `<a href="${href}">x</a>`)
        .join("")

    it("does not pin the numeric suffix as a literal in the derived pattern", () => {
        const shape = deriveChapterShape("/manga/demo-title/chapter-10-5")!
        const chapter = new RegExp(shape.chapterMatch).exec("/manga/other-series/chapter-3-5")!
        expect(chapter[1]).toBe("other-series")
        expect(chapter[2]).toBe("3-5")
        expect(new RegExp(shape.chapterMatch).test("/manga/other-series/chapter-4")).toBe(true)
    })

    it("lists all four chapters with the right numbers, from a dashed or a plain sample url", async () => {
        for (const sample of ["/manga/demo-title/chapter-10-5", "/manga/demo-title/chapter-11"]) {
            const { chapters } = await listFor(sample, "/manga/demo-title", html)
            expect(chapters.map(c => c.sortKey)).toEqual([9, 10.5, 11, 12.5])
            expect(chapters.map(c => c.sourceChapterId)).toEqual(["9", "10.5", "11", "12.5"])
        }
    })

    it("resolves a captured chapter-10-5 page as chapter 10.5", async () => {
        const { adapter } = adapterFor("/manga/demo-title/chapter-11")
        const resolved = await adapter.resolveChapter(
            { url: new URL(`${ORIGIN}/manga/demo-title/chapter-10-5`) },
            makeContext({})
        )
        expect(resolved.chapter.sortKey).toBe(10.5)
    })
})

describe("a long ascending chapter list", () => {
    it("keeps the newest chapters, counting chapters rather than raw links", async () => {
        const rows = Array.from({ length: 2500 }, (_, i) => {
            const link = `<a href="/manga/demo-title/chapter-${i + 1}">c</a>`
            return link + link
        }).join("")
        const { chapters } = await listFor("/manga/demo-title/chapter-2", "/manga/demo-title", rows)
        expect(chapters).toHaveLength(2500)
        expect(Math.max(...chapters.map(c => c.sortKey))).toBe(2500)
    })

    it("drops the oldest, not the newest, past the cap, and says so", async () => {
        const rows = Array.from({ length: 5200 }, (_, i) => `<a href="/manga/demo-title/chapter-${i + 1}">c</a>`).join(
            ""
        )
        const warn = vi.fn()
        const { adapter } = adapterFor("/manga/demo-title/chapter-2")
        const ctx = makeContext({ "/manga/demo-title": rows }, [], warn)
        const manga = await adapter.resolveManga({ url: new URL(`${ORIGIN}/manga/demo-title`) }, ctx)
        const chapters = await adapter.listChapters({ manga }, ctx)
        expect(chapters).toHaveLength(5000)
        expect(Math.max(...chapters.map(c => c.sortKey))).toBe(5200)
        expect(Math.min(...chapters.map(c => c.sortKey))).toBe(201)
        expect(warn).toHaveBeenCalledOnce()
    })
})

describe("scraped text and item-pattern boundaries", () => {
    it("decodes entities in chapter titles", async () => {
        const profile = parseProfile({
            profileFormat: 2,
            id: "reader.example",
            name: "Reader",
            engine: "generic",
            numberingKind: "chapter",
            origin: ORIGIN,
            domains: ["reader.example"],
            languages: ["en"],
            capabilities: ["chapters", "manga"],
            requestRateLimit: { requests: 3, intervalMs: 1000 },
            origins: [`${ORIGIN}/*`],
            match: { manga: "^/manga/([^/]+)/?$", chapter: "^/manga/([^/]+)/chapter-([0-9.]+)/?$" },
            series: { urlTemplate: "/manga/{slug}", titlePattern: "<h1>(?<title>[^<]+)</h1>" },
            list: {
                itemPattern:
                    'href="(?<chapterUrl>/manga/{slug}/chapter-(?<chapterNumber>[0-9.]+))">(?<chapterTitle>[^<]*)<'
            }
        })
        if (!profile.ok) throw new Error(profile.error)
        const adapter = createAdapterFromProfile(profile.profile)
        const ctx = makeContext({
            "/manga/demo": `<h1>Tom &amp; Jerry</h1><a href="/manga/demo/chapter-1">The &quot;Cat&quot; &#38; Mouse<`
        })
        const manga = await adapter.resolveManga({ url: new URL(`${ORIGIN}/manga/demo`) }, ctx)
        expect(manga.manga.title).toBe("Tom & Jerry")
        const chapters = await adapter.listChapters({ manga }, ctx)
        expect(chapters[0]?.title).toBe('Ch.1 - The "Cat" & Mouse')
    })

    it("does not let the series-name lead swallow quotes or tags", () => {
        const shape = deriveChapterShape("/manga/one-piece/one-piece-chapter-12")!
        const swallowed = `href="/manga/x/a" title="q" href="/manga/x/ch-chapter-1"`
        const matches = [...swallowed.matchAll(new RegExp(shape.itemPattern.replace("{slug}", "x"), "g"))]
        for (const m of matches) expect(m.groups!["chapterUrl"]).not.toMatch(/["'<>]/)
    })
})
