import { OFFICIAL_SOURCE_IDS, parseBuildScope, sourceAdapters } from "@amr/sources"
import { describe, expect, it } from "vitest"
import { OFFICIAL_SITES_DEFAULT, isOfficialHost } from "./official-sources"
import { SOURCE_ORIGINS, originsInScope, sourcesOwningOrigin } from "./permissions"

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

    // Regression check for the bug that motivated this test: a real user hit a
    // console CORS error fetching a MangaHub-adjacent cover image from
    // fmcdn.mfcdn.net. Live investigation traced it to the FanFox adapter's
    // og:image cover extraction, not MangaHub - see fanfox-sites.ts.
    it("covers the fanfox cover CDN host (fmcdn.mfcdn.net) that motivated this test", () => {
        expect(isHostGranted("fmcdn.mfcdn.net", SOURCE_ORIGINS)).toBe(true)
    })
})

describe("origins in a build without bundled adapters", () => {
    it("every origin traces back to a source, so none is left behind when its adapter is dropped", () => {
        expect(SOURCE_ORIGINS.filter(pattern => sourcesOwningOrigin(pattern).length === 0)).toEqual([])
    })

    it("a default build keeps every origin, in order", () => {
        expect(originsInScope(SOURCE_ORIGINS, parseBuildScope({}))).toBe(SOURCE_ORIGINS)
    })

    it("VITE_NO_BUNDLED=1 keeps only what the official sources own", () => {
        const kept = originsInScope(SOURCE_ORIGINS, parseBuildScope({ VITE_NO_BUNDLED: "1" }))
        expect(kept.length).toBeGreaterThan(0)
        expect(kept.length).toBeLessThan(SOURCE_ORIGINS.length)
        for (const pattern of kept) {
            expect(
                sourcesOwningOrigin(pattern).some(id => OFFICIAL_SOURCE_IDS.includes(id)),
                pattern
            ).toBe(true)
        }
        for (const id of OFFICIAL_SOURCE_IDS) {
            const manifest = sourceAdapters.find(adapter => adapter.manifest.id === id)!.manifest
            for (const domain of manifest.domains) expect(isHostGranted(domain, kept), domain).toBe(true)
        }
    })

    it("VITE_EXCLUDE_SOURCES drops only the origins of the named source", () => {
        const id = sourceAdapters.find(adapter => !OFFICIAL_SOURCE_IDS.includes(adapter.manifest.id))!.manifest.id
        const kept = originsInScope(SOURCE_ORIGINS, parseBuildScope({ VITE_EXCLUDE_SOURCES: id }))
        const dropped = SOURCE_ORIGINS.filter(pattern => !kept.includes(pattern))
        expect(dropped.length).toBeGreaterThan(0)
        for (const pattern of dropped) expect(sourcesOwningOrigin(pattern)).toEqual([id])
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
        expect(isHostGranted("mangahub.io", ["https://mangahub.io/*"])).toBe(true)
        expect(isHostGranted("evil-mangahub.io", ["https://mangahub.io/*"])).toBe(false)
        expect(isHostGranted("sub.mangahub.io", ["https://mangahub.io/*"])).toBe(false)
    })

    it("matches a wildcard-subdomain pattern against the bare domain and any subdomain", () => {
        expect(isHostGranted("mfcdn.net", ["*://*.mfcdn.net/*"])).toBe(true)
        expect(isHostGranted("fmcdn.mfcdn.net", ["*://*.mfcdn.net/*"])).toBe(true)
        expect(isHostGranted("mfcdn.net.evil.com", ["*://*.mfcdn.net/*"])).toBe(false)
    })
})
