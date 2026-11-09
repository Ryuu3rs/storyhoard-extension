import "fake-indexeddb/auto"
import type { MangaRecord } from "@amr/contracts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { db, type LibraryManga } from "../database"

const {
    getAniListConfigMock,
    setAniListConfigMock,
    getViewerProgressMock,
    saveViewerProgressMock,
    getMediaListEntryIdMock,
    getViewerListEntryMock,
    saveMediaStatusMock,
    deleteMediaListEntryMock,
    getViewerNameMock,
    getViewerMangaListMock,
    getKnownMembershipMock,
    setKnownMembershipMock,
    resolveMetadataMock,
    configureAniListAlarmMock,
    getSettingsMock
} = vi.hoisted(() => ({
    getAniListConfigMock: vi.fn(),
    setAniListConfigMock: vi.fn(),
    getViewerProgressMock: vi.fn(),
    saveViewerProgressMock: vi.fn(),
    getMediaListEntryIdMock: vi.fn(),
    getViewerListEntryMock: vi.fn(),
    saveMediaStatusMock: vi.fn(),
    deleteMediaListEntryMock: vi.fn(),
    getViewerNameMock: vi.fn(),
    getViewerMangaListMock: vi.fn(),
    getKnownMembershipMock: vi.fn(),
    setKnownMembershipMock: vi.fn(),
    resolveMetadataMock: vi.fn(),
    configureAniListAlarmMock: vi.fn(),
    getSettingsMock: vi.fn()
}))

// Keep the pure status-mapping helpers real (they carry the reconcile decision logic);
// only the network functions are mocked.
vi.mock("../anilist", async () => {
    const actual = await vi.importActual<typeof import("../anilist")>("../anilist")
    return {
        getAniListConfig: getAniListConfigMock,
        setAniListConfig: setAniListConfigMock,
        getAniListStatus: vi.fn(),
        getViewerName: getViewerNameMock,
        getViewerProgress: getViewerProgressMock,
        saveViewerProgress: saveViewerProgressMock,
        getViewerMangaList: getViewerMangaListMock,
        getViewerListEntry: getViewerListEntryMock,
        getMediaListEntryId: getMediaListEntryIdMock,
        saveMediaStatus: saveMediaStatusMock,
        deleteMediaListEntry: deleteMediaListEntryMock,
        getKnownMembership: getKnownMembershipMock,
        setKnownMembership: setKnownMembershipMock,
        resolveStatusSync: actual.resolveStatusSync,
        localStatusToAniList: actual.localStatusToAniList,
        aniListStatusToLocal: actual.aniListStatusToLocal
    }
})
vi.mock("../metadata", () => ({ resolveMetadata: resolveMetadataMock }))
vi.mock("../settings", () => ({ getSettings: getSettingsMock }))
vi.mock("../background/alarms", () => ({ configureAniListAlarm: configureAniListAlarmMock }))
vi.mock("../live", () => ({ publishLive: vi.fn() }))

function makeManga(o: Partial<LibraryManga> = {}): LibraryManga {
    const base: MangaRecord = {
        id: o.id ?? `src:manga:${Math.random().toString(36).slice(2)}`,
        title: o.title ?? "Test",
        normalizedTitle: "test",
        authors: [],
        status: "ongoing",
        addedAt: 1,
        updatedAt: 1
    }
    return { ...base, sourceId: "mangadex", sourceUrl: "https://x/c/1", ...o }
}

beforeEach(async () => {
    await db.manga.clear()
    getAniListConfigMock.mockReset()
    getAniListConfigMock.mockResolvedValue({ token: "t", autoSync: false, syncMembership: false })
    setAniListConfigMock.mockReset()
    setAniListConfigMock.mockResolvedValue({ token: "t", autoSync: false, syncMembership: false })
    getViewerProgressMock.mockReset()
    saveViewerProgressMock.mockReset()
    getMediaListEntryIdMock.mockReset()
    getViewerListEntryMock.mockReset()
    saveMediaStatusMock.mockReset()
    deleteMediaListEntryMock.mockReset()
    getViewerNameMock.mockReset()
    getViewerMangaListMock.mockReset()
    getKnownMembershipMock.mockReset()
    getKnownMembershipMock.mockResolvedValue([])
    setKnownMembershipMock.mockReset()
    setKnownMembershipMock.mockResolvedValue(undefined)
    resolveMetadataMock.mockReset()
    getSettingsMock.mockReset()
    getSettingsMock.mockResolvedValue({
        anilistImportPaused: true,
        anilistImportDropped: true,
        anilistImportPlanning: true
    })
    // Make the inter-title rate-limit delay instant.
    vi.stubGlobal("setTimeout", (fn: () => void) => {
        fn()
        return 0
    })
})

