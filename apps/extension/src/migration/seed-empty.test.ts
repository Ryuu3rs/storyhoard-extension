import "fake-indexeddb/auto"
import { parseProfile } from "@amr/source-engine"
import { sourceRegistry } from "@amr/sources"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { db, putArchProfile } from "../database"

// The shipped build loads the migration seed with no profiles (wxt.config.ts stripSiteProfiles).
vi.mock("./seed-profiles", async importOriginal => ({
    ...(await importOriginal<typeof import("./seed-profiles")>()),
    loadSeedProfiles: () => new Map(),
    isCommittedSeedProfile: () => false,
    seedIsBundled: () => false
}))
vi.mock("../background/chapter-cache", () => ({ scheduleChapterListRefresh: vi.fn() }))
vi.mock("../settings", () => ({ getSettings: async () => ({ language: "en" }) }))

const { initUserSources } = await import("../arch-sources")
const { runSourceMigrationSeed } = await import("./seed-register")
const { getSourceById } = await import("../sources")

const ORIGIN = "https://example-scans.net"
const PROFILE_ID = "example-scans"

const parsed = parseProfile({
    profileFormat: 2,
    id: PROFILE_ID,
    name: "Example Scans",
    engine: "generic",
    origin: ORIGIN,
    domains: ["example-scans.net"],
    languages: ["en"],
    capabilities: ["manga"],
    numberingKind: "chapter",
    requestRateLimit: { requests: 50, intervalMs: 1000 },
    origins: [`${ORIGIN}/*`],
    match: { manga: "^/manga/([a-z0-9-]+)/?$", chapter: "^/manga/([a-z0-9-]+)/ch-([0-9.]+)/?$" },
    series: { urlTemplate: "/manga/{slug}", titlePattern: '<meta property="og:title" content="(?<title>[^"]+)"' }
})
if (!parsed.ok) throw new Error(parsed.error)
const seedRow = parsed.profile

const permissions = { contains: vi.fn(), getAll: vi.fn() }
let localStore: Record<string, unknown> = {}

beforeEach(async () => {
    await db.archProfiles.clear()
    await db.manga.clear()
    localStore = {}
    permissions.contains.mockReset().mockResolvedValue(true)
    permissions.getAll.mockReset().mockResolvedValue({ origins: [] })
    vi.stubGlobal("browser", {
        permissions,
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
})

afterEach(() => {
    sourceRegistry.unregister(PROFILE_ID)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe("a build with an empty migration seed", () => {
    it("writes nothing on install or update and keeps every stored seed row", async () => {
        await putArchProfile(PROFILE_ID, seedRow, "seed")
        await db.manga.put({
            id: "m1",
            title: "Demo",
            normalizedTitle: "demo",
            authors: [],
            status: "ongoing",
            sourceId: PROFILE_ID,
            sourceUrl: `${ORIGIN}/manga/demo`,
            addedAt: 1,
            updatedAt: 1
        })

        const result = await runSourceMigrationSeed()

        expect(result.seeded).toEqual([])
        expect(await db.archProfiles.get(PROFILE_ID)).toMatchObject({ origin: "seed", profile: seedRow })
        expect(await db.manga.get("m1")).toBeDefined()
    })

    it("registers a stored seed row like a site the user added once its access is granted", async () => {
        await putArchProfile(PROFILE_ID, seedRow, "seed")
        permissions.getAll.mockResolvedValue({ origins: [`${ORIGIN}/*`] })

        await initUserSources()

        expect(getSourceById(PROFILE_ID)?.manifest.id).toBe(PROFILE_ID)
    })

    it("leaves a stored seed row unregistered, and in place, while its access was never granted", async () => {
        await putArchProfile(PROFILE_ID, seedRow, "seed")
        permissions.contains.mockResolvedValue(false)

        await initUserSources()

        expect(getSourceById(PROFILE_ID)).toBeUndefined()
        expect(await db.archProfiles.get(PROFILE_ID)).toBeDefined()
    })
})
