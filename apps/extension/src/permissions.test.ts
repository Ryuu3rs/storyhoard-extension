import type { SourceAdapter } from "@amr/source-sdk"
import { OFFICIAL_SOURCE_IDS, parseBuildScope, sourceAdapters } from "@amr/sources"
import { describe, expect, it } from "vitest"
import { OFFICIAL_SITES_DEFAULT, isOfficialHost } from "./official-sources"
import { SOURCE_ORIGINS, originsInScope, sourceOriginsFor, sourcesOwningOrigin, type SiteSet } from "./permissions"

// Parses a Chrome extension match pattern of the restricted shape this codebase
// always uses ("https://host/*" or "*://*.host/*") into its host component.
// Returns undefined for anything else (path-scoped patterns, unsupported schemes).
function parsePatternHost(pattern: string): { host: string; matchesSubdomains: boolean } | undefined {
    const m = pattern.match(/^(?:\*|https?):\/\/([^/]+)\/\*$/)
    if (!m) return undefined
    const rawHost = m[1]!.toLowerCase()
    return rawHost.startsWith("*.")
        ? { host: rawHost.slice(2), matchesSubdomains: true }
        : { host: rawHost, matchesSubdomains: false }
}

// True if some pattern in `patterns` would grant host_permissions access to `host`.
function isHostGranted(host: string, patterns: readonly string[]): boolean {
    const normalized = host.toLowerCase().replace(/\.$/, "")
    return patterns.some(pattern => {
        const parsed = parsePatternHost(pattern)
        if (!parsed) return false
        if (parsed.matchesSubdomains) {
            return normalized === parsed.host || normalized.endsWith(`.${parsed.host}`)
        }
        return normalized === parsed.host
    })
}

// Guards against the exact bug pattern this codebase kept hitting: a source
// adapter's manifest declares a domain (or, since imageOrigins was added, a
// separate cover/page-image CDN host) but nobody added a matching pattern to
// SOURCE_ORIGINS, so the extension's manifest never requests permission for it
// and reads fail with a real browser console CORS error. Every adapter actually
// registered in the source registry must be fully covered.
describe("SOURCE_ORIGINS covers every registered source adapter", () => {
    it("grants an origin for every adapter's manifest.domains entry", () => {
        const missing: string[] = []
        for (const adapter of sourceAdapters) {
            for (const domain of adapter.manifest.domains) {
                if (!isHostGranted(domain, SOURCE_ORIGINS)) {
                    missing.push(
                        `${adapter.manifest.id}: domain "${domain}" is not covered by any SOURCE_ORIGINS pattern`
                    )
                }
            }
        }
        expect(missing).toEqual([])
    })

    it("grants an origin for every adapter's manifest.imageOrigins entry", () => {
        const missing: string[] = []
        for (const adapter of sourceAdapters) {
            for (const imageOrigin of adapter.manifest.imageOrigins ?? []) {
                const parsed = parsePatternHost(imageOrigin)
                if (!parsed) {
                    missing.push(
                        `${adapter.manifest.id}: imageOrigins entry "${imageOrigin}" is not a recognised match pattern`
                    )
                    continue
                }
                if (!isHostGranted(parsed.host, SOURCE_ORIGINS)) {
                    missing.push(
                        `${adapter.manifest.id}: imageOrigins entry "${imageOrigin}" is not covered by any SOURCE_ORIGINS pattern`
                    )
                }
            }
        }
        expect(missing).toEqual([])
    })
})

const fakeSite = (id: string, domains: string[], imageOrigins?: string[]) =>
    ({ manifest: { id, domains, ...(imageOrigins ? { imageOrigins } : {}) } }) as unknown as SourceAdapter

// What the local testing build plugs in from the private site lab, stood in by two made-up sites.
const LAB_SITES: SiteSet = {
    siteAdapters: [
        fakeSite("site-a", ["site-a.example"], ["*://*.cdn-a.example/*"]),
        fakeSite("site-b", ["site-b.example"])
    ],
    siteOrigins: [
        "https://site-a.example/*",
        "*://*.cdn-a.example/*",
        "https://site-b.example/*",
        "https://img-b.example/*"
    ],
    siteExtraHosts: { "site-b": ["img-b.example"] }
}

describe("origins in a shipped build, which bundles only the official sources", () => {
    it("every origin traces back to an official source", () => {
        for (const pattern of SOURCE_ORIGINS) {
            expect(
                sourcesOwningOrigin(pattern).some(id => OFFICIAL_SOURCE_IDS.includes(id)),
                pattern
            ).toBe(true)
        }
        for (const id of OFFICIAL_SOURCE_IDS) {
            const manifest = sourceAdapters.find(adapter => adapter.manifest.id === id)!.manifest
            for (const domain of manifest.domains) expect(isHostGranted(domain, SOURCE_ORIGINS), domain).toBe(true)
        }
    })

    it("a shipped build leaves out every site host, even when sites are on hand", () => {
        expect(sourceOriginsFor(LAB_SITES, parseBuildScope({}))).toEqual(SOURCE_ORIGINS)
    })

    it("the local bundled build adds every site host, in order", () => {
        const origins = sourceOriginsFor(LAB_SITES, parseBuildScope({ VITE_BUNDLED: "1" }))
        expect(origins).toEqual([...SOURCE_ORIGINS, ...LAB_SITES.siteOrigins])
    })

    it("VITE_EXCLUDE_SOURCES drops only the origins of the named source", () => {
        const origins = sourceOriginsFor(
            LAB_SITES,
            parseBuildScope({ VITE_BUNDLED: "1", VITE_EXCLUDE_SOURCES: "site-b" })
        )
        expect(origins).toEqual([...SOURCE_ORIGINS, "https://site-a.example/*", "*://*.cdn-a.example/*"])
    })

    it("originsInScope keeps every origin when nothing is scoped out", () => {
        expect(originsInScope(SOURCE_ORIGINS, parseBuildScope({ VITE_BUNDLED: "1" }))).toBe(SOURCE_ORIGINS)
    })

    it("OFFICIAL_SOURCE_IDS is exactly the bundled sources on an official site", () => {
        const official = sourceAdapters
            .filter(({ manifest }) =>
                manifest.domains.some(domain => isOfficialHost(domain.replace(/^\*\./, ""), OFFICIAL_SITES_DEFAULT))
            )
            .map(({ manifest }) => manifest.id)
        expect(official.sort()).toEqual([...OFFICIAL_SOURCE_IDS].sort())
    })
})
describe("parsePatternHost / isHostGranted", () => {
    it("matches a bare-domain pattern only against the exact host", () => {
        expect(isHostGranted("site-a.example", ["https://site-a.example/*"])).toBe(true)
        expect(isHostGranted("evil-site-a.example", ["https://site-a.example/*"])).toBe(false)
        expect(isHostGranted("sub.site-a.example", ["https://site-a.example/*"])).toBe(false)
    })

    it("matches a wildcard-subdomain pattern against the bare domain and any subdomain", () => {
        expect(isHostGranted("cdn-a.example", ["*://*.cdn-a.example/*"])).toBe(true)
        expect(isHostGranted("img.cdn-a.example", ["*://*.cdn-a.example/*"])).toBe(true)
        expect(isHostGranted("cdn-a.example.evil.com", ["*://*.cdn-a.example/*"])).toBe(false)
    })
})
