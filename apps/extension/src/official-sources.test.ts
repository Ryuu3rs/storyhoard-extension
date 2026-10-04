import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("browser", fakeBrowser)

const {
    OFFICIAL_SITES_DEFAULT,
    isOfficialHost,
    officialNameForHost,
    mergeOfficialSites,
    getCachedOfficialSites,
    refreshOfficialSites
} = await import("./official-sources")

beforeEach(async () => {
    await fakeBrowser.storage.local.clear()
    vi.unstubAllGlobals()
    vi.stubGlobal("browser", fakeBrowser)
})

describe("isOfficialHost / officialSiteForHost", () => {
    it("matches exact domain, subdomains, and strips www", () => {
        expect(isOfficialHost("webtoons.com", OFFICIAL_SITES_DEFAULT)).toBe(true)
        expect(isOfficialHost("www.webtoons.com", OFFICIAL_SITES_DEFAULT)).toBe(true)
        expect(isOfficialHost("m.webtoons.com", OFFICIAL_SITES_DEFAULT)).toBe(true)
        expect(isOfficialHost("comikey.com", OFFICIAL_SITES_DEFAULT)).toBe(true)
    })

    it("does not match a lookalike or unrelated host", () => {
        expect(isOfficialHost("notwebtoons.com", OFFICIAL_SITES_DEFAULT)).toBe(false)
        expect(isOfficialHost("webtoons.com.evil.io", OFFICIAL_SITES_DEFAULT)).toBe(false)
        expect(isOfficialHost("example.org", OFFICIAL_SITES_DEFAULT)).toBe(false)
    })
})

describe("mergeOfficialSites", () => {
    it("keeps every baked site even when the remote list omits it (floor, never subtract)", () => {
        const merged = mergeOfficialSites(OFFICIAL_SITES_DEFAULT, [])
        for (const baked of OFFICIAL_SITES_DEFAULT) {
            expect(merged.some(m => m.domain === baked.domain && m.verified === true)).toBe(true)
        }
    })

    it("lets the feed relabel a baked domain while keeping it verified", () => {
        const merged = mergeOfficialSites(OFFICIAL_SITES_DEFAULT, [{ domain: "webtoons.com", name: "Webtoon (KR)" }])
        const entry = merged.find(m => m.domain === "webtoons.com")
        expect(entry).toEqual({ domain: "webtoons.com", name: "Webtoon (KR)", verified: true })
    })

    it("adds a new remote domain as UNVERIFIED (overlay yes, named credit no)", () => {
        const merged = mergeOfficialSites(OFFICIAL_SITES_DEFAULT, [{ domain: "new-partner.com", name: "New Partner" }])
        const entry = merged.find(m => m.domain === "new-partner.com")
        expect(entry).toEqual({ domain: "new-partner.com", name: "New Partner", verified: false })
        // overlay treatment applies
        expect(isOfficialHost("new-partner.com", merged)).toBe(true)
        // but it is not eligible for the named credit line (R4)
        expect(officialNameForHost("new-partner.com", merged)).toBeUndefined()
    })

    it("normalizes feed domains (protocol, www, path) and drops empty ones", () => {
        const merged = mergeOfficialSites(
            [],
            [
                { domain: "https://www.foo.com/title/1", name: "Foo" },
                { domain: "   ", name: "Blank" }
            ]
        )
        expect(merged).toEqual([{ domain: "foo.com", name: "Foo", verified: false }])
    })
})

describe("officialNameForHost", () => {
    it("returns the name only for a verified (baked) match", () => {
        expect(officialNameForHost("www.mangadex.org", OFFICIAL_SITES_DEFAULT)).toBe("MangaDex")
        expect(officialNameForHost("example.org", OFFICIAL_SITES_DEFAULT)).toBeUndefined()
    })
})

describe("getCachedOfficialSites / refreshOfficialSites", () => {
    it("returns the baked default when nothing is cached", async () => {
        const sites = await getCachedOfficialSites()
        expect(sites.map(s => s.domain)).toEqual(OFFICIAL_SITES_DEFAULT.map(s => s.domain))
    })

    it("merges a valid cached feed over the baked default", async () => {
        await fakeBrowser.storage.local.set({
            officialSitesCache: { sites: [{ domain: "new-partner.com", name: "New Partner" }], fetchedAt: 1 }
        })
        const sites = await getCachedOfficialSites()
        expect(sites.some(s => s.domain === "new-partner.com")).toBe(true)
        expect(sites.some(s => s.domain === "webtoons.com")).toBe(true)
    })

    it("writes a validated feed into the cache", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                ok: true,
                status: 200,
                headers: { get: () => '"etag-1"' },
                json: async () => ({ sites: [{ domain: "partner.io", name: "Partner" }] })
            }))
        )
        await refreshOfficialSites()
        const stored = await fakeBrowser.storage.local.get("officialSitesCache")
        expect(stored.officialSitesCache).toMatchObject({
            sites: [{ domain: "partner.io", name: "Partner" }],
            etag: '"etag-1"'
        })
    })

    it("ignores an invalid feed and leaves the existing cache untouched (R4/R5)", async () => {
        await fakeBrowser.storage.local.set({
            officialSitesCache: { sites: [{ domain: "good.com", name: "Good" }], fetchedAt: 1 }
        })
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                ok: true,
                status: 200,
                headers: { get: () => null },
                json: async () => ({ sites: [{ bogus: true }] })
            }))
        )
        await refreshOfficialSites()
        const stored = await fakeBrowser.storage.local.get("officialSitesCache")
        expect(stored.officialSitesCache).toMatchObject({ sites: [{ domain: "good.com", name: "Good" }] })
    })

    it("leaves the cache untouched on a 304", async () => {
        await fakeBrowser.storage.local.set({
            officialSitesCache: { sites: [{ domain: "good.com", name: "Good" }], fetchedAt: 1, etag: '"e"' }
        })
        const fetchMock = vi.fn(async () => ({
            ok: false,
            status: 304,
            headers: { get: () => null },
            json: async () => ({})
        }))
        vi.stubGlobal("fetch", fetchMock)
        await refreshOfficialSites()
        const stored = await fakeBrowser.storage.local.get("officialSitesCache")
        expect(stored.officialSitesCache).toMatchObject({ sites: [{ domain: "good.com", name: "Good" }] })
    })
})
