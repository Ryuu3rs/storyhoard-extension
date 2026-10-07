import { createBoundedRequestClient, type FetchFunction, type SourceContext } from "@amr/source-sdk"
import { describe, expect, it } from "vitest"
import { createAdapterFromProfile } from "./create-adapter-from-profile"
import { parseProfile, type SiteProfile } from "./profile-schema"

const ORIGIN = "https://example-scans.test"
const SLUG = "demo-title"

// A declarative profile for a fictional static-HTML site. No code, no token recipes - just
// regexes and templates. This is what a user would import.
const rawProfile = {
    profileFormat: 1,
    id: "example-scans",
    name: "Example Scans",
    engine: "generic",
    origin: "https://example-scans.test",
    domains: ["example-scans.test"],
    languages: ["en"],
    capabilities: ["pages", "chapters"],
    requestRateLimit: { requests: 3, intervalMs: 1000 },
    origins: ["https://example-scans.test/*"],
    match: {
        manga: "^/manga/([a-z0-9-]+)/?$",
        chapter: "^/manga/([a-z0-9-]+)/ch-([0-9.]+)/?$"
    },
    series: {
        urlTemplate: "/manga/{slug}",
        titlePattern: '<meta property="og:title" content="(?<title>[^"]+)"',
        coverPattern: '<meta property="og:image" content="(?<cover>[^"]+)"'
    },
    list: {
        itemPattern:
            '<a href="(?<chapterUrl>/manga/[a-z0-9-]+/ch-(?<chapterNumber>[0-9.]+))">(?<chapterTitle>[^<]*)</a>'
    },
    pages: {
        imagePatterns: ['<img class="page" src="(?<url>[^"]+)"'],
        exclude: "/ads/"
    },
    search: {
        urlTemplate: "/search?q={query}",
        itemPattern: '<a class="result" href="(?<url>[^"]+)">(?<title>[^<]+)</a>'
    }
}

const seriesHtml = `<!doctype html><html><head>
<meta property="og:title" content="Demo Title" />
<meta property="og:image" content="https://example-scans.test/covers/demo.jpg" />
</head><body>
<a href="/manga/demo-title/ch-1">First</a>
<a href="/manga/demo-title/ch-2">Second</a>
</body></html>`

const chapterHtml = `<html><body>
<img class="page" src="https://cdn.example-scans.test/ch/1/001.webp" />
<img class="page" src="https://cdn.example-scans.test/ch/1/002.webp" />
<img class="page" src="https://cdn.example-scans.test/ads/promo.webp" />
</body></html>`

const searchHtml = `<html><body>
<a class="result" href="/manga/demo-title">Demo Title</a>
</body></html>`

