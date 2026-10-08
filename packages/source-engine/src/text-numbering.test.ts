import { createBoundedRequestClient, type FetchFunction, type SourceContext } from "@amr/source-sdk"
import { describe, expect, it } from "vitest"
import { createAdapterFromProfile } from "./create-adapter-from-profile"
import { deriveChapterShape, draftProfileFromChapterPage, looksLikeChapterUrl, type CaptureSignals } from "./draft"
import { parseProfile, regexComplexityIssue } from "./profile-schema"

const ORIGIN = "https://mangafire.example"
const CHAPTER_URL = `${ORIGIN}/title/demo-title.abc/chapter/9475194`

function signals(extra: Partial<CaptureSignals> = {}): CaptureSignals {
    return {
        url: CHAPTER_URL,
        ogSiteName: "MangaFire Example",
        docTitle: "Demo Title - Chapter 86 - MangaFire Example",
        links: [
            { href: "/title/demo-title.abc/chapter/9475192", text: "Ch. 84" },
            { href: "/title/demo-title.abc/chapter/9475193", text: "Ch. 85" },
            { href: "/title/demo-title.abc/chapter/9475194", text: "Ch. 86" },
            { href: "/title/other-title.xyz/chapter/9400001", text: "Ch. 3" }
        ],
        images: [],
        ...extra
    }
}

const SERIES_HTML = `<html><head><meta property="og:title" content="Demo Title - MangaFire Example" /></head><body>
<ul>
<li><a href="/title/demo-title.abc/chapter/9475194"><span>Ch. 86</span></a></li>
<li><a class="x" href="https://mangafire.example/title/demo-title.abc/chapter/9475193/">Chapter 85: The Gate</a></li>
<li><a href="/title/demo-title.abc/chapter/9475192">
    Ch. 84
</a></li>
<li><a href="/title/demo-title.abc/chapter/9475000">Read first</a></li>
<li><a href="/title/other-title.xyz/chapter/9400001">Ch. 3</a></li>
</ul></body></html>`

