import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it } from "vitest"
import { addImportedManga, createBackup, db, exportDatabase, importDatabase, restoreBackup } from "./database"
import type { LibraryManga } from "./database"

function row(over: Partial<LibraryManga> & { id: string; title: string }): LibraryManga {
    return {
        normalizedTitle: over.title.toLowerCase(),
        authors: [],
        status: "unknown",
        sourceId: "import",
        sourceUrl: `amr:import:${encodeURIComponent(over.title.toLowerCase())}`,
        manualTracking: true,
        addedAt: 1,
        updatedAt: 1,
        ...over
    }
}

beforeEach(async () => {
    await Promise.all([db.manga.clear(), db.chapters.clear(), db.progress.clear(), db.backups.clear()])
})

describe("reader-app import rows survive backup and restore", () => {
    it("keeps titles whose optional fields would fail the restore schema", async () => {
        await addImportedManga([
            row({ id: "import:manga:a", title: "A", coverUrl: "file:///sdcard/c.jpg", lastReadChapterNumber: 4 }),
            row({ id: "import:manga:b", title: "B", categories: ["   ", "Fav"] }),
            row({ id: "anilist:manga:1.5", title: "C", anilistId: 1.5 }),
            row({ id: "import:manga:d", title: "D", coverUrl: "https://x.test/d.jpg" })
        ])
        const backupId = await createBackup("pre-import")
        const result = await restoreBackup(backupId)
        expect(result.skipped).toEqual([])
        const rows = await db.manga.toArray()
        expect(rows).toHaveLength(4)
        const a = rows.find(r => r.id === "import:manga:a")!
        expect(a.coverUrl).toBeUndefined()
        expect(a.lastReadChapterNumber).toBe(4)
        expect(rows.find(r => r.id === "import:manga:b")!.categories).toEqual(["Fav"])
        expect(rows.find(r => r.title === "C")!.anilistId).toBeUndefined()
        expect(rows.find(r => r.id === "import:manga:d")!.coverUrl).toBe("https://x.test/d.jpg")
    })

    it("restore strips a bad optional field instead of dropping the whole row", async () => {
        const envelope = await exportDatabase()
        envelope.data.manga = [
            row({ id: "m1", title: "M1", coverUrl: "file:///x.jpg", categories: [""], lastReadChapterNumber: 9 }),
            { ...row({ id: "m2", title: "M2" }), anilistId: -3 } as LibraryManga
        ]
        const result = await importDatabase(envelope)
        expect(result.skipped).toEqual([])
        expect(result.manga).toBe(2)
        const m1 = await db.manga.get("m1")
        expect(m1?.lastReadChapterNumber).toBe(9)
        expect(m1?.coverUrl).toBeUndefined()
        expect(m1?.categories).toBeUndefined()
        expect((await db.manga.get("m2"))?.anilistId).toBeUndefined()
    })
})

describe("imported urls are limited to safe schemes", () => {
    it("importDatabase replaces a script sourceUrl and drops a non-http mangaUrl", async () => {
        const envelope = await exportDatabase()
        envelope.data.manga = [
            row({ id: "x1", title: "X1", sourceUrl: "javascript:alert(1)", mangaUrl: "data:text/html,hi" }),
            row({ id: "x2", title: "X2", sourceUrl: "https://ok.test/x2", mangaUrl: "https://ok.test/x2" })
        ]
        await importDatabase(envelope)
        const x1 = await db.manga.get("x1")
        expect(x1?.sourceUrl).toBe("amr:import:x1")
        expect(x1?.mangaUrl).toBeUndefined()
        const x2 = await db.manga.get("x2")
        expect(x2?.sourceUrl).toBe("https://ok.test/x2")
        expect(x2?.mangaUrl).toBe("https://ok.test/x2")
    })

    it("addImportedManga drops a non-http mangaUrl and a script sourceUrl", async () => {
        await addImportedManga([
            row({ id: "y1", title: "Y1", sourceUrl: "javascript:alert(1)", mangaUrl: "javascript:alert(2)" })
        ])
        const y1 = await db.manga.get("y1")
        expect(y1?.sourceUrl).toBe("amr:import:y1")
        expect(y1?.mangaUrl).toBeUndefined()
    })
})

describe("import counts", () => {
    it("counts a duplicated manga id once", async () => {
        const envelope = await exportDatabase()
        envelope.data.manga = [row({ id: "dup", title: "Dup" }), row({ id: "dup", title: "Dup", updatedAt: 2 })]
        const result = await importDatabase(envelope)
        expect(await db.manga.count()).toBe(1)
        expect(result.manga).toBe(1)
    })
})