function createContext(fixtures: Readonly<Record<string, string>>): SourceContext {
    const fetch: FetchFunction = async url => {
        const key = new URL(url).pathname + new URL(url).search
        const body = fixtures[key] ?? fixtures[new URL(url).pathname]
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
    [`/manga/${SLUG}`]: seriesHtml,
    [`/manga/${SLUG}/ch-1`]: chapterHtml,
    "/search?q=demo": searchHtml
}

function profile(): SiteProfile {
    const parsed = parseProfile(rawProfile)
    if (!parsed.ok) throw new Error(parsed.error)
    return parsed.profile
}

describe("format 2 (on-site: chapter-list fetch, no image extraction)", () => {
    function v2Profile(): SiteProfile {
        const { pages: _pages, ...rest } = rawProfile
        const parsed = parseProfile({
            ...rest,
            profileFormat: 2,
            numberingKind: "chapter",
            capabilities: ["chapters", "manga"]
        })
        if (!parsed.ok) throw new Error(parsed.error)
        return parsed.profile
    }

    it("still fetches and parses the chapter list (background update-checks keep working)", async () => {
        const a = createAdapterFromProfile(v2Profile())
        const ctx = createContext(fixtures)
        const manga = await a.resolveManga({ url: new URL(`${ORIGIN}/manga/${SLUG}`) }, ctx)
        const chapters = await a.listChapters({ manga }, ctx)
        expect(chapters.map(c => c.sortKey)).toEqual([1, 2])
    })

    it("resolveChapter is inert - returns the chapter with no pages, never fetches images", async () => {
        const a = createAdapterFromProfile(v2Profile())
        const resolved = await a.resolveChapter(
            { url: new URL(`${ORIGIN}/manga/${SLUG}/ch-1`) },
            createContext(fixtures)
        )
        expect(resolved.pages).toEqual([])
        expect(resolved.chapter.sourceChapterId).toBe("1")
    })
})

describe("createAdapterFromProfile", () => {
    it("matches manga and chapter URLs from the profile patterns", () => {
        const a = createAdapterFromProfile(profile())
        expect(a.match(new URL(`${ORIGIN}/manga/${SLUG}`))).toBe("manga")
        expect(a.match(new URL(`${ORIGIN}/manga/${SLUG}/ch-1`))).toBe("chapter")
        expect(a.match(new URL(`${ORIGIN}/browse`))).toBe("none")
        expect(a.match(new URL("https://other.test/manga/x"))).toBe("none")
    })

    it("resolves a series title and cover", async () => {
        const res = await createAdapterFromProfile(profile()).resolveManga(
            { url: new URL(`${ORIGIN}/manga/${SLUG}`) },
            createContext(fixtures)
        )
        expect(res.manga.title).toBe("Demo Title")
        expect(res.manga.coverUrl).toBe("https://example-scans.test/covers/demo.jpg")
        expect(res.sourceMangaId).toBe(SLUG)
    })

    it("lists chapters via the item pattern", async () => {
        const manga = await createAdapterFromProfile(profile()).resolveManga(
            { url: new URL(`${ORIGIN}/manga/${SLUG}`) },
            createContext(fixtures)
        )
        const chapters = await createAdapterFromProfile(profile()).listChapters({ manga }, createContext(fixtures))
        expect(chapters).toHaveLength(2)
        expect(chapters[0]).toMatchObject({ sourceChapterId: "1", sortKey: 1, title: "Ch.1 - First" })
        expect(chapters[1]).toMatchObject({ sourceChapterId: "2", sortKey: 2 })
    })

    it("resolves chapter pages and drops excluded urls", async () => {
        const res = await createAdapterFromProfile(profile()).resolveChapter(
            { url: new URL(`${ORIGIN}/manga/${SLUG}/ch-1`) },
            createContext(fixtures)
        )
        expect(res.pages).toHaveLength(2)
        expect(res.pages[0]!.url).toBe("https://cdn.example-scans.test/ch/1/001.webp")
        expect(res.pages.some(p => /\/ads\//.test(p.url))).toBe(false)
        expect(res.chapter.sourceChapterId).toBe("1")
    })

    it("searches and maps results", async () => {
        const results = await createAdapterFromProfile(profile()).search!("demo", createContext(fixtures))
        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({ sourceId: "example-scans", sourceMangaId: SLUG, title: "Demo Title" })
    })
})

describe("parseProfile (deny-by-default)", () => {
    it("accepts a valid profile", () => {
        expect(parseProfile(rawProfile).ok).toBe(true)
    })

    it("rejects an unknown field (strict schema)", () => {
        const res = parseProfile({ ...rawProfile, somethingExtra: true })
        expect(res.ok).toBe(false)
    })

    it("rejects a circumvention/token-recipe field - inexpressible by design", () => {
        const res = parseProfile({
            ...rawProfile,
            signatures: { algo: "md5", template: "{ts}secret", slice: 16 }
        })
        expect(res.ok).toBe(false)
    })

    it("rejects an invalid regular expression", () => {
        const res = parseProfile({ ...rawProfile, match: { manga: "([unclosed" } })
        expect(res.ok).toBe(false)
    })

    it("accepts format 2 (chapter-list fetch, no image extraction)", () => {
        expect(parseProfile({ ...rawProfile, profileFormat: 2 }).ok).toBe(true)
    })

    it("rejects an unknown format version", () => {
        expect(parseProfile({ ...rawProfile, profileFormat: 3 }).ok).toBe(false)
    })
})

describe("list pagination", () => {
    const base = "https://p.test"
    const pagFixtures: Record<string, string> = {
        "/series/x?page=1": '<a href="/read/3"></a><a href="/read/2"></a>',
        "/series/x?page=2": '<a href="/read/1"></a><a href="/read/2"></a>',
        "/series/x?page=3": "<html>no more</html>"
    }
    function pagContext(): SourceContext {
        const fetch: FetchFunction = async url => {
            const key = new URL(url).pathname + new URL(url).search
            const body = pagFixtures[key]
            return { ok: body !== undefined, status: body === undefined ? 404 : 200, text: async () => body ?? "" }
        }
        return {
            request: createBoundedRequestClient({
                fetch,
                allowedOrigins: ["*://*.test/*"],
                maxRequests: 50,
                maxResponseBytes: 1_000_000,
                timeoutMs: 1000
            }),
            now: () => 0,
            logger: { debug: () => undefined, warn: () => undefined }
        }
    }
    function pagProfile(): SiteProfile {
        const parsed = parseProfile({
            profileFormat: 1,
            id: "p",
            name: "P",
            engine: "generic",
            origin: base,
            domains: ["p.test"],
            languages: ["en"],
            capabilities: ["chapters"],
            requestRateLimit: { requests: 5, intervalMs: 1000 },
            origins: ["*://*.test/*"],
            match: { manga: "^/series/([a-z]+)/?$", chapter: "^/read/([0-9]+)/?$" },
            series: { titlePattern: "x" },
            list: {
                itemPattern: '<a href="(?<chapterUrl>/read/(?<chapterNumber>[0-9]+))">',
                pagination: { param: "page", maxPages: 10 }
            }
        })
        if (!parsed.ok) throw new Error(parsed.error)
        return parsed.profile
    }

    it("crawls pages until one is empty and dedups across pages", async () => {
        const manga = {
            manga: {
                id: "p:manga:x",
                title: "x",
                normalizedTitle: "x",
                authors: [],
                status: "unknown" as const,
                addedAt: 0,
                updatedAt: 0
            },
            sourceId: "p",
            sourceMangaId: "x",
            url: `${base}/series/x`
        }
        const chapters = await createAdapterFromProfile(pagProfile()).listChapters({ manga }, pagContext())
        // page1: 3,2  page2: 1 (2 deduped)  page3: empty -> stop. = 3 unique.
        expect(chapters.map(c => c.sourceChapterId)).toEqual(["3", "2", "1"])
    })
})

describe("recognition-only profile (migration seed: match + series, no list)", () => {
    function recognitionOnly(): SiteProfile {
        const { pages: _pages, list: _list, ...rest } = rawProfile
        const parsed = parseProfile({
            ...rest,
            profileFormat: 2,
            numberingKind: "chapter",
            capabilities: ["manga"],
            // chapter URL carries no number group: the chapter must be UNNUMBERED, never "1"
            match: { manga: "^/manga/([a-z0-9-]+)/?$", chapter: "^/manga/([a-z0-9-]+)/ch-[0-9.]+/?$" }
        })
        if (!parsed.ok) throw new Error(parsed.error)
        return parsed.profile
    }

    it("parses without a list and lists no chapters (tracking-only)", async () => {
        const a = createAdapterFromProfile(recognitionOnly())
        const ctx = createContext(fixtures)
        const manga = await a.resolveManga({ url: new URL(`${ORIGIN}/manga/${SLUG}`) }, ctx)
        expect(await a.listChapters({ manga }, ctx)).toEqual([])
    })

    it("still recognises and resolves series/chapter URLs", () => {
        const a = createAdapterFromProfile(recognitionOnly())
        expect(a.match(new URL(`${ORIGIN}/manga/${SLUG}`))).toBe("manga")
        expect(a.match(new URL(`${ORIGIN}/manga/${SLUG}/ch-3`))).toBe("chapter")
        expect(a.parseMangaUrl?.(new URL(`${ORIGIN}/manga/${SLUG}/ch-3`))?.sourceMangaId).toBe(SLUG)
    })

    it("a chapter regex with no number group yields an unnumbered chapter, not Chapter 1", async () => {
        const a = createAdapterFromProfile(recognitionOnly())
        const resolved = await a.resolveChapter(
            { url: new URL(`${ORIGIN}/manga/${SLUG}/ch-3`) },
            createContext(fixtures)
        )
        expect(resolved.chapter.sortKey).toBe(Number.POSITIVE_INFINITY)
        expect(resolved.chapter.sourceChapterId).not.toBe("1")
    })

    it("parseMangaUrl refuses a URL on a foreign host", () => {
        const a = createAdapterFromProfile(recognitionOnly())
        expect(a.parseMangaUrl?.(new URL(`https://other.test/manga/${SLUG}`))).toBeNull()
    })
})

describe("hardening against hostile page content", () => {
    function coverFor(cover: string) {
        const html = `<meta property="og:title" content="Demo Title" /><meta property="og:image" content="${cover}" />`
        return createAdapterFromProfile(profile()).resolveManga(
            { url: new URL(`${ORIGIN}/manga/${SLUG}`) },
            createContext({ [`/manga/${SLUG}`]: html })
        )
    }

    it("keeps a relative cover on the profile's own origin", async () => {
        expect((await coverFor("/covers/x.jpg")).manga.coverUrl).toBe("https://example-scans.test/covers/x.jpg")
    })

    it.each([
        "https://cdn.other-host.net/c.jpg",
        "http://example-scans.test/c.jpg",
        "https://127.0.0.1/c.jpg",
        "http://localhost:8080/admin",
        "javascript:alert(1)",
        "https://example-scans.test.evil.net/c.jpg"
    ])("drops a cover that points at %s", async cover => {
        expect((await coverFor(cover)).manga.coverUrl).toBeUndefined()
    })

    it("allows a cover on a declared imageOrigins host", async () => {
        const withImages = parseProfile({ ...rawProfile, imageOrigins: ["https://img.example-scans.test/*"] })
        if (!withImages.ok) throw new Error(withImages.error)
        const html = `<meta property="og:title" content="T" /><meta property="og:image" content="https://img.example-scans.test/c.jpg" />`
        const res = await createAdapterFromProfile(withImages.profile).resolveManga(
            { url: new URL(`${ORIGIN}/manga/${SLUG}`) },
            createContext({ [`/manga/${SLUG}`]: html })
        )
        expect(res.manga.coverUrl).toBe("https://img.example-scans.test/c.jpg")
    })

    it("inserts a slug containing $ replacement tokens literally into the item pattern", async () => {
        const slug = "a$&b$'c"
        const p = parseProfile({
            ...rawProfile,
            match: { manga: "^/manga/(.+)$", chapter: "^/manga/(.+)/ch-([0-9.]+)/?$" },
            list: {
                itemPattern: 'href="(?<chapterUrl>/manga/{slug}/ch-(?<chapterNumber>[0-9.]+))"'
            }
        })
        if (!p.ok) throw new Error(p.error)
        const adapter = createAdapterFromProfile(p.profile)
        const html = `<a href="/manga/${slug}/ch-1">x</a><a href="/manga/other/ch-9">y</a>`
        const seriesUrl = new URL(`${ORIGIN}/manga/${slug}`)
        const ctx = createContext({ [seriesUrl.pathname]: html })
        const manga = await adapter.resolveManga({ url: seriesUrl }, ctx)
        const chapters = await adapter.listChapters({ manga }, ctx)
        expect(chapters.map(c => c.sortKey)).toEqual([1])
    })

    it("stops examining a page after the per-page item cap", async () => {
        const html = Array.from({ length: 5000 }, (_, i) => `<a href="/manga/${SLUG}/ch-${i + 1}">c</a>`).join("")
        const a = createAdapterFromProfile(profile())
        const ctx = createContext({ [`/manga/${SLUG}`]: html })
        const manga = await a.resolveManga({ url: new URL(`${ORIGIN}/manga/${SLUG}`) }, ctx)
        const chapters = await a.listChapters({ manga }, ctx)
        expect(chapters).toHaveLength(2000)
    })
})
