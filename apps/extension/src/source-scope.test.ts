import type { SiteProfile } from "@amr/source-engine"
import { afterEach, describe, expect, it, vi } from "vitest"
import { isAddableUrl, reservedHosts, validateProfileScope } from "./source-scope"

afterEach(() => {
    vi.unstubAllEnvs()
})

function profile(overrides: Partial<SiteProfile> = {}): SiteProfile {
    return {
        profileFormat: 2,
        id: "reader.example",
        name: "Reader Example",
        engine: "generic",
        origin: "https://reader.example",
        domains: ["reader.example"],
        languages: ["en"],
        capabilities: ["chapters", "manga"],
        requestRateLimit: { requests: 3, intervalMs: 1000 },
        origins: ["https://reader.example/*"],
        match: { manga: "^/manga/([^/]+)/?$" },
        series: { titlePattern: "<title>(?<title>[^<]+)</title>" },
        ...overrides
    }
}

describe("isAddableUrl", () => {
    it("accepts a public https site", () => {
        expect(isAddableUrl(new URL("https://reader.example/manga/a/chapter-1"))).toBe(true)
        expect(isAddableUrl(new URL("https://www.reader.example/x"))).toBe(true)
    })

    it.each([
        "http://reader.example/x",
        "https://localhost/x",
        "https://127.0.0.1/x",
        "https://192.168.1.5/x",
        "https://[::1]/x",
        "https://reader.example:8443/x",
        "https://printer.local/x",
        "https://singlelabel/x",
        "https://files.corp/x",
        "https://wiki.intranet/x",
        "https://nas.private/x",
        "https://host.localdomain/x",
        "https://reader.example./x",
        "https://user@reader.example/x",
        "https://user:pw@reader.example/x",
        "https://weeb.ltd/x",
        "https://www.weeb.ltd/x",
        "https://github.com/x",
        "https://api.github.com/x",
        "https://graphql.anilist.co/x",
        "https://s4.anilist.co/x",
        "https://cdn.myanimelist.net/x",
        "https://mangadex.org/x",
        "https://mirror.mangafreak.me/x",
        "https://cdn.mghcdn.com/x"
    ])("rejects %s", raw => {
        expect(isAddableUrl(new URL(raw))).toBe(false)
    })

    it("rejects the build-time service origins", () => {
        vi.stubEnv("VITE_COMMUNITY_API_ORIGIN", "https://community.example-api.net/*")
        vi.stubEnv("VITE_METADATA_API_ORIGIN", "https://metadata.example-api.net")
        vi.stubEnv("VITE_WEEB_SITE_ORIGIN", "https://dev.example-site.net/*")
        expect(isAddableUrl(new URL("https://community.example-api.net/x"))).toBe(false)
        expect(isAddableUrl(new URL("https://sub.metadata.example-api.net/x"))).toBe(false)
        expect(isAddableUrl(new URL("https://dev.example-site.net/x"))).toBe(false)
        expect(isAddableUrl(new URL("https://other.example-api.net/x"))).toBe(true)
    })
})

describe("reservedHosts", () => {
    it("is built from the manifest host permissions, not a hand-kept list", () => {
        const hosts = reservedHosts()
        for (const host of ["weeb.ltd", "api.github.com", "graphql.anilist.co", "mangadex.org", "mangafreak.me"]) {
            expect(hosts.has(host)).toBe(true)
        }
    })
})

