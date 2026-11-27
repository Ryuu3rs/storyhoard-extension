import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./live", () => ({ publishLive: vi.fn() }))
vi.mock("./notifications", () => ({ notifyNewChapters: vi.fn() }))

const { db, trackExternalChapter } = await import("./database")
const { chaptersFromObservedList, recordObservedChapters } = await import("./observed-chapter-list")
const { chapterNumberInPath } = await import("./chapter-number-in-address")

const ORIGIN = "https://reader.example"
const MANGA_ID = "s:manga:demo"
const url = (tail: string) => `${ORIGIN}/manga/demo/${tail}`

const listNumbers = (tails: string[]) =>
    chaptersFromObservedList({
        sourceId: "s",
        match: () => "chapter",
        allowedOrigins: [ORIGIN],
        sourceMangaId: "demo",
        mangaId: MANGA_ID,
        numberFromUrl: true,
        items: tails.map(tail => ({ url: url(tail), text: tail }))
    }).map(c => c.sortKey)

beforeEach(async () => {
    await Promise.all([db.manga.clear(), db.chapters.clear(), db.progress.clear(), db.historyEvents.clear()])
})

describe("a visit and a chapter list number one address the same way", () => {
    it("opening chapter 12.5 marks 12.5 read, not 12", async () => {
        const listed = chaptersFromObservedList({
            sourceId: "s",
            match: () => "chapter",
            allowedOrigins: [ORIGIN],
            sourceMangaId: "demo",
            mangaId: MANGA_ID,
            numberFromUrl: true,
            items: [
                { url: url("chapter-13"), text: "Chapter 13" },
                { url: url("chapter-12-5"), text: "Chapter 12.5" },
                { url: url("chapter-12"), text: "Chapter 12" },
                { url: url("chapter-11"), text: "Chapter 11" }
            ]
        })
        expect(listed.map(c => c.sortKey)).toEqual([13, 12.5, 12, 11])
        const first = await trackExternalChapter({
            url: url("chapter-11"),
            sourceId: "s",
            mangaInfo: { sourceMangaId: "demo", mangaUrl: url("") }
        })
        await recordObservedChapters({ mangaId: first.mangaId, chapters: listed })

        const visit = await trackExternalChapter({
            url: url("chapter-12-5"),
            sourceId: "s",
            mangaInfo: { sourceMangaId: "demo", mangaUrl: url("") }
        })

        expect(visit.chapterNumber).toBe(12.5)
        expect((await db.progress.get("s:chapter:demo:12"))?.completed ?? false).toBe(false)
    })

    it.each([
        ["/manga/demo/chapter-12-5", 12.5],
        ["/manga/demo/chapter_10_5", 10.5],
        ["/manga/demo/chapter-12-5.html", 12.5],
        ["/manga/demo/chapter-12-2024-01-15", 12],
        ["/manga/demo/chapter-1-2-prince", 1],
        ["/manga/demo/chapter-30-finale", 30],
        ["/manga/demo/chapter-12.html", 12]
    ])("reads %s as %d on both sides", (path, number) => {
        expect(chapterNumberInPath(path)).toBe(number)
        expect(listNumbers([path.replace("/manga/demo/", "")])).toEqual([number])
    })
})
