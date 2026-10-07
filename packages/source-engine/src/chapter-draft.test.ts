import { createBoundedRequestClient, type FetchFunction, type SourceContext } from "@amr/source-sdk"
import { describe, expect, it } from "vitest"
import { createAdapterFromProfile } from "./create-adapter-from-profile"
import {
    deriveChapterShape,
    draftProfileFromChapterPage,
    looksLikeChapterUrl,
    looksLikeReaderPage,
    type CaptureSignals
} from "./draft"
import { probeSource } from "./probe"
import { parseProfile } from "./profile-schema"

describe("deriveChapterShape", () => {
    it("derives the series and chapter shape from a keyword-number segment", () => {
        const shape = deriveChapterShape("/manga/demo-title/chapter-12")!
        expect(shape.slug).toBe("demo-title")
        expect(shape.seriesTemplate).toBe("/manga/{slug}")
        const chapter = new RegExp(shape.chapterMatch).exec("/manga/other-series/chapter-3.5")!
        expect(chapter[1]).toBe("other-series")
        expect(chapter[2]).toBe("3.5")
        expect(new RegExp(shape.mangaMatch).test("/manga/other-series")).toBe(true)
        expect(new RegExp(shape.mangaMatch).test("/manga/other-series/chapter-3")).toBe(false)
    })

    it("keeps a series-name lead generic so it matches other series", () => {
        const shape = deriveChapterShape("/manga/one-piece/one-piece-chapter-12")!
        expect(new RegExp(shape.chapterMatch).test("/manga/bleach/bleach-chapter-9")).toBe(true)
    })

    it("supports a separate keyword segment and a literal tail", () => {
        expect(
            new RegExp(deriveChapterShape("/series/x/chapter/7")!.chapterMatch).exec("/series/y/chapter/8")![2]
        ).toBe("8")
        const viewer = deriveChapterShape("/en/fantasy/tower/ep-1/viewer")!
        expect(viewer.seriesTemplate).toBe("/en/fantasy/{slug}")
        expect(new RegExp(viewer.chapterMatch).test("/en/fantasy/other/ep-4/viewer")).toBe(true)
    })

    it("rejects paths that are not chapter pages", () => {
        for (const path of ["/", "/manga/demo-title", "/search", "/page/2", "/chapter-12"]) {
            expect(deriveChapterShape(path)).toBeUndefined()
        }
    })

    it.each([
        "https://en.wikipedia.org/wiki/Chapter_3",
        "https://example.test/wiki/Some-Show/chapter-3",
        "https://example.test/podcast/my-show/episode-12",
        "https://example.test/tv/my-show/episode-3",
        "https://example.test/news/issue-12",
        "https://example.test/news/the-big-story/issue-12"
    ])("does not treat %s as a reader page", url => {
        expect(looksLikeChapterUrl(url)).toBe(false)
    })

    it("still accepts reader urls whose series or site name merely resembles a non-reader word", () => {
        expect(looksLikeChapterUrl("https://example.test/manga/tv-show-girl/chapter-3")).toBe(true)
        expect(looksLikeChapterUrl("https://example.test/series/news-room/chapter-3")).toBe(true)
    })

    it("looksLikeChapterUrl is a cheap url-only check", () => {
        expect(looksLikeChapterUrl("https://example.test/manga/a/chapter-1")).toBe(true)
        expect(looksLikeChapterUrl("https://example.test/about")).toBe(false)
        expect(looksLikeChapterUrl("not a url")).toBe(false)
    })
})

const CHAPTER_URL = "https://reader.example/manga/demo-title/chapter-2"

function chapterSignals(extra?: Partial<CaptureSignals>): CaptureSignals {
    return {
        url: CHAPTER_URL,
        ogTitle: "Demo Title Chapter 2 | Example Reader",
        ogSiteName: "Example Reader",
        links: [
            { href: "/manga/demo-title/chapter-1", text: "Prev" },
            { href: "/manga/demo-title/chapter-3", text: "Next" }
        ],
        images: [],
        ...extra
    }
}