afterEach(() => vi.unstubAllGlobals())

describe("runAniListSync", () => {
    it("pushes the floored local progress when it is higher than remote", async () => {
        const { runAniListSync } = await import("./anilist")
        await db.manga.put(makeManga({ id: "m1", anilistId: 100, lastReadChapterNumber: 10.7 }))
        getViewerProgressMock.mockResolvedValue(5)
        saveViewerProgressMock.mockResolvedValue(10)

        const result = await runAniListSync()

        expect(saveViewerProgressMock).toHaveBeenCalledWith("t", 100, 10)
        expect(result.pushed).toBe(1)
    })

    it("does not lower remote progress", async () => {
        const { runAniListSync } = await import("./anilist")
        await db.manga.put(makeManga({ id: "m1", anilistId: 100, lastReadChapterNumber: 3 }))
        getViewerProgressMock.mockResolvedValue(20)

        const result = await runAniListSync()

        expect(saveViewerProgressMock).not.toHaveBeenCalled()
        expect(result.pushed).toBe(0)
        expect(result.checked).toBe(1)
    })

    it("resolves and caches a missing anilistId before pushing", async () => {
        const { runAniListSync } = await import("./anilist")
        await db.manga.put(makeManga({ id: "m1", title: "Solo Leveling", lastReadChapterNumber: 4 }))
        resolveMetadataMock.mockResolvedValue({ anilistId: 777 })
        getViewerProgressMock.mockResolvedValue(undefined)
        saveViewerProgressMock.mockResolvedValue(4)

        const result = await runAniListSync()

        expect(saveViewerProgressMock).toHaveBeenCalledWith("t", 777, 4)
        expect((await db.manga.get("m1"))?.anilistId).toBe(777)
        expect(result.pushed).toBe(1)
    })

    it("skips titles with no read number, on hold, or no resolvable anilistId", async () => {
        const { runAniListSync } = await import("./anilist")
        await db.manga.bulkPut([
            makeManga({ id: "no-num", anilistId: 1 }),
            makeManga({ id: "held", anilistId: 2, lastReadChapterNumber: 5, onHold: true }),
            makeManga({ id: "no-id", title: "Unknown", lastReadChapterNumber: 5 })
        ])
        resolveMetadataMock.mockResolvedValue(null)

        const result = await runAniListSync()

        expect(saveViewerProgressMock).not.toHaveBeenCalled()
        // no-num and held are filtered out entirely; no-id is checked-and-skipped.
        expect(result.pushed).toBe(0)
    })

    it("throws when no token is configured", async () => {
        const { runAniListSync } = await import("./anilist")
        getAniListConfigMock.mockResolvedValue({ autoSync: false })
        await expect(runAniListSync()).rejects.toThrow(/token/i)
    })

    it("adds an unread cached title as PLANNING only when membership sync is on", async () => {
        const { runAniListSync } = await import("./anilist")
        getAniListConfigMock.mockResolvedValue({ token: "t", autoSync: false, syncMembership: true })
        await db.manga.put(makeManga({ id: "u1", anilistId: 55 })) // unread, cached id
        getMediaListEntryIdMock.mockResolvedValue(undefined) // not on the list yet

        const result = await runAniListSync()

        expect(saveMediaStatusMock).toHaveBeenCalledWith("t", 55, "PLANNING")
        expect(result.added).toBe(1)
    })

    it("does not re-add an unread title that is already on the list", async () => {
        const { runAniListSync } = await import("./anilist")
        getAniListConfigMock.mockResolvedValue({ token: "t", autoSync: false, syncMembership: true })
        await db.manga.put(makeManga({ id: "u1", anilistId: 55 }))
        getMediaListEntryIdMock.mockResolvedValue(9001) // already has an entry

        const result = await runAniListSync()

        expect(saveMediaStatusMock).not.toHaveBeenCalled()
        expect(result.added).toBe(0)
    })

    it("pushes a read-to-Ch0.5 title as progress, never PLANNING (floored 0 is still read)", async () => {
        const { runAniListSync } = await import("./anilist")
        getAniListConfigMock.mockResolvedValue({ token: "t", autoSync: false, syncMembership: true })
        // Read only to 0.5 -> Math.floor is 0, but the title is read, not unread.
        await db.manga.put(makeManga({ id: "r0", anilistId: 42, lastReadChapterNumber: 0.5 }))
        getViewerProgressMock.mockResolvedValue(undefined)
        saveViewerProgressMock.mockResolvedValue(0)
        getMediaListEntryIdMock.mockResolvedValue(undefined)
        getViewerMangaListMock.mockResolvedValue([{ anilistId: 999 }])

        const result = await runAniListSync()

        expect(saveMediaStatusMock).not.toHaveBeenCalled() // never treated as PLANNING
        expect(saveViewerProgressMock).toHaveBeenCalledWith("t", 42, 0)
        expect(result.added).toBe(0)
    })
})