function context(body: string): SourceContext {
    const fetch: FetchFunction = async url => {
        const ok = new URL(url).pathname === "/title/demo-title.abc"
        return { ok, status: ok ? 200 : 404, text: async () => (ok ? body : "") }
    }
    return {
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

describe("deriveChapterShape with an internal-id chapter segment", () => {
    it("recognises /chapter/{7+ digit id} and flags the id as opaque", () => {
        const shape = deriveChapterShape("/title/demo-title.abc/chapter/9475194")!
        expect(shape.opaqueId).toBe(true)
        expect(shape.slug).toBe("demo-title.abc")
        expect(new RegExp(shape.chapterMatch).exec("/title/other.xyz/chapter/12345678")![1]).toBe("other.xyz")
        expect(looksLikeChapterUrl(CHAPTER_URL)).toBe(true)
    })

    it("flags a 6-digit id at or above the opaque floor, but not an ordinary chapter number", () => {
        expect(deriveChapterShape("/manga/a/chapter/123456")!.opaqueId).toBe(true)
        expect(deriveChapterShape("/manga/a/chapter/99999")!.opaqueId).toBe(false)
        expect(deriveChapterShape("/manga/a/chapter-12")!.opaqueId).toBe(false)
        expect(deriveChapterShape("/manga/a/chapter-123456")!.opaqueId).toBe(true)
    })

    it("still rejects a long digit run that is not behind a chapter keyword", () => {
        expect(deriveChapterShape("/title/a/9475194")).toBeUndefined()
    })

    it("builds an itemTextPattern that passes the ReDoS screen and captures url + text", () => {
        const shape = deriveChapterShape("/title/demo-title.abc/chapter/9475194")!
        expect(regexComplexityIssue(shape.itemTextPattern)).toBeUndefined()
        expect(shape.itemTextPattern).toContain("(?<chapterText>")
        expect(shape.itemTextPattern).not.toContain("chapterNumber")
    })
})

describe("draftProfileFromChapterPage on a text-numbered site", () => {
    it("takes the number from the current chapter's link text", () => {
        const draft = draftProfileFromChapterPage(signals())!
        expect(draft.profile["numberSource"]).toBe("text")
        expect(draft.profile["numberingKind"]).toBe("chapter")
        const list = draft.profile["list"] as { itemPattern: string; itemTextPattern: string }
        expect(list.itemTextPattern).toContain("(?<chapterText>")
        expect(parseProfile(draft.profile).ok).toBe(true)
        expect(draft.matchOk).toBe(true)
    })

    it("falls back to the page's active chapter text, then to a labelled page title", () => {
        const noOwnLink = signals({ links: [] })
        expect(
            draftProfileFromChapterPage({ ...noOwnLink, activeChapterText: "Ch. 86" })!.profile["numberSource"]
        ).toBe("text")
        expect(draftProfileFromChapterPage(noOwnLink)!.profile["numberSource"]).toBe("title")
    })

    it("does not trust a bare trailing number in a page title", () => {
        const draft = draftProfileFromChapterPage(signals({ links: [], docTitle: "Mob Psycho 100" }))
        expect(draft).toBeUndefined()
    })

    it("does not draft a long-id site when no readable number exists anywhere", () => {
        expect(draftProfileFromChapterPage(signals({ links: [], docTitle: undefined }))).toBeUndefined()
    })

    it("keeps a short internal id on the url reading when no text number exists", () => {
        const draft = draftProfileFromChapterPage({
            url: `${ORIGIN}/manga/demo/chapter/123456`,
            links: [],
            images: []
        })!
        expect(draft.profile["numberSource"]).toBeUndefined()
        expect((draft.profile["list"] as Record<string, unknown>)["itemTextPattern"]).toBeUndefined()
    })

    it("infers the numbering kind from the dominant label kind", () => {
        const draft = draftProfileFromChapterPage(
            signals({
                links: [
                    { href: "/title/demo-title.abc/chapter/9475192", text: "Vol. 1" },
                    { href: "/title/demo-title.abc/chapter/9475193", text: "Vol. 2" },
                    { href: "/title/demo-title.abc/chapter/9475194", text: "Vol. 3" }
                ]
            })
        )!
        expect(draft.profile["numberingKind"]).toBe("volume")
    })

    it("leaves a url-numbered draft untouched (additive)", () => {
        const draft = draftProfileFromChapterPage({
            url: "https://reader.example/manga/demo-title/chapter-2",
            links: [],
            images: []
        })!
        expect(draft.profile["numberSource"]).toBeUndefined()
        expect(draft.profile["numberingKind"]).toBe("chapter")
        expect(Object.keys(draft.profile["list"] as object)).toEqual(["itemPattern"])
    })

    it("carries no circumvention field", () => {
        const text = JSON.stringify(draftProfileFromChapterPage(signals())!.profile).toLowerCase()
        for (const banned of ["token", "nonce", "signature", "header", "drm", "cookie"]) {
            expect(text).not.toContain(banned)
        }
    })
})

describe("createAdapterFromProfile with numberSource text", () => {
    async function listFor(html: string) {
        const draft = draftProfileFromChapterPage(signals())!
        const parsed = parseProfile(draft.profile)
        if (!parsed.ok) throw new Error(parsed.error)
        const adapter = createAdapterFromProfile(parsed.profile)
        const manga = await adapter.resolveManga({ url: new URL(draft.seriesUrl) }, context(html))
        return adapter.listChapters({ manga }, context(html))
    }

    it("numbers chapters from the link text, not the href digits", async () => {
        const chapters = await listFor(SERIES_HTML)
        expect(chapters.map(c => c.sortKey).sort((a, b) => a - b)).toEqual([84, 85, 86])
        const byKey = new Map(chapters.map(c => [c.sortKey, c]))
        expect(byKey.get(86)!.url).toBe(`${ORIGIN}/title/demo-title.abc/chapter/9475194`)
        expect(byKey.get(85)!.sourceChapterId).toBe("85")
        expect(byKey.get(84)!.title).toBe("Ch.84")
    })

    it("skips links whose text names no chapter and other titles' chapters", async () => {
        const chapters = await listFor(SERIES_HTML)
        expect(chapters).toHaveLength(3)
        expect(chapters.some(c => c.url.includes("other-title"))).toBe(false)
        expect(chapters.some(c => c.url.endsWith("9475000"))).toBe(false)
    })

    it("reads decimal and prefixed labels", async () => {
        const html = `<a href="/title/demo-title.abc/chapter/9475201">Chapter 10.5</a>
<a href="/title/demo-title.abc/chapter/9475202">#11</a><a href="/title/demo-title.abc/chapter/9475203">Episode 12 - Title</a>`
        const chapters = await listFor(html)
        expect(chapters.map(c => c.sortKey).sort((a, b) => a - b)).toEqual([10.5, 11, 12])
    })

    it("resolveChapter leaves a text-numbered chapter unnumbered (the id is not a number)", async () => {
        const draft = draftProfileFromChapterPage(signals())!
        const parsed = parseProfile(draft.profile)
        if (!parsed.ok) throw new Error(parsed.error)
        const adapter = createAdapterFromProfile(parsed.profile)
        const resolved = await adapter.resolveChapter({ url: new URL(CHAPTER_URL) }, context(SERIES_HTML))
        expect(resolved.chapter.sortKey).toBe(Number.POSITIVE_INFINITY)
        expect(resolved.chapter.sourceChapterId).toBe("9475194")
    })

    it("a url-numbered profile still numbers from the href", async () => {
        const draft = draftProfileFromChapterPage({
            url: "https://reader.example/manga/demo-title/chapter-2",
            links: [],
            images: []
        })!
        const parsed = parseProfile(draft.profile)
        if (!parsed.ok) throw new Error(parsed.error)
        const adapter = createAdapterFromProfile(parsed.profile)
        const html = `<a href="/manga/demo-title/chapter-1">Whatever</a><a href="/manga/demo-title/chapter-2">Ch. 99</a>`
        const fetch: FetchFunction = async () => ({ ok: true, status: 200, text: async () => html })
        const ctx: SourceContext = {
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
        const manga = await adapter.resolveManga({ url: new URL(draft.seriesUrl) }, ctx)
        const chapters = await adapter.listChapters({ manga }, ctx)
        expect(chapters.map(c => c.sortKey)).toEqual([1, 2])
    })
})

describe("profile schema: numberSource and itemTextPattern", () => {
    const base = (): Record<string, unknown> => draftProfileFromChapterPage(signals())!.profile

    it("accepts the new optional fields and rejects a bad numberSource", () => {
        expect(parseProfile(base()).ok).toBe(true)
        expect(parseProfile({ ...base(), numberSource: "dom" }).ok).toBe(false)
        expect(parseProfile({ ...base(), numberSource: "title" }).ok).toBe(true)
    })

    it("requires chapterUrl and chapterText groups and the ReDoS screen on itemTextPattern", () => {
        const withText = (itemTextPattern: string): Record<string, unknown> => ({
            ...base(),
            list: { itemPattern: 'href="(?<chapterUrl>/c/1)"', itemTextPattern }
        })
        expect(parseProfile(withText('<a href="(?<chapterUrl>/c/[0-9]+)">(?<chapterText>[^<]+)')).ok).toBe(true)
        expect(parseProfile(withText('<a href="(?<chapterUrl>/c/[0-9]+)">')).ok).toBe(false)
        expect(parseProfile(withText("(?<chapterUrl>(a+)+)(?<chapterText>x)")).ok).toBe(false)
    })

    it("stays strict: unknown fields are still rejected", () => {
        expect(parseProfile({ ...base(), numberHeader: "x" }).ok).toBe(false)
    })
})
