import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LibraryManga } from "./database"

vi.stubGlobal("browser", fakeBrowser)

const { db, createBackup, restoreTitleFromBackup } = await import("./database")
const { applyRemoteItem } = await import("./handlers/account")

const T0 = 1_700_000_000_000
const T_SWITCH = T0 + 60_000

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

beforeEach(async () => {
    fakeBrowser.reset()
    await Promise.all([db.manga.clear(), db.sourceLinks.clear(), db.chapters.clear(), db.backups.clear()])
})

describe("restoreTitleFromBackup", () => {
    it("stamps the undone title as newer than the synced change, so the next pull keeps the undo", async () => {
        vi.spyOn(Date, "now").mockReturnValue(T0)
        await db.manga.put(manga({}))
        const backupId = await createBackup("pre-source-change")

        // The source change (library:switch) moves the title to another site and bumps updatedAt.
        vi.spyOn(Date, "now").mockReturnValue(T_SWITCH)
        await db.manga.update("mangadex:manga:abc", {
            sourceId: "other-site",
            sourceUrl: "https://other.example/s/abc",
            mangaUrl: "https://other.example/s/abc",
            latestChapterNumber: 120,
            updatedAt: T_SWITCH
        })
        // That change was pushed to the account (lastPushAt >= T_SWITCH) before the user hit Undo.

        vi.spyOn(Date, "now").mockReturnValue(T_SWITCH + 60_000)
        await restoreTitleFromBackup(backupId, "mangadex:manga:abc")
        const undone = await db.manga.get("mangadex:manga:abc")
        expect(undone?.sourceId).toBe("mangadex")

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
        expect(
            after?.latestChapterNumber,
            `undo restored updatedAt=${undone?.updatedAt} (< change at ${T_SWITCH}), so the pull re-applied the switched source's number`
        ).toBe(40)
    })
})
