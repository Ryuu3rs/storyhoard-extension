import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./live", () => ({ publishLive: vi.fn() }))
vi.mock("./notifications", () => ({ notifyNewChapters: vi.fn() }))

const { db } = await import("./database")
const { recordObservedChapters } = await import("./observed-chapter-list")

const ID = "detected:reader.example:manga:long-series"
const chapter = (n: number) => ({
    id: `detected:reader.example:chapter:long-series:${n}`,
    mangaId: ID,
    sourceId: "detected:reader.example",
    title: `Chapter ${n}`,
    url: `https://reader.example/manga/long-series/chapter-${n}`,
    sortKey: n
})

beforeEach(async () => {
    await Promise.all([db.manga.clear(), db.chapters.clear()])
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

describe("far-ahead guard on a title with no latest chapter yet", () => {
    it("takes the latest chapter from a series page that links only its first and newest chapters", async () => {
        // The common "Read first / Read last" pair (the full list loads later by script, or not at all).
        const result = await recordObservedChapters({ mangaId: ID, chapters: [chapter(1), chapter(150)] })
        expect(result.advanced).toBe(true)
        expect((await db.manga.get(ID))!.latestChapterNumber).toBe(150)
    })

    it("still drops a lone far link when the list itself holds a real stretch of chapters", async () => {
        const list = [...Array.from({ length: 20 }, (_, i) => chapter(i + 1)), chapter(9000)]
        await recordObservedChapters({ mangaId: ID, chapters: list })
        expect((await db.manga.get(ID))!.latestChapterNumber).toBe(20)
        expect(await db.chapters.where("sortKey").equals(9000).count()).toBe(0)
    })

    it("measures the gap from a chapter the title already knows", async () => {
        await db.chapters.put(chapter(1))
        await recordObservedChapters({ mangaId: ID, chapters: [chapter(1), chapter(150)] })
        expect((await db.manga.get(ID))!.latestChapterNumber).toBe(1)
        expect(await db.chapters.where("sortKey").equals(150).count()).toBe(0)
    })
})

describe("rows an older label reading filed under the wrong number", () => {
    const labelled = (n: number, url: number, title: string) => ({
        ...chapter(n),
        url: `https://reader.example/manga/long-series/chapter-${url}`,
        title
    })
    const VOL = "#26.2 - Vol.4 - Chapter 26.2"

    it("moves a volume-numbered row to its chapter number and keeps the read chapter on it", async () => {
        await db.chapters.bulkPut([chapter(3), labelled(4, 26.2, VOL)])
        await db.manga.update(ID, {
            latestChapterNumber: 4,
            lastReadChapterNumber: 4,
            lastReadChapterId: chapter(4).id
        } as never)

        await recordObservedChapters({
            mangaId: ID,
            chapters: [chapter(3), labelled(4, 4, "#4"), labelled(26.2, 26.2, VOL)]
        })

        const rows = await db.chapters.where("mangaId").equals(ID).sortBy("sortKey")
        expect(rows.map(r => [r.sortKey, r.url.split("chapter-")[1]])).toEqual([
            [3, "3"],
            [4, "4"],
            [26.2, "26.2"]
        ])
        expect((await db.manga.get(ID))!.lastReadChapterId).toBe(chapter(26.2).id)
    })

    it("keeps the first row when the page relabels a link", async () => {
        await db.chapters.put(labelled(5, 5, "Chapter 5"))
        await recordObservedChapters({ mangaId: ID, chapters: [labelled(50, 5, "Chapter 50")] })
        const rows = await db.chapters.where("mangaId").equals(ID).toArray()
        expect(rows.map(r => r.sortKey)).toEqual([5])
    })
})
