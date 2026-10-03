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
<meta property="og:image" content="https://cdn.example-scans.test/covers/demo.jpg" />
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
        expect(res.manga.coverUrl).toBe("https://cdn.example-scans.test/covers/demo.jpg")
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

    it("rejects an unknown format version", () => {
        expect(parseProfile({ ...rawProfile, profileFormat: 2 }).ok).toBe(false)
    })
})
