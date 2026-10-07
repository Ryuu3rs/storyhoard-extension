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

    it("accepts an origin's subdomain, a wildcard of it, and matching image hosts", () => {
        expect(
            validateProfileScope(
                profile({
                    domains: ["reader.example", "www.reader.example", "*.reader.example"],
                    origins: ["https://reader.example/*", "https://www.reader.example/*"],
                    imageOrigins: ["https://*.reader.example/*"]
                })
            )
        ).toBe(true)
    })

    it.each<[string, Partial<SiteProfile>]>([
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
