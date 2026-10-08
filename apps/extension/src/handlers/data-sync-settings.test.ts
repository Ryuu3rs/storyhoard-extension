import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { HandlerContext } from "../background/handler-types"
import { db } from "../database"
import type { LibraryManga } from "../database"

vi.mock("../sync", async () => {
    const actual = await vi.importActual<typeof import("../sync")>("../sync")
    return {
        ...actual,
        pushToGist: vi.fn(),
        pullFromGist: vi.fn()
    }
})

const alarmsCreate = vi.fn()
const alarmsClear = vi.fn()

// Minimal in-memory fake for the two browser.* surfaces our handlers touch:
// storage.local (sync.ts / settings.ts) and alarms (alarms.ts). No WXT vitest
// plugin is wired into this repo's vitest config, so `browser` is otherwise
// undefined at runtime here.
function installFakeBrowser() {
    const store = new Map<string, unknown>()
    vi.stubGlobal("browser", {
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
        alarms: {
            create: alarmsCreate,
            clear: alarmsClear
        }
    })
    return store
}

const ctx: HandlerContext = { sender: {} as HandlerContext["sender"] }

const manga: LibraryManga = {
    id: "mangadex:manga:abc",
    title: "Test Manga",
    normalizedTitle: "test manga",
    authors: [],
    status: "ongoing",
    sourceId: "mangadex",
    sourceUrl: "https://mangadex.org/chapter/1",
    addedAt: 1,
    updatedAt: 1
}

beforeEach(async () => {
    vi.clearAllMocks()
    installFakeBrowser()
    await Promise.all([
        db.manga.clear(),
        db.sourceLinks.clear(),
        db.chapters.clear(),
        db.progress.clear(),
        db.historyEvents.clear(),
        db.downloads.clear(),
        db.covers.clear(),
        db.pageBookmarks.clear(),
        db.backups.clear()
    ])
})

describe("data:export / data:import round-trip", () => {
    it("exports current state through the handler and re-imports it with matching counts", async () => {
        const { dataSyncSettingsHandlers } = await import("./data-sync-settings")

        await db.manga.add(manga)
        await db.sourceLinks.add({
            mangaId: manga.id,
            sourceId: "mangadex",
            url: "https://mangadex.org/title/abc",
            addedAt: 1,
            updatedAt: 1
        })
        await db.chapters.add({
            id: "mangadex:chapter:1",
            mangaId: manga.id,
            sourceId: "mangadex",
            title: "Chapter 5",
            url: "https://mangadex.org/chapter/1",
            sortKey: 5
        })
        await db.progress.add({
            mangaId: manga.id,
            chapterId: "mangadex:chapter:1",
            pageIndex: 0,
            pageCount: 10,
            completed: false,
            updatedAt: 1
        })

        const exportedRaw = await dataSyncSettingsHandlers["data:export"]!({ type: "data:export" }, ctx)
        const exported = exportedRaw as {
            data: { manga: unknown[]; chapters: unknown[]; progress: unknown[] }
        }
        expect(exported.data.manga).toHaveLength(1)
        expect(exported.data.chapters).toHaveLength(1)
        expect(exported.data.progress).toHaveLength(1)

        await db.manga.clear()
        await db.chapters.clear()
        await db.sourceLinks.clear()
        await db.progress.clear()

        const importResult = (await dataSyncSettingsHandlers["data:import"]!(
            { type: "data:import", envelope: exported },
            ctx
        )) as { manga: number; chapters: number; skipped: unknown[] }

        expect(importResult.manga).toBe(1)
        expect(importResult.chapters).toBe(1)
        expect(importResult.skipped).toEqual([])
        expect(await db.manga.count()).toBe(1)
        expect(await db.chapters.count()).toBe(1)
        expect(await db.progress.count()).toBe(1)
    })

    it("snapshots a pre-import backup before applying the import", async () => {
        const { dataSyncSettingsHandlers } = await import("./data-sync-settings")

        await db.manga.add(manga)
        const exported = await dataSyncSettingsHandlers["data:export"]!({ type: "data:export" }, ctx)

        expect(await db.backups.count()).toBe(0)
        await dataSyncSettingsHandlers["data:import"]!({ type: "data:import", envelope: exported }, ctx)

        const backups = (await dataSyncSettingsHandlers["data:backup:list"]!(
            { type: "data:backup:list" },
            ctx
        )) as Array<{ id: number; createdAt: number; reason: string }>
        expect(backups).toHaveLength(1)
        expect(backups[0]).toMatchObject({ reason: "pre-import" })
        expect(backups[0]).not.toHaveProperty("envelope")
    })
})