describe("draftProfileFromChapterPage", () => {
    it("drafts a valid format-2 profile from the chapter url shape", () => {
        const draft = draftProfileFromChapterPage(chapterSignals())!
        const parsed = parseProfile(draft.profile)
        expect(parsed.ok).toBe(true)
        expect(draft.profile["profileFormat"]).toBe(2)
        expect(draft.profile["name"]).toBe("Example Reader")
        expect(draft.profile["domains"]).toEqual(["reader.example", "www.reader.example"])
        expect(draft.profile["origins"]).toEqual(["https://reader.example/*", "https://www.reader.example/*"])
        expect(draft.profile["pages"]).toBeUndefined()
        expect(draft.seriesUrl).toBe("https://reader.example/manga/demo-title")
        expect(draft.matchOk).toBe(true)
    })

    it("covers the www twin of an apex host, and only the host itself for a www host", () => {
        const apex = draftProfileFromChapterPage(chapterSignals())!
        expect(apex.profile["domains"]).toEqual(["reader.example", "www.reader.example"])
        const www = draftProfileFromChapterPage(
            chapterSignals({ url: "https://www.reader.example/manga/demo-title/chapter-2" })
        )!
        expect(www.profile["domains"]).toEqual(["www.reader.example"])
        expect(www.profile["origins"]).toEqual(["https://www.reader.example/*"])
        expect(www.profile["id"]).toBe(apex.profile["id"])
    })

    it("names a country-code registry host by its real label", () => {
        const draft = draftProfileFromChapterPage(
            chapterSignals({ ogSiteName: undefined, url: "https://www.foo.co.uk/manga/demo-title/chapter-2" })
        )!
        expect(draft.profile["name"]).toBe("Foo")
    })

    it("takes the language from the document, defaulting to English", () => {
        expect(draftProfileFromChapterPage(chapterSignals({ lang: "pt-BR" }))!.profile["languages"]).toEqual(["pt"])
        expect(draftProfileFromChapterPage(chapterSignals({ lang: "klingon-x-y" }))!.profile["languages"]).toEqual([
            "en"
        ])
        expect(draftProfileFromChapterPage(chapterSignals())!.profile["languages"]).toEqual(["en"])
    })

    it("falls back to the host name when the page has no site name", () => {
        const draft = draftProfileFromChapterPage(chapterSignals({ ogSiteName: undefined, url: CHAPTER_URL }))!
        expect(draft.profile["name"]).toBe("Reader")
    })

    it("reports matchOk false when the page links do not corroborate the shape", () => {
        const draft = draftProfileFromChapterPage(chapterSignals({ links: [{ href: "/about", text: "About" }] }))!
        expect(draft.matchOk).toBe(false)
    })

    it("is matchOk with no links at all (url-only draft)", () => {
        expect(draftProfileFromChapterPage(chapterSignals({ links: [] }))!.matchOk).toBe(true)
    })

    it("returns undefined for a non-chapter page", () => {
        expect(draftProfileFromChapterPage(chapterSignals({ url: "https://reader.example/about" }))).toBeUndefined()
    })

    it("carries no circumvention field (token, nonce, signature, header, drm)", () => {
        const text = JSON.stringify(draftProfileFromChapterPage(chapterSignals())!.profile).toLowerCase()
        for (const banned of ["token", "nonce", "signature", "header", "drm", "cookie"]) {
            expect(text).not.toContain(banned)
        }
    })
})

describe("looksLikeReaderPage", () => {
    const base = chapterSignals()

    it("accepts a page with several page-sized images", () => {
        expect(looksLikeReaderPage({ ...base, largeImages: 4 })).toBe(true)
    })

    it("accepts a reader container that holds images", () => {
        expect(looksLikeReaderPage({ ...base, readerContainer: true, largeImages: 1 })).toBe(true)
        expect(looksLikeReaderPage({ ...base, readerContainer: true, images: ["/a.jpg", "/b.jpg"] })).toBe(true)
    })

    it("rejects text pages and pages with only icons or a lone image", () => {
        expect(looksLikeReaderPage({ ...base, largeImages: 0 })).toBe(false)
        expect(looksLikeReaderPage({ ...base, largeImages: 1 })).toBe(false)
        expect(looksLikeReaderPage({ ...base, readerContainer: true })).toBe(false)
        expect(looksLikeReaderPage(base)).toBe(false)
    })
})