describe("removeFromAniList", () => {
    it("deletes the list entry when membership sync is on", async () => {
        const { removeFromAniList } = await import("./anilist")
        getAniListConfigMock.mockResolvedValue({ token: "t", autoSync: false, syncMembership: true })
        getMediaListEntryIdMock.mockResolvedValue(4242)

        await removeFromAniList(55)

        expect(deleteMediaListEntryMock).toHaveBeenCalledWith("t", 4242)
    })

    it("is a no-op when membership sync is off or the id is unknown", async () => {
        const { removeFromAniList } = await import("./anilist")
        getAniListConfigMock.mockResolvedValue({ token: "t", autoSync: false, syncMembership: false })
        await removeFromAniList(55)
        await removeFromAniList(undefined)
        expect(getMediaListEntryIdMock).not.toHaveBeenCalled()
        expect(deleteMediaListEntryMock).not.toHaveBeenCalled()
    })
})

describe("anilist:import", () => {
    function entry(o: Record<string, unknown> = {}) {
        return {
            anilistId: 100,
            title: "Solo Leveling",
            status: "ongoing" as const,
            genres: ["Action"],
            progress: 0,
            ...o
        }
    }

    it("creates a reconcile-ready entry with progress as lastReadChapterNumber", async () => {
        const { runAniListImport } = await import("./anilist")
        getViewerMangaListMock.mockResolvedValue([
            entry({ anilistId: 100, progress: 42, coverUrl: "https://s4.anilist.co/cover/100.jpg" })
        ])

        const result = await runAniListImport()

        expect(result).toEqual({ imported: 1, skipped: 0, total: 1 })
        const created = await db.manga.get("anilist:manga:100")
        expect(created).toMatchObject({
            anilistId: 100,
            title: "Solo Leveling",
            normalizedTitle: "solo leveling",
            status: "ongoing",
            genres: ["Action"],
            coverUrl: "https://s4.anilist.co/cover/100.jpg",
            manualTracking: true,
            lastReadChapterNumber: 42,
            authors: []
        })
        // Surfaces in the ImportReconcile relink flow: manualTracking + a dot-containing sourceId.
        expect(created?.sourceId).toContain(".")
        expect(created?.manualTracking).toBe(true)
    })

    it("omits lastReadChapterNumber when progress is 0", async () => {
        const { runAniListImport } = await import("./anilist")
        getViewerMangaListMock.mockResolvedValue([entry({ anilistId: 200, progress: 0 })])

        await runAniListImport()

        expect((await db.manga.get("anilist:manga:200"))?.lastReadChapterNumber).toBeUndefined()
    })

    it("skips a title already in the library by anilistId", async () => {
        const { runAniListImport } = await import("./anilist")
        await db.manga.put(makeManga({ id: "existing", anilistId: 100 }))
        getViewerMangaListMock.mockResolvedValue([entry({ anilistId: 100 })])

        const result = await runAniListImport()

        expect(result).toEqual({ imported: 0, skipped: 1, total: 1 })
        expect(await db.manga.get("anilist:manga:100")).toBeUndefined()
    })

    it("skips a title already in the library by normalizedTitle", async () => {
        const { runAniListImport } = await import("./anilist")
        await db.manga.put(makeManga({ id: "existing", title: "Solo Leveling", normalizedTitle: "solo leveling" }))
        getViewerMangaListMock.mockResolvedValue([entry({ anilistId: 999, title: "Solo Leveling" })])

        const result = await runAniListImport()

        expect(result).toEqual({ imported: 0, skipped: 1, total: 1 })
    })

    it("imports the new titles and counts the duplicates as skipped", async () => {
        const { runAniListImport } = await import("./anilist")
        await db.manga.put(makeManga({ id: "existing", anilistId: 1 }))
        getViewerMangaListMock.mockResolvedValue([
            entry({ anilistId: 1, title: "Dup" }),
            entry({ anilistId: 2, title: "Fresh A" }),
            entry({ anilistId: 3, title: "Fresh B" })
        ])

        const result = await runAniListImport()

        expect(result).toEqual({ imported: 2, skipped: 1, total: 3 })
    })

    it("throws when no token is configured", async () => {
        const { runAniListImport } = await import("./anilist")
        getAniListConfigMock.mockResolvedValue({ autoSync: false })
        await expect(runAniListImport()).rejects.toThrow(/account|token/i)
        expect(getViewerMangaListMock).not.toHaveBeenCalled()
    })

    it("carries the AniList list status onto readingStatus", async () => {
        const { runAniListImport } = await import("./anilist")
        getViewerMangaListMock.mockResolvedValue([
            entry({ anilistId: 10, title: "Paused One", listStatus: "paused" }),
            entry({ anilistId: 11, title: "Dropped One", listStatus: "dropped" }),
            entry({ anilistId: 12, title: "Planning One", listStatus: "planning" }),
            entry({ anilistId: 13, title: "Reading One" }) // no listStatus
        ])

        await runAniListImport()

        expect((await db.manga.get("anilist:manga:10"))?.readingStatus).toBe("paused")
        expect((await db.manga.get("anilist:manga:11"))?.readingStatus).toBe("dropped")
        expect((await db.manga.get("anilist:manga:12"))?.readingStatus).toBe("planning")
        expect((await db.manga.get("anilist:manga:13"))?.readingStatus).toBeUndefined()
    })

    it("skips paused/dropped entries when those import options are off", async () => {
        const { runAniListImport } = await import("./anilist")
        getSettingsMock.mockResolvedValue({
            anilistImportPaused: false,
            anilistImportDropped: false,
            anilistImportPlanning: true
        })
        getViewerMangaListMock.mockResolvedValue([
            entry({ anilistId: 20, title: "Paused", listStatus: "paused" }),
            entry({ anilistId: 21, title: "Dropped", listStatus: "dropped" }),
            entry({ anilistId: 22, title: "Planning", listStatus: "planning" }),
            entry({ anilistId: 23, title: "Reading" })
        ])

        const result = await runAniListImport()

        expect(result.imported).toBe(2)
        expect(await db.manga.get("anilist:manga:20")).toBeUndefined()
        expect(await db.manga.get("anilist:manga:21")).toBeUndefined()
        expect((await db.manga.get("anilist:manga:22"))?.readingStatus).toBe("planning")
        expect(await db.manga.get("anilist:manga:23")).toBeDefined()
    })

    it("skips planning entries when the planning import option is off", async () => {
        const { runAniListImport } = await import("./anilist")
        getSettingsMock.mockResolvedValue({
            anilistImportPaused: true,
            anilistImportDropped: true,
            anilistImportPlanning: false
        })
        getViewerMangaListMock.mockResolvedValue([
            entry({ anilistId: 30, title: "Planning", listStatus: "planning" }),
            entry({ anilistId: 31, title: "Reading" })
        ])

        const result = await runAniListImport()

        expect(result.imported).toBe(1)
        expect(await db.manga.get("anilist:manga:30")).toBeUndefined()
        expect(await db.manga.get("anilist:manga:31")).toBeDefined()
    })

    it("imports a COMPLETED entry as completed only when the SERIES is finished + has a total", async () => {
        const { runAniListImport } = await import("./anilist")
        getViewerMangaListMock.mockResolvedValue([
            entry({
                anilistId: 40,
                title: "Finished Series",
                status: "completed", // publication finished - required to stamp completed (S7)
                rawListStatus: "COMPLETED",
                totalChapters: 100,
                progress: 90
            })
        ])

        await runAniListImport()

        const created = await db.manga.get("anilist:manga:40")
        expect(created?.status).toBe("completed")
        expect(created?.latestChapterNumber).toBe(100)
        expect(created?.lastReadChapterNumber).toBe(100)
        expect(created?.readingStatus).toBeUndefined()
    })

    it("does NOT stamp completed for a still-ongoing series the user list-completed (S7)", async () => {
        const { runAniListImport } = await import("./anilist")
        getViewerMangaListMock.mockResolvedValue([
            entry({
                anilistId: 42,
                title: "Ongoing But List-Completed",
                status: "ongoing", // publication still ongoing - must NOT become completed
                rawListStatus: "COMPLETED",
                totalChapters: 100,
                progress: 90
            })
        ])

        await runAniListImport()

        const created = await db.manga.get("anilist:manga:42")
        expect(created?.status).toBe("ongoing")
        expect(created?.latestChapterNumber).toBeUndefined()
        expect(created?.lastReadChapterNumber).toBe(90)
    })

    it("skips light novel entries on import (S9)", async () => {
        const { runAniListImport } = await import("./anilist")
        getViewerMangaListMock.mockResolvedValue([
            entry({ anilistId: 43, title: "A Light Novel", format: "LIGHT_NOVEL" }),
            entry({ anilistId: 44, title: "A Real Manga", format: "MANGA" })
        ])

        await runAniListImport()

        expect(await db.manga.get("anilist:manga:43")).toBeUndefined()
        expect(await db.manga.get("anilist:manga:44")).toBeDefined()
    })

    it("sets nsfw and authors from the AniList entry on import (S9/S10)", async () => {
        const { runAniListImport } = await import("./anilist")
        getViewerMangaListMock.mockResolvedValue([
            entry({ anilistId: 45, title: "Adult With Authors", nsfw: true, authors: ["Story Writer", "Art Drawer"] })
        ])

        await runAniListImport()

        const created = await db.manga.get("anilist:manga:45")
        expect(created?.nsfw).toBe(true)
        expect(created?.authors).toEqual(["Story Writer", "Art Drawer"])
    })

    it("leaves a COMPLETED entry with no known total as a normal (reading) import", async () => {
        const { runAniListImport } = await import("./anilist")
        getViewerMangaListMock.mockResolvedValue([
            entry({
                anilistId: 41,
                title: "Finished But Untotalled",
                status: "completed",
                rawListStatus: "COMPLETED",
                progress: 12
                // no totalChapters
            })
        ])

        await runAniListImport()

        const created = await db.manga.get("anilist:manga:41")
        expect(created?.latestChapterNumber).toBeUndefined()
        expect(created?.lastReadChapterNumber).toBe(12)
    })
})

