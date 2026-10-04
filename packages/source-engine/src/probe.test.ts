import { createBoundedRequestClient, type FetchFunction, type SourceContext } from "@amr/source-sdk"
import { describe, expect, it } from "vitest"
import { probeSource } from "./probe"
import { parseProfile, type SiteProfile } from "./profile-schema"

const fixtures: Record<string, string> = {
    "/search/?q=a": '<a class="r" href="/manga/demo/">Demo Title</a>',
    "/manga/demo/": '<meta property="og:title" content="Demo Title" /><a class="ch" href="/manga/demo/c1/">Ch 1</a>',
    "/manga/demo/c1/": '<img src="https://cdn.x.test/1.jpg"><img src="https://cdn.x.test/2.jpg">'
}

// Build a context whose fetch only serves the given "live" hosts; everything else 404s. Lets a
// test simulate a dead primary mirror and a live fallback mirror.
function contextFor(liveHosts: Set<string>, requests: string[] = []): SourceContext {
    const fetch: FetchFunction = async url => {
        const u = new URL(url)
        requests.push(u.host + u.pathname + u.search)
        if (!liveHosts.has(u.host)) return { ok: false, status: 404, text: async () => "" }
        const body = fixtures[u.pathname + u.search] ?? fixtures[u.pathname]
        return { ok: body !== undefined, status: body === undefined ? 404 : 200, text: async () => body ?? "" }
    }
    return {
        request: createBoundedRequestClient({
            fetch,
            allowedOrigins: ["*://*.x.test/*", "https://cdn.x.test/*"],
            maxRequests: 50,
            maxResponseBytes: 1_000_000,
            timeoutMs: 1000
        }),
        now: () => 1_700_000_000_000,
        logger: { debug: () => undefined, warn: () => undefined }
    }
}

function profile(origin: string): SiteProfile {
    const parsed = parseProfile({
        profileFormat: 1,
        id: "x-scans",
        name: "X Scans",
        engine: "generic",
        origin,
        domains: ["ww3.x.test", "ww2.x.test"],
        languages: ["en"],
        capabilities: ["pages", "chapters", "manga"],
        requestRateLimit: { requests: 5, intervalMs: 1000 },
        origins: ["*://*.x.test/*"],
        match: { manga: "^/manga/([a-z0-9-]+)/?$", chapter: "^/manga/([a-z0-9-]+)/c([0-9.]+)/?$" },
        series: { urlTemplate: "/manga/{slug}/", titlePattern: 'og:title" content="(?<title>[^"]+)"' },
        list: { itemPattern: '<a class="ch" href="(?<chapterUrl>/manga/[a-z0-9-]+/c(?<chapterNumber>[0-9.]+)/)"' },
        pages: { imagePatterns: ['<img src="(?<url>[^"]+)"'] },
        search: {
            urlTemplate: "/search/?q={query}",
            itemPattern: '<a class="r" href="(?<url>/manga/[a-z0-9-]+/)">(?<title>[^<]+)</a>'
        }
    })
    if (!parsed.ok) throw new Error(parsed.error)
    return parsed.profile
}

describe("probeSource", () => {
    it("reports every stage ok when the site works", async () => {
        const report = await probeSource(profile("https://ww3.x.test"), contextFor(new Set(["ww3.x.test"])))
        expect(report.ok).toBe(true)
        expect(report.originCorrected).toBe(false)
        expect(report.effectiveOrigin).toBe("https://ww3.x.test")
        expect(report.stages.map(s => s.stage)).toEqual(["search", "series", "chapters", "pages"])
        expect(report.stages.every(s => s.ok)).toBe(true)
    })

    it("auto-corrects the origin to a live mirror when the primary is dead", async () => {
        // Primary ww3 is dead; ww2 serves. Probe should switch to ww2 and still pass.
        const report = await probeSource(profile("https://ww3.x.test"), contextFor(new Set(["ww2.x.test"])))
        expect(report.originCorrected).toBe(true)
        expect(report.effectiveOrigin).toBe("https://ww2.x.test")
        expect(report.profile.origin).toBe("https://ww2.x.test")
        expect(report.ok).toBe(true)
    })

    it("flags the failing stage when a selector is broken", async () => {
        // Point search at a query with no fixture -> search returns nothing -> not ok.
        const report = await probeSource(profile("https://ww3.x.test"), contextFor(new Set(["ww3.x.test"])), {
            sampleQuery: "zzz"
        })
        expect(report.ok).toBe(false)
        const search = report.stages.find(s => s.stage === "search")
        expect(search?.ok).toBe(false)
    })
})
