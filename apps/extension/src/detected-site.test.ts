import { describe, expect, it } from "vitest"
import { chaptersFromObservedList } from "./observed-chapter-list"
import { detectedPageFor, detectedSourceIdFor, isDetectedSourceId, siteIdForHost } from "./detected-site"

const SLUG_PAGE = "https://reader.example/manga/demo-title/chapter-4"
const BARE_PAGE = "https://reader.example/read/demo-title/12"
const OPAQUE_PAGE = "https://mangafire.example/title/demo-title.abc/chapter/9475194"

function page(url: string) {
    const found = detectedPageFor(url)
    if (!found) throw new Error(`expected ${url} to be detected`)
    return found
}
const u = (s: string) => new URL(s)

describe("detectedPageFor", () => {
    it("derives the identity from the chapter URL alone", () => {
        const p = page(SLUG_PAGE)
        expect(p.sourceId).toBe("detected:reader.example")
        expect(p.sourceMangaId).toBe("demo-title")
        expect(p.mangaUrl).toBe("https://reader.example/manga/demo-title")
        expect(p.numberFromUrl).toBe(true)
    })

    it("files a www host under the same id as its apex", () => {
        expect(page("https://www.reader.example/manga/demo-title/chapter-4").sourceId).toBe("detected:reader.example")
        expect(siteIdForHost("WWW.Reader.Example")).toBe("reader.example")
        expect(detectedSourceIdFor("www.reader.example")).toBe("detected:reader.example")
    })

    it("recognises the chapter shape of a slug, a bare number and an opaque id", () => {
        for (const url of [
            SLUG_PAGE,
            "https://reader.example/series/x-y/ch-12.5",
            BARE_PAGE.replace("/12", "/chapter/12")
        ]) {
            expect(detectedPageFor(url), url).toBeDefined()
        }
        const opaque = page(OPAQUE_PAGE)
        expect(opaque.numberFromUrl).toBe(false)
        expect(opaque.sourceMangaId).toBe("demo-title.abc")
    })

    it("matches a chapter of the same shape and a series page, and nothing else", () => {
        const p = page(SLUG_PAGE)
        expect(p.match(u("https://reader.example/manga/demo-title/chapter-9"))).toBe("chapter")
        expect(p.match(u("https://reader.example/manga/other-title/chapter-9"))).toBe("chapter")
        expect(p.match(u("https://reader.example/manga/demo-title"))).toBe("manga")
        expect(p.match(u("https://reader.example/about/us/now"))).toBe("none")
        expect(p.match(u("https://reader.example/"))).toBe("none")
    })

    it("names the series a chapter belongs to, so another title is rejected", () => {
        const p = page(SLUG_PAGE)
        expect(p.ownerOf(u("https://reader.example/manga/demo-title/chapter-9"))).toBe("demo-title")
        expect(p.ownerOf(u("https://reader.example/manga/other-title/chapter-9"))).toBe("other-title")
        expect(p.ownerOf(u("https://reader.example/manga/demo-title"))).toBeUndefined()
    })

    it("only matches the page's own origin and its www/apex twin", () => {
        const p = page(SLUG_PAGE)
        expect(p.allowedOrigins).toEqual(["https://reader.example/*", "https://www.reader.example/*"])
        expect(p.match(u("https://www.reader.example/manga/demo-title/chapter-9"))).toBe("chapter")
        expect(p.match(u("https://evil.example/manga/demo-title/chapter-9"))).toBe("none")
        expect(p.match(u("https://cdn.reader.example/manga/demo-title/chapter-9"))).toBe("none")
        expect(p.match(u("http://reader.example/manga/demo-title/chapter-9"))).toBe("none")
        expect(p.ownerOf(u("https://evil.example/manga/demo-title/chapter-9"))).toBeUndefined()
        expect(page("https://www.reader.example/manga/demo-title/chapter-4").allowedOrigins).toEqual([
            "https://www.reader.example/*",
            "https://reader.example/*"
        ])
    })

    it("refuses pages that are not a reader of the open web", () => {
        for (const url of [
            "https://en.wikipedia.org/manga/demo-title/chapter-4",
            "https://www.youtube.com/watch/demo-title/episode-4",
            "https://weeb.ltd/manga/demo-title/chapter-4",
            "https://mangadex.org/title/demo-title/chapter-4",
            "https://reader.example/news/demo-title/chapter-4",
            "https://reader.example/podcast/my-show/episode-12",
            "https://reader.example/wiki/Demo/chapter-3",
            "http://reader.example/manga/demo-title/chapter-4",
            "https://reader.example:8443/manga/demo-title/chapter-4",
            "https://localhost/manga/demo-title/chapter-4",
            "https://192.168.1.4/manga/demo-title/chapter-4",
            "https://reader.example/about",
            "not a url"
        ]) {
            expect(detectedPageFor(url), url).toBeUndefined()
        }
    })

    it("is identified by its namespace", () => {
        expect(isDetectedSourceId("detected:reader.example")).toBe(true)
        expect(isDetectedSourceId("reader.example")).toBe(false)
        expect(isDetectedSourceId("mangadex")).toBe(false)
    })
})

