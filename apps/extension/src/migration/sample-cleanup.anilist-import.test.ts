import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LibraryManga } from "../database"

vi.stubGlobal("browser", fakeBrowser)

const { db, seedDatabase, addImportedManga } = await import("../database")
const { sampleEntries } = await import("../lab/sample-library")
const { removeUntouchedSamples } = await import("./sample-cleanup")

beforeEach(async () => {
    fakeBrowser.reset()
    await Promise.all([db.manga.clear(), db.chapters.clear(), db.sourceLinks.clear()])
})

describe("an AniList import that names a work a sample also carries", () => {
    it("leaves the user's AniList-listed work in the library after the untouched samples go", async () => {
        const now = Date.now()
        await seedDatabase(sampleEntries(now))
        const sample = sampleEntries(now).find(entry => entry.manga.anilistId !== undefined)!
        const anilistId = sample.manga.anilistId!

        // The user connects AniList and imports a list that holds this work, read to chapter 30.
        const fromAniList: LibraryManga = {
            id: `anilist:manga:${anilistId}`,
            title: sample.manga.title,
            normalizedTitle: sample.manga.normalizedTitle,
            authors: [],
            status: "ongoing",
            addedAt: now,
            updatedAt: now,
            anilistId,
            sourceId: "anilist.co",
            sourceUrl: `https://anilist.co/manga/${anilistId}`,
            manualTracking: true,
            lastReadChapterNumber: 30
        }
        const imported = await addImportedManga([fromAniList])
        expect(imported.imported).toBe(1)

        // Update to the store build.
        await removeUntouchedSamples({ backedUp: true })

        expect(await db.manga.get(sample.manga.id)).toBeUndefined()
        const rows = (await db.manga.toArray()).filter(m => m.anilistId === anilistId)
        expect(rows.map(m => [m.id, m.lastReadChapterNumber])).toEqual([[fromAniList.id, 30]])
    })
})