describe("runAniListSync bidirectional status sync", () => {
    it("pushes a local dropped status to AniList when statusPush is on", async () => {
        const { runAniListSync } = await import("./anilist")
        getAniListConfigMock.mockResolvedValue({
            token: "t",
            autoSync: false,
            syncMembership: false,
            statusPush: true,
            statusPull: false
        })
        await db.manga.add(
            makeManga({
                id: "m1",
                anilistId: 55,
                lastReadChapterNumber: 3,
                readingStatus: "dropped",
                readingStatusUpdatedAt: 1000
            })
        )
        getViewerProgressMock.mockResolvedValue(3) // equal progress -> no progress push
        getViewerListEntryMock.mockResolvedValue({ progress: 3, status: "CURRENT", updatedAt: 1 })

        const res = await runAniListSync()

        expect(saveMediaStatusMock).toHaveBeenCalledWith("t", 55, "DROPPED")
        expect(res.statusPushed).toBe(1)
    })

    it("pulls an AniList paused status onto the library when statusPull is on", async () => {
        const { runAniListSync } = await import("./anilist")
        getAniListConfigMock.mockResolvedValue({
            token: "t",
            autoSync: false,
            syncMembership: false,
            statusPush: false,
            statusPull: true
        })
        await db.manga.add(makeManga({ id: "m2", anilistId: 66, lastReadChapterNumber: 5, readingStatusUpdatedAt: 1 }))
        getViewerProgressMock.mockResolvedValue(5)
        getViewerListEntryMock.mockResolvedValue({ progress: 5, status: "PAUSED", updatedAt: 9999 })

        const res = await runAniListSync()

        expect((await db.manga.get("m2"))?.readingStatus).toBe("paused")
        expect(res.statusPulled).toBe(1)
    })

    it("completes a title when AniList reports COMPLETED with a known total (pull)", async () => {
        const { runAniListSync } = await import("./anilist")
        getAniListConfigMock.mockResolvedValue({
            token: "t",
            autoSync: false,
            syncMembership: false,
            statusPush: false,
            statusPull: true
        })
        await db.manga.add(makeManga({ id: "m3", anilistId: 77, status: "ongoing", lastReadChapterNumber: 40 }))
        getViewerProgressMock.mockResolvedValue(40)
        getViewerListEntryMock.mockResolvedValue({
            progress: 40,
            status: "COMPLETED",
            updatedAt: 5,
            totalChapters: 50,
            seriesFinished: true
        })

        await runAniListSync()

        const updated = await db.manga.get("m3")
        expect(updated?.status).toBe("completed")
        expect(updated?.latestChapterNumber).toBe(50)
        expect(updated?.lastReadChapterNumber).toBe(50)
    })

    it("does not push CURRENT over a deliberate remote PAUSED for a merely-read title (push-only)", async () => {
        const { runAniListSync } = await import("./anilist")
        getAniListConfigMock.mockResolvedValue({
            token: "t",
            autoSync: false,
            syncMembership: false,
            statusPush: true,
            statusPull: false
        })
        // Read locally with NO explicit status -> derives "reading". User PAUSED it on AniList.
        await db.manga.add(makeManga({ id: "mp", anilistId: 91, lastReadChapterNumber: 10, lastReadAt: 9_999_999 }))
        getViewerProgressMock.mockResolvedValue(10)
        getViewerListEntryMock.mockResolvedValue({ progress: 10, status: "PAUSED", updatedAt: 1 })

        const res = await runAniListSync()

        expect(saveMediaStatusMock).not.toHaveBeenCalled()
        expect(res.statusPushed).toBe(0)
    })

    it("adopts a remote PAUSED locally for a merely-read title instead of clobbering it (both on)", async () => {
        const { runAniListSync } = await import("./anilist")
        getAniListConfigMock.mockResolvedValue({
            token: "t",
            autoSync: false,
            syncMembership: false,
            statusPush: true,
            statusPull: true
        })
        await db.manga.add(makeManga({ id: "mp2", anilistId: 92, lastReadChapterNumber: 10, lastReadAt: 9_999_999 }))
        getViewerProgressMock.mockResolvedValue(10)
        getViewerListEntryMock.mockResolvedValue({ progress: 10, status: "PAUSED", updatedAt: 1 })

        await runAniListSync()

        expect(saveMediaStatusMock).not.toHaveBeenCalled()
        expect((await db.manga.get("mp2"))?.readingStatus).toBe("paused")
    })

    it("pull-COMPLETED never lowers a higher local latest or fabricates reads (clamp)", async () => {
        const { runAniListSync } = await import("./anilist")
        getAniListConfigMock.mockResolvedValue({
            token: "t",
            autoSync: false,
            syncMembership: false,
            statusPush: false,
            statusPull: true
        })
        await db.manga.add(
            makeManga({
                id: "m5",
                anilistId: 90,
                status: "completed",
                latestChapterNumber: 150,
                lastReadChapterNumber: 140
            })
        )
        getViewerProgressMock.mockResolvedValue(140)
        getViewerListEntryMock.mockResolvedValue({
            progress: 140,
            status: "COMPLETED",
            updatedAt: 5,
            totalChapters: 145,
            seriesFinished: true
        })

        await runAniListSync()

        const u = await db.manga.get("m5")
        expect(u?.latestChapterNumber).toBe(150) // never lowered to AniList's 145 (would hide 5 chapters)
        expect(u?.lastReadChapterNumber).toBe(145) // raised to the total, capped at the real local latest
    })

    it("does not run the status pass when both directions are off (default)", async () => {
        const { runAniListSync } = await import("./anilist")
        await db.manga.add(makeManga({ id: "m4", anilistId: 88, lastReadChapterNumber: 2, readingStatus: "dropped" }))
        getViewerProgressMock.mockResolvedValue(2)
        getViewerListEntryMock.mockResolvedValue({ progress: 2, status: "CURRENT", updatedAt: 1 })

        const res = await runAniListSync()

        expect(getViewerListEntryMock).not.toHaveBeenCalled()
        expect(res.statusPushed).toBe(0)
        expect(res.statusPulled).toBe(0)
    })
})