describe("validateProfileScope", () => {
    it("accepts a profile drafted from a public origin", () => {
        expect(validateProfileScope(profile())).toBe(true)
    })

    it("accepts a text-numbered profile and rejects a bad numberSource or unsafe itemTextPattern", () => {
        const itemTextPattern = '<a href="(?<chapterUrl>/c/[0-9]+)">(?<chapterText>[^<]{1,80})'
        expect(
            validateProfileScope(
                profile({
                    numberSource: "text",
                    list: { itemPattern: 'href="(?<chapterUrl>/c/(?<chapterNumber>[0-9]+))"', itemTextPattern }
                })
            )
        ).toBe(true)
        expect(validateProfileScope(profile({ numberSource: "nope" as unknown as "text" }))).toBe(false)
        for (const unsafe of [
            "(?<chapterUrl>(a+)+)(?<chapterText>x)",
            "(unclosed",
            "(?<chapterUrl>a)(?<chapterText>b)\\1"
        ]) {
            expect(
                validateProfileScope(
                    profile({ list: { itemPattern: 'href="(?<chapterUrl>/c/1)"', itemTextPattern: unsafe } })
                )
            ).toBe(false)
        }
    })

    it("accepts the origin host with its www twin, and matching image hosts", () => {
        expect(
            validateProfileScope(
                profile({
                    domains: ["reader.example", "www.reader.example"],
                    origins: ["https://reader.example/*", "https://www.reader.example/*"],
                    imageOrigins: ["https://www.reader.example/*"]
                })
            )
        ).toBe(true)
    })

    it("accepts a www origin whose id is the bare host", () => {
        expect(
            validateProfileScope(
                profile({
                    origin: "https://www.reader.example",
                    domains: ["www.reader.example"],
                    origins: ["https://www.reader.example/*"]
                })
            )
        ).toBe(true)
    })

    it("accepts a url template that stays on the origin", () => {
        expect(
            validateProfileScope(
                profile({
                    series: { titlePattern: "<title>(?<title>[^<]+)</title>", urlTemplate: "/manga/{slug}" },
                    list: {
                        itemPattern: "(?<chapterUrl>/a/(?<chapterNumber>[0-9]+))",
                        urlTemplate: "/manga/{slug}/chapters"
                    },
                    search: { itemPattern: "(?<url>/a)(?<title>b)", urlTemplate: "/search?q={query}" }
                })
            )
        ).toBe(true)
    })

    it.each<[string, Partial<SiteProfile>]>([
        ["a wildcard subdomain of the origin", { domains: ["reader.example", "*.reader.example"] }],
        ["a wildcard subdomain image host", { imageOrigins: ["https://*.reader.example/*"] }],
        ["a deeper subdomain of the origin", { domains: ["reader.example", "cdn.reader.example"] }],
        [
            "a deeper subdomain that is not www",
            { domains: ["a.b.reader.example"], origins: ["https://a.b.reader.example/*"] }
        ],
        ["an id that is not the origin host", { id: "something-else" }],
        ["an id that is a bundled source's id", { id: "mangadex" }],
        ["an id that is a seed id for another host", { id: "kagane" }],
        ["an id with www kept", { id: "www.reader.example" }],
        [
            "a seed id claimed for an origin the seed does not cover",
            {
                id: "kagane",
                origin: "https://evil.example",
                domains: ["evil.example"],
                origins: ["https://evil.example/*"]
            }
        ],
        [
            "a country registry origin (co.uk)",
            { id: "co.uk", origin: "https://co.uk", domains: ["co.uk"], origins: ["https://co.uk/*"] }
        ],
        [
            "a country registry origin (com.au)",
            { id: "com.au", origin: "https://com.au", domains: ["com.au"], origins: ["https://com.au/*"] }
        ],
        [
            "a shared-hosting origin (github.io)",
            { id: "github.io", origin: "https://github.io", domains: ["github.io"], origins: ["https://github.io/*"] }
        ],
        [
            "a shared-hosting origin (pages.dev)",
            { id: "pages.dev", origin: "https://pages.dev", domains: ["pages.dev"], origins: ["https://pages.dev/*"] }
        ],
        [
            "a shared-hosting origin (blogspot.com)",
            {
                id: "blogspot.com",
                origin: "https://blogspot.com",
                domains: ["blogspot.com"],
                origins: ["https://blogspot.com/*"]
            }
        ],
        [
            "a wildcard over a shared-hosting suffix",
            {
                id: "github.io",
                origin: "https://github.io",
                domains: ["*.github.io"],
                origins: ["https://*.github.io/*"]
            }
        ],
        [
            "a series template on another host",
            { series: { titlePattern: "<title>(?<title>[^<]+)</title>", urlTemplate: "//evil.example/{slug}" } }
        ],
        [
            "a series template with an absolute foreign url",
            { series: { titlePattern: "<title>(?<title>[^<]+)</title>", urlTemplate: "https://evil.example/{slug}" } }
        ],
        [
            "a list template on another host",
            {
                list: {
                    itemPattern: "(?<chapterUrl>/a/(?<chapterNumber>[0-9]+))",
                    urlTemplate: "//evil.example/{slug}"
                }
            }
        ],
        [
            "a search template on another host",
            { search: { itemPattern: "(?<url>/a)(?<title>b)", urlTemplate: "//evil.example/?q={query}" } }
        ],
        [
            "a template whose placeholder decides the host",
            { series: { titlePattern: "<title>(?<title>[^<]+)</title>", urlTemplate: "//{slug}/x" } }
        ],
        [
            "a template with an unknown placeholder",
            { series: { titlePattern: "<title>(?<title>[^<]+)</title>", urlTemplate: "/manga/{nope}" } }
        ],
        [
            "a template with a placeholder the engine does not supply for it",
            { series: { titlePattern: "<title>(?<title>[^<]+)</title>", urlTemplate: "/manga/{query}" } }
        ],
        ["a wildcard TLD domain", { domains: ["*.com"], origins: ["https://*.com/*"] }],
        ["a bare TLD domain", { domains: ["com"], origins: ["https://com/*"] }],
        ["a lone wildcard", { domains: ["*"], origins: ["https://*/*"] }],
        [
            "a domain on another site",
            { domains: ["reader.example", "evil.net"], origins: ["https://reader.example/*"] }
        ],
        ["a sibling lookalike", { domains: ["notreader.example"], origins: ["https://notreader.example/*"] }],
        ["an apex above the origin", { origin: "https://www.reader.example", domains: ["reader.example"] }],
        [
            "a loopback origin",
            { origin: "https://127.0.0.1", domains: ["127.0.0.1"], origins: ["https://127.0.0.1/*"] }
        ],
        ["localhost", { origin: "https://localhost", domains: ["localhost"], origins: ["https://localhost/*"] }],
        ["a private-network origin", { origin: "https://10.0.0.8", domains: ["reader.example"] }],
        ["an http origin", { origin: "http://reader.example" }],
        ["an origin with a port", { origin: "https://reader.example:8443" }],
        ["an origin with a path", { origin: "https://reader.example/manga" }],
        ["an origin with credentials", { origin: "https://user:pw@reader.example" }],
        [
            "a reserved first-party origin",
            { origin: "https://weeb.ltd", domains: ["weeb.ltd"], origins: ["https://weeb.ltd/*"] }
        ],
        [
            "a bundled source's host",
            { origin: "https://mangadex.org", domains: ["mangadex.org"], origins: ["https://mangadex.org/*"] }
        ],
        ["a match-everything origin pattern", { origins: ["*://*/*"] }],
        ["an all-https origin pattern", { origins: ["https://*/*"] }],
        ["a wildcard-scheme origin pattern", { origins: ["*://*.reader.example/*"] }],
        ["a bare-TLD origin pattern", { origins: ["https://*.com/*"] }],
        ["an origin pattern for another host", { origins: ["https://reader.example/*", "https://evil.net/*"] }],
        ["an origin pattern with a path", { origins: ["https://reader.example/manga/*"] }],
        ["an image origin on another host", { imageOrigins: ["https://cdn.evil.net/*"] }],
        ["an uppercase domain", { domains: ["Reader.Example"], origins: ["https://Reader.Example/*"] }],
        ["a domain with a path", { domains: ["reader.example/x"], origins: ["https://reader.example/x/*"] }],
        ["a domain with a port", { domains: ["reader.example:8443"], origins: ["https://reader.example:8443/*"] }]
    ])("rejects %s", (_name, overrides) => {
        expect(validateProfileScope(profile(overrides))).toBe(false)
    })

    it("rejects an unreasonable number of domains", () => {
        const many = Array.from({ length: 11 }, (_, i) => `s${i}.reader.example`)
        expect(validateProfileScope(profile({ domains: many, origins: many.map(d => `https://${d}/*`) }))).toBe(false)
    })
})