describe("data:backup:restore", () => {
    it("restores a prior snapshot and reports counts through the handler", async () => {
        const { dataSyncSettingsHandlers } = await import("./data-sync-settings")

        await db.manga.add(manga)
        await dataSyncSettingsHandlers["data:import"]!(
            {
                type: "data:import",
                envelope: await dataSyncSettingsHandlers["data:export"]!({ type: "data:export" }, ctx)
            },
            ctx
        )
        const [backup] = (await dataSyncSettingsHandlers["data:backup:list"]!(
            { type: "data:backup:list" },
            ctx
        )) as Array<{ id: number }>

        await db.manga.clear()

        const restoreResult = (await dataSyncSettingsHandlers["data:backup:restore"]!(
            { type: "data:backup:restore", id: backup!.id },
            ctx
        )) as { manga: number; chapters: number; skipped: unknown[] }

        expect(restoreResult.manga).toBe(1)
        expect(await db.manga.get(manga.id)).toBeDefined()
    })
})

describe("sync:config", () => {
    it("filters undefined values from the patch and never echoes the token", async () => {
        const { dataSyncSettingsHandlers } = await import("./data-sync-settings")

        // Seed an existing gistId so we can prove the partial patch below doesn't clear it.
        await dataSyncSettingsHandlers["sync:config"]!(
            { type: "sync:config", config: { gistId: "existing-gist", autoSync: false } },
            ctx
        )

        const result = (await dataSyncSettingsHandlers["sync:config"]!(
            { type: "sync:config", config: { autoSync: true, token: undefined, gistId: undefined } },
            ctx
        )) as { hasToken: boolean; gistId?: string; autoSync: boolean }

        expect(result.autoSync).toBe(true)
        expect(result.gistId).toBe("existing-gist")
        expect(result).not.toHaveProperty("token")
        expect(result.hasToken).toBe(false)
    })

    it("creates the sync alarm when autoSync is true and a token is present", async () => {
        const { dataSyncSettingsHandlers } = await import("./data-sync-settings")

        await dataSyncSettingsHandlers["sync:config"]!(
            { type: "sync:config", config: { token: "gh-token", autoSync: true } },
            ctx
        )

        expect(alarmsCreate).toHaveBeenCalledWith("sync-push", { periodInMinutes: 60 })
    })

    it("does not create the sync alarm when no token is present", async () => {
        const { dataSyncSettingsHandlers } = await import("./data-sync-settings")

        await dataSyncSettingsHandlers["sync:config"]!({ type: "sync:config", config: { autoSync: true } }, ctx)

        expect(alarmsCreate).not.toHaveBeenCalled()
        expect(alarmsClear).toHaveBeenCalledWith("sync-push")
    })
})

describe("autoPush cold start", () => {
    it("waits for the added sources to be registered before exporting the library", async () => {
        const { dataSyncSettingsHandlers, autoPush } = await import("./data-sync-settings")
        const { beginUserSourcesInit } = await import("../background/user-sources-ready")
        const { pushToGist } = await import("../sync")
        await dataSyncSettingsHandlers["sync:config"]!(
            { type: "sync:config", config: { token: "gh-token", autoSync: true } },
            ctx
        )

        let release!: () => void
        void beginUserSourcesInit(() => new Promise<void>(resolve => (release = resolve)))

        const pending = autoPush()
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(pushToGist).not.toHaveBeenCalled()

        release()
        await pending
        expect(pushToGist).toHaveBeenCalledTimes(1)
        await beginUserSourcesInit(async () => undefined)
    })
})