describe("runAniListSync reconcile (removed on AniList)", () => {
    it("drops a read title that was in prior known membership and is now absent, membership sync on", async () => {
        const { runAniListSync } = await import("./anilist")
        getAniListConfigMock.mockResolvedValue({ token: "t", autoSync: false, syncMembership: true })
        // read + has anilistId, the user HAD it on AniList (known membership), now gone.
        await db.manga.put(makeManga({ id: "gone", anilistId: 500, lastReadChapterNumber: 12 }))
        getKnownMembershipMock.mockResolvedValue([500])
        getViewerProgressMock.mockResolvedValue(12)
        getViewerMangaListMock.mockResolvedValue([{ anilistId: 999 }])

        await runAniListSync()

        expect((await db.manga.get("gone"))?.readingStatus).toBe("dropped")
    })

    it("first sync (empty known membership) drops nothing even when a read title is absent remotely", async () => {
        const { runAniListSync } = await import("./anilist")
        getAniListConfigMock.mockResolvedValue({ token: "t", autoSync: false, syncMembership: true })
        await db.manga.put(makeManga({ id: "gone", anilistId: 500, lastReadChapterNumber: 12 }))
        getKnownMembershipMock.mockResolvedValue([]) // nothing known yet
        getViewerProgressMock.mockResolvedValue(0)
        saveViewerProgressMock.mockResolvedValue(12)
        getViewerMangaListMock.mockResolvedValue([{ anilistId: 999 }])

        await runAniListSync()

        expect((await db.manga.get("gone"))?.readingStatus).toBeUndefined()
    })

    it("does not drop an enrichment-only id that was never in known membership", async () => {
        const { runAniListSync } = await import("./anilist")
        getAniListConfigMock.mockResolvedValue({ token: "t", autoSync: false, syncMembership: true })
        // 500 has an anilistId (stamped by metadata enrichment) but the user never tracked
        // it on AniList: it is absent from the remote list AND from prior known membership.
        await db.manga.put(makeManga({ id: "enriched", anilistId: 500, lastReadChapterNumber: 12 }))
        getKnownMembershipMock.mockResolvedValue([888]) // known, but a different title
        getViewerProgressMock.mockResolvedValue(12)
        getViewerMangaListMock.mockResolvedValue([{ anilistId: 999 }])

        await runAniListSync()

        expect((await db.manga.get("enriched"))?.readingStatus).toBeUndefined()
    })

    it("does not re-push a genuine removal (skips the push so it is not re-created)", async () => {
        const { runAniListSync } = await import("./anilist")
        getAniListConfigMock.mockResolvedValue({ token: "t", autoSync: false, syncMembership: true })
        await db.manga.put(makeManga({ id: "gone", anilistId: 500, lastReadChapterNumber: 12 }))
        getKnownMembershipMock.mockResolvedValue([500])
        getViewerProgressMock.mockResolvedValue(0)
        getViewerMangaListMock.mockResolvedValue([{ anilistId: 999 }])

        await runAniListSync()

        expect((await db.manga.get("gone"))?.readingStatus).toBe("dropped")
        expect(saveViewerProgressMock).not.toHaveBeenCalled()
        expect(getViewerProgressMock).not.toHaveBeenCalled()
    })

    it("leaves an unread orphan untouched even when in known membership", async () => {
        const { runAniListSync } = await import("./anilist")
        getAniListConfigMock.mockResolvedValue({ token: "t", autoSync: false, syncMembership: true })
        await db.manga.put(makeManga({ id: "unread-orphan", anilistId: 501 }))
        getKnownMembershipMock.mockResolvedValue([501])
        getMediaListEntryIdMock.mockResolvedValue(1) // already on list, so no add
        getViewerMangaListMock.mockResolvedValue([{ anilistId: 999 }])

        await runAniListSync()

        expect((await db.manga.get("unread-orphan"))?.readingStatus).toBeUndefined()
    })

    it("does not reconcile when membership sync is off", async () => {
        const { runAniListSync } = await import("./anilist")
        getAniListConfigMock.mockResolvedValue({ token: "t", autoSync: false, syncMembership: false })
        await db.manga.put(makeManga({ id: "gone", anilistId: 500, lastReadChapterNumber: 12 }))
        getViewerProgressMock.mockResolvedValue(12)

        await runAniListSync()

        expect(getViewerMangaListMock).not.toHaveBeenCalled()
        expect((await db.manga.get("gone"))?.readingStatus).toBeUndefined()
    })

    it("drops nothing when the remote list comes back EMPTY (soft-failure guard)", async () => {
        const { runAniListSync } = await import("./anilist")
        getAniListConfigMock.mockResolvedValue({ token: "t", autoSync: false, syncMembership: true })
        await db.manga.bulkPut([
            makeManga({ id: "a", anilistId: 500, lastReadChapterNumber: 12 }),
            makeManga({ id: "b", anilistId: 501, lastReadChapterNumber: 3 })
        ])
        getKnownMembershipMock.mockResolvedValue([500, 501])
        getViewerProgressMock.mockResolvedValue(0)
        getViewerMangaListMock.mockResolvedValue([]) // empty == indistinguishable from failure

        await runAniListSync()

        expect((await db.manga.get("a"))?.readingStatus).toBeUndefined()
        expect((await db.manga.get("b"))?.readingStatus).toBeUndefined()
        // A soft-failed (empty) remote must not overwrite the known membership.
        expect(setKnownMembershipMock).not.toHaveBeenCalled()
    })

    it("drops nothing when the remote fetch THROWS", async () => {
        const { runAniListSync } = await import("./anilist")
        getAniListConfigMock.mockResolvedValue({ token: "t", autoSync: false, syncMembership: true })
        await db.manga.put(makeManga({ id: "gone", anilistId: 500, lastReadChapterNumber: 12 }))
        getKnownMembershipMock.mockResolvedValue([500])
        getViewerProgressMock.mockResolvedValue(12)
        getViewerMangaListMock.mockRejectedValue(new Error("AniList API 429"))

        await runAniListSync()

        expect((await db.manga.get("gone"))?.readingStatus).toBeUndefined()
        // A failed remote must not overwrite the known membership.
        expect(setKnownMembershipMock).not.toHaveBeenCalled()
    })

    it("does not drop a read title still on the remote list even if its push errored", async () => {
        const { runAniListSync } = await import("./anilist")
        getAniListConfigMock.mockResolvedValue({ token: "t", autoSync: false, syncMembership: true })
        await db.manga.put(makeManga({ id: "kept", anilistId: 500, lastReadChapterNumber: 12 }))
        getKnownMembershipMock.mockResolvedValue([500])
        // The push for this title fails (rate limit) this run...
        getViewerProgressMock.mockRejectedValue(new Error("AniList API 429"))
        // ...but it is present in the up-front remote snapshot, so it must not be dropped.
        getViewerMangaListMock.mockResolvedValue([{ anilistId: 500 }])

        await runAniListSync()

        expect((await db.manga.get("kept"))?.readingStatus).toBeUndefined()
    })

    it("persists the next known membership as the remote list unioned with what was pushed", async () => {
        const { runAniListSync } = await import("./anilist")
        getAniListConfigMock.mockResolvedValue({ token: "t", autoSync: false, syncMembership: true })
        // A read title (id 500) newly pushed, plus an unread cached title (id 55) added.
        await db.manga.bulkPut([
            makeManga({ id: "read", anilistId: 500, lastReadChapterNumber: 12 }),
            makeManga({ id: "unread", anilistId: 55 })
        ])
        getKnownMembershipMock.mockResolvedValue([])
        getViewerProgressMock.mockResolvedValue(undefined)
        saveViewerProgressMock.mockResolvedValue(12)
        getMediaListEntryIdMock.mockResolvedValue(undefined)
        getViewerMangaListMock.mockResolvedValue([{ anilistId: 999 }]) // remote had an unrelated title

        await runAniListSync()

        expect(setKnownMembershipMock).toHaveBeenCalledTimes(1)
        const persisted = new Set(setKnownMembershipMock.mock.calls[0]![0] as number[])
        expect(persisted).toEqual(new Set([999, 500, 55]))
    })
})

