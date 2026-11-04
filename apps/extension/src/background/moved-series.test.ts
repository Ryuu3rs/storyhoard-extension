import "fake-indexeddb/auto"
import { SourceRequestError, type SourceManga } from "@amr/source-sdk"
import type { SourceLinkRecord } from "@amr/contracts"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { db, type LibraryManga } from "../database"

const mocks = vi.hoisted(() => ({
    findMovedSeriesFor: vi.fn(),
    listMangaChapters: vi.fn(),
    recordTombstone: vi.fn(async () => undefined)
}))

vi.mock("../sources", () => ({
    findMovedSeriesFor: mocks.findMovedSeriesFor,
    listMangaChapters: mocks.listMangaChapters
}))
vi.mock("../account", () => ({ recordTombstone: mocks.recordTombstone }))

const { adoptFormerSeriesEntries, followMovedSeries, isSeriesGone } = await import("./moved-series")

const SOURCE = "reader"
const OLD_ID = `${SOURCE}:manga:old-name`
const NEW_ID = `${SOURCE}:manga:new-name`
const SERIES = { sourceMangaId: "new-name", mangaUrl: "https://reader.example/comics/new-name/", title: "New Name" }

const item: LibraryManga = {
    id: OLD_ID,
    title: "Old Name Chapter 5 &#8211; Reader",
    normalizedTitle: "old name",
    authors: [],
    status: "unknown",
    addedAt: 1,
    updatedAt: 1,
    sourceId: SOURCE,
    sourceMangaId: "old-name",
    mangaUrl: "https://reader.example/comics/old-name/",
    lastReadChapterId: `${SOURCE}:chapter:old-name-chapter-5`,
    lastReadChapterNumber: 5,
    rating: 4
} as unknown as LibraryManga

const link: SourceLinkRecord = {
    mangaId: OLD_ID,
    sourceId: SOURCE,
    sourceMangaId: "old-name",
    url: "https://reader.example/comics/old-name/",
    title: "Old Name",
    addedAt: 1,
    updatedAt: 1
}

const chapterRow = (n: number) => ({
    id: `${SOURCE}:chapter:old-name-chapter-${n}`,
    mangaId: OLD_ID,
    sourceId: SOURCE,
    title: `Chapter ${n}`,
    url: `https://reader.example/old-name-chapter-${n}/`,
    sortKey: n
})

beforeEach(async () => {
    vi.clearAllMocks()
    await Promise.all(db.tables.map(table => table.clear()))
    await db.manga.put(item)
    await db.sourceLinks.put(link)
    await db.chapters.bulkPut([chapterRow(4), chapterRow(5), chapterRow(6), chapterRow(7)])
    await db.progress.put({
        mangaId: OLD_ID,
        chapterId: chapterRow(5).id,
        pageIndex: 0,
        pageCount: 1,
        completed: true,
        updatedAt: 1
    } as never)
})

describe("isSeriesGone", () => {
    it("is true only for a 404 from the site", () => {
        expect(isSeriesGone(new SourceRequestError("gone", 404))).toBe(true)
        expect(isSeriesGone(new SourceRequestError("down", 503))).toBe(false)
        expect(isSeriesGone(new Error("Request failed with status 404"))).toBe(false)
    })
})