describe("settings:update", () => {
    it("filters undefined values from the patch", async () => {
        const { dataSyncSettingsHandlers } = await import("./data-sync-settings")

        const result = (await dataSyncSettingsHandlers["settings:update"]!(
            {
                type: "settings:update",
                settings: { autoAdd: false, theme: undefined as unknown as "dark" | "light" | "system" }
            },
            ctx
        )) as { autoAdd: boolean; theme: string }

        expect(result.autoAdd).toBe(false)
        // theme untouched by the undefined patch value - falls back to default
        expect(result.theme).toBe("dark")
    })

    it("reconfigures the update alarm with the new interval", async () => {
        const { dataSyncSettingsHandlers } = await import("./data-sync-settings")

        await dataSyncSettingsHandlers["settings:update"]!(
            { type: "settings:update", settings: { updateIntervalHours: 6 } },
            ctx
        )

        // ensureAlarm reconfigures by create() (which overwrites an existing alarm of
        // the same name with the new period) - no separate clear() call is needed.
        expect(alarmsCreate).toHaveBeenCalledWith("check-manga-updates", { periodInMinutes: 6 * 60 })
    })

    it("clears (does not schedule) the update alarm when interval is set to 0", async () => {
        const { dataSyncSettingsHandlers } = await import("./data-sync-settings")

        await dataSyncSettingsHandlers["settings:update"]!(
            { type: "settings:update", settings: { updateIntervalHours: 0 } },
            ctx
        )

        expect(alarmsClear).toHaveBeenCalledWith("check-manga-updates")
        expect(alarmsCreate).not.toHaveBeenCalledWith("check-manga-updates", expect.anything())
    })

    it("arms the daily backup alarm when autoBackup is on and clears it when off", async () => {
        const { dataSyncSettingsHandlers } = await import("./data-sync-settings")

        await dataSyncSettingsHandlers["settings:update"]!(
            { type: "settings:update", settings: { autoBackup: true } },
            ctx
        )
        expect(alarmsCreate).toHaveBeenCalledWith("amr-daily-backup", { periodInMinutes: 24 * 60 })

        vi.clearAllMocks()
        await dataSyncSettingsHandlers["settings:update"]!(
            { type: "settings:update", settings: { autoBackup: false } },
            ctx
        )
        expect(alarmsClear).toHaveBeenCalledWith("amr-daily-backup")
        expect(alarmsCreate).not.toHaveBeenCalledWith("amr-daily-backup", expect.anything())
    })
})

describe("runAutoBackup", () => {
    it("creates an auto backup when the library changed, then skips on an unchanged rerun", async () => {
        const { runAutoBackup } = await import("./data-sync-settings")
        await db.manga.add(manga)

        await runAutoBackup()
        expect(await db.backups.count()).toBe(1)
        expect((await db.backups.toArray())[0]?.reason).toBe("auto")

        // Signature unchanged -> no second snapshot.
        await runAutoBackup()
        expect(await db.backups.count()).toBe(1)

        // Library changes -> a fresh snapshot is taken.
        await db.manga.update(manga.id, { updatedAt: 5_000 })
        await runAutoBackup()
        expect(await db.backups.count()).toBe(2)
    })

    it("no-ops when the library is empty", async () => {
        const { runAutoBackup } = await import("./data-sync-settings")
        await runAutoBackup()
        expect(await db.backups.count()).toBe(0)
    })

    it("no-ops when the autoBackup setting is off", async () => {
        const { runAutoBackup } = await import("./data-sync-settings")
        const { updateSettings } = await import("../settings")
        await updateSettings({ autoBackup: false })
        await db.manga.add(manga)

        await runAutoBackup()
        expect(await db.backups.count()).toBe(0)
    })
})

describe("sync:pull", () => {
    it("imports the pulled envelope's manga into the database", async () => {
        const { dataSyncSettingsHandlers } = await import("./data-sync-settings")
        const { pullFromGist } = await import("../sync")

        const pulledManga: LibraryManga = {
            id: "mangadex:manga:pulled",
            title: "Pulled Manga",
            normalizedTitle: "pulled manga",
            authors: [],
            status: "ongoing",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/pulled",
            addedAt: 1,
            updatedAt: 1
        }
        const envelope = {
            format: "all-mangas-reader",
            version: 1,
            exportedAt: Date.now(),
            data: {
                manga: [pulledManga],
                sourceLinks: [],
                chapters: [],
                progress: [],
                historyEvents: []
            }
        }
        vi.mocked(pullFromGist).mockResolvedValue(envelope)

        await dataSyncSettingsHandlers["sync:pull"]!({ type: "sync:pull" }, ctx)

        expect(pullFromGist).toHaveBeenCalled()
        const stored = await db.manga.get(pulledManga.id)
        expect(stored?.title).toBe("Pulled Manga")

        // Same safety net as data:import: a pull overwrites/merges local data too.
        const backups = await db.backups.toArray()
        expect(backups).toHaveLength(1)
        expect(backups[0]?.reason).toBe("pre-sync-pull")
    })
})
