import "fake-indexeddb/auto"
import { parseProfile } from "@amr/source-engine"
import { sourceRegistry } from "@amr/sources"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { HandlerContext } from "../background/handler-types"
import { createBackup, db, exportDatabase, importDatabase, putArchProfile } from "../database"
import type { LibraryManga } from "../database"

vi.mock("../background/chapter-cache", () => ({ scheduleChapterListRefresh: vi.fn() }))
vi.mock("../settings", () => ({ getSettings: async () => ({ language: "en" }) }))

const store = new Map<string, unknown>()
const permissions = { contains: vi.fn(), remove: vi.fn() }

function installBrowser(): void {
    store.clear()
    vi.stubGlobal("browser", {
        permissions,
        storage: {
            local: {
                get: vi.fn(async (key: string) => ({ [key]: store.get(key) })),
                set: vi.fn(async (items: Record<string, unknown>) => {
                    for (const [k, v] of Object.entries(items)) store.set(k, v)
                }),
                remove: vi.fn(async (key: string) => {
                    store.delete(key)
                })
            }
        },
        alarms: { create: vi.fn(), clear: vi.fn() }
    })
}

const { dataSyncSettingsHandlers } = await import("./data-sync-settings")
const { isProfileSource, listImportedProfiles, registerStoredArchProfiles } = await import("../arch-sources")

const ctx: HandlerContext = { sender: {} as HandlerContext["sender"] }
const ORIGIN = "https://example-scans.net"
const PROFILE_ID = "example-scans.net"

const profileRaw = {
    profileFormat: 2,
    id: PROFILE_ID,
    name: "Example Scans",
    engine: "generic",
    origin: ORIGIN,
    domains: [PROFILE_ID],
    languages: ["en"],
    capabilities: ["chapters", "manga"],
    numberingKind: "chapter",
    requestRateLimit: { requests: 50, intervalMs: 1000 },
    origins: [`${ORIGIN}/*`],
    match: { manga: "^/manga/([a-z0-9-]+)/?$", chapter: "^/manga/([a-z0-9-]+)/ch-([0-9.]+)/?$" },
    series: { urlTemplate: "/manga/{slug}", titlePattern: '<meta property="og:title" content="(?<title>[^"]+)"' },
    list: {
        itemPattern: 'href="(?<chapterUrl>/manga/[a-z0-9-]+/ch-(?<chapterNumber>[0-9.]+))"'
    }
}

function parsedProfile() {
    const parsed = parseProfile(profileRaw)
    if (!parsed.ok) throw new Error(parsed.error)
    return parsed.profile
}

function sushiManga(): LibraryManga {
    return {
        id: "m-sushi",
        title: "Title",
        normalizedTitle: "title",
        authors: [],
        status: "ongoing",
        addedAt: 1,
        updatedAt: 1,
        sourceId: "mangasushi",
        sourceUrl: "https://example.test/m-sushi",
        sourceMangaId: "m-sushi"
    }
}

beforeEach(async () => {
    installBrowser()
    permissions.contains.mockReset().mockResolvedValue(true)
    permissions.remove.mockReset().mockResolvedValue(true)
    await Promise.all(db.tables.map(table => table.clear()))
})

afterEach(() => {
    sourceRegistry.unregister(PROFILE_ID)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe("a restore or pull that drops an added source", () => {
    it("unregisters it, so it is not left live and unremovable until the worker restarts", async () => {
        const snapshot = await createBackup("auto")
        await putArchProfile(PROFILE_ID, parsedProfile(), "user")
        await registerStoredArchProfiles({ onlyUnresolved: true })
        expect(isProfileSource(PROFILE_ID)).toBe(true)

        await dataSyncSettingsHandlers["data:backup:restore"]!({ type: "data:backup:restore", id: snapshot }, ctx)

        expect(await db.archProfiles.get(PROFILE_ID)).toBeUndefined()
        expect(isProfileSource(PROFILE_ID)).toBe(false)
        expect(sourceRegistry.get(PROFILE_ID)).toBeUndefined()
        expect(await listImportedProfiles()).toEqual([])
    })

    it("keeps a source the restore still contains", async () => {
        await putArchProfile(PROFILE_ID, parsedProfile(), "user")
        const snapshot = await createBackup("auto")
        await registerStoredArchProfiles({ onlyUnresolved: true })

        await dataSyncSettingsHandlers["data:backup:restore"]!({ type: "data:backup:restore", id: snapshot }, ctx)

        expect(isProfileSource(PROFILE_ID)).toBe(true)
    })
})

describe("a restore that wipes the profile rows", () => {
    it("re-seeds the sources the restored library uses", async () => {
        await db.manga.put(sushiManga())
        const snapshot = await createBackup("auto")
        expect(await db.archProfiles.get("mangasushi")).toBeUndefined()

        await dataSyncSettingsHandlers["data:backup:restore"]!({ type: "data:backup:restore", id: snapshot }, ctx)

        expect((await db.archProfiles.get("mangasushi"))?.origin).toBe("seed")
    })
})

describe("importing profile rows never downgrades a local one", () => {
    async function importRows(rows: Array<{ id: string; profile: unknown; importedAt: number; origin?: string }>) {
        const envelope = (await exportDatabase()) as { data: Record<string, unknown> }
        envelope.data["archProfiles"] = rows
        await importDatabase(envelope as never)
    }

    it("does not replace a user-added row with a seed row", async () => {
        const mine = parsedProfile()
        await putArchProfile(PROFILE_ID, mine, "user")

        await importRows([
            { id: PROFILE_ID, profile: { ...mine, name: "Seed stand-in" }, importedAt: 1, origin: "seed" }
        ])

        const row = await db.archProfiles.get(PROFILE_ID)
        expect(row?.origin).toBe("user")
        expect((row?.profile as { name: string }).name).toBe("Example Scans")
    })

    it("does not replace a row that has a chapter list with one that has none", async () => {
        const mine = parsedProfile()
        await putArchProfile(PROFILE_ID, mine, "user")
        const { list: _list, ...listless } = mine

        await importRows([{ id: PROFILE_ID, profile: listless, importedAt: 1, origin: "user" }])

        expect((await db.archProfiles.get(PROFILE_ID))?.profile).toHaveProperty("list")
    })

    it("still replaces a list-less seed row with an imported user row that has a list", async () => {
        const mine = parsedProfile()
        const { list: _list, ...listless } = mine
        await putArchProfile(PROFILE_ID, listless, "seed")

        await importRows([{ id: PROFILE_ID, profile: mine, importedAt: 1, origin: "user" }])

        const row = await db.archProfiles.get(PROFILE_ID)
        expect(row?.origin).toBe("user")
        expect(row?.profile).toHaveProperty("list")
    })

    it("adds a row that is not stored locally", async () => {
        await importRows([{ id: PROFILE_ID, profile: parsedProfile(), importedAt: 1, origin: "user" }])
        expect(await db.archProfiles.get(PROFILE_ID)).toBeDefined()
    })
})
