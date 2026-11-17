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