describe("chaptersFromObservedList with a detected page", () => {
    const run = (url: string, items: Array<{ url: string; text: string }>) => {
        const p = page(url)
        return chaptersFromObservedList({
            sourceId: p.sourceId,
            match: p.match,
            ownerOf: p.ownerOf,
            allowedOrigins: p.allowedOrigins,
            sourceMangaId: p.sourceMangaId,
            mangaId: `${p.sourceId}:manga:${p.sourceMangaId}`,
            numberFromUrl: p.numberFromUrl,
            items
        })
    }
    const link = (n: number, text = `Chapter ${n}`) => ({
        url: `https://reader.example/manga/demo-title/chapter-${n}`,
        text
    })

    it("keeps the title's own chapters and drops foreign, other-title and non-chapter links", () => {
        const chapters = run(SLUG_PAGE, [
            link(5),
            link(4),
            { url: "https://evil.example/manga/demo-title/chapter-9", text: "Chapter 9" },
            { url: "https://reader.example/manga/other-title/chapter-8", text: "Chapter 8" },
            { url: "https://reader.example/about", text: "Chapter 7" },
            { url: "javascript:alert(1)", text: "Chapter 6" }
        ])
        expect(chapters.map(c => c.sortKey).sort()).toEqual([4, 5])
        expect(chapters.every(c => c.sourceId === "detected:reader.example")).toBe(true)
        expect(chapters[0]?.id).toMatch(/^detected:reader\.example:chapter:demo-title:\d$/)
    })

    it("reads an opaque-id site's numbers from the link text, never from the id", () => {
        const chapters = run(OPAQUE_PAGE, [
            { url: "https://mangafire.example/title/demo-title.abc/chapter/9475196", text: "Ch. 86" },
            { url: "https://mangafire.example/title/demo-title.abc/chapter/9475195", text: "Read first" },
            { url: "https://mangafire.example/title/other.xyz/chapter/9400099", text: "Ch. 3" }
        ])
        expect(chapters.map(c => c.sortKey)).toEqual([86])
    })
})

