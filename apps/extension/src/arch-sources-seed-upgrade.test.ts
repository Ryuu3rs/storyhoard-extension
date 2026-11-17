import "fake-indexeddb/auto"
import { parseProfile, type SiteProfile } from "@amr/source-engine"
import { OFFICIAL_SOURCE_IDS, sourceRegistry } from "@amr/sources"
import seedJson from "@amr/sources/migration-seed.json"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { db, putArchProfile } from "./database"

// 0.30.0 to 0.32.2 wrote one archProfiles row with origin "seed" for each non-official source in the user's
// library. The store build bundles an empty seed, so it cannot vouch for those rows. Rows whose committed
// profile reaches beyond the origin host and its www twin (a bare-vs-www mismatch, a second domain, a
// wildcard, a CDN or sister origin) are narrowed to that pair instead of refused, so every one of them can
// still be turned on, and the prompt and the registration ask for the same patterns.
//
// The real committed seed is the fixture, so a later seed edit cannot reopen the gap. Test files are not
// part of any build output.
vi.mock("./migration/seed-profiles", async importOriginal => ({
    ...(await importOriginal<typeof import("./migration/seed-profiles")>()),
    loadSeedProfiles: () => new Map(),
    isCommittedSeedProfile: () => false,
    seedIsBundled: () => false
}))
vi.mock("./background/chapter-cache", () => ({ scheduleChapterListRefresh: vi.fn() }))
vi.mock("./settings", () => ({ getSettings: async () => ({ language: "en" }) }))

const { initUserSources, siteAccessPatternsOf, storedRowAccessPatterns } = await import("./arch-sources")
const { fixItHandlers } = await import("./handlers/fix-it")

const realSeedRows: SiteProfile[] = (seedJson as { profiles: unknown[] }).profiles
    .map(raw => parseProfile(raw))
    .flatMap(parsed => (parsed.ok ? [parsed.profile] : []))
    .filter(profile => !OFFICIAL_SOURCE_IDS.includes(profile.id))

let granted: Set<string>

beforeEach(async () => {
    await db.archProfiles.clear()
    granted = new Set()
    vi.stubGlobal("browser", {
        permissions: {
            contains: vi.fn(async (request: { origins?: string[] }) =>
                (request.origins ?? []).every(origin => granted.has(origin))
            ),
            getAll: vi.fn(async () => ({ origins: [...granted] }))
        },
        runtime: { getManifest: () => ({ host_permissions: [] }) },
        storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } }
    })
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
    for (const profile of realSeedRows) sourceRegistry.unregister(profile.id)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

const twinPair = (origin: string): string[] => {
    const bare = new URL(origin).hostname.replace(/^www\./, "")
    return [`https://${bare}/*`, `https://www.${bare}/*`]
}

describe("seed rows from an older build, in the store build", () => {
    it("the real seed has rows to check", () => {
        expect(realSeedRows.length).toBeGreaterThan(20)
    })

    it("every stored seed row can be turned on again (has access patterns)", async () => {
        const stuck: string[] = []
        for (const profile of realSeedRows) {
            await putArchProfile(profile.id, profile, "seed")
            const row = (await db.archProfiles.get(profile.id))!
            if (storedRowAccessPatterns(row).length === 0) stuck.push(profile.id)
        }
        expect(stuck).toEqual([])
    })

    it("never asks for more than the origin host and its www twin", async () => {
        for (const profile of realSeedRows) {
            await putArchProfile(profile.id, profile, "seed")
            const row = (await db.archProfiles.get(profile.id))!
            const allowed = new Set(twinPair(profile.origin))
            expect(
                storedRowAccessPatterns(row).every(pattern => allowed.has(pattern)),
                profile.id
            ).toBe(true)
        }
    })

    it("the fix-it page offers Turn on for every upgraded seed site", async () => {
        for (const profile of realSeedRows) await putArchProfile(profile.id, profile, "seed")
        const overview = (await fixItHandlers["fixit:overview"]!(
            { type: "fixit:overview", sourceIds: realSeedRows.map(p => p.id) } as never,
            {} as never
        )) as { sites: Array<{ sourceId: string; canTurnOn: boolean }> }
        const cannot = overview.sites.filter(site => !site.canTurnOn).map(site => site.sourceId)
        expect(cannot).toEqual([])
    })

    it("registers each row with exactly the patterns the prompt asked for, once they are granted", async () => {
        const asked = new Map<string, string[]>()
        for (const profile of realSeedRows) {
            await putArchProfile(profile.id, profile, "seed")
            const patterns = storedRowAccessPatterns((await db.archProfiles.get(profile.id))!)
            asked.set(profile.id, patterns)
            for (const pattern of patterns) granted.add(pattern)
        }
        await initUserSources()
        const unregistered = realSeedRows
            .filter(profile => sourceRegistry.get(profile.id) === undefined)
            .map(profile => profile.id)
        expect(unregistered).toEqual([])
        for (const profile of realSeedRows) {
            expect([...(siteAccessPatternsOf(profile.id) ?? [])].sort(), profile.id).toEqual(
                [...asked.get(profile.id)!].sort()
            )
        }
    })
})
