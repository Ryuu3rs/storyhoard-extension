import "fake-indexeddb/auto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { db } from "../database"

// seed-register first shipped in 0.30.0. A user who jumps straight from an older release to the store build
// (a sideloaded copy updated by hand, or a Firefox install that missed the updates in between) never had seed
// rows written, and the store build bundles an empty seed. Their titles' own addresses still name the site,
// so the fix-it page offers Turn on for it, and the grant writes a minimal row under the existing source id.

vi.mock("./seed-profiles", async importOriginal => ({
    ...(await importOriginal<typeof import("./seed-profiles")>()),
    loadSeedProfiles: () => new Map(),
    isCommittedSeedProfile: () => false,
    seedIsBundled: () => false
}))
vi.mock("../background/chapter-cache", () => ({ scheduleChapterListRefresh: vi.fn() }))
vi.mock("../settings", () => ({ getSettings: async () => ({ language: "en" }) }))
vi.mock("wxt/browser", () => ({
    browser: {
        permissions: {
            contains: async (request: { origins?: string[] }) =>
                (request.origins ?? []).every(origin => granted.has(origin))
        }
    }
}))

const { runSourceMigrationSeed } = await import("./seed-register")
const { fixItHandlers } = await import("../handlers/fix-it")
const { getSourceById } = await import("../sources")
const { sourceRegistry } = await import("@amr/sources")

const SITE_ID = "example-scans"
const ORIGIN = "https://example-scans.net"
let localStore: Record<string, unknown> = {}
let granted: Set<string>

type Overview = { sites: Array<{ sourceId: string; canTurnOn: boolean; origins: string[] }> }
const overview = async (sourceIds: string[]): Promise<Overview> =>
    (await fixItHandlers["fixit:overview"]!({ type: "fixit:overview", sourceIds } as never, {} as never)) as Overview

beforeEach(async () => {
    await Promise.all([db.manga.clear(), db.sourceLinks.clear(), db.archProfiles.clear()])
    localStore = {}
    granted = new Set()
    vi.stubGlobal("browser", {
        permissions: {
            contains: vi.fn(async (request: { origins?: string[] }) =>
                (request.origins ?? []).every(origin => granted.has(origin))
            ),
            getAll: vi.fn(async () => ({ origins: [...granted] }))
        },
        runtime: { getManifest: () => ({ host_permissions: [] }) },
        storage: {
            local: {
                get: vi.fn(async (key: string) => (key in localStore ? { [key]: localStore[key] } : {})),
                set: vi.fn(async (items: Record<string, unknown>) => {
                    localStore = { ...localStore, ...items }
                })
            }
        }
    })
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await db.manga.put({
        id: "m1",
        title: "Demo",
        normalizedTitle: "demo",
        authors: [],
        status: "ongoing",
        sourceId: SITE_ID,
        sourceUrl: `${ORIGIN}/manga/demo/ch-3`,
        mangaUrl: `${ORIGIN}/manga/demo`,
        sourceMangaId: "demo",
        addedAt: 1,
        updatedAt: 1
    })
})

afterEach(() => {
    sourceRegistry.unregister(SITE_ID)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe("a library source with no stored profile, in the store build", () => {
    it("still offers a way to turn the title's site back on", async () => {
        await runSourceMigrationSeed()
        expect((await overview([SITE_ID])).sites).toEqual([
            expect.objectContaining({ sourceId: SITE_ID, canTurnOn: true })
        ])
    })

    it("asks for the site host and its www twin only", async () => {
        const [site] = (await overview([SITE_ID])).sites
        expect([...site!.origins].sort()).toEqual([`${ORIGIN}/*`, "https://www.example-scans.net/*"])
    })

    it("on grant writes a minimal row under the existing source id and registers it", async () => {
        const [site] = (await overview([SITE_ID])).sites
        for (const origin of site!.origins) granted.add(origin)
        const result = (await fixItHandlers["fixit:enable-site"]!(
            { type: "fixit:enable-site", sourceId: SITE_ID } as never,
            {} as never
        )) as { enabled: boolean }
        expect(result.enabled).toBe(true)
        const row = await db.archProfiles.get(SITE_ID)
        expect(row?.origin).toBe("seed")
        expect((row?.profile as { id: string; list?: unknown }).id).toBe(SITE_ID)
        expect((row?.profile as { list?: unknown }).list).toBeUndefined()
        expect(getSourceById(SITE_ID)).toBeDefined()
    })

    it("writes nothing without the grant", async () => {
        const result = (await fixItHandlers["fixit:enable-site"]!(
            { type: "fixit:enable-site", sourceId: SITE_ID } as never,
            {} as never
        )) as { enabled: boolean }
        expect(result.enabled).toBe(false)
        expect(await db.archProfiles.get(SITE_ID)).toBeUndefined()
    })

    it("never offers a site that only lab sample rows name, or an address that is not an addable https site", async () => {
        await db.manga.clear()
        await db.manga.bulkPut([
            {
                id: "seed-xx-001",
                title: "Sample",
                normalizedTitle: "sample",
                authors: [],
                status: "ongoing",
                sourceId: SITE_ID,
                sourceUrl: `${ORIGIN}/manga/sample/ch-1`,
                mangaUrl: `${ORIGIN}/manga/sample`,
                coverUrl: "/sample-covers/sample.jpg",
                addedAt: 1,
                updatedAt: 1
            },
            {
                id: "local-1",
                title: "Local",
                normalizedTitle: "local",
                authors: [],
                status: "ongoing",
                sourceId: "local-site",
                sourceUrl: "http://192.168.1.2/manga/a/ch-1",
                mangaUrl: "http://192.168.1.2/manga/a",
                addedAt: 1,
                updatedAt: 1
            }
        ])
        expect((await overview([SITE_ID, "local-site"])).sites.map(site => site.canTurnOn)).toEqual([false, false])
    })
})