describe("the detected matcher stays local", () => {
    it("makes no request of its own: it is a pure function of one address", async () => {
        const { readFileSync } = await import("node:fs")
        const { fileURLToPath } = await import("node:url")
        const source = readFileSync(fileURLToPath(new URL("./detected-site.ts", import.meta.url)), "utf8")
        expect(source).not.toMatch(/\bfetch\(|XMLHttpRequest|sendMessage|browser\.|chrome\./)
    })
})

describe("a flat chapter scheme with the title inside the chapter segment", () => {
    const FLAT = "https://reader.example/manga/one-piece-chapter-12"

    it("files the title under its own slug, never the static directory", () => {
        const p = page(FLAT)
        expect(p.sourceMangaId).toBe("one-piece")
        expect(p.sourceMangaId).not.toBe("manga")
        expect(p.mangaUrl).toBe("https://reader.example/manga/one-piece")
    })

    it("tells titles apart, so a latest-updates link to another title is rejected from this one", () => {
        const p = page(FLAT)
        expect(p.ownerOf(u("https://reader.example/manga/one-piece-chapter-13"))).toBe("one-piece")
        expect(p.ownerOf(u("https://reader.example/manga/bleach-chapter-5"))).toBe("bleach")
        const items = [
            { url: "https://reader.example/manga/one-piece-chapter-11", text: "Chapter 11" },
            { url: "https://reader.example/manga/bleach-chapter-5", text: "Chapter 5" }
        ]
        const rows = chaptersFromObservedList({
            sourceId: p.sourceId,
            match: p.match,
            ownerOf: p.ownerOf,
            allowedOrigins: p.allowedOrigins,
            sourceMangaId: p.sourceMangaId,
            mangaId: "m",
            numberFromUrl: p.numberFromUrl,
            items
        })
        expect(rows.map(row => row.sortKey)).toEqual([11])
    })

    it("does not pool foreign titles when the title contains the directory word", () => {
        const p = page("https://reader.example/comic/comics-world-chapter-5")
        // The title "comics-world" contains the directory "comic"; it must still be its own slug,
        // not collapse onto the directory (which would pool every /comic/ title into one record).
        expect(p.sourceMangaId).toBe("comics-world")
        expect(p.sourceMangaId).not.toBe("comic")
        expect(p.ownerOf(u("https://reader.example/comic/naruto-chapter-7"))).toBe("naruto")
    })

    it("treats a real slug directory as the series, not the embedded filename title", () => {
        // /comic/12345/one-piece-chapter-3 - the numeric "12345" is the series id directory, so the
        // slug is 12345 and the embedded filename title must not swallow it.
        const p = page("https://reader.example/comic/12345/one-piece-chapter-3")
        expect(p.sourceMangaId).toBe("12345")
        expect(p.mangaUrl).toBe("https://reader.example/comic/12345")
    })
})

describe("the chapter number a detected address spells out", () => {
    const NUMBERED = [
        ["https://reader.example/series/x/episode-12", 12],
        ["https://reader.example/series/x/ep-3", 3],
        ["https://reader.example/series/x/ch-12", 12],
        ["https://reader.example/series/x/chap_7", 7],
        ["https://reader.example/series/x/chapter.5", 5],
        ["https://reader.example/series/x/issue-9", 9],
        ["https://reader.example/series/x/chapter-10-5", 10.5],
        ["https://reader.example/series/x/chapter/6", 6],
        ["https://reader.example/read/demo-title/12", undefined]
    ] as const

    it("is always readable when the page says the number comes from the address", () => {
        for (const [url] of NUMBERED) {
            const found = detectedPageFor(url)
            if (!found?.numberFromUrl) continue
            expect(found.numberOf(u(url)), url).toBeTypeOf("number")
        }
    })

    it("reads the number with the matcher that recognised the chapter", () => {
        for (const [url, expected] of NUMBERED) {
            if (expected === undefined) continue
            expect(page(url).numberOf(u(url)), url).toBe(expected)
        }
    })

    it("reads none for an internal chapter id or another site", () => {
        const opaque = page(OPAQUE_PAGE)
        expect(opaque.numberOf(u(OPAQUE_PAGE))).toBeUndefined()
        expect(page(SLUG_PAGE).numberOf(u("https://evil.example/manga/demo-title/chapter-9"))).toBeUndefined()
    })
})

describe("hardening of the detected matcher", () => {
    it("ignores a trailing dot when naming the site", () => {
        expect(siteIdForHost("Reader.Example.")).toBe("reader.example")
        expect(detectedSourceIdFor("www.reader.example.")).toBe("detected:reader.example")
    })

    it("never groups titles under a registry or shared-hosting suffix", () => {
        for (const host of ["co.uk", "www.co.uk", "github.io", "vercel.app", "com.au"]) {
            expect(detectedPageFor(`https://${host}/manga/demo-title/chapter-4`), host).toBeUndefined()
        }
        expect(detectedPageFor("https://my-site.github.io/manga/demo-title/chapter-4")).toBeDefined()
        expect(detectedPageFor("https://reader.co.uk/manga/demo-title/chapter-4")).toBeDefined()
    })

    it("only matches the default https port of its own origin", () => {
        const p = page(SLUG_PAGE)
        const elsewhere = u("https://reader.example:8443/manga/demo-title/chapter-9")
        expect(p.match(elsewhere)).toBe("none")
        expect(p.ownerOf(elsewhere)).toBeUndefined()
        expect(p.numberOf(elsewhere)).toBeUndefined()
        expect(p.match(u("https://reader.example/manga/demo-title/chapter-9"))).toBe("chapter")
    })
})

describe("a visit and an observed list derive one number from one address", () => {
    const ADDRESSES = [
        "https://reader.example/series/demo/chapter-10-5",
        "https://reader.example/series/demo/chapter.5",
        "https://reader.example/series/demo/issue-9",
        "https://reader.example/series/demo/episode-12",
        "https://reader.example/series/demo/ch_3_5",
        "https://reader.example/series/demo/chap-7"
    ]

    it.each(ADDRESSES)("agrees on %s", address => {
        const p = page(address)
        const visit = p.numberOf(u(address))
        const rows = chaptersFromObservedList({
            sourceId: p.sourceId,
            match: p.match,
            ownerOf: p.ownerOf,
            allowedOrigins: p.allowedOrigins,
            sourceMangaId: p.sourceMangaId,
            mangaId: "m",
            numberFromUrl: p.numberFromUrl,
            items: [{ url: address, text: "Read now" }]
        })
        expect(visit).toBeTypeOf("number")
        expect(rows.map(row => row.sortKey)).toEqual([visit])
    })

    it("reads a dash decimal as a decimal, not as its integer part", () => {
        const address = "https://reader.example/series/demo/chapter-10-5"
        const rows = chaptersFromObservedList({
            ...page(address),
            sourceMangaId: "demo",
            mangaId: "m",
            items: [{ url: address, text: "Read now" }]
        })
        expect(rows.map(row => row.sortKey)).toEqual([10.5])
    })
})
