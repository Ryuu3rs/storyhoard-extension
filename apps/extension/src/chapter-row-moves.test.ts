import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"

vi.mock("./live", () => ({ publishLive: vi.fn() }))
vi.mock("./notifications", () => ({ notifyNewChapters: vi.fn() }))

const { db, clampIdSizedChapterNumbers, guardMangaOnCreate, guardMangaOnUpdate } = await import("./database")
const { recordObservedChapters } = await import("./observed-chapter-list")

const ID = "detected:reader.example:manga:long-series"
const row = (n: number, urlNo: number, title: string) => ({
    id: `detected:reader.example:chapter:long-series:${n}`,
    mangaId: ID,
    sourceId: "detected:reader.example",
    title,
    url: `https://reader.example/manga/long-series/chapter-${urlNo}`,
    sortKey: n
})

beforeEach(async () => {
    await Promise.all([db.manga.clear(), db.chapters.clear(), db.progress.clear(), db.historyEvents.clear()])
    await db.manga.put({
        id: ID,
        title: "Long Series",
        normalizedTitle: "long series",
        sourceId: "detected:reader.example",
        sourceUrl: "https://reader.example/manga/long-series",
        mangaUrl: "https://reader.example/manga/long-series",
        authors: [],
        status: "unknown",
        addedAt: 1,
        updatedAt: 1
    } as never)
})

describe("renumbered rows that form a chain", () => {
    it("keeps the read state on the chapter the user actually read", async () => {
        const A = "Vol.3 - Chapter 4"
        const B = "Vol.4 - Chapter 9"
        await db.chapters.bulkPut([row(3, 1003, A), row(4, 1004, B)])
        await db.progress.put({
            chapterId: row(3, 1003, A).id,
            mangaId: ID,
            pageIndex: 10,
            pageCount: 10,
            completed: true,
            updatedAt: 5
        } as never)
        await db.historyEvents.add({
            mangaId: ID,
            chapterId: row(3, 1003, A).id,
            type: "completed",
            occurredAt: 5
        } as never)
        await db.manga.update(ID, {
            latestChapterNumber: 4,
            lastReadChapterNumber: 3,
            lastReadChapterId: row(3, 1003, A).id
        } as never)

        await recordObservedChapters({ mangaId: ID, chapters: [row(4, 1003, A), row(9, 1004, B)] })

        expect((await db.progress.get(row(4, 1003, A).id))?.completed).toBe(true)
        expect((await db.progress.get(row(9, 1004, B).id))?.completed ?? false).toBe(false)
        expect((await db.historyEvents.toArray()).map(e => e.chapterId)).toEqual([row(4, 1003, A).id])
        expect((await db.chapters.get(row(4, 1003, A).id))?.url).toBe(row(4, 1003, A).url)
        expect((await db.chapters.get(row(9, 1004, B).id))?.url).toBe(row(9, 1004, B).url)
        expect((await db.manga.get(ID))?.lastReadChapterId).toBe(row(4, 1003, A).id)
    })
})

describe("clamping id-sized chapter numbers", () => {
    const mangaId = "hubsite:manga:y"
    const idUrl = "https://hub.example/manga/y/chapter-664275"
    const visitId = "hubsite:ext:y:664275"

    async function seed(readChapterAtIdUrl: number | undefined, completedListed: number[] = []) {
        db.manga.hook("creating").unsubscribe(guardMangaOnCreate)
        db.manga.hook("updating").unsubscribe(guardMangaOnUpdate)
        onTestFinished(() => {
            db.manga.hook("creating", guardMangaOnCreate)
            db.manga.hook("updating", guardMangaOnUpdate)
        })
        await db.manga.put({
            id: mangaId,
            title: "Y",
            normalizedTitle: "y",
            sourceId: "hubsite",
            sourceUrl: "https://hub.example/manga/y",
            authors: [],
            status: "unknown",
            addedAt: 1,
            updatedAt: 1,
            latestChapterNumber: 664275,
            lastReadChapterNumber: 664275,
            lastReadChapterId: visitId
        })
        await db.chapters.bulkPut([
            ...Array.from({ length: 50 }, (_, i) => ({
                id: `hubsite:chapter:y:${i + 1}`,
                mangaId,
                sourceId: "hubsite",
                title: `Chapter ${i + 1}`,
                url: i + 1 === readChapterAtIdUrl ? idUrl : `https://hub.example/manga/y/chapter-x${i + 1}`,
                sortKey: i + 1
            })),
            { id: visitId, mangaId, sourceId: "hubsite", title: "Chapter", url: idUrl, sortKey: 664275 }
        ])
        await db.progress.put({
            chapterId: visitId,
            mangaId,
            pageIndex: 20,
            pageCount: 20,
            completed: true,
            updatedAt: 2
        } as never)
        await db.historyEvents.add({ mangaId, chapterId: visitId, type: "completed", occurredAt: 2 } as never)
        for (const n of completedListed) {
            await db.progress.put({
                chapterId: `hubsite:chapter:y:${n}`,
                mangaId,
                pageIndex: 1,
                pageCount: 1,
                completed: true,
                updatedAt: 1
            } as never)
        }
    }

    it("moves an id-numbered visit's history onto the listed row with the same address", async () => {
        await seed(3)

        expect(await clampIdSizedChapterNumbers(mangaId)).toBe(true)

        const events = await db.historyEvents.where("mangaId").equals(mangaId).toArray()
        expect(events.map(e => e.chapterId)).toEqual(["hubsite:chapter:y:3"])
        expect((await db.progress.get("hubsite:chapter:y:3"))?.completed).toBe(true)
        expect(await db.chapters.get(visitId)).toBeUndefined()
        const title = await db.manga.get(mangaId)
        expect(title?.lastReadChapterNumber).toBe(3)
        expect(title?.lastReadChapterId).toBe("hubsite:chapter:y:3")
        expect(title?.latestChapterNumber).toBe(50)
    })

    it("falls back to the furthest chapter the user completed, never the newest one", async () => {
        await seed(undefined, [7, 12])

        await clampIdSizedChapterNumbers(mangaId)

        const title = await db.manga.get(mangaId)
        expect(title?.lastReadChapterNumber).toBe(12)
        expect(title?.lastReadChapterId).toBe("hubsite:chapter:y:12")
    })

    it("clears the read position when nothing says how far the user got", async () => {
        await seed(undefined)

        await clampIdSizedChapterNumbers(mangaId)

        const title = await db.manga.get(mangaId)
        expect(title?.lastReadChapterNumber).toBeUndefined()
        expect(title?.lastReadChapterId).toBeUndefined()
    })
})
