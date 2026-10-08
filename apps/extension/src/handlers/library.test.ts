import "fake-indexeddb/auto"
import type { ChapterRecord, MangaRecord, SourceLinkRecord } from "@amr/contracts"
import { SourceRequestError } from "@amr/source-sdk"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { db, listBackups } from "../database"
import type { LibraryManga } from "../database"

vi.mock("../sources", async () => {
    const actual = await vi.importActual<typeof import("../sources")>("../sources")
    return {
        ...actual,
        resolveChapterUrl: vi.fn(),
        resolveCoverFor: vi.fn(),
        listChaptersForSource: vi.fn(),
        listChaptersFromSourceHtml: vi.fn(),
        listChaptersBySource: vi.fn(),
        findSource: vi.fn()
    }
})

// getSettings reads browser.storage, which isn't stubbed here - mock it so chapter:adjacent
// (which reads settings.language for language-aware prev/next) doesn't touch the browser global.
vi.mock("../settings", () => ({
    getSettings: vi.fn().mockResolvedValue({ language: "en" })
}))

vi.mock("../background/covers", () => ({
    fetchCoverBlob: vi.fn()
}))

vi.mock("../metadata", () => ({
    resolveMetadata: vi.fn()
}))

vi.mock("../diag-log", () => ({
    diag: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock("../background/chapter-cache", () => ({
    scheduleChapterListRefresh: vi.fn()
}))

// isBotBlocked (imported by the handler from ../background/capture) is
// deliberately left unmocked - it's a pure function and these tests exercise
// its real bot-block-detection logic against SourceRequestError instances.
vi.mock("../background/tab-fetch", () => ({
    fetchChapterHtmlViaTab: vi.fn()
}))

// publishLive touches browser.storage, which isn't stubbed in this test file -
// stub it out here so handlers that call it (e.g. chapter:adjacent) can be
// asserted on without needing a full browser.storage mock.
const publishLiveMock = vi.fn()
vi.mock("../live", () => ({
    publishLive: (...args: unknown[]) => publishLiveMock(...args)
}))

const { libraryHandlers, isFallbackCreated } = await import("./library")
const {
    resolveChapterUrl,
    listChaptersForSource,
    listChaptersFromSourceHtml,
    listChaptersBySource,
    findSource,
    resolveCoverFor
} = await import("../sources")
const { fetchCoverBlob } = await import("../background/covers")
const { resolveMetadata } = await import("../metadata")
const { scheduleChapterListRefresh } = await import("../background/chapter-cache")
const { fetchChapterHtmlViaTab } = await import("../background/tab-fetch")

const ctx = { sender: {} } as never

const manga: MangaRecord = {
    id: "mangadex:manga:abc",
    title: "Test Manga",
    normalizedTitle: "test manga",
    authors: [],
    status: "ongoing",
    addedAt: 1,
    updatedAt: 1
}

const sourceLink: SourceLinkRecord = {
    mangaId: manga.id,
    sourceId: "mangadex",
    url: "https://mangadex.org/title/abc",
    addedAt: 1,
    updatedAt: 1
}

beforeEach(async () => {
    vi.clearAllMocks()
    await Promise.all([
        db.manga.clear(),
        db.sourceLinks.clear(),
        db.chapters.clear(),
        db.progress.clear(),
        db.historyEvents.clear(),
        db.downloads.clear(),
        db.covers.clear(),
        db.backups.clear(),
        db.pageBookmarks.clear()
    ])
})

describe("library:switch", () => {
    it("deletes the old mirror's chapters and preserves user fields on the manga record", async () => {
        const libraryManga: LibraryManga = {
            ...manga,
            sourceId: "mangadex",
            sourceUrl: sourceLink.url,
            sourceMangaId: "abc",
            mangaUrl: "https://mangadex.org/title/abc",
            rating: 4,
            categories: ["fav"]
        }
        await db.manga.put(libraryManga)
        await db.sourceLinks.put(sourceLink)

        const oldChapter: ChapterRecord = {
            id: "mangadex:chapter:old-1",
            mangaId: manga.id,
            sourceId: "mangadex",
            title: "Old Chapter 1",
            url: "https://mangadex.org/chapter/old-1",
            sortKey: 1
        }
        await db.chapters.put(oldChapter)

        const newChapter: ChapterRecord = {
            id: "othermirror:chapter:new-1",
            mangaId: manga.id,
            sourceId: "othermirror",
            title: "New Chapter 1",
            url: "https://othermirror.example/chapter/new-1",
            sortKey: 1
        }
        vi.mocked(listChaptersForSource).mockResolvedValue([newChapter] as never)

        const handler = libraryHandlers["library:switch"]!
        await handler(
            {
                type: "library:switch",
                mangaId: manga.id,
                sourceId: "othermirror",
                sourceMangaId: "new-src-id",
                mangaUrl: "https://othermirror.example/title/new-src-id"
            } as never,
            ctx
        )

        const chaptersAfter = await db.chapters.where("mangaId").equals(manga.id).toArray()
        expect(chaptersAfter.map(c => c.id).sort()).toEqual([newChapter.id])
        expect(chaptersAfter.some(c => c.sourceId !== "othermirror")).toBe(false)

        const stored = await db.manga.get(manga.id)
        expect(stored?.rating).toBe(4)
        expect(stored?.categories).toEqual(["fav"])
        expect(stored?.sourceId).toBe("othermirror")
    })

    it("flags chapterNumberingUnreliable when switching to mangahub from a different source with existing read progress", async () => {
        const libraryManga: LibraryManga = {
            ...manga,
            sourceId: "mangadex",
            sourceUrl: sourceLink.url,
            sourceMangaId: "abc",
            mangaUrl: "https://mangadex.org/title/abc",
            lastReadChapterNumber: 50
        }
        await db.manga.put(libraryManga)
        await db.sourceLinks.put(sourceLink)

        const newChapter: ChapterRecord = {
            id: "mangahub:chapter:new-1",
            mangaId: manga.id,
            sourceId: "mangahub",
            title: "Chapter 45",
            url: "https://mangahub.io/chapter/new-src-id/chapter-45",
            sortKey: 45
        }
        vi.mocked(listChaptersForSource).mockResolvedValue([newChapter] as never)

        const handler = libraryHandlers["library:switch"]!
        await handler(
            {
                type: "library:switch",
                mangaId: manga.id,
                sourceId: "mangahub",
                sourceMangaId: "new-src-id",
                mangaUrl: "https://mangahub.io/manga/new-src-id"
            } as never,
            ctx
        )

        const stored = (await db.manga.get(manga.id)) as
            | (LibraryManga & { chapterNumberingUnreliable?: boolean })
            | undefined
        expect(stored?.chapterNumberingUnreliable).toBe(true)
        // The old source's read-progress number itself is left untouched by the switch.
        expect(stored?.lastReadChapterNumber).toBe(50)
    })

    it("does not flag chapterNumberingUnreliable when switching between two non-mangahub sources", async () => {
        const libraryManga: LibraryManga = {
            ...manga,
            sourceId: "mangadex",
            sourceUrl: sourceLink.url,
            sourceMangaId: "abc",
            mangaUrl: "https://mangadex.org/title/abc",
            lastReadChapterNumber: 50
        }
        await db.manga.put(libraryManga)
        await db.sourceLinks.put(sourceLink)

        const newChapter: ChapterRecord = {
            id: "othermirror:chapter:new-1",
            mangaId: manga.id,
            sourceId: "othermirror",
            title: "New Chapter 1",
            url: "https://othermirror.example/chapter/new-1",
            sortKey: 1
        }
        vi.mocked(listChaptersForSource).mockResolvedValue([newChapter] as never)

        const handler = libraryHandlers["library:switch"]!
        await handler(
            {
                type: "library:switch",
                mangaId: manga.id,
                sourceId: "othermirror",
                sourceMangaId: "new-src-id",
                mangaUrl: "https://othermirror.example/title/new-src-id"
            } as never,
            ctx
        )

        const stored = (await db.manga.get(manga.id)) as
            | (LibraryManga & { chapterNumberingUnreliable?: boolean })
            | undefined
        expect(stored?.chapterNumberingUnreliable).toBeUndefined()
    })

    it("re-points lastReadChapterId to the equivalent chapter in the new mirror by read number", async () => {
        const libraryManga: LibraryManga = {
            ...manga,
            sourceId: "mangadex",
            sourceUrl: sourceLink.url,
            sourceMangaId: "abc",
            mangaUrl: "https://mangadex.org/title/abc",
            lastReadChapterNumber: 50,
            lastReadChapterId: "mangadex:chapter:old-50"
        }
        await db.manga.put(libraryManga)
        await db.sourceLinks.put(sourceLink)

        const newChapters: ChapterRecord[] = [49, 50, 51].map(n => ({
            id: `othermirror:chapter:c${n}`,
            mangaId: manga.id,
            sourceId: "othermirror",
            title: `Chapter ${n}`,
            url: `https://othermirror.example/c${n}`,
            sortKey: n
        }))
        vi.mocked(listChaptersForSource).mockResolvedValue(newChapters as never)

        const handler = libraryHandlers["library:switch"]!
        await handler(
            {
                type: "library:switch",
                mangaId: manga.id,
                sourceId: "othermirror",
                sourceMangaId: "new-src-id",
                mangaUrl: "https://othermirror.example/title/new-src-id"
            } as never,
            ctx
        )

        const stored = await db.manga.get(manga.id)
        // The dangling old-source read id is re-pointed at the new mirror's chapter 50,
        // so the title stays caught up instead of resetting to unread.
        expect(stored?.lastReadChapterId).toBe("othermirror:chapter:c50")
        expect(stored?.lastReadChapterNumber).toBe(50)
    })

    it("recovers read position by URL when the number is unknown (numberless import)", async () => {
        // A numberless import: lastReadChapterId points at a preserved chapter carrying
        // only the last-read URL, with no lastReadChapterNumber.
        const oldReadChapter: ChapterRecord = {
            id: "weebcentral:manga:x:ext:lastread",
            mangaId: manga.id,
            sourceId: "weebcentral",
            title: "Last read",
            url: "https://weebcentral.com/chapters/01J76XZ7N4Y3C0X29Y0TZ4QC3Y",
            sortKey: Number.POSITIVE_INFINITY
        }
        await db.chapters.put(oldReadChapter)
        const libraryManga: LibraryManga = {
            ...manga,
            sourceId: "weebcentral",
            sourceUrl: sourceLink.url,
            sourceMangaId: "x",
            mangaUrl: "https://weebcentral.com/series/x",
            lastReadChapterId: oldReadChapter.id
        }
        await db.manga.put(libraryManga)
        await db.sourceLinks.put(sourceLink)

        // The re-fetched list has the same ulid chapter, now with a real number.
        const newChapters: ChapterRecord[] = [
            {
                id: "weebcentral:chapter:new-184",
                mangaId: manga.id,
                sourceId: "weebcentral",
                title: "Episode 184",
                url: "https://weebcentral.com/chapters/AAAA1111BBBB2222CCCC3333",
                sortKey: 184
            },
            {
                id: "weebcentral:chapter:new-185",
                mangaId: manga.id,
                sourceId: "weebcentral",
                title: "Episode 185",
                url: "https://weebcentral.com/chapters/01J76XZ7N4Y3C0X29Y0TZ4QC3Y",
                sortKey: 185
            }
        ]
        vi.mocked(listChaptersForSource).mockResolvedValue(newChapters as never)

        const handler = libraryHandlers["library:switch"]!
        await handler(
            {
                type: "library:switch",
                mangaId: manga.id,
                sourceId: "weebcentral",
                sourceMangaId: "x",
                mangaUrl: "https://weebcentral.com/series/x"
            } as never,
            ctx
        )

        const stored = await db.manga.get(manga.id)
        // The ulid matched, recovering both the id and the previously-unknown number.
        expect(stored?.lastReadChapterId).toBe("weebcentral:chapter:new-185")
        expect(stored?.lastReadChapterNumber).toBe(185)
    })

    it("clears the stale lastReadChapterId (keeps the number) when switching to mangahub (numbering not comparable)", async () => {
        const libraryManga: LibraryManga = {
            ...manga,
            sourceId: "mangadex",
            sourceUrl: sourceLink.url,
            sourceMangaId: "abc",
            mangaUrl: "https://mangadex.org/title/abc",
            lastReadChapterNumber: 50,
            lastReadChapterId: "mangadex:chapter:old-50"
        }
        await db.manga.put(libraryManga)
        await db.sourceLinks.put(sourceLink)

        const newChapter: ChapterRecord = {
            id: "mangahub:chapter:c50",
            mangaId: manga.id,
            sourceId: "mangahub",
            title: "Chapter 50",
            url: "https://mangahub.io/chapter/new-src-id/chapter-50",
            sortKey: 50
        }
        vi.mocked(listChaptersForSource).mockResolvedValue([newChapter] as never)

        const handler = libraryHandlers["library:switch"]!
        await handler(
            {
                type: "library:switch",
                mangaId: manga.id,
                sourceId: "mangahub",
                sourceMangaId: "new-src-id",
                mangaUrl: "https://mangahub.io/manga/new-src-id"
            } as never,
            ctx
        )

        const stored = await db.manga.get(manga.id)
        // The old id pointed at a mangadex chapter row that switchMangaSource deletes,
        // so keeping it would dangle and break chapter:resume. It's cleared; the read
        // position survives as the number (recovered later if numbering becomes comparable).
        expect(stored?.lastReadChapterId).toBeUndefined()
        expect(stored?.lastReadChapterNumber).toBe(50)
    })

    it("threads a bounded timeoutMs/maxRetries override into listChaptersForSource, not the ~46s default", async () => {
        const libraryManga: LibraryManga = {
            ...manga,
            sourceId: "mangadex",
            sourceUrl: sourceLink.url,
            sourceMangaId: "abc",
            mangaUrl: "https://mangadex.org/title/abc"
        }
        await db.manga.put(libraryManga)
        await db.sourceLinks.put(sourceLink)

        const newChapter: ChapterRecord = {
            id: "othermirror:chapter:new-1",
            mangaId: manga.id,
            sourceId: "othermirror",
            title: "New Chapter 1",
            url: "https://othermirror.example/chapter/new-1",
            sortKey: 1
        }
        vi.mocked(listChaptersForSource).mockResolvedValue([newChapter] as never)

        const handler = libraryHandlers["library:switch"]!
        await handler(
            {
                type: "library:switch",
                mangaId: manga.id,
                sourceId: "othermirror",
                sourceMangaId: "new-src-id",
                mangaUrl: "https://othermirror.example/title/new-src-id"
            } as never,
            ctx
        )

        // ~10s timeout / 1 retry (~10-11s worst case), not the library-wide default
        // of ~15s timeout / 2 retries (~46s worst case) - a hanging candidate during
        // the reconcile sweep's sequential auto-link retry loop must not be able to
        // blow the sweep's time budget by itself.
        expect(listChaptersForSource).toHaveBeenCalledWith(
            expect.objectContaining({ id: manga.id }),
            "othermirror",
            "new-src-id",
            "https://othermirror.example/title/new-src-id",
            { timeoutMs: 10_000, maxRetries: 1 }
        )
    })

    it("falls back to a tab-rendered chapter list when the direct fetch is bot-blocked and allowTabFallback is set", async () => {
        const libraryManga: LibraryManga = {
            ...manga,
            sourceId: "mangadex",
            sourceUrl: sourceLink.url,
            sourceMangaId: "abc",
            mangaUrl: "https://mangadex.org/title/abc"
        }
        await db.manga.put(libraryManga)
        await db.sourceLinks.put(sourceLink)

        vi.mocked(listChaptersForSource).mockRejectedValue(
            new SourceRequestError("Request failed with status 403", 403)
        )
        vi.mocked(fetchChapterHtmlViaTab).mockResolvedValue("<html>kagane series page</html>")
        const tabChapter: ChapterRecord = {
            id: "kagane:chapter:new-1",
            mangaId: manga.id,
            sourceId: "kagane",
            title: "New Chapter 1",
            url: "https://kagane.to/series/new-src-id/reader/new-1",
            sortKey: 1
        }
        vi.mocked(listChaptersFromSourceHtml).mockResolvedValue([tabChapter] as never)

        const handler = libraryHandlers["library:switch"]!
        await handler(
            {
                type: "library:switch",
                mangaId: manga.id,
                sourceId: "kagane",
                sourceMangaId: "new-src-id",
                mangaUrl: "https://kagane.to/series/new-src-id",
                allowTabFallback: true
            } as never,
            ctx
        )

        expect(fetchChapterHtmlViaTab).toHaveBeenCalledWith("https://kagane.to/series/new-src-id", undefined)
        expect(listChaptersFromSourceHtml).toHaveBeenCalledWith(
            expect.objectContaining({ id: manga.id }),
            "kagane",
            "new-src-id",
            "https://kagane.to/series/new-src-id",
            "<html>kagane series page</html>"
        )
        const chaptersAfter = await db.chapters.where("mangaId").equals(manga.id).toArray()
        expect(chaptersAfter.map(c => c.id)).toEqual([tabChapter.id])
    })

    it("rethrows a bot-blocked failure without opening a tab when allowTabFallback is not set", async () => {
        const libraryManga: LibraryManga = {
            ...manga,
            sourceId: "mangadex",
            sourceUrl: sourceLink.url,
            sourceMangaId: "abc",
            mangaUrl: "https://mangadex.org/title/abc"
        }
        await db.manga.put(libraryManga)
        await db.sourceLinks.put(sourceLink)

        vi.mocked(listChaptersForSource).mockRejectedValue(
            new SourceRequestError("Request failed with status 403", 403)
        )

        const handler = libraryHandlers["library:switch"]!
        await expect(
            handler(
                {
                    type: "library:switch",
                    mangaId: manga.id,
                    sourceId: "kagane",
                    sourceMangaId: "new-src-id",
                    mangaUrl: "https://kagane.to/series/new-src-id"
                    // allowTabFallback intentionally omitted - this is the auto-link sweep path.
                } as never,
                ctx
            )
        ).rejects.toThrow()

        expect(fetchChapterHtmlViaTab).not.toHaveBeenCalled()
        expect(listChaptersFromSourceHtml).not.toHaveBeenCalled()
    })

    it("rethrows a non-bot-block failure (e.g. a timeout) even with allowTabFallback set", async () => {
        const libraryManga: LibraryManga = {
            ...manga,
            sourceId: "mangadex",
            sourceUrl: sourceLink.url,
            sourceMangaId: "abc",
            mangaUrl: "https://mangadex.org/title/abc"
        }
        await db.manga.put(libraryManga)
        await db.sourceLinks.put(sourceLink)

        // status: undefined -> a network timeout/connection failure. isBotBlocked
        // deliberately excludes these (a genuinely-down site can't be helped by a
        // tab load either), so this must rethrow even with the flag set.
        vi.mocked(listChaptersForSource).mockRejectedValue(
            new SourceRequestError("Request timed out after 10000ms", undefined)
        )

        const handler = libraryHandlers["library:switch"]!
        await expect(
            handler(
                {
                    type: "library:switch",
                    mangaId: manga.id,
                    sourceId: "kagane",
                    sourceMangaId: "new-src-id",
                    mangaUrl: "https://kagane.to/series/new-src-id",
                    allowTabFallback: true
                } as never,
                ctx
            )
        ).rejects.toThrow()

        expect(fetchChapterHtmlViaTab).not.toHaveBeenCalled()
        expect(listChaptersFromSourceHtml).not.toHaveBeenCalled()
    })
})

describe("library:relink", () => {
    it("preserves user fields and coverUrl through the relink, and removes the old-id record", async () => {
        const oldId = manga.id
        const newId = "webtoons:manga:xyz"

        const libraryManga: LibraryManga = {
            ...manga,
            id: oldId,
            sourceId: "mangadex",
            sourceUrl: sourceLink.url,
            sourceMangaId: "abc",
            mangaUrl: "https://mangadex.org/title/abc",
            rating: 5,
            categories: ["action", "fav"],
            lastReadChapterId: "mangadex:chapter:3",
            addedAt: 12345,
            coverUrl: "https://existing-cdn.example/cover.jpg"
        }
        await db.manga.put(libraryManga)
        await db.sourceLinks.put({ ...sourceLink, mangaId: oldId })

        const resolvedChapter: ChapterRecord & { sourceChapterId: string; language: string } = {
            id: "webtoons:chapter:1",
            mangaId: newId,
            sourceId: "webtoons",
            title: "Episode 1",
            url: "https://www.webtoons.com/en/x/y/ep-1/viewer?title_no=99&episode_no=1",
            sortKey: 1,
            sourceChapterId: "1",
            language: "en"
        }

        const resolvedManga: MangaRecord = {
            id: newId,
            title: "Relinked Title",
            normalizedTitle: "relinked title",
            authors: [],
            status: "ongoing",
            addedAt: 999,
            updatedAt: 999,
            coverUrl: "https://new-cdn.example/cover.jpg"
        }

        vi.mocked(resolveChapterUrl).mockResolvedValue({
            manga: {
                manga: resolvedManga,
                sourceId: "webtoons",
                sourceMangaId: "99",
                url: "https://www.webtoons.com/en/x/y/"
            },
            chapter: resolvedChapter,
            pages: []
        } as never)
        vi.mocked(findSource).mockReturnValue({ manifest: { id: "webtoons" } } as never)

        const { libraryHandlers } = await import("./library")
        const handler = libraryHandlers["library:relink"]!
        const result = (await handler(
            {
                type: "library:relink",
                mangaId: oldId,
                url: resolvedChapter.url
            } as never,
            ctx
        )) as { sourceId: string; mangaId: string }

        expect(result.mangaId).toBe(newId)
        expect(await db.manga.get(oldId)).toBeUndefined()

        const stored = await db.manga.get(newId)
        expect(stored?.rating).toBe(5)
        expect(stored?.categories).toEqual(["action", "fav"])
        expect(stored?.lastReadChapterId).toBe("mangadex:chapter:3")
        expect(stored?.addedAt).toBe(12345)
        // Existing cover is preferred over the newly resolved one.
        expect(stored?.coverUrl).toBe("https://existing-cdn.example/cover.jpg")
    })

    // Fix 3: rekeyManga and the post-rekey chapter put now run in one transaction -
    // an SW restart (simulated here by the chapter put itself failing) between them
    // used to leave the manga pointing at a chapter row that was never written.
    // Forcing db.chapters.put to reject proves the whole rekey rolled back with it.
    it("rolls back the rekey if the post-rekey chapter write fails (atomicity)", async () => {
        const oldId = manga.id
        const newId = "webtoons:manga:xyz"

        await db.manga.put({ ...manga, id: oldId, sourceId: "mangadex", sourceUrl: sourceLink.url })
        await db.sourceLinks.put({ ...sourceLink, mangaId: oldId })

        const resolvedChapter: ChapterRecord & { sourceChapterId: string; language: string } = {
            id: "webtoons:chapter:1",
            mangaId: newId,
            sourceId: "webtoons",
            title: "Episode 1",
            url: "https://www.webtoons.com/en/x/y/ep-1/viewer?title_no=99&episode_no=1",
            sortKey: 1,
            sourceChapterId: "1",
            language: "en"
        }
        const resolvedManga: MangaRecord = {
            id: newId,
            title: "Relinked Title",
            normalizedTitle: "relinked title",
            authors: [],
            status: "ongoing",
            addedAt: 999,
            updatedAt: 999
        }
        vi.mocked(resolveChapterUrl).mockResolvedValue({
            manga: {
                manga: resolvedManga,
                sourceId: "webtoons",
                sourceMangaId: "99",
                url: "https://www.webtoons.com/en/x/y/"
            },
            chapter: resolvedChapter,
            pages: []
        } as never)
        vi.mocked(findSource).mockReturnValue({ manifest: { id: "webtoons" } } as never)

        const putSpy = vi.spyOn(db.chapters, "put").mockRejectedValueOnce(new Error("boom"))

        const { libraryHandlers } = await import("./library")
        const handler = libraryHandlers["library:relink"]!
        await expect(
            handler({ type: "library:relink", mangaId: oldId, url: resolvedChapter.url } as never, ctx)
        ).rejects.toThrow("boom")

        putSpy.mockRestore()
        // The rekey must not have taken effect - old id still present, new id absent.
        expect(await db.manga.get(oldId)).toBeDefined()
        expect(await db.manga.get(newId)).toBeUndefined()
    })
})

describe("chapter:adjacent", () => {
    const libraryManga: LibraryManga = {
        ...manga,
        sourceId: "mangadex",
        sourceUrl: "https://mangadex.org/chapter/2",
        sourceMangaId: "abc",
        mangaUrl: "https://mangadex.org/title/abc",
        lastReadChapterNumber: 2
    }

    const chapter = (n: number): ChapterRecord => ({
        id: `mangadex:chapter:${n}`,
        mangaId: manga.id,
        sourceId: "mangadex",
        title: `Chapter ${n}`,
        url: `https://mangadex.org/chapter/${n}`,
        sortKey: n
    })

    it("serves next/prev from the cached chapter list without calling the network", async () => {
        await db.manga.put(libraryManga)
        await db.chapters.bulkPut([chapter(1), chapter(2), chapter(3)])

        const handler = libraryHandlers["chapter:adjacent"]!
        const result = (await handler({ type: "chapter:adjacent", mangaId: manga.id } as never, ctx)) as {
            current: number | null
            next: { number: number } | null
            prev: { number: number } | null
        }

        expect(result.current).toBe(2)
        expect(result.next?.number).toBe(3)
        expect(result.prev?.number).toBe(1)
        expect(listChaptersForSource).not.toHaveBeenCalled()
    })

    it("schedules a background chapter-list refresh after serving successfully from cache", async () => {
        await db.manga.put(libraryManga)
        await db.chapters.bulkPut([chapter(1), chapter(2), chapter(3)])

        const handler = libraryHandlers["chapter:adjacent"]!
        await handler({ type: "chapter:adjacent", mangaId: manga.id } as never, ctx)

        expect(scheduleChapterListRefresh).toHaveBeenCalledTimes(1)
    })

    it("falls through to the network when the cache is empty, and caches the result for next time", async () => {
        await db.manga.put(libraryManga)
        const networkChapters = [chapter(1), chapter(3)]
        vi.mocked(listChaptersForSource).mockResolvedValue(networkChapters as never)

        const handler = libraryHandlers["chapter:adjacent"]!
        const result = (await handler({ type: "chapter:adjacent", mangaId: manga.id } as never, ctx)) as {
            next: { number: number } | null
            prev: { number: number } | null
        }

        expect(listChaptersForSource).toHaveBeenCalledTimes(1)
        expect(result.next?.number).toBe(3)
        expect(result.prev?.number).toBe(1)

        const stored = await db.chapters.where("mangaId").equals(manga.id).toArray()
        expect(stored.map(c => c.id).sort()).toEqual(["mangadex:chapter:1", "mangadex:chapter:3"])

        // A stale-cache refresh that actually wrote new chapters must publish, or
        // open tabs never learn the cache changed underneath them.
        expect(publishLiveMock).toHaveBeenCalledWith(["chapters"], [manga.id])
    })

    it("re-checks the network when the cache's highest chapter isn't past the current one, but still serves the stale cache if that network call fails", async () => {
        // lastReadChapterNumber is 2 and the cache's highest chapter is also 2 - the
        // cache might just be stale (a new chapter may have shipped since it was last
        // populated), not genuinely caught up, so this should attempt the network.
        await db.manga.put(libraryManga)
        await db.chapters.bulkPut([chapter(1), chapter(2)])
        vi.mocked(listChaptersForSource).mockRejectedValue(new Error("network down"))

        const handler = libraryHandlers["chapter:adjacent"]!
        const result = (await handler({ type: "chapter:adjacent", mangaId: manga.id } as never, ctx)) as {
            current: number | null
            next: { number: number } | null
            prev: { number: number } | null
        }

        expect(listChaptersForSource).toHaveBeenCalledTimes(1)
        // Network failed (e.g. a Cloudflare-gated source) - falls back to the stale
        // cache's own answer instead of going blank.
        expect(result.current).toBe(2)
        expect(result.next).toBeNull()
        expect(result.prev?.number).toBe(1)
        // Nothing was written, so nothing should be published.
        expect(publishLiveMock).not.toHaveBeenCalled()
    })

    it("publishes after a successful stale-cache refresh that finds new chapters", async () => {
        // Same setup as the re-check test above, but the network call succeeds this
        // time and returns a longer list - the bulkPut it triggers must publish.
        await db.manga.put(libraryManga)
        await db.chapters.bulkPut([chapter(1), chapter(2)])
        vi.mocked(listChaptersForSource).mockResolvedValue([chapter(1), chapter(2), chapter(3)] as never)

        const handler = libraryHandlers["chapter:adjacent"]!
        const result = (await handler({ type: "chapter:adjacent", mangaId: manga.id } as never, ctx)) as {
            next: { number: number } | null
        }

        expect(result.next?.number).toBe(3)
        expect(publishLiveMock).toHaveBeenCalledWith(["chapters"], [manga.id])
    })
})

describe("library:covers:backfill", () => {
    it("skips seed- ids and manga that already have a cached cover blob, never writes a data: coverUrl, and doesn't retry a failed id twice", async () => {
        const { libraryHandlers } = await import("./library")

        const seedManga: LibraryManga = {
            ...manga,
            id: "seed-1",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/1",
            coverUrl: undefined
        }
        const alreadyCached: LibraryManga = {
            ...manga,
            id: "mangadex:manga:cached",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/2",
            coverUrl: "https://cdn.example/already-cached.jpg"
        }
        const needsBackfill: LibraryManga = {
            ...manga,
            id: "mangadex:manga:needs-backfill",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/3",
            coverUrl: "https://cdn.example/cover.jpg"
        }
        // Pad past the 20-item batch size with extra targets so `remaining` stays > 0 after
        // the first pass - otherwise the handler clears its dedup Set at the end of the pass
        // and the "don't retry" behavior below wouldn't actually be exercised.
        const padding: LibraryManga[] = Array.from({ length: 25 }, (_, i) => ({
            ...manga,
            id: `mangadex:manga:pad-${i}`,
            sourceId: "mangadex",
            sourceUrl: `https://mangadex.org/chapter/pad-${i}`,
            coverUrl: `https://cdn.example/pad-${i}.jpg`
        }))
        await db.manga.bulkPut([seedManga, alreadyCached, needsBackfill, ...padding])
        await db.covers.put({ mangaId: alreadyCached.id, blob: new Blob(["x"]), cachedAt: 1 })

        vi.mocked(fetchCoverBlob).mockResolvedValue(undefined)

        const handler = libraryHandlers["library:covers:backfill"]!
        const first = (await handler({ type: "library:covers:backfill" } as never, ctx)) as {
            updated: number
            remaining: number
        }

        // needsBackfill was within the first batch and got attempted; seed- ids and titles
        // with an already-cached blob were filtered out regardless of batch position.
        expect(fetchCoverBlob).toHaveBeenCalledWith("https://cdn.example/cover.jpg")
        expect(fetchCoverBlob).not.toHaveBeenCalledWith("https://cdn.example/already-cached.jpg")
        expect(first.updated).toBe(0)
        expect(first.remaining).toBeGreaterThan(0)

        // Covers are never inlined as data: URIs anymore.
        const allAfter = await db.manga.toArray()
        expect(allAfter.every(m => !m.coverUrl?.startsWith("data:"))).toBe(true)

        vi.mocked(fetchCoverBlob).mockClear()

        // Second call in the same run must not retry needsBackfill again - it's already
        // tracked in coverBackfillAttempted from the first pass.
        await handler({ type: "library:covers:backfill" } as never, ctx)
        expect(fetchCoverBlob).not.toHaveBeenCalledWith("https://cdn.example/cover.jpg")
    })

    it("resolves a fresh remote cover URL for a title with no cover, stores it as-is (never inlined), and caches the blob", async () => {
        const { libraryHandlers } = await import("./library")

        const noCover: LibraryManga = {
            ...manga,
            id: "webtoons:manga:8579",
            sourceId: "webtoons",
            sourceMangaId: "8579",
            mangaUrl: "https://www.webtoons.com/en/romance/daisy-how-to-become-the-dukes-fiancee/list?title_no=8579",
            sourceUrl:
                "https://www.webtoons.com/en/romance/daisy-how-to-become-the-dukes-fiancee/episode-1/viewer?title_no=8579&episode_no=1",
            coverUrl: undefined
        }
        await db.manga.put(noCover)

        vi.mocked(resolveCoverFor).mockResolvedValue("https://fresh-cdn.example/new-cover.jpg")
        const fakeBlob = new Blob(["cover-bytes"], { type: "image/jpeg" })
        vi.mocked(fetchCoverBlob).mockResolvedValue(fakeBlob)

        const handler = libraryHandlers["library:covers:backfill"]!
        const result = (await handler({ type: "library:covers:backfill" } as never, ctx)) as {
            updated: number
            remaining: number
        }

        expect(resolveCoverFor).toHaveBeenCalledWith(expect.objectContaining({ id: "webtoons:manga:8579" }))
        expect(fetchCoverBlob).toHaveBeenCalledWith("https://fresh-cdn.example/new-cover.jpg")
        expect(result.updated).toBe(1)

        const stored = await db.manga.get("webtoons:manga:8579")
        // The source's real remote URL is stored as-is - never inlined as a data: URI.
        expect(stored?.coverUrl).toBe("https://fresh-cdn.example/new-cover.jpg")

        // fake-indexeddb structured-clones the stored Blob, so compare by content/type
        // rather than by reference.
        const cachedRow = await db.covers.get("webtoons:manga:8579")
        expect(cachedRow?.blob.type).toBe(fakeBlob.type)
        expect(cachedRow?.blob.size).toBe(fakeBlob.size)
    })

    it("falls back to the metadata catalog cover when the source cannot resolve one (dead source)", async () => {
        const { libraryHandlers } = await import("./library")

        const deadSource: LibraryManga = {
            ...manga,
            id: "aquamanga:manga:dead",
            sourceId: "aquamanga",
            sourceUrl: "https://aquamanga.com/manga/dead",
            coverUrl: undefined
        }
        await db.manga.put(deadSource)

        vi.mocked(resolveCoverFor).mockResolvedValue(undefined) // source is dead - no scrape
        vi.mocked(resolveMetadata).mockResolvedValue({
            coverUrl: "https://s4.anilist.co/cover.jpg",
            status: "ongoing"
        } as never)
        const fakeBlob = new Blob(["cover-bytes"], { type: "image/jpeg" })
        vi.mocked(fetchCoverBlob).mockResolvedValue(fakeBlob)

        const handler = libraryHandlers["library:covers:backfill"]!
        const result = (await handler({ type: "library:covers:backfill" } as never, ctx)) as { updated: number }

        expect(resolveMetadata).toHaveBeenCalled()
        expect(fetchCoverBlob).toHaveBeenCalledWith("https://s4.anilist.co/cover.jpg")
        expect(result.updated).toBe(1)
        const stored = await db.manga.get("aquamanga:manga:dead")
        expect(stored?.coverUrl).toBe("https://s4.anilist.co/cover.jpg")
    })

    it("falls back to the metadata catalog cover even when the source scrape throws", async () => {
        const { libraryHandlers } = await import("./library")

        const throwingSource: LibraryManga = {
            ...manga,
            id: "aquamanga:manga:throws",
            sourceId: "aquamanga",
            sourceUrl: "https://aquamanga.com/manga/throws",
            coverUrl: undefined
        }
        await db.manga.put(throwingSource)

        vi.mocked(resolveCoverFor).mockRejectedValue(new Error("adapter blew up"))
        vi.mocked(resolveMetadata).mockResolvedValue({
            coverUrl: "https://s4.anilist.co/recovered.jpg",
            status: "ongoing"
        } as never)
        vi.mocked(fetchCoverBlob).mockResolvedValue(new Blob(["cover-bytes"], { type: "image/jpeg" }))

        const handler = libraryHandlers["library:covers:backfill"]!
        const result = (await handler({ type: "library:covers:backfill" } as never, ctx)) as { updated: number }

        expect(resolveMetadata).toHaveBeenCalled()
        expect(fetchCoverBlob).toHaveBeenCalledWith("https://s4.anilist.co/recovered.jpg")
        expect(result.updated).toBe(1)
        const stored = await db.manga.get("aquamanga:manga:throws")
        expect(stored?.coverUrl).toBe("https://s4.anilist.co/recovered.jpg")
    })

    it("processes titles from two different sources in the same batch concurrently", async () => {
        const { libraryHandlers } = await import("./library")

        const mangadexManga: LibraryManga = {
            ...manga,
            id: "mangadex:manga:cross-a",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/cross-a",
            coverUrl: undefined
        }
        const webtoonsManga: LibraryManga = {
            ...manga,
            id: "webtoons:manga:cross-b",
            sourceId: "webtoons",
            sourceUrl: "https://www.webtoons.com/en/x/y/ep-1/viewer?title_no=1&episode_no=1",
            coverUrl: undefined
        }
        await db.manga.bulkPut([mangadexManga, webtoonsManga])

        vi.mocked(resolveCoverFor).mockImplementation(async m => `https://cdn.example/${m.sourceId}.jpg`)
        vi.mocked(fetchCoverBlob).mockResolvedValue(new Blob(["x"], { type: "image/jpeg" }))

        const handler = libraryHandlers["library:covers:backfill"]!
        const result = (await handler({ type: "library:covers:backfill" } as never, ctx)) as {
            updated: number
            remaining: number
            total: number
        }

        // Both single-source-title groups get processed even though they're on
        // different sources - cross-source concurrency doesn't skip either one.
        expect(result.updated).toBe(2)
        expect(await db.covers.get(mangadexManga.id)).toBeDefined()
        expect(await db.covers.get(webtoonsManga.id)).toBeDefined()
        const storedMangadex = await db.manga.get(mangadexManga.id)
        const storedWebtoons = await db.manga.get(webtoonsManga.id)
        expect(storedMangadex?.coverUrl).toBe("https://cdn.example/mangadex.jpg")
        expect(storedWebtoons?.coverUrl).toBe("https://cdn.example/webtoons.jpg")
    })
})

describe("library:covers:backfill targeted (mangaId)", () => {
    it("processes only the requested manga even when other backfill-eligible titles exist", async () => {
        const { libraryHandlers } = await import("./library")

        const target: LibraryManga = {
            ...manga,
            id: "mangadex:manga:target",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/target",
            coverUrl: undefined
        }
        const other: LibraryManga = {
            ...manga,
            id: "mangadex:manga:other",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/other",
            coverUrl: undefined
        }
        await db.manga.bulkPut([target, other])

        vi.mocked(resolveCoverFor).mockResolvedValue("https://cdn.example/cover.jpg")
        vi.mocked(fetchCoverBlob).mockResolvedValue(new Blob(["x"], { type: "image/jpeg" }))

        const handler = libraryHandlers["library:covers:backfill"]!
        const result = (await handler({ type: "library:covers:backfill", mangaId: target.id } as never, ctx)) as {
            updated: number
            remaining: number
            total: number
        }

        expect(result.total).toBe(1)
        expect(resolveCoverFor).toHaveBeenCalledTimes(1)
        expect(resolveCoverFor).toHaveBeenCalledWith(expect.objectContaining({ id: target.id }))
        expect(await db.covers.get(target.id)).toBeDefined()
        expect(await db.covers.get(other.id)).toBeUndefined()
    })

    it("does not clear coverBackfillAttempted for other ids even though it reports remaining: 0", async () => {
        const { libraryHandlers } = await import("./library")

        const attemptedFirst: LibraryManga = {
            ...manga,
            id: "mangadex:manga:attempted",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/attempted",
            coverUrl: "https://cdn.example/attempted.jpg"
        }
        // Pad past the 20-item batch size so `remaining` stays > 0 after the full
        // pass below - otherwise the full pass itself would clear the dedup Set
        // and the "targeted call must not clear it" behavior wouldn't be exercised.
        const padding: LibraryManga[] = Array.from({ length: 25 }, (_, i) => ({
            ...manga,
            id: `mangadex:manga:pad-${i}`,
            sourceId: "mangadex",
            sourceUrl: `https://mangadex.org/chapter/pad-${i}`,
            coverUrl: `https://cdn.example/pad-${i}.jpg`
        }))
        const targetManga: LibraryManga = {
            ...manga,
            id: "mangadex:manga:targeted-other",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/targeted-other",
            coverUrl: undefined
        }
        await db.manga.bulkPut([attemptedFirst, ...padding, targetManga])

        vi.mocked(fetchCoverBlob).mockResolvedValue(undefined)
        vi.mocked(resolveCoverFor).mockResolvedValue("https://cdn.example/fresh.jpg")

        const handler = libraryHandlers["library:covers:backfill"]!
        // Full pass: 26 candidates (attemptedFirst + 25 padding), batch is 20, so
        // remaining stays > 0 and coverBackfillAttempted is NOT cleared by this pass.
        const firstPass = (await handler({ type: "library:covers:backfill" } as never, ctx)) as {
            remaining: number
        }
        expect(firstPass.remaining).toBeGreaterThan(0)

        vi.mocked(fetchCoverBlob).mockClear()

        // Targeted call for an unrelated manga reports remaining: 0 for itself, but
        // must not clear the session-wide attempted set from the full pass above.
        const targetedResult = (await handler(
            { type: "library:covers:backfill", mangaId: targetManga.id } as never,
            ctx
        )) as { remaining: number; total: number }
        expect(targetedResult.remaining).toBe(0)
        expect(targetedResult.total).toBe(1)

        vi.mocked(fetchCoverBlob).mockClear()

        // A second full pass must still exclude attemptedFirst - it was never
        // cleared by the targeted call in between.
        await handler({ type: "library:covers:backfill" } as never, ctx)
        expect(fetchCoverBlob).not.toHaveBeenCalledWith("https://cdn.example/attempted.jpg")
    })

    it("falls back to resolveCoverFor and updates coverUrl when the stored cover is dead", async () => {
        const { libraryHandlers } = await import("./library")

        const relinkedManga: LibraryManga = {
            ...manga,
            id: "webtoons:manga:relinked",
            sourceId: "webtoons",
            sourceMangaId: "123",
            sourceUrl: "https://www.webtoons.com/en/x/y/ep-1/viewer?title_no=123&episode_no=1",
            // Still carries the OLD dead source's coverUrl, as a title fresh off a
            // relink would - this is what the targeted backfill exists to fix.
            coverUrl: "https://dead-source.example/old-cover.jpg"
        }
        await db.manga.put(relinkedManga)

        vi.mocked(fetchCoverBlob).mockImplementation(async (url: string) =>
            url === "https://dead-source.example/old-cover.jpg"
                ? undefined
                : new Blob(["fresh"], { type: "image/jpeg" })
        )
        vi.mocked(resolveCoverFor).mockResolvedValue("https://live-source.example/fresh-cover.jpg")

        const handler = libraryHandlers["library:covers:backfill"]!
        const result = (await handler(
            { type: "library:covers:backfill", mangaId: relinkedManga.id } as never,
            ctx
        )) as { updated: number }

        expect(fetchCoverBlob).toHaveBeenCalledWith("https://dead-source.example/old-cover.jpg")
        expect(resolveCoverFor).toHaveBeenCalledWith(expect.objectContaining({ id: relinkedManga.id }))
        expect(fetchCoverBlob).toHaveBeenCalledWith("https://live-source.example/fresh-cover.jpg")
        expect(result.updated).toBe(1)

        const stored = await db.manga.get(relinkedManga.id)
        expect(stored?.coverUrl).toBe("https://live-source.example/fresh-cover.jpg")

        const cachedRow = await db.covers.get(relinkedManga.id)
        expect(cachedRow?.blob.type).toBe("image/jpeg")
    })
})

describe("library:dismiss", () => {
    it("rewrites sourceId to manual only when the current sourceId looks hostname-style", async () => {
        const { libraryHandlers } = await import("./library")
        const handler = libraryHandlers["library:dismiss"]!

        const broken: LibraryManga = {
            ...manga,
            id: "broken-1",
            sourceId: "some.broken.host",
            sourceUrl: "https://some.broken.host/x"
        }
        await db.manga.put(broken)
        await handler({ type: "library:dismiss", mangaId: broken.id } as never, ctx)
        const storedBroken = await db.manga.get(broken.id)
        expect(storedBroken?.sourceId).toBe("manual")
        expect(storedBroken?.manualTracking).toBe(true)

        const normal: LibraryManga = {
            ...manga,
            id: "normal-1",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/1"
        }
        await db.manga.put(normal)
        await handler({ type: "library:dismiss", mangaId: normal.id } as never, ctx)
        const storedNormal = await db.manga.get(normal.id)
        expect(storedNormal?.sourceId).toBe("mangadex")
        expect(storedNormal?.manualTracking).toBeUndefined()
    })
})

describe("library:numbers", () => {
    it("clears latestChapterNumber when null but leaves an omitted lastReadChapterNumber untouched", async () => {
        const { libraryHandlers } = await import("./library")
        const handler = libraryHandlers["library:numbers"]!

        const existing: LibraryManga = {
            ...manga,
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/1",
            latestChapterNumber: 10,
            lastReadChapterNumber: 5
        }
        await db.manga.put(existing)

        await handler(
            {
                type: "library:numbers",
                mangaId: manga.id,
                latestChapterNumber: null
                // lastReadChapterNumber intentionally omitted
            } as never,
            ctx
        )

        const stored = await db.manga.get(manga.id)
        expect(stored?.latestChapterNumber).toBeUndefined()
        expect(stored?.lastReadChapterNumber).toBe(5)
    })

    it("advancing lastRead (mark caught up) refreshes lastReadAt, clears a paused override, and bumps updatedAt", async () => {
        const { libraryHandlers } = await import("./library")
        const handler = libraryHandlers["library:numbers"]!

        const existing: LibraryManga = {
            ...manga,
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/1",
            latestChapterNumber: 12,
            lastReadChapterNumber: 3,
            lastReadAt: 1,
            updatedAt: 1,
            readingStatus: "paused"
        }
        await db.manga.put(existing)

        await handler(
            {
                type: "library:numbers",
                mangaId: manga.id,
                lastReadChapterNumber: 12,
                lastReadChapterId: "mangadex:chapter:12"
            } as never,
            ctx
        )

        const stored = await db.manga.get(manga.id)
        expect(stored?.lastReadChapterNumber).toBe(12)
        expect(stored?.readingStatus).toBeUndefined() // paused override cleared
        expect(stored?.lastReadAt).toBeGreaterThan(1) // clock refreshed so it won't re-auto-pause
        expect(stored?.updatedAt).toBeGreaterThan(1) // so it pushes to account sync
    })

    it("editing only latestChapterNumber does NOT touch lastReadAt or a paused override", async () => {
        const { libraryHandlers } = await import("./library")
        const handler = libraryHandlers["library:numbers"]!

        const existing: LibraryManga = {
            ...manga,
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/1",
            lastReadAt: 1,
            readingStatus: "paused"
        }
        await db.manga.put(existing)

        await handler({ type: "library:numbers", mangaId: manga.id, latestChapterNumber: 20 } as never, ctx)

        const stored = await db.manga.get(manga.id)
        expect(stored?.latestChapterNumber).toBe(20)
        expect(stored?.readingStatus).toBe("paused") // not a read, override stays
        expect(stored?.lastReadAt).toBe(1)
    })
})

describe("library:reading-prefs", () => {
    it("sets an explicit per-series noGapContinuous override", async () => {
        const { libraryHandlers } = await import("./library")
        const handler = libraryHandlers["library:reading-prefs"]!

        const existing: LibraryManga = {
            ...manga,
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/1"
        }
        await db.manga.put(existing)

        await handler({ type: "library:reading-prefs", mangaId: manga.id, noGapContinuous: true } as never, ctx)

        const stored = await db.manga.get(manga.id)
        expect(stored?.noGapContinuous).toBe(true)
    })

    it("clears noGapContinuous back to undefined when set to null, leaving readingDirection untouched", async () => {
        const { libraryHandlers } = await import("./library")
        const handler = libraryHandlers["library:reading-prefs"]!

        const existing: LibraryManga = {
            ...manga,
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/1",
            readingDirection: "rtl",
            noGapContinuous: true
        }
        await db.manga.put(existing)

        await handler(
            {
                type: "library:reading-prefs",
                mangaId: manga.id,
                noGapContinuous: null
                // readingDirection intentionally omitted
            } as never,
            ctx
        )

        const stored = await db.manga.get(manga.id)
        expect(stored?.noGapContinuous).toBeUndefined()
        expect(stored?.readingDirection).toBe("rtl")
    })
})

// Regression for the import/export audit's Bug 4: library:clear used to call
// clearLibrary() with no snapshot first, unlike data:import/sync:pull which both
// already snapshot via createBackup(...) - a fully destructive, unrecoverable wipe
// even though the backup machinery now exists for other destructive paths.
describe("library:clear", () => {
    it("takes a pre-clear backup before wiping the library, and the backups table itself survives the clear", async () => {
        const libraryManga: LibraryManga = {
            ...manga,
            sourceId: "mangadex",
            sourceUrl: sourceLink.url
        }
        await db.manga.put(libraryManga)
        await db.sourceLinks.put(sourceLink)

        const handler = libraryHandlers["library:clear"]!
        await handler({ type: "library:clear" } as never, ctx)

        expect(await db.manga.count()).toBe(0)
        expect(await db.sourceLinks.count()).toBe(0)

        const backups = await listBackups()
        expect(backups).toHaveLength(1)
        expect(backups[0]).toMatchObject({ reason: "pre-clear" })

        const stored = await db.backups.toArray()
        expect(stored[0]?.envelope.data.manga).toHaveLength(1)
        expect(stored[0]?.envelope.data.manga[0]?.id).toBe(manga.id)
    })
})

// library:merge subsumes the old App.svelte migrateLoserData + 5-message field-merge
// sequence into a single mergeMangaRecords transaction (see src/database.ts) - these
// tests exercise the row re-pointing, cleanup, and field-merge rules directly against
// the handler.
describe("library:merge", () => {
    const primaryId = manga.id
    const loserId = "othermirror:manga:def"
    const loserId2 = "thirdmirror:manga:ghi"

    function libMangaFor(id: string, overrides: Partial<LibraryManga> = {}): LibraryManga {
        return {
            ...manga,
            id,
            sourceId: "mangadex",
            sourceUrl: `https://mangadex.org/title/${id}`,
            ...overrides
        }
    }

    it("re-points progress, historyEvents, downloads, and pageBookmarks from loser to primary mangaId", async () => {
        await db.manga.put(libMangaFor(primaryId))
        await db.manga.put(libMangaFor(loserId))

        await db.progress.put({
            mangaId: loserId,
            chapterId: "loser-ch-1",
            pageIndex: 0,
            pageCount: 5,
            completed: true,
            updatedAt: 1
        })
        await db.historyEvents.add({ mangaId: loserId, chapterId: "loser-ch-1", type: "completed", occurredAt: 1 })
        await db.downloads.put({
            chapterId: "loser-ch-1",
            mangaId: loserId,
            pageBlobs: [],
            pageCount: 5,
            downloadedAt: 1
        })
        await db.pageBookmarks.put({
            id: "loser-ch-1:0",
            mangaId: loserId,
            chapterId: "loser-ch-1",
            pageIndex: 0,
            mangaTitle: "Test",
            chapterTitle: "Ch1",
            chapterUrl: "https://mangadex.org/chapter/loser-1",
            addedAt: 1
        })

        const handler = libraryHandlers["library:merge"]!
        await handler({ type: "library:merge", primaryId, loserIds: [loserId] } as never, ctx)

        expect((await db.progress.get("loser-ch-1"))?.mangaId).toBe(primaryId)
        const events = await db.historyEvents.where("mangaId").equals(primaryId).toArray()
        expect(events).toHaveLength(1)
        expect((await db.downloads.get("loser-ch-1"))?.mangaId).toBe(primaryId)
        expect((await db.pageBookmarks.get("loser-ch-1:0"))?.mangaId).toBe(primaryId)
    })

    it("deletes the loser's chapters, sourceLinks, and manga rows after merge, leaving the primary intact", async () => {
        await db.manga.put(libMangaFor(primaryId))
        await db.manga.put(libMangaFor(loserId))
        await db.sourceLinks.put({ ...sourceLink, mangaId: primaryId })
        await db.sourceLinks.put({ ...sourceLink, mangaId: loserId, sourceId: "othermirror" })
        await db.chapters.put({
            id: "loser-ch-1",
            mangaId: loserId,
            sourceId: "othermirror",
            title: "Ch1",
            url: "https://othermirror.example/chapter/1",
            sortKey: 1
        })

        const handler = libraryHandlers["library:merge"]!
        await handler({ type: "library:merge", primaryId, loserIds: [loserId] } as never, ctx)

        expect(await db.manga.get(loserId)).toBeUndefined()
        expect(await db.sourceLinks.get(loserId)).toBeUndefined()
        expect(await db.chapters.where("mangaId").equals(loserId).count()).toBe(0)
        expect(await db.manga.get(primaryId)).toBeDefined()
        expect(await db.sourceLinks.get(primaryId)).toBeDefined()
    })

    it("concatenates notes with a blank line when both primary and loser have notes", async () => {
        await db.manga.put(libMangaFor(primaryId, { notes: "Primary note" }))
        await db.manga.put(libMangaFor(loserId, { notes: "Loser note" }))

        const handler = libraryHandlers["library:merge"]!
        const result = (await handler(
            { type: "library:merge", primaryId, loserIds: [loserId] } as never,
            ctx
        )) as LibraryManga

        expect(result.notes).toBe("Primary note\n\nLoser note")
    })

    it("carries over the loser's notes when the primary has none", async () => {
        await db.manga.put(libMangaFor(primaryId))
        await db.manga.put(libMangaFor(loserId, { notes: "Loser note" }))

        const handler = libraryHandlers["library:merge"]!
        const result = (await handler(
            { type: "library:merge", primaryId, loserIds: [loserId] } as never,
            ctx
        )) as LibraryManga

        expect(result.notes).toBe("Loser note")
    })

    it("keeps the primary's rating when the loser has none, and unions categories from both", async () => {
        await db.manga.put(libMangaFor(primaryId, { rating: 5, categories: ["fav"] }))
        await db.manga.put(libMangaFor(loserId, { categories: ["action", "fav"] }))

        const handler = libraryHandlers["library:merge"]!
        const result = (await handler(
            { type: "library:merge", primaryId, loserIds: [loserId] } as never,
            ctx
        )) as LibraryManga

        expect(result.rating).toBe(5)
        expect([...(result.categories ?? [])].sort()).toEqual(["action", "fav"])
    })

    it("takes the loser's rating when the primary has none", async () => {
        await db.manga.put(libMangaFor(primaryId))
        await db.manga.put(libMangaFor(loserId, { rating: 4 }))

        const handler = libraryHandlers["library:merge"]!
        const result = (await handler(
            { type: "library:merge", primaryId, loserIds: [loserId] } as never,
            ctx
        )) as LibraryManga

        expect(result.rating).toBe(4)
    })

    // Regression: the old App.svelte migrateLoserData had a documented gap where
    // historyEvents were silently dropped on merge (no message type could write one
    // for an arbitrary mangaId/occurredAt). This would have failed under that behavior.
    it("historyEvents survive the merge under the primary's mangaId", async () => {
        await db.manga.put(libMangaFor(primaryId))
        await db.manga.put(libMangaFor(loserId))
        await db.historyEvents.add({ mangaId: loserId, chapterId: "loser-ch-1", type: "started", occurredAt: 10 })
        await db.historyEvents.add({ mangaId: loserId, chapterId: "loser-ch-1", type: "completed", occurredAt: 20 })

        const handler = libraryHandlers["library:merge"]!
        await handler({ type: "library:merge", primaryId, loserIds: [loserId] } as never, ctx)

        const events = await db.historyEvents.where("mangaId").equals(primaryId).toArray()
        expect(events).toHaveLength(2)
        expect(events.map(e => e.type).sort()).toEqual(["completed", "started"])
    })

    it("skips a stale/nonexistent loserId without throwing, and still merges the other valid losers in the same call", async () => {
        await db.manga.put(libMangaFor(primaryId))
        await db.manga.put(libMangaFor(loserId2, { rating: 3 }))

        const handler = libraryHandlers["library:merge"]!
        const result = (await handler(
            { type: "library:merge", primaryId, loserIds: ["nonexistent:manga:zzz", loserId2] } as never,
            ctx
        )) as LibraryManga

        expect(result.rating).toBe(3)
        expect(await db.manga.get(loserId2)).toBeUndefined()
    })

    it("throws a clear error when the primary manga does not exist", async () => {
        const handler = libraryHandlers["library:merge"]!
        await expect(
            handler({ type: "library:merge", primaryId: "nonexistent:manga:xxx", loserIds: [loserId] } as never, ctx)
        ).rejects.toThrow()
    })
})

// isFallbackCreated backs both library:cleanup:scan's candidate selection and
// library:cleanup:apply's step-1 re-validation. This test file doesn't mock
// @amr/sources, so "mangafreak" here is the REAL registered adapter (deterministic,
// no network needed for a plain sourceRegistry.get() lookup).
describe("isFallbackCreated", () => {
    it("is true for a genuine fallback-created record", () => {
        const m: LibraryManga = {
            ...manga,
            id: "mangafreak:manga:read1-foo-1",
            sourceId: "mangafreak",
            sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_1"
        }
        expect(isFallbackCreated(m)).toBe(true)
    })

    it("is false for an adapter-resolved record (has sourceMangaId)", () => {
        const m: LibraryManga = {
            ...manga,
            sourceId: "mangafreak",
            sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_1",
            sourceMangaId: "Foo"
        }
        expect(isFallbackCreated(m)).toBe(false)
    })

    it("is false for a legacy-hostname record whose sourceId isn't a registered adapter", () => {
        const m: LibraryManga = {
            ...manga,
            id: "example.com:manga:legacy",
            sourceId: "example.com",
            sourceUrl: "https://example.com/manga/foo/"
        }
        expect(isFallbackCreated(m)).toBe(false)
    })

    it("is false for a manually-tracked record", () => {
        const m: LibraryManga = {
            ...manga,
            sourceId: "mangafreak",
            sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_1",
            manualTracking: true
        }
        expect(isFallbackCreated(m)).toBe(false)
    })

    it("is false for a bundled seed- record", () => {
        const m: LibraryManga = {
            ...manga,
            id: "seed-mf-001",
            sourceId: "mangafreak",
            sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_1"
        }
        expect(isFallbackCreated(m)).toBe(false)
    })
})

describe("library:cleanup:scan", () => {
    it("groups two same-source fallback records when one's stored URL pathname appears in the representative's canonical chapter list", async () => {
        await db.manga.bulkPut([
            {
                ...manga,
                id: "mangafreak:manga:read1-foo-1",
                title: "Read1 Foo 1",
                sourceId: "mangafreak",
                sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_1"
            },
            {
                ...manga,
                id: "mangafreak:manga:read1-foo-2",
                title: "Read1 Foo 2",
                sourceId: "mangafreak",
                sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_2"
            }
        ])
        vi.mocked(listChaptersBySource).mockResolvedValue([
            {
                id: "mangafreak:chapter:Foo:1",
                mangaId: "mangafreak:manga:Foo",
                sourceId: "mangafreak",
                title: "Ch.1",
                url: "https://ww2.mangafreak.me/Read1_Foo_1",
                sortKey: 1
            },
            {
                id: "mangafreak:chapter:Foo:2",
                mangaId: "mangafreak:manga:Foo",
                sourceId: "mangafreak",
                title: "Ch.2",
                url: "https://ww2.mangafreak.me/Read1_Foo_2",
                sortKey: 2
            }
        ] as never)
        vi.mocked(resolveCoverFor).mockResolvedValue(undefined)

        const handler = libraryHandlers["library:cleanup:scan"]!
        const result = (await handler({ type: "library:cleanup:scan" } as never, ctx)) as {
            groups: Array<{ canonicalId: string; records: Array<{ mangaId: string; matchedBy: string }> }>
            unresolved: unknown[]
        }

        expect(result.groups).toHaveLength(1)
        expect(result.groups[0]?.canonicalId).toBe("mangafreak:manga:Foo")
        expect(result.groups[0]?.records).toHaveLength(2)
        expect(result.groups[0]?.records.map(r => r.matchedBy).sort()).toEqual(["adapter", "pathname"])
        expect(result.unresolved).toHaveLength(0)
    })

    it("never groups two fallback records that are on different sourceIds, even under the same scan", async () => {
        await db.manga.bulkPut([
            {
                ...manga,
                id: "mangafreak:manga:read1-foo-1",
                title: "Read1 Foo 1",
                sourceId: "mangafreak",
                sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_1"
            },
            {
                ...manga,
                id: "webtoons:manga:legacy",
                title: "Legacy Webtoon",
                sourceId: "webtoons",
                sourceUrl: "https://www.webtoons.com/en/action/hero/ep-1/viewer?title_no=42&episode_no=1"
            }
        ])
        vi.mocked(listChaptersBySource).mockResolvedValue([] as never)
        vi.mocked(resolveCoverFor).mockResolvedValue(undefined)

        const handler = libraryHandlers["library:cleanup:scan"]!
        const result = (await handler({ type: "library:cleanup:scan" } as never, ctx)) as {
            groups: Array<{ canonicalId: string; sourceId: string; records: unknown[] }>
        }

        expect(result.groups).toHaveLength(2)
        expect(result.groups.every(g => g.records.length === 1)).toBe(true)
        expect(new Set(result.groups.map(g => g.sourceId))).toEqual(new Set(["mangafreak", "webtoons"]))
    })

    it("lists a candidate with an unregistered source as unresolved instead of dropping it", async () => {
        await db.manga.put({
            ...manga,
            id: "retired-source:manga:foo",
            sourceId: "retired-source",
            sourceUrl: "https://retired-source.example/chapter/1"
        })

        const handler = libraryHandlers["library:cleanup:scan"]!
        const result = (await handler({ type: "library:cleanup:scan" } as never, ctx)) as {
            groups: unknown[]
            unresolved: Array<{ mangaId: string; reason: string }>
        }

        expect(result.groups).toHaveLength(0)
        expect(result.unresolved).toHaveLength(1)
        expect(result.unresolved[0]?.reason).toMatch(/not currently registered/i)
    })
})

describe("library:cleanup:apply", () => {
    const canonicalChapters = [
        {
            id: "mangafreak:chapter:Foo:1",
            mangaId: "mangafreak:manga:Foo",
            sourceId: "mangafreak",
            title: "Ch.1",
            url: "https://ww2.mangafreak.me/Read1_Foo_1",
            sortKey: 1
        },
        {
            id: "mangafreak:chapter:Foo:2",
            mangaId: "mangafreak:manga:Foo",
            sourceId: "mangafreak",
            title: "Ch.2",
            url: "https://ww2.mangafreak.me/Read1_Foo_2",
            sortKey: 2
        }
    ]

    beforeEach(() => {
        vi.mocked(listChaptersBySource).mockResolvedValue(canonicalChapters as never)
        vi.mocked(resolveCoverFor).mockResolvedValue(undefined)
        vi.mocked(fetchCoverBlob).mockResolvedValue(undefined)
    })

    // Regression for the bug two separate reviews of the original plan caught: a
    // naive per-loser (not per-chapter) remap corrupts history for any loser that
    // tracked more than one external chapter - trackExternalChapter can attach a
    // second read to an already-fallback-created record via its slug/prefix matchers.
    it("remaps a loser with two tracked external chapters onto two different canonical chapters with no cross-contamination", async () => {
        const loserId = "mangafreak:manga:read1-foo-x"
        await db.manga.put({
            ...manga,
            id: loserId,
            title: "Read1 Foo 2",
            sourceId: "mangafreak",
            sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_2"
        })
        await db.chapters.bulkPut([
            {
                id: `${loserId}:ext:ch-1`,
                mangaId: loserId,
                sourceId: "mangafreak",
                title: "Chapter 1",
                url: "https://ww2.mangafreak.me/Read1_Foo_1",
                sortKey: 1
            },
            {
                id: `${loserId}:ext:ch-2`,
                mangaId: loserId,
                sourceId: "mangafreak",
                title: "Chapter 2",
                url: "https://ww2.mangafreak.me/Read1_Foo_2",
                sortKey: 2
            }
        ])
        await db.progress.bulkPut([
            {
                mangaId: loserId,
                chapterId: `${loserId}:ext:ch-1`,
                pageIndex: 0,
                pageCount: 1,
                completed: true,
                updatedAt: 10
            },
            {
                mangaId: loserId,
                chapterId: `${loserId}:ext:ch-2`,
                pageIndex: 0,
                pageCount: 1,
                completed: false,
                updatedAt: 20
            }
        ])

        const handler = libraryHandlers["library:cleanup:apply"]!
        const result = (await handler(
            {
                type: "library:cleanup:apply",
                groups: [
                    {
                        canonicalId: "mangafreak:manga:Foo",
                        sourceId: "mangafreak",
                        sourceMangaId: "Foo",
                        mangaUrl: "https://ww2.mangafreak.me/Manga/Foo",
                        representativeChapterUrl: "https://ww2.mangafreak.me/Read1_Foo_2",
                        losers: [{ mangaId: loserId, matchedBy: "adapter" }]
                    }
                ]
            } as never,
            ctx
        )) as { merged: number; groups: number; backupId: number }

        expect(result.merged).toBe(1)
        expect(result.groups).toBe(1)
        expect(await db.manga.get(loserId)).toBeUndefined()

        const p1 = await db.progress.get("mangafreak:chapter:Foo:1")
        const p2 = await db.progress.get("mangafreak:chapter:Foo:2")
        expect(p1).toMatchObject({ completed: true, updatedAt: 10 })
        expect(p2).toMatchObject({ completed: false, updatedAt: 20 })
    })

    // Regression: a naive "only fix lastReadChapterId if the chapter number
    // increased" post-merge check misses exactly this case - the number didn't
    // change, only the id went dangling.
    it("fixes a dangling lastReadChapterId produced by the merge itself, unconditionally", async () => {
        const loserId = "mangafreak:manga:read1-foo-2"
        await db.manga.put({
            ...manga,
            id: loserId,
            title: "Read1 Foo 2",
            sourceId: "mangafreak",
            sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_2",
            lastReadChapterNumber: 2,
            lastReadChapterId: `${loserId}:ext:ch-2`
        })
        await db.chapters.put({
            id: `${loserId}:ext:ch-2`,
            mangaId: loserId,
            sourceId: "mangafreak",
            title: "Chapter 2",
            url: "https://ww2.mangafreak.me/Read1_Foo_2",
            sortKey: 2
        })

        const handler = libraryHandlers["library:cleanup:apply"]!
        await handler(
            {
                type: "library:cleanup:apply",
                groups: [
                    {
                        canonicalId: "mangafreak:manga:Foo",
                        sourceId: "mangafreak",
                        sourceMangaId: "Foo",
                        mangaUrl: "https://ww2.mangafreak.me/Manga/Foo",
                        representativeChapterUrl: "https://ww2.mangafreak.me/Read1_Foo_2",
                        losers: [{ mangaId: loserId, matchedBy: "adapter" }]
                    }
                ]
            } as never,
            ctx
        )

        const stored = await db.manga.get("mangafreak:manga:Foo")
        expect(stored?.lastReadChapterId).toBe("mangafreak:chapter:Foo:2")
        expect(await db.chapters.get(stored!.lastReadChapterId!)).toBeDefined()
    })

    it("silently skips a stale loser (already fixed / no longer a fallback record) without failing the group", async () => {
        const validLoser = "mangafreak:manga:read1-foo-1"
        const staleLoser = "mangafreak:manga:read1-foo-2"
        await db.manga.bulkPut([
            {
                ...manga,
                id: validLoser,
                sourceId: "mangafreak",
                sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_1"
            },
            {
                ...manga,
                id: staleLoser,
                sourceId: "mangafreak",
                sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_2",
                // Someone already fixed this one - it no longer qualifies as fallback-created.
                sourceMangaId: "Foo"
            }
        ])

        const handler = libraryHandlers["library:cleanup:apply"]!
        const result = (await handler(
            {
                type: "library:cleanup:apply",
                groups: [
                    {
                        canonicalId: "mangafreak:manga:Foo",
                        sourceId: "mangafreak",
                        sourceMangaId: "Foo",
                        mangaUrl: "https://ww2.mangafreak.me/Manga/Foo",
                        representativeChapterUrl: "https://ww2.mangafreak.me/Read1_Foo_1",
                        losers: [
                            { mangaId: validLoser, matchedBy: "adapter" },
                            { mangaId: staleLoser, matchedBy: "adapter" }
                        ]
                    }
                ]
            } as never,
            ctx
        )) as { merged: number; skippedStale: number }

        expect(result.skippedStale).toBe(1)
        expect(result.merged).toBe(1)
        expect(await db.manga.get(validLoser)).toBeUndefined()
        // The stale record was left completely untouched, not deleted.
        expect(await db.manga.get(staleLoser)).toBeDefined()
    })

    it("skips a pathname-tagged loser whose URL no longer appears in the freshly-fetched chapter list", async () => {
        const loserId = "mangafreak:manga:read1-foo-drifted"
        await db.manga.put({
            ...manga,
            id: loserId,
            sourceId: "mangafreak",
            // Not present in this test's canonicalChapters (only Foo:1/Foo:2 exist).
            sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_99"
        })

        const handler = libraryHandlers["library:cleanup:apply"]!
        const result = (await handler(
            {
                type: "library:cleanup:apply",
                groups: [
                    {
                        canonicalId: "mangafreak:manga:Foo",
                        sourceId: "mangafreak",
                        sourceMangaId: "Foo",
                        mangaUrl: "https://ww2.mangafreak.me/Manga/Foo",
                        representativeChapterUrl: "https://ww2.mangafreak.me/Read1_Foo_1",
                        losers: [{ mangaId: loserId, matchedBy: "pathname" }]
                    }
                ]
            } as never,
            ctx
        )) as { merged: number; skippedUnverified: number }

        expect(result.skippedUnverified).toBe(1)
        expect(result.merged).toBe(0)
        expect(await db.manga.get(loserId)).toBeDefined()
    })

    it("merges 50 losers into one canonical title", async () => {
        const loserIds = Array.from({ length: 50 }, (_, i) => `mangafreak:manga:read1-foo-${i}`)
        await db.manga.bulkPut(
            loserIds.map(id => ({
                ...manga,
                id,
                sourceId: "mangafreak",
                sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_1"
            }))
        )

        const handler = libraryHandlers["library:cleanup:apply"]!
        const result = (await handler(
            {
                type: "library:cleanup:apply",
                groups: [
                    {
                        canonicalId: "mangafreak:manga:Foo",
                        sourceId: "mangafreak",
                        sourceMangaId: "Foo",
                        mangaUrl: "https://ww2.mangafreak.me/Manga/Foo",
                        representativeChapterUrl: "https://ww2.mangafreak.me/Read1_Foo_1",
                        losers: loserIds.map(mangaId => ({ mangaId, matchedBy: "adapter" as const }))
                    }
                ]
            } as never,
            ctx
        )) as { merged: number; groups: number }

        expect(result.merged).toBe(50)
        expect(result.groups).toBe(1)
        expect(await db.manga.get("mangafreak:manga:Foo")).toBeDefined()
    })

    // Fix 5: saveResolvedChapter's unconditional put used to resurrect the canonical
    // record if a concurrent library:remove landed during the group's network
    // resolution phase (representativeChapter re-resolution, cover fetch, etc). The
    // existence check now happens fresh INSIDE the write transaction, not just before
    // it, so a deletion that races the network phase actually sticks. Simulated here
    // by deleting the canonical manga from inside the mocked listChaptersBySource
    // call - after the handler's existedAtStart snapshot but before the write
    // transaction runs.
    it("skips (does not resurrect) a canonical manga deleted by a concurrent operation during the group's network phase", async () => {
        const canonicalId = "mangafreak:manga:Foo"
        await db.manga.put({
            ...manga,
            id: canonicalId,
            sourceId: "mangafreak",
            sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_2"
        })

        vi.mocked(listChaptersBySource).mockImplementationOnce(async () => {
            await db.manga.delete(canonicalId)
            return canonicalChapters as never
        })

        const handler = libraryHandlers["library:cleanup:apply"]!
        const result = (await handler(
            {
                type: "library:cleanup:apply",
                groups: [
                    {
                        canonicalId,
                        sourceId: "mangafreak",
                        sourceMangaId: "Foo",
                        mangaUrl: "https://ww2.mangafreak.me/Manga/Foo",
                        representativeChapterUrl: "https://ww2.mangafreak.me/Read1_Foo_2",
                        losers: []
                    }
                ]
            } as never,
            ctx
        )) as { merged: number; groups: number; skippedStale: number }

        expect(result.skippedStale).toBe(1)
        expect(result.groups).toBe(0)
        expect(result.merged).toBe(0)
        expect(await db.manga.get(canonicalId)).toBeUndefined()
    })
})

describe("library:merge", () => {
    it("snapshots a restorable pre-merge backup before deleting the loser (guards a wrong same-title merge)", async () => {
        const a: LibraryManga = {
            ...manga,
            id: "mangadex:manga:a",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/title/a",
            lastReadChapterNumber: 700
        }
        const b: LibraryManga = {
            ...manga,
            id: "webtoons:manga:b",
            title: "Test Manga",
            sourceId: "webtoons",
            sourceUrl: "https://www.webtoons.com/title/b",
            lastReadChapterNumber: 50
        }
        await db.manga.bulkPut([a, b])

        const handler = libraryHandlers["library:merge"]!
        await handler({ type: "library:merge", primaryId: a.id, loserIds: [b.id] }, ctx)

        const backups = await listBackups()
        expect(backups.some(bk => bk.reason === "pre-merge")).toBe(true)
        // The merge still happened (loser gone).
        expect(await db.manga.get(b.id)).toBeUndefined()
    })
})

describe("library:quick-add (Discover -> library)", () => {
    const req = (over: Record<string, unknown>) => ({
        type: "library:quick-add" as const,
        anilistId: 101517,
        title: "Jujutsu Kaisen",
        genres: ["Action"],
        mode: "read" as const,
        ...over
    })

    it("adds a completed, manual, no-source entry for mode=read that reads as caught-up", async () => {
        const res = (await libraryHandlers["library:quick-add"]!(req({}), ctx)) as { added: boolean }
        expect(res.added).toBe(true)
        const m = (await db.manga.get("anilist:manga:101517")) as LibraryManga
        expect(m.manualTracking).toBe(true)
        expect(m.sourceId).toBe("anilist.co")
        expect(m.anilistId).toBe(101517)
        expect(m.status).toBe("completed")
        // 1/1 so reading-status derives "completed" without a real chapter total.
        expect(m.latestChapterNumber).toBe(1)
        expect(m.lastReadChapterNumber).toBe(1)
        expect(m.genres).toEqual(["Action"])
    })

    it("adds a plan-to-read entry for mode=planning", async () => {
        await libraryHandlers["library:quick-add"]!(
            req({ anilistId: 200, title: "Planned One", mode: "planning" }),
            ctx
        )
        const m = (await db.manga.get("anilist:manga:200")) as LibraryManga
        expect(m.readingStatus).toBe("planning")
        expect(m.manualTracking).toBe(true)
        expect(m.lastReadChapterNumber).toBeUndefined()
    })

    it("dedups by anilist id (a second add is a no-op)", async () => {
        const first = (await libraryHandlers["library:quick-add"]!(req({ anilistId: 300 }), ctx)) as { added: boolean }
        const second = (await libraryHandlers["library:quick-add"]!(req({ anilistId: 300 }), ctx)) as { added: boolean }
        expect(first.added).toBe(true)
        expect(second.added).toBe(false)
    })
})

describe("library:relink preserves per-title fields", () => {
    it("keeps pageWidthPct, AniList linkage, reading status and workId across a relink", async () => {
        const oldId = "mangadex:manga:relink-old"
        const newId = "webtoons:manga:relink-new"
        await db.manga.put({
            ...manga,
            id: oldId,
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/old",
            mangaUrl: "https://mangadex.org/title/old",
            sourceMangaId: "old",
            pageFit: "height",
            noGapContinuous: true,
            pageWidthPct: 50,
            anilistId: 194902,
            genres: ["Action"],
            metadataUpdatedAt: 1_700_000_000_000,
            readingStatus: "dropped",
            readingStatusUpdatedAt: 5000,
            workId: "work_1"
        } as LibraryManga)
        await db.sourceLinks.put({ ...sourceLink, mangaId: oldId })

        const chapterUrl = "https://www.webtoons.com/en/x/y/ep-1/viewer?title_no=99&episode_no=1"
        vi.mocked(resolveChapterUrl).mockResolvedValue({
            manga: {
                manga: {
                    id: newId,
                    title: "Relinked",
                    normalizedTitle: "relinked",
                    authors: [],
                    status: "ongoing",
                    addedAt: 999,
                    updatedAt: 999
                },
                sourceId: "webtoons",
                sourceMangaId: "99",
                url: "https://www.webtoons.com/en/x/y/"
            },
            chapter: {
                id: "webtoons:chapter:1",
                mangaId: newId,
                sourceId: "webtoons",
                title: "Episode 1",
                url: chapterUrl,
                sortKey: 1
            },
            pages: []
        } as never)

        await libraryHandlers["library:relink"]!(
            { type: "library:relink", mangaId: oldId, url: chapterUrl } as never,
            ctx
        )

        const stored = await db.manga.get(newId)
        expect(stored?.pageFit).toBe("height")
        expect(stored?.noGapContinuous).toBe(true)
        expect(stored?.pageWidthPct).toBe(50)
        expect(stored?.anilistId).toBe(194902)
        expect(stored?.genres).toEqual(["Action"])
        expect(stored?.metadataUpdatedAt).toBe(1_700_000_000_000)
        expect(stored?.readingStatus).toBe("dropped")
        expect(stored?.readingStatusUpdatedAt).toBe(5000)
        expect(stored?.workId).toBe("work_1")
    })
})

describe("chapter:adjacent ignores the unnumbered-chapter sentinel", () => {
    it("still re-checks the network and finds a new numbered next when an unnumbered extra is cached", async () => {
        const mangaId = "mangadex:manga:adj"
        await db.manga.put({
            ...manga,
            id: mangaId,
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/title/adj",
            mangaUrl: "https://mangadex.org/title/adj",
            sourceMangaId: "adj",
            lastReadChapterNumber: 100
        } as LibraryManga)
        await db.chapters.bulkPut([
            { id: "c99", mangaId, sourceId: "mangadex", title: "99", url: "u99", sortKey: 99 },
            { id: "c100", mangaId, sourceId: "mangadex", title: "100", url: "u100", sortKey: 100 },
            { id: "cx", mangaId, sourceId: "mangadex", title: "Extra", url: "ux", sortKey: Number.POSITIVE_INFINITY }
        ] as ChapterRecord[])

        vi.mocked(listChaptersForSource).mockResolvedValue([
            { id: "c99", mangaId, sourceId: "mangadex", title: "99", url: "u99", sortKey: 99 },
            { id: "c100", mangaId, sourceId: "mangadex", title: "100", url: "u100", sortKey: 100 },
            { id: "c101", mangaId, sourceId: "mangadex", title: "101", url: "u101", sortKey: 101 }
        ] as never)

        const res = (await libraryHandlers["chapter:adjacent"]!(
            { type: "chapter:adjacent", mangaId } as never,
            ctx
        )) as { next: { number: number } | null }

        // The Infinity extra must not inflate maxSortKey (which would skip the recheck) or be picked
        // as next; caught up to the numbered max, the stale-cache recheck should surface ch101.
        expect(vi.mocked(listChaptersForSource)).toHaveBeenCalled()
        expect(res.next?.number).toBe(101)
    })
})