describe("followMovedSeries", () => {
    it("asks the newest chapters, then moves the title with everything it owns", async () => {
        mocks.findMovedSeriesFor.mockResolvedValue(SERIES)
        const listed = [{ ...chapterRow(8), mangaId: NEW_ID }]
        mocks.listMangaChapters.mockResolvedValue(listed)

        const moved = await followMovedSeries(item, link, "en")

        const asked = mocks.findMovedSeriesFor.mock.calls[0]![2] as URL[]
        expect(asked.map(url => url.pathname)).toEqual([
            "/old-name-chapter-7/",
            "/old-name-chapter-6/",
            "/old-name-chapter-5/"
        ])
        expect(moved?.chapters).toEqual(listed)
        expect(moved?.item.id).toBe(NEW_ID)
        expect(moved?.link.url).toBe(SERIES.mangaUrl)

        expect(await db.manga.get(OLD_ID)).toBeUndefined()
        expect(await db.sourceLinks.get(OLD_ID)).toBeUndefined()
        const row = await db.manga.get(NEW_ID)
        expect(row?.title).toBe("New Name")
        expect(row?.lastReadChapterNumber).toBe(5)
        expect(row?.rating).toBe(4)
        expect((await db.sourceLinks.get(NEW_ID))?.sourceMangaId).toBe("new-name")
        expect(await db.chapters.where("mangaId").equals(NEW_ID).count()).toBe(4)
        expect(await db.chapters.where("mangaId").equals(OLD_ID).count()).toBe(0)
        expect(await db.progress.where("mangaId").equals(NEW_ID).count()).toBe(1)
        expect(mocks.recordTombstone).toHaveBeenCalledWith(OLD_ID)
    })

    it("lists the new address before touching anything, and leaves the title alone if it has no list", async () => {
        mocks.findMovedSeriesFor.mockResolvedValue(SERIES)
        mocks.listMangaChapters.mockResolvedValue([])

        expect(await followMovedSeries(item, link, "en")).toBeUndefined()

        expect(mocks.listMangaChapters.mock.calls[0]![1]).toMatchObject({
            sourceMangaId: "new-name",
            url: SERIES.mangaUrl
        })
        expect(await db.manga.get(OLD_ID)).toBeDefined()
        expect(await db.manga.get(NEW_ID)).toBeUndefined()
    })

    it("leaves the title alone when the new address fails too", async () => {
        mocks.findMovedSeriesFor.mockResolvedValue(SERIES)
        mocks.listMangaChapters.mockRejectedValue(new SourceRequestError("gone", 404))

        await expect(followMovedSeries(item, link, "en")).rejects.toThrow("gone")

        expect(await db.manga.get(OLD_ID)).toBeDefined()
    })

    it("does nothing when the site names the address already saved, or nothing at all", async () => {
        mocks.findMovedSeriesFor.mockResolvedValueOnce({ ...SERIES, sourceMangaId: "old-name" })
        expect(await followMovedSeries(item, link, "en")).toBeUndefined()
        mocks.findMovedSeriesFor.mockResolvedValueOnce(null)
        expect(await followMovedSeries(item, link, "en")).toBeUndefined()

        expect(mocks.listMangaChapters).not.toHaveBeenCalled()
        expect(await db.manga.get(OLD_ID)).toBeDefined()
    })

    it("merges into an entry already at the new address instead of duplicating it", async () => {
        await db.manga.put({ ...item, id: NEW_ID, lastReadChapterNumber: 9, rating: undefined } as never)
        mocks.findMovedSeriesFor.mockResolvedValue(SERIES)
        mocks.listMangaChapters.mockResolvedValue([chapterRow(8)])

        await followMovedSeries(item, link, "en")

        expect(await db.manga.count()).toBe(1)
        const row = await db.manga.get(NEW_ID)
        expect(row?.lastReadChapterNumber).toBe(9)
        expect(row?.rating).toBe(4)
    })
})

describe("what account sync sees after a move", () => {
    // Sync pushes rows changed since its last push, and a tombstone for the old id. A moved row that kept its
    // old timestamp would leave only the tombstone, and the title would vanish from the account.
    it("marks the new row as changed and keeps its AniList id", async () => {
        await db.manga.update(OLD_ID, { anilistId: 12345 })
        mocks.findMovedSeriesFor.mockResolvedValue(SERIES)
        mocks.listMangaChapters.mockResolvedValue([chapterRow(8)])
        const before = Date.now()

        await followMovedSeries({ ...item, anilistId: 12345 }, link, "en")

        const row = await db.manga.get(NEW_ID)
        expect(row?.updatedAt).toBeGreaterThanOrEqual(before)
        expect(row?.anilistId).toBe(12345)
    })

    it("does the same for an entry adopted from a chapter page", async () => {
        const before = Date.now()

        await adoptFormerSeriesEntries({
            manga: { ...item, id: NEW_ID, title: "New Name" },
            sourceId: SOURCE,
            sourceMangaId: "new-name",
            url: SERIES.mangaUrl,
            formerSourceMangaIds: ["old-name"]
        })

        expect((await db.manga.get(NEW_ID))?.updatedAt).toBeGreaterThanOrEqual(before)
    })
})

describe("adoptFormerSeriesEntries", () => {
    const resolved = (former?: string[]): SourceManga => ({
        manga: { ...item, id: NEW_ID, title: "New Name" },
        sourceId: SOURCE,
        sourceMangaId: "new-name",
        url: SERIES.mangaUrl,
        ...(former ? { formerSourceMangaIds: former } : {})
    })

    it("moves an entry saved under the guessed id, chapters and all", async () => {
        await adoptFormerSeriesEntries(resolved(["old-name"]))

        expect(await db.manga.get(OLD_ID)).toBeUndefined()
        expect((await db.manga.get(NEW_ID))?.lastReadChapterNumber).toBe(5)
        expect(await db.chapters.where("mangaId").equals(NEW_ID).count()).toBe(4)
    })

    it("does nothing when no such entry exists, or none is named", async () => {
        await adoptFormerSeriesEntries(resolved(["never-saved"]))
        await adoptFormerSeriesEntries(resolved())

        expect(await db.manga.get(OLD_ID)).toBeDefined()
        expect(await db.manga.get(NEW_ID)).toBeUndefined()
    })
})