describe("a drafted profile works end to end through the engine", () => {
    const seriesHtml = `<html><head><meta property="og:title" content="Demo Title - Example Reader" /></head><body>
<a href="/manga/demo-title/chapter-1">Chapter 1</a>
<a href="https://reader.example/manga/demo-title/chapter-2/">Chapter 2</a>
<a href="/manga/other-series/chapter-99">Sidebar</a>
</body></html>`

    function context(): SourceContext {
        const fetch: FetchFunction = async url => {
            const path = new URL(url).pathname
            const body = path === "/manga/demo-title" ? seriesHtml : undefined
            return { ok: body !== undefined, status: body === undefined ? 404 : 200, text: async () => body ?? "" }
        }
        return {
            request: createBoundedRequestClient({
                fetch,
                allowedOrigins: ["https://reader.example/*"],
                maxRequests: 20,
                maxResponseBytes: 1_000_000,
                timeoutMs: 1000
            }),
            now: () => 1,
            logger: { debug: () => undefined, warn: () => undefined }
        }
    }

    it("lists only the series' own chapters (the {slug} token excludes a sidebar of other titles)", async () => {
        const draft = draftProfileFromChapterPage(chapterSignals())!
        const parsed = parseProfile(draft.profile)
        if (!parsed.ok) throw new Error(parsed.error)
        const adapter = createAdapterFromProfile(parsed.profile)
        const manga = await adapter.resolveManga({ url: new URL(draft.seriesUrl) }, context())
        const chapters = await adapter.listChapters({ manga }, context())
        expect(chapters.map(c => c.sortKey)).toEqual([1, 2])
        expect(chapters[1]!.url).toBe("https://reader.example/manga/demo-title/chapter-2/")
    })

    it("probeSource verifies a search-less draft when given its series url", async () => {
        const draft = draftProfileFromChapterPage(chapterSignals())!
        const parsed = parseProfile(draft.profile)
        if (!parsed.ok) throw new Error(parsed.error)
        const report = await probeSource(parsed.profile, context(), { seriesUrl: draft.seriesUrl })
        expect(report.ok).toBe(true)
        expect(report.stages.map(s => s.stage)).toEqual(["series", "chapters"])
    })

    it("probeSource fails a draft whose series page does not exist", async () => {
        const draft = draftProfileFromChapterPage(chapterSignals())!
        const parsed = parseProfile(draft.profile)
        if (!parsed.ok) throw new Error(parsed.error)
        const report = await probeSource(parsed.profile, context(), {
            seriesUrl: "https://reader.example/manga/missing"
        })
        expect(report.ok).toBe(false)
    })
})

describe("draftProfileFromChapterPage hardening", () => {
    it("never runs the link-based list guess on a hostile 20KB href", () => {
        const started = Date.now()
        const draft = draftProfileFromChapterPage({
            url: "https://reader.example/manga/demo-title/chapter-2",
            links: [{ href: `/manga/demo-title/chapter-${"7".repeat(20_000)}`, text: "x" }],
            images: []
        })
        expect(Date.now() - started).toBeLessThan(500)
        expect(draft).toBeDefined()
        expect((draft!.profile["list"] as { itemPattern: string }).itemPattern).toContain("{slug}")
    })

    it("treats $ replacement tokens in the slug literally", () => {
        const draft = draftProfileFromChapterPage({
            url: "https://reader.example/manga/a$&b/chapter-2",
            links: [{ href: "/manga/a$&b/chapter-1", text: "Prev" }],
            images: []
        })
        expect(draft).toBeDefined()
        expect(draft!.seriesUrl).toContain("/manga/a$&b")
        expect(draft!.matchOk).toBe(true)
    })
})
