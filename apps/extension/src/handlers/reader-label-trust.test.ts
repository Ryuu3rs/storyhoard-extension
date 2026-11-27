import "fake-indexeddb/auto"
import type { ChapterRecord } from "@amr/contracts"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LibraryManga } from "../database"

const findSourceMock = vi.fn()
vi.mock("../sources", () => ({
    findSource: (...args: unknown[]) => findSourceMock(...args),
    getSourceById: vi.fn(),
    resolveChapterUrl: vi.fn(),
    resolveChapterFromHtml: vi.fn(),
    listChaptersBySource: vi.fn(),
    resolveMangaMetadata: vi.fn(),
    chaptersForLanguage: <T>(chapters: T[]) => chapters,
    tabOriginsForSource: () => undefined
}))
vi.mock("../settings", () => ({ getSettings: vi.fn().mockResolvedValue({ language: "en", autoAdd: true }) }))
vi.mock("../live", () => ({ publishLive: vi.fn() }))
vi.stubGlobal("browser", {
    runtime: { getURL: () => "chrome-extension://ext/" },
    action: { setBadgeBackgroundColor: vi.fn(), setBadgeText: vi.fn() }
})

const { db } = await import("../database")
const { readerHandlers } = await import("./reader")
vi.spyOn(await import("../background/chapter-cache"), "scheduleChapterListRefresh").mockImplementation(() => {})

const HOST = "https://idsite.example"
const mangaId = "idsite:manga:demo"
const title: LibraryManga = {
    id: mangaId,
    title: "Demo",
    normalizedTitle: "demo",
    authors: [],
    status: "ongoing",
    addedAt: 1,
    updatedAt: 1,
    sourceId: "idsite",
    sourceMangaId: "demo",
    sourceUrl: `${HOST}/series/demo`,
    mangaUrl: `${HOST}/series/demo`,
    latestChapterNumber: 12,
    latestChapterId: `${mangaId}:12`,
    lastReadChapterNumber: 10,
    lastReadChapterId: `${mangaId}:10`
}

// A content-script sender on the site's own page.
const pageCtx = (url: string) => ({ sender: { url, tab: { id: 1, url }, origin: HOST } }) as never

beforeEach(async () => {
    await db.delete()
    await db.open()
    findSourceMock.mockReturnValue({
        manifest: { id: "idsite" },
        match: () => "chapter",
        parseMangaUrl: () => ({ sourceMangaId: "demo", mangaUrl: `${HOST}/series/demo` })
    })
    await db.manga.put(title)
    await db.chapters.bulkPut(
        Array.from(
            { length: 12 },
            (_, i) =>
                ({
                    id: `${mangaId}:${i + 1}`,
                    mangaId,
                    sourceId: "idsite",
                    title: `Chapter ${i + 1}`,
                    url: `${HOST}/series/demo/chapter-${700000 + i}`,
                    sortKey: i + 1
                }) as ChapterRecord
        )
    )
})

describe("chapter:track label on an id-sized address", () => {
    it("a page label far past the title's latest chapter does not move the read position there", async () => {
        const url = `${HOST}/series/demo/chapter-764275`
        await readerHandlers["chapter:track"]!({ type: "chapter:track", url, label: "Chapter 99999" }, pageCtx(url))
        const after = await db.manga.get(mangaId)
        // MAX_GAP (database.ts:2279) says a number > 50 past what the title knows is a stray.
        expect(after?.lastReadChapterNumber).toBeLessThanOrEqual(12 + 50)
    })

    it("the document.title fallback of a series named with a number is not read as the chapter", async () => {
        const url = `${HOST}/series/demo/chapter-764276`
        // inject-chapter-prompt.ts:996 falls back to document.title when the page has no chapter link/dropdown.
        await readerHandlers["chapter:track"]!({ type: "chapter:track", url, label: "Mob Psycho 100" }, pageCtx(url))
        const after = await db.manga.get(mangaId)
        expect(after?.lastReadChapterNumber).not.toBe(100)
    })

    it("a title containing 'No. N' is not read as chapter N when the label names the chapter", async () => {
        const url = `${HOST}/series/demo/chapter-764277`
        const res = (await readerHandlers["chapter:track"]!(
            { type: "chapter:track", url, label: "Kaiju No. 8 - Chapter 13" },
            pageCtx(url)
        )) as { chapterNumber: number | null }
        expect(res.chapterNumber).toBe(13)
    })
})
