import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LibraryManga } from "./database"

vi.stubGlobal("browser", fakeBrowser)

const { db, createBackup, restoreTitleFromBackup } = await import("./database")
const { applyRemoteItem } = await import("./handlers/account")

const T0 = 1_700_000_000_000
const T_SWITCH = T0 + 60_000
const T_READ = T0 + 120_000

function manga(overrides: Partial<LibraryManga>): LibraryManga {
    return {
        id: "mangadex:manga:abc",
        title: "Original Title",
        normalizedTitle: "original title",
        sourceId: "mangadex",
        sourceUrl: "https://mangadex.org/title/abc",
        mangaUrl: "https://mangadex.org/title/abc",
        authors: [],
        status: "ongoing",
        latestChapterNumber: 40,
        lastReadChapterNumber: 30,
        addedAt: T0,
        updatedAt: T0,
        ...overrides
    }
}

const chapter = (id: string, sortKey: number, sourceId = "mangadex") => ({
    id,
    mangaId: "mangadex:manga:abc",
    sourceId,
    title: `Chapter ${sortKey}`,
    url: `https://${sourceId}.example/${id}`,
    sortKey
})

async function backupThenSwitch(): Promise<number> {
    vi.spyOn(Date, "now").mockReturnValue(T0)
    await db.manga.put(manga({}))
    await db.chapters.bulkPut([chapter("md-30", 30), chapter("md-35", 35), chapter("md-40", 40)])
    const backupId = await createBackup("pre-source-change")

    // The source change (library:switch) moves the title to another site and bumps updatedAt.
    vi.spyOn(Date, "now").mockReturnValue(T_SWITCH)
    await db.chapters.where("mangaId").equals("mangadex:manga:abc").delete()
    await db.chapters.bulkPut([chapter("os-35", 35, "other-site"), chapter("os-120", 120, "other-site")])
    await db.manga.update("mangadex:manga:abc", {
        sourceId: "other-site",
        sourceUrl: "https://other.example/s/abc",
        mangaUrl: "https://other.example/s/abc",
        latestChapterNumber: 120,
        latestChapterId: "os-120",
        updatedAt: T_SWITCH
    })
    return backupId
}

beforeEach(async () => {
    fakeBrowser.reset()
    await Promise.all([db.manga.clear(), db.sourceLinks.clear(), db.chapters.clear(), db.backups.clear()])
})

describe("restoreTitleFromBackup", () => {
    it("keeps the undo when the account copy of the source change is pulled", async () => {
        const backupId = await backupThenSwitch()
        // That change was pushed to the account (lastPushAt >= T_SWITCH) before the user hit Undo.

        vi.spyOn(Date, "now").mockReturnValue(T_SWITCH + 60_000)
        await restoreTitleFromBackup(backupId, "mangadex:manga:abc")
        const undone = await db.manga.get("mangadex:manga:abc")
        expect(undone?.sourceId).toBe("mangadex")
        expect(undone?.latestChapterNumber).toBe(40)

        // Next account pull: the server's copy is the switched one, stamped T_SWITCH.
        await applyRemoteItem({
            clientId: "mangadex:manga:abc",
            title: "Original Title",
            normalizedTitle: "original title",
            sourceId: "other-site",
            mangaUrl: "https://other.example/s/abc",
            status: "ongoing",
            latestChapterNumber: 120,
            clientUpdatedAt: T_SWITCH
        } as never)

        const after = await db.manga.get("mangadex:manga:abc")
        expect(after?.sourceId).toBe("mangadex")
        expect(after?.latestChapterNumber).toBe(40)
    })

    it("keeps reading progress made after the backup once the account copy is pulled", async () => {
        const backupId = await backupThenSwitch()

        // The user keeps reading on another device: chapter 35. That change reached the account at T_READ.
        vi.spyOn(Date, "now").mockReturnValue(T_READ + 60_000)
        await restoreTitleFromBackup(backupId, "mangadex:manga:abc")

        await applyRemoteItem({
            clientId: "mangadex:manga:abc",
            title: "Original Title",
            normalizedTitle: "original title",
            sourceId: "other-site",
            mangaUrl: "https://other.example/s/abc",
            status: "ongoing",
            lastReadChapterNumber: 35,
            latestChapterNumber: 120,
            readingStatus: "paused",
            clientUpdatedAt: T_READ
        } as never)

        const after = await db.manga.get("mangadex:manga:abc")
        expect(after?.sourceId).toBe("mangadex")
        expect(after?.lastReadChapterNumber).toBe(35)
        expect(after?.readingStatus).toBe("paused")
        expect(after?.latestChapterNumber, "the copy predates the undo, so its chapter count is the other site's").toBe(
            40
        )
    })

    it("restores only the source and keeps progress, status and rating changed here since the backup", async () => {
        const backupId = await backupThenSwitch()

        vi.spyOn(Date, "now").mockReturnValue(T_READ)
        await db.manga.update("mangadex:manga:abc", {
            lastReadChapterNumber: 35,
            lastReadChapterId: "os-35",
            lastReadAt: T_READ,
            readingStatus: "paused",
            rating: 4,
            notes: "great arc",
            updatedAt: T_READ
        })

        vi.spyOn(Date, "now").mockReturnValue(T_READ + 60_000)
        await restoreTitleFromBackup(backupId, "mangadex:manga:abc")

        const after = await db.manga.get("mangadex:manga:abc")
        expect(after?.sourceId).toBe("mangadex")
        expect(after?.mangaUrl).toBe("https://mangadex.org/title/abc")
        expect(after?.latestChapterNumber).toBe(40)
        expect(after?.latestChapterId).toBeUndefined()
        expect(after?.lastReadChapterNumber).toBe(35)
        expect(after?.lastReadChapterId, "the read chapter is mapped onto the restored list by number").toBe("md-35")
        expect(after?.lastReadAt).toBe(T_READ)
        expect(after?.readingStatus).toBe("paused")
        expect(after?.rating).toBe(4)
        expect(after?.notes).toBe("great arc")
        expect(after?.updatedAt).toBe(T_READ)
        expect(after?.sourceRestoredAt).toBe(T_READ + 60_000)
        const chapters = await db.chapters.where("mangaId").equals("mangadex:manga:abc").toArray()
        expect(chapters.map(c => c.id).sort()).toEqual(["md-30", "md-35", "md-40"])
    })
})