describe("bughunt regressions", () => {
    it("does NOT stamp lastSyncAt when the run was aborted partway", async () => {
        const { runAniListSync, abortAniListSync } = await import("./anilist")
        await db.manga.bulkPut([
            makeManga({ id: "a", anilistId: 1, lastReadChapterNumber: 5 }),
            makeManga({ id: "b", anilistId: 2, lastReadChapterNumber: 5 })
        ])
        // Abort while processing the first title.
        getViewerProgressMock.mockImplementation(async () => {
            abortAniListSync()
            return 1
        })
        saveViewerProgressMock.mockResolvedValue(5)

        await runAniListSync()

        const stampedLastSyncAt = setAniListConfigMock.mock.calls.some(
            ([arg]) => arg && Object.prototype.hasOwnProperty.call(arg, "lastSyncAt")
        )
        expect(stampedLastSyncAt).toBe(false)
    })

    it("caches only anilistId (not metadataUpdatedAt) when resolving an id during sync", async () => {
        const { runAniListSync } = await import("./anilist")
        await db.manga.put(makeManga({ id: "m1", title: "Solo Leveling", lastReadChapterNumber: 4 }))
        resolveMetadataMock.mockResolvedValue({ anilistId: 777 })
        getViewerProgressMock.mockResolvedValue(undefined)
        saveViewerProgressMock.mockResolvedValue(4)

        await runAniListSync()

        const stored = await db.manga.get("m1")
        expect(stored?.anilistId).toBe(777)
        // Must stay undefined so the metadata-enrichment pass still runs for this title.
        expect(stored?.metadataUpdatedAt).toBeUndefined()
    })

    it("anilist:config saves the token on a transient (5xx) validation error", async () => {
        const { anilistHandlers } = await import("./anilist")
        getViewerNameMock.mockRejectedValue(new Error("AniList API 503"))
        setAniListConfigMock.mockResolvedValue({ token: "tok", autoSync: false, syncMembership: false })

        const res = await anilistHandlers["anilist:config"]!(
            { type: "anilist:config", config: { token: "tok" } } as never,
            {} as never
        )

        expect(setAniListConfigMock).toHaveBeenCalledWith(expect.objectContaining({ token: "tok" }))
        expect((res as { hasToken: boolean }).hasToken).toBe(true)
    })

    it("anilist:config rejects a token on a genuine auth (4xx) error without saving", async () => {
        const { anilistHandlers } = await import("./anilist")
        getViewerNameMock.mockRejectedValue(new Error("AniList API 401"))

        await expect(
            anilistHandlers["anilist:config"]!(
                { type: "anilist:config", config: { token: "bad" } } as never,
                {} as never
            )
        ).rejects.toThrow(/rejected/i)
        expect(setAniListConfigMock).not.toHaveBeenCalled()
    })
})
