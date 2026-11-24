import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("browser", fakeBrowser)

const {
    OFFICIAL_SITES_DEFAULT,
    isOfficialHost,
    isVerifiedOfficialHost,
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

    it("keeps a baked domain verified when the feed lists it too", () => {
        const merged = mergeOfficialSites(OFFICIAL_SITES_DEFAULT, [{ domain: OFFICIAL_SITES_DEFAULT[0]!.domain }])
        const entry = merged.find(m => m.domain === OFFICIAL_SITES_DEFAULT[0]!.domain)
        expect(entry).toEqual({ domain: OFFICIAL_SITES_DEFAULT[0]!.domain, verified: true })
    })

    it("adds a new remote domain as UNVERIFIED (overlay yes, offered as a destination no)", () => {
        const merged = mergeOfficialSites(OFFICIAL_SITES_DEFAULT, [{ domain: "new-partner.com" }])
        const entry = merged.find(m => m.domain === "new-partner.com")
        expect(entry).toEqual({ domain: "new-partner.com", verified: false })
        // overlay treatment applies
        expect(isOfficialHost("new-partner.com", merged)).toBe(true)
        // but it is never offered as a destination (R4)
        expect(isVerifiedOfficialHost("new-partner.com", merged)).toBe(false)
    })

    it("normalizes feed domains (protocol, www, path) and drops empty ones", () => {
        const merged = mergeOfficialSites([], [{ domain: "https://www.foo.com/title/1" }, { domain: "   " }])
        expect(merged).toEqual([{ domain: "foo.com", verified: false }])
    })
})

describe("isVerifiedOfficialHost", () => {
    it("is true only for a verified (baked) match, including a www host", () => {
        expect(isVerifiedOfficialHost(`www.${OFFICIAL_SITES_DEFAULT[0]!.domain}`, OFFICIAL_SITES_DEFAULT)).toBe(true)
        expect(isVerifiedOfficialHost("example.org", OFFICIAL_SITES_DEFAULT)).toBe(false)
    })
})

// The owner's rule: official sites are supported but never named to users or in public copy.
describe("official sites stay unnamed", () => {
    const NAMES = /MangaDex|WEBTOON|MANGA Plus|Tapas|Comikey|INKR/
    const FILES = [
        "../entrypoints/app/App.svelte",
        "./background/inject-chapter-prompt.ts",
        "./official-sources.ts",
        "../../../README.md"
    ]

    it.each(FILES)("%s has no display names", file => {
        const text = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8")
        expect(text.match(NAMES)?.[0]).toBeUndefined()
    })

    it("baked entries carry a domain and no name", () => {
        for (const site of OFFICIAL_SITES_DEFAULT) expect(Object.keys(site).sort()).toEqual(["domain", "verified"])
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
        expect(stored.officialSitesCache).toMatchObject({ sites: [{ domain: "partner.io" }] })
        // A name in the feed is dropped, so it can never reach the UI.
        expect((stored.officialSitesCache as { sites: object[] }).sites[0]).not.toHaveProperty("name")
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

    // The check carries only what any web request does. A server-chosen ETag stored and echoed back on every
    // later check would work like a cookie: the server could hand each install its own value.
    it("never stores a server-chosen ETag or sends it back on a later check", async () => {
        const perInstall = '"install-7f3a9c2e-1b44-4d0a-9e61-5c2f0b8d1a77"'
        const fetchMock = vi.fn<typeof fetch>()
        vi.stubGlobal("fetch", fetchMock)
        for (let i = 0; i < 3; i++) {
            fetchMock.mockResolvedValueOnce(
                new Response(JSON.stringify({ sites: [{ domain: "official.example" }] }), {
                    status: 200,
                    headers: { "Content-Type": "application/json", ETag: perInstall }
                })
            )
            await refreshOfficialSites()
        }
        const sent = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("If-None-Match"))
        expect(sent).toEqual([null, null, null])
        const stored = await fakeBrowser.storage.local.get("officialSitesCache")
        expect(JSON.stringify(stored)).not.toContain("install-7f3a9c2e")
    })

    it("drops the ETag an older version stored once the feed is read again", async () => {
        await fakeBrowser.storage.local.set({
            officialSitesCache: { sites: [{ domain: "good.com" }], fetchedAt: 1, etag: '"old"' }
        })
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(JSON.stringify({ sites: [{ domain: "partner.io" }] }), { status: 200 }))
        )
        await refreshOfficialSites()
        const stored = await fakeBrowser.storage.local.get("officialSitesCache")
        expect(stored.officialSitesCache).toMatchObject({ sites: [{ domain: "partner.io" }] })
        expect(stored.officialSitesCache).not.toHaveProperty("etag")
    })

    it("leaves the cache untouched on a failed check", async () => {
        await fakeBrowser.storage.local.set({
            officialSitesCache: { sites: [{ domain: "good.com", name: "Good" }], fetchedAt: 1 }
        })
        const fetchMock = vi.fn(async () => ({
            ok: false,
            status: 503,
            headers: { get: () => null },
            json: async () => ({})
        }))
        vi.stubGlobal("fetch", fetchMock)
        await refreshOfficialSites()
        const stored = await fakeBrowser.storage.local.get("officialSitesCache")
        expect(stored.officialSitesCache).toMatchObject({ sites: [{ domain: "good.com", name: "Good" }] })
    })
})
