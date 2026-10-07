import "fake-indexeddb/auto"
import type { ChapterRecord, MangaRecord, ReadingProgress, SourceLinkRecord } from "@amr/contracts"
import { normalizeTitle } from "@amr/normalize"
import type { SourceChapter } from "@amr/source-sdk"
import Dexie from "dexie"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
    addImportedManga,
    applyCleanupGroup,
    cacheCover,
    clampPoisonedMangahubLocally,
    createBackup,
    db,
    exportDatabase,
    fixupDanglingChapterIds,
    getActivityCalendar,
    getAnalyticsSummary,
    getCachedCovers,
    getLocalStats,
    importDatabase,
    libraryChangeSignature,
    listArchProfiles,
    listBackups,
    putArchProfile,
    mergeMangaRecords,
    putChapters,
    recordAnalyticsEvent,
    rekeyManga,
    remapExternalChapterProgress,
    removeManga,
    restoreBackup,
    saveLinkedChapters,
    saveProgress,
    saveReaderResolvedChapter,
    saveResolvedChapter,
    seedDatabase,
    switchMangaSource,
    toggleBookmark,
    trackExternalChapter
} from "./database"
import type { LibraryManga, PageBookmark } from "./database"
import { exportEnvelopeSchema } from "./schema"

const manga: MangaRecord = {
    id: "mangadex:manga:abc",
    title: "Test Manga",
    normalizedTitle: "test manga",
    authors: [],
    status: "ongoing",
    addedAt: 1,
    updatedAt: 1
}

const chapter: ChapterRecord = {
    id: "mangadex:chapter:1",
    mangaId: manga.id,
    sourceId: "mangadex",
    title: "Chapter 5",
    url: "https://mangadex.org/chapter/1",
    sortKey: 5
}

const sourceLink: SourceLinkRecord = {
    mangaId: manga.id,
    sourceId: "mangadex",
    url: "https://mangadex.org/title/abc",
    addedAt: 1,
    updatedAt: 1
}

beforeEach(async () => {
    await Promise.all([
        db.manga.clear(),
        db.sourceLinks.clear(),
        db.chapters.clear(),
        db.progress.clear(),
        db.historyEvents.clear(),
        db.downloads.clear(),
        db.covers.clear(),
        db.pageBookmarks.clear(),
        db.backups.clear()
    ])
})

describe("saveResolvedChapter", () => {
    it("persists manga, chapter, link, and the latest chapter number", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })
        const stored = await db.manga.get(manga.id)
        expect(stored?.latestChapterId).toBe(chapter.id)
        expect(stored?.latestChapterNumber).toBe(5)
        expect(await db.chapters.get(chapter.id)).toBeDefined()
        expect(await db.sourceLinks.get(manga.id)).toBeDefined()
    })

    it("preserves enrichment and sort fields across a re-capture", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })
        await db.manga.update(manga.id, {
            anilistId: 12345,
            genres: ["Action", "Drama"],
            metadataUpdatedAt: 1_700_000_000_000,
            latestChapterAt: 1_700_000_500_000,
            chapterNumberingUnreliable: true
        })

        // A routine re-read hands saveResolvedChapter a plain source MangaRecord that
        // carries none of these fields - they must survive rather than be dropped.
        await saveResolvedChapter({ manga, chapter, sourceLink })

        const stored = await db.manga.get(manga.id)
        expect(stored?.anilistId).toBe(12345)
        expect(stored?.genres).toEqual(["Action", "Drama"])
        expect(stored?.metadataUpdatedAt).toBe(1_700_000_000_000)
        expect(stored?.latestChapterAt).toBe(1_700_000_500_000)
        expect(stored?.chapterNumberingUnreliable).toBe(true)
    })

    it("preserves per-title reader overrides across a re-capture", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })
        await db.manga.update(manga.id, {
            readingDirection: "rtl",
            pageFit: "height",
            pageWidthPct: 50,
            noGapContinuous: true,
            continuousScroll: true,
            readerTheme: "dark",
            // Server-authoritative canonical Work id (C4); a re-capture must not drop it.
            workId: "work_abc123"
        })

        // A re-read/capture hands a plain source MangaRecord with none of these per-title
        // reader settings; the full-record put must not wipe the user's overrides.
        await saveResolvedChapter({ manga, chapter, sourceLink })

        const stored = await db.manga.get(manga.id)
        expect(stored?.readingDirection).toBe("rtl")
        expect(stored?.pageFit).toBe("height")
        expect(stored?.pageWidthPct).toBe(50)
        expect(stored?.noGapContinuous).toBe(true)
        expect(stored?.continuousScroll).toBe(true)
        expect(stored?.readerTheme).toBe("dark")
        expect(stored?.workId).toBe("work_abc123")
    })

    it("keeps a clean stored series title when a capture carries a chapter-suffixed one (S4)", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })
        await saveResolvedChapter({
            manga: { ...manga, title: "Test Manga Chapter 6" },
            chapter: { ...chapter, id: "mangadex:chapter:2", sortKey: 6 },
            sourceLink
        })
        expect((await db.manga.get(manga.id))?.title).toBe("Test Manga")
    })

    it("self-heals an already chapter-suffixed stored title when a clean capture arrives (S4)", async () => {
        await saveResolvedChapter({ manga: { ...manga, title: "Test Manga Chapter 5" }, chapter, sourceLink })
        await saveResolvedChapter({ manga: { ...manga, title: "Test Manga" }, chapter, sourceLink })
        expect((await db.manga.get(manga.id))?.title).toBe("Test Manga")
    })
})

describe("saveProgress", () => {
    it("records read chapter number + lastReadAt and emits history events", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })
        const progress: ReadingProgress = {
            mangaId: manga.id,
            chapterId: chapter.id,
            pageIndex: 9,
            pageCount: 10,
            completed: true,
            updatedAt: 1_700_000_000_000
        }
        await saveProgress(progress)

        const stored = await db.manga.get(manga.id)
        expect(stored?.lastReadChapterNumber).toBe(5)
        expect(stored?.lastReadAt).toBe(progress.updatedAt)

        const events = await db.historyEvents.toArray()
        expect(events.map(e => e.type).sort()).toEqual(["completed", "started"])
    })

    it("does not let a later report from an earlier page regress an already-completed chapter (Bug 1)", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })

        await saveProgress({
            mangaId: manga.id,
            chapterId: chapter.id,
            pageIndex: 9,
            pageCount: 10,
            completed: true,
            updatedAt: 1_000
        })

        // Simulates paging back after finishing (or a fresh reader session's reporter
        // starting again from page 0) reporting completed:false in a later, separate
        // saveProgress call - not the same throttle.ts pending window.
        await saveProgress({
            mangaId: manga.id,
            chapterId: chapter.id,
            pageIndex: 2,
            pageCount: 10,
            completed: false,
            updatedAt: 2_000
        })

        const afterRegressAttempt = await db.progress.get(chapter.id)
        expect(afterRegressAttempt?.completed).toBe(true)
        expect(afterRegressAttempt?.pageIndex).toBe(2)

        // Re-reaching the last page and reporting completed:true again must not insert
        // a second "completed" historyEvent for this chapter.
        await saveProgress({
            mangaId: manga.id,
            chapterId: chapter.id,
            pageIndex: 9,
            pageCount: 10,
            completed: true,
            updatedAt: 3_000
        })

        const completedEvents = (await db.historyEvents.toArray()).filter(
            e => e.chapterId === chapter.id && e.type === "completed"
        )
        expect(completedEvents).toHaveLength(1)
    })
})

describe("export / import round-trip", () => {
    it("preserves extended library fields (rating, categories, chapter numbers)", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })
        await db.manga.update(manga.id, { rating: 4, categories: ["fav", "action"], lastReadChapterNumber: 3 })

        const envelope = await exportDatabase()
        await db.manga.clear()
        await db.chapters.clear()
        await db.sourceLinks.clear()

        const result = await importDatabase(envelope)
        expect(result.manga).toBe(1)
        const restored = await db.manga.get(manga.id)
        expect(restored?.rating).toBe(4)
        expect(restored?.categories).toEqual(["fav", "action"])
        expect(restored?.lastReadChapterNumber).toBe(3)
        expect(restored?.latestChapterNumber).toBe(5)
    })

    // An unnumbered chapter is stored with sortKey = Number.POSITIVE_INFINITY
    // (UNNUMBERED_SORT_KEY). IndexedDB keeps that, but a backup file is JSON and
    // JSON.stringify turns Infinity into null. The import chapter schema must round-
    // trip that null back to the sentinel; otherwise the finite() check skips the
    // whole chapter on restore. This test FAILS before the schema fix (chapter
    // dropped as RECORD_INVALID) and passes after.
    it("round-trips an unnumbered chapter (sortKey Infinity -> null in JSON) without skipping it, its progress, or its bookmark", async () => {
        const oneshot: ChapterRecord = {
            id: "mangadex:chapter:oneshot",
            mangaId: manga.id,
            sourceId: "mangadex",
            title: "Oneshot",
            url: "https://mangadex.org/chapter/oneshot",
            sortKey: Number.POSITIVE_INFINITY
        }
        await saveResolvedChapter({ manga, chapter: oneshot, sourceLink })
        await saveProgress({
            mangaId: manga.id,
            chapterId: oneshot.id,
            pageIndex: 3,
            pageCount: 10,
            completed: false,
            updatedAt: 1_700_000_000_000
        })
        const bookmark: PageBookmark = {
            id: `${oneshot.id}:3`,
            mangaId: manga.id,
            chapterId: oneshot.id,
            pageIndex: 3,
            mangaTitle: manga.title,
            chapterTitle: oneshot.title,
            chapterUrl: oneshot.url,
            addedAt: 1_700_000_000_000
        }
        await db.pageBookmarks.put(bookmark)

        // Runtime IndexedDB keeps the sentinel as-is.
        expect((await db.chapters.get(oneshot.id))?.sortKey).toBe(Number.POSITIVE_INFINITY)

        // Simulate a real backup file: export -> JSON.stringify -> JSON.parse. This is
        // where Infinity becomes null.
        const envelope = await exportDatabase()
        const serialized = JSON.parse(JSON.stringify(envelope)) as typeof envelope
        const serializedChapter = serialized.data.chapters.find(c => c.id === oneshot.id)
        expect(serializedChapter).toBeDefined()
        expect(serializedChapter?.sortKey).toBeNull()

        await Promise.all([
            db.manga.clear(),
            db.chapters.clear(),
            db.sourceLinks.clear(),
            db.progress.clear(),
            db.pageBookmarks.clear()
        ])

        const result = await importDatabase(serialized)

        // The chapter survived import with its sentinel restored - not skipped.
        expect(result.skipped).toEqual([])
        const restoredChapter = await db.chapters.get(oneshot.id)
        expect(restoredChapter).toBeDefined()
        expect(restoredChapter?.sortKey).toBe(Number.POSITIVE_INFINITY)

        // Its progress and bookmark were not lost in the process.
        expect(await db.progress.get(oneshot.id)).toBeDefined()
        expect(await db.pageBookmarks.get(bookmark.id)).toBeDefined()
    })

    it("rejects a malformed envelope", async () => {
        await expect(importDatabase({ format: "wrong", version: 9, data: {} })).rejects.toThrow(/invalid/i)
    })

    it("accepts legacy envelope with missing optional tables", async () => {
        const legacyEnvelope = {
            format: "all-mangas-reader",
            version: 1,
            data: {
                manga: [
                    {
                        id: "legacy-1",
                        title: "Legacy Manga",
                        normalizedTitle: "legacy manga",
                        authors: [],
                        status: "ongoing",
                        sourceId: "mangadex",
                        sourceUrl: "https://mangadex.org/chapter/x",
                        sourceMangaId: "legacy-src-id",
                        mangaUrl: "https://mangadex.org/title/legacy-id",
                        addedAt: Date.now(),
                        updatedAt: Date.now()
                    }
                ]
                // sourceLinks, chapters, progress, historyEvents intentionally omitted
            }
        }

        const result = await importDatabase(legacyEnvelope)
        expect(result.manga).toBe(1)
        expect(result.chapters).toBe(0)

        const restored = await db.manga.get("legacy-1")
        expect(restored?.title).toBe("Legacy Manga")
    })
})

describe("seedDatabase", () => {
    it("is idempotent - re-seeding does not duplicate", async () => {
        await seedDatabase()
        const first = await db.manga.where("id").startsWith("seed-").count()
        await seedDatabase()
        const second = await db.manga.where("id").startsWith("seed-").count()
        expect(second).toBe(first)
        expect(first).toBeGreaterThan(0)
    })
})

describe("getLocalStats", () => {
    it("computes streaks from history days", async () => {
        const day = 86_400_000
        const base = Date.parse("2026-06-10T12:00:00Z")
        await db.historyEvents.bulkAdd([
            { mangaId: manga.id, chapterId: "c1", type: "completed", occurredAt: base },
            { mangaId: manga.id, chapterId: "c2", type: "completed", occurredAt: base + day },
            { mangaId: manga.id, chapterId: "c3", type: "completed", occurredAt: base + 2 * day }
        ])
        const stats = await getLocalStats()
        expect(stats.readingDays).toBe(3)
        expect(stats.longestStreak).toBe(3)
    })

    it("counts a logical chapter once even across duplicate/placeholder completed rows (S6)", async () => {
        await db.chapters.bulkPut([
            {
                id: "asurascans:chapter:foo-chapter-12",
                mangaId: "m1",
                sourceId: "asurascans",
                title: "Chapter 12",
                url: "https://a/comics/foo/chapter/12",
                sortKey: 12
            },
            {
                id: "m1:ext:ch-12",
                mangaId: "m1",
                sourceId: "asurascans",
                title: "External chapter",
                url: "https://a/comics/foo/chapter/12",
                sortKey: 12
            }
        ])
        await db.progress.bulkAdd([
            {
                mangaId: "m1",
                chapterId: "asurascans:chapter:foo-chapter-12",
                pageIndex: 0,
                pageCount: 1,
                completed: true,
                updatedAt: 1
            },
            { mangaId: "m1", chapterId: "m1:ext:ch-12", pageIndex: 0, pageCount: 1, completed: true, updatedAt: 2 }
        ])
        const stats = await getLocalStats()
        expect(stats.completedChapters).toBe(1)
    })

    it("counts only completed events toward reading days and streaks, not bare 'started' (S5)", async () => {
        const day = 86_400_000
        const base = Date.parse("2026-06-10T12:00:00Z")
        await db.historyEvents.bulkAdd([
            { mangaId: manga.id, chapterId: "c1", type: "completed", occurredAt: base },
            // A merely-opened chapter on a different day must NOT manufacture a reading day.
            { mangaId: manga.id, chapterId: "c2", type: "started", occurredAt: base + day }
        ])
        const stats = await getLocalStats()
        expect(stats.readingDays).toBe(1)
        expect(stats.longestStreak).toBe(1)
    })

    it("buckets reading days on the same local-day boundary as the activity calendar", async () => {
        // getLocalStats and getActivityCalendar must agree on which day an event
        // falls in; the streak stats previously used UTC days while the heatmap uses
        // local days, so a non-UTC user saw the two disagree near midnight. Assert the
        // invariant directly: the number of distinct reading days equals the number of
        // calendar days with any activity, for the same event set.
        const localMidday = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0, 0).getTime()
        await db.historyEvents.bulkAdd([
            { mangaId: manga.id, chapterId: "c1", type: "completed", occurredAt: localMidday(2026, 6, 10) },
            { mangaId: manga.id, chapterId: "c2", type: "completed", occurredAt: localMidday(2026, 6, 10) },
            { mangaId: manga.id, chapterId: "c3", type: "completed", occurredAt: localMidday(2026, 6, 11) }
        ])

        const stats = await getLocalStats()
        const calendar = await getActivityCalendar(365)
        const activeDays = calendar.filter(entry => entry.count > 0).length

        expect(stats.readingDays).toBe(activeDays)
        expect(stats.readingDays).toBe(2)
    })
})

describe("removeManga", () => {
    it("cascades delete to chapters, progress, history events, and source link", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })
        await saveProgress({
            mangaId: manga.id,
            chapterId: chapter.id,
            pageIndex: 9,
            pageCount: 10,
            completed: true,
            updatedAt: 1_700_000_000_000
        })

        await removeManga(manga.id)

        expect(await db.manga.get(manga.id)).toBeUndefined()
        expect(await db.sourceLinks.get(manga.id)).toBeUndefined()
        expect(await db.chapters.where("mangaId").equals(manga.id).count()).toBe(0)
        expect(await db.progress.where("mangaId").equals(manga.id).count()).toBe(0)
        expect(await db.historyEvents.where("mangaId").equals(manga.id).count()).toBe(0)
    })

    it("deletes the manga's covers row (Bug 3)", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })
        await db.covers.put({ mangaId: manga.id, blob: new Blob(["x"]), cachedAt: 1 })

        await removeManga(manga.id)

        expect(await db.covers.get(manga.id)).toBeUndefined()
    })

    it("does not remove other manga's data", async () => {
        const manga2: MangaRecord = {
            ...manga,
            id: "mangadex:manga:xyz",
            title: "Other Manga",
            normalizedTitle: "other manga"
        }
        const chapter2: ChapterRecord = { ...chapter, id: "mangadex:chapter:2", mangaId: manga2.id }
        const sourceLink2: SourceLinkRecord = { ...sourceLink, mangaId: manga2.id }

        await saveResolvedChapter({ manga, chapter, sourceLink })
        await saveResolvedChapter({ manga: manga2, chapter: chapter2, sourceLink: sourceLink2 })

        await removeManga(manga.id)

        expect(await db.manga.get(manga2.id)).toBeDefined()
        expect(await db.chapters.where("mangaId").equals(manga2.id).count()).toBe(1)
        expect(await db.sourceLinks.get(manga2.id)).toBeDefined()
    })
})

describe("toggleBookmark", () => {
    const bmData = {
        mangaId: manga.id,
        chapterId: "mangadex:chapter:1",
        pageIndex: 3,
        mangaTitle: "Test Manga",
        chapterTitle: "Ch.1",
        chapterUrl: "https://mangadex.org/chapter/1"
    }

    it("does not create an orphan bookmark for a manga not in the library", async () => {
        await db.manga.clear()
        const added = await toggleBookmark(bmData)
        expect(added).toBe(false)
        expect(await db.pageBookmarks.count()).toBe(0)
    })

    it("adds then removes when the manga is in the library", async () => {
        await db.manga.put({
            ...manga,
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/title/abc"
        } as LibraryManga)
        expect(await toggleBookmark(bmData)).toBe(true)
        expect(await db.pageBookmarks.count()).toBe(1)
        expect(await toggleBookmark(bmData)).toBe(false)
        expect(await db.pageBookmarks.count()).toBe(0)
    })

    it("two concurrent toggles from an unbookmarked page net exactly one bookmark (atomic)", async () => {
        await db.manga.put({
            ...manga,
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/title/abc"
        } as LibraryManga)
        const [a, b] = await Promise.all([toggleBookmark(bmData), toggleBookmark(bmData)])
        expect([a, b].filter(Boolean).length).toBe(1)
        expect(await db.pageBookmarks.count()).toBe(0)
    })
})

describe("orphan-write guards (title removed during the network fetch)", () => {
    it("saveLinkedChapters writes no chapters when the manga is absent", async () => {
        await saveLinkedChapters(manga.id, [chapter], undefined)
        expect(await db.chapters.where("mangaId").equals(manga.id).count()).toBe(0)
    })

    it("switchMangaSource writes no chapters or source link when the manga is absent", async () => {
        await switchMangaSource({
            mangaId: manga.id,
            sourceId: "other",
            chapters: [{ ...chapter, id: "other:chapter:1", sourceId: "other" }],
            mangaPatch: {},
            numberingUnreliable: false,
            sourceLink
        })
        expect(await db.chapters.where("mangaId").equals(manga.id).count()).toBe(0)
        expect(await db.sourceLinks.get(manga.id)).toBeUndefined()
    })

    it("putChapters writes nothing for a manga that no longer exists, but writes when it does", async () => {
        await putChapters([chapter])
        expect(await db.chapters.get(chapter.id)).toBeUndefined()
        await db.manga.put({
            ...manga,
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/title/abc"
        } as LibraryManga)
        await putChapters([chapter])
        expect(await db.chapters.get(chapter.id)).toBeDefined()
    })

    it("saveReaderResolvedChapter writes no chapter row when the manga is absent", async () => {
        await saveReaderResolvedChapter({ chapter, mangaId: manga.id })
        expect(await db.chapters.get(chapter.id)).toBeUndefined()
    })
})

describe("mergeMangaRecords", () => {
    it("carries the loser's chapter-id fields alongside whichever side's number won the max (Bug 2)", async () => {
        const primary: LibraryManga = {
            ...manga,
            id: "mangadex:manga:primary",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/primary",
            mangaUrl: "https://mangadex.org/title/primary",
            lastReadChapterNumber: 18,
            lastReadChapterId: "ch18",
            latestChapterNumber: 20,
            latestChapterId: "ch20"
        }
        const loser: LibraryManga = {
            ...manga,
            id: "mangadex:manga:loser",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/loser",
            mangaUrl: "https://mangadex.org/title/loser",
            lastReadChapterNumber: 22,
            lastReadChapterId: "ch22",
            latestChapterNumber: 22,
            latestChapterId: "ch22"
        }
        await db.manga.bulkPut([primary, loser])

        const merged = await mergeMangaRecords(primary.id, [loser.id])

        expect(merged.latestChapterId).toBe("ch22")
        expect(merged.lastReadChapterId).toBe("ch22")
        expect(merged.latestChapterNumber).toBe(22)
        expect(merged.lastReadChapterNumber).toBe(22)
    })

    it("adopts the loser's anilistId/genres/metadataUpdatedAt when the primary has none", async () => {
        const primary: LibraryManga = {
            ...manga,
            id: "mangadex:manga:p-plain",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/p-plain",
            mangaUrl: "https://mangadex.org/title/p-plain"
            // deliberately un-enriched
        }
        const loser: LibraryManga = {
            ...manga,
            id: "mangadex:manga:l-rich",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/l-rich",
            mangaUrl: "https://mangadex.org/title/l-rich",
            anilistId: 194902,
            genres: ["Action", "Drama"],
            metadataUpdatedAt: 1_700_000_000_000
        }
        await db.manga.bulkPut([primary, loser])

        const merged = await mergeMangaRecords(primary.id, [loser.id])

        expect(merged.anilistId).toBe(194902)
        expect(merged.genres).toEqual(["Action", "Drama"])
        expect(merged.metadataUpdatedAt).toBe(1_700_000_000_000)
    })

    it("leaves the primary's chapter-id fields untouched when the primary is already at the max and the loser has nothing set", async () => {
        const primary: LibraryManga = {
            ...manga,
            id: "mangadex:manga:primary2",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/primary2",
            mangaUrl: "https://mangadex.org/title/primary2",
            lastReadChapterNumber: 18,
            lastReadChapterId: "ch18",
            latestChapterNumber: 20,
            latestChapterId: "ch20"
        }
        const loser: LibraryManga = {
            ...manga,
            id: "mangadex:manga:loser2",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/loser2",
            mangaUrl: "https://mangadex.org/title/loser2"
        }
        await db.manga.bulkPut([primary, loser])

        const merged = await mergeMangaRecords(primary.id, [loser.id])

        expect(merged.latestChapterId).toBe("ch20")
        expect(merged.lastReadChapterId).toBe("ch18")
        expect(merged.latestChapterNumber).toBe(20)
        expect(merged.lastReadChapterNumber).toBe(18)
    })

    it("carries the loser's cover to the primary when the primary has none, and deletes the loser's cover row (Bug 3)", async () => {
        const primary: LibraryManga = {
            ...manga,
            id: "mangadex:manga:coverprimary",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/coverprimary",
            mangaUrl: "https://mangadex.org/title/coverprimary"
        }
        const loser: LibraryManga = {
            ...manga,
            id: "mangadex:manga:coverloser",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/coverloser",
            mangaUrl: "https://mangadex.org/title/coverloser"
        }
        await db.manga.bulkPut([primary, loser])
        await db.covers.put({ mangaId: loser.id, blob: new Blob(["loser-cover"]), cachedAt: 1 })

        await mergeMangaRecords(primary.id, [loser.id])

        const primaryCover = await db.covers.get(primary.id)
        expect(primaryCover).toBeDefined()
        const bytes = new Uint8Array(await primaryCover!.blob.arrayBuffer())
        expect(new TextDecoder().decode(bytes)).toBe("loser-cover")
        expect(await db.covers.get(loser.id)).toBeUndefined()
    })

    it("does not max chapter numbers across different sources - the primary's own number+id pairs win", async () => {
        const primary: LibraryManga = {
            ...manga,
            id: "mangadex:manga:crossprimary",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/crossprimary",
            mangaUrl: "https://mangadex.org/title/crossprimary",
            lastReadChapterNumber: 18,
            lastReadChapterId: "ch18",
            latestChapterNumber: 20,
            latestChapterId: "ch20",
            categories: ["favorites"]
        }
        const loser: LibraryManga = {
            ...manga,
            id: "webtoons:manga:crossloser",
            sourceId: "webtoons",
            sourceUrl: "https://webtoons.com/chapter/crossloser",
            mangaUrl: "https://webtoons.com/title/crossloser",
            lastReadChapterNumber: 22,
            lastReadChapterId: "webtoons:ch22",
            latestChapterNumber: 22,
            latestChapterId: "webtoons:ch22",
            categories: ["action"]
        }
        await db.manga.bulkPut([primary, loser])

        const merged = await mergeMangaRecords(primary.id, [loser.id])

        expect(merged.lastReadChapterNumber).toBe(18)
        expect(merged.lastReadChapterId).toBe("ch18")
        expect(merged.latestChapterNumber).toBe(20)
        expect(merged.latestChapterId).toBe("ch20")
        // Non-numeric fields still merge - only the numeric cross-source policy changed.
        expect(merged.categories).toEqual(expect.arrayContaining(["favorites", "action"]))
    })

    it("adopts a cross-source loser's number+id pair only when the primary has neither", async () => {
        const primary: LibraryManga = {
            ...manga,
            id: "mangadex:manga:fillprimary",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/fillprimary",
            mangaUrl: "https://mangadex.org/title/fillprimary"
        }
        const loser: LibraryManga = {
            ...manga,
            id: "webtoons:manga:fillloser",
            sourceId: "webtoons",
            sourceUrl: "https://webtoons.com/chapter/fillloser",
            mangaUrl: "https://webtoons.com/title/fillloser",
            latestChapterNumber: 22,
            latestChapterId: "webtoons:ch22"
        }
        await db.manga.bulkPut([primary, loser])

        const merged = await mergeMangaRecords(primary.id, [loser.id])

        expect(merged.latestChapterNumber).toBe(22)
        expect(merged.latestChapterId).toBe("webtoons:ch22")
    })

    it("does not carry a cross-source loser id when the primary has a number but no id", async () => {
        const primary: LibraryManga = {
            ...manga,
            id: "mangadex:manga:numonlyprimary",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/numonlyprimary",
            mangaUrl: "https://mangadex.org/title/numonlyprimary",
            latestChapterNumber: 20
        }
        const loser: LibraryManga = {
            ...manga,
            id: "webtoons:manga:numonlyloser",
            sourceId: "webtoons",
            sourceUrl: "https://webtoons.com/chapter/numonlyloser",
            mangaUrl: "https://webtoons.com/title/numonlyloser",
            latestChapterNumber: 22,
            latestChapterId: "webtoons:ch22"
        }
        await db.manga.bulkPut([primary, loser])

        const merged = await mergeMangaRecords(primary.id, [loser.id])

        expect(merged.latestChapterNumber).toBe(20)
        expect(merged.latestChapterId).toBeUndefined()
    })

    it("still maxes lastReadAt across sources", async () => {
        const primary: LibraryManga = {
            ...manga,
            id: "mangadex:manga:lastreadatprimary",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/lastreadatprimary",
            mangaUrl: "https://mangadex.org/title/lastreadatprimary",
            lastReadAt: 1_000
        }
        const loser: LibraryManga = {
            ...manga,
            id: "webtoons:manga:lastreadatloser",
            sourceId: "webtoons",
            sourceUrl: "https://webtoons.com/chapter/lastreadatloser",
            mangaUrl: "https://webtoons.com/title/lastreadatloser",
            lastReadAt: 5_000
        }
        await db.manga.bulkPut([primary, loser])

        const merged = await mergeMangaRecords(primary.id, [loser.id])

        expect(merged.lastReadAt).toBe(5_000)
    })

    it("processes same-source losers before cross-source losers so a later same-source max can't reintroduce a dangling cross-source id", async () => {
        const primary: LibraryManga = {
            ...manga,
            id: "mangadex:manga:orderprimary",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/orderprimary",
            mangaUrl: "https://mangadex.org/title/orderprimary"
        }
        const loserA: LibraryManga = {
            ...manga,
            id: "webtoons:manga:orderlosera",
            sourceId: "webtoons",
            sourceUrl: "https://webtoons.com/chapter/orderlosera",
            mangaUrl: "https://webtoons.com/title/orderlosera",
            latestChapterNumber: 22,
            latestChapterId: "webtoons:ch22"
        }
        const loserB: LibraryManga = {
            ...manga,
            id: "mangadex:manga:orderloserb",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/orderloserb",
            mangaUrl: "https://mangadex.org/title/orderloserb",
            latestChapterNumber: 20,
            latestChapterId: "mangadex:ch20"
        }
        await db.manga.bulkPut([primary, loserA, loserB])

        // Pass A before B - if the function did NOT reorder, A (cross-source) would
        // fill the empty slot first and B's later same-source max would then carry
        // A's dangling webtoons id forward.
        const merged = await mergeMangaRecords(primary.id, [loserA.id, loserB.id])

        expect(merged.latestChapterId).toBe("mangadex:ch20")
        expect(merged.latestChapterId).not.toBe("webtoons:ch22")
    })
})

// The falsy-0 merge bug class: `Math.max(a ?? 0, b ?? 0) || undefined` maps a
// genuine chapter-0 value (Math.max(0, x) === 0, then `0 || undefined`) to
// undefined, silently wiping real chapter-0 reading progress. Each of these FAILS
// before the maxDefined() fix (the merged number comes back undefined) and passes
// after. Scenarios are chosen so the merged value REPLACES the base record's field
// rather than falling back to it - otherwise a conditional spread would mask the bug.
describe("chapter-0 progress survives merge, import, and relink (falsy-0 merge bug)", () => {
    it("adopts a same-source loser's chapter-0 lastReadChapterNumber when the primary has none (merge)", async () => {
        const primary: LibraryManga = {
            ...manga,
            id: "mangadex:manga:zero-primary",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/zero-primary",
            mangaUrl: "https://mangadex.org/title/zero-primary"
        }
        const loser: LibraryManga = {
            ...manga,
            id: "mangadex:manga:zero-loser",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/zero-loser",
            mangaUrl: "https://mangadex.org/title/zero-loser",
            lastReadChapterNumber: 0,
            lastReadChapterId: "ch0"
        }
        await db.manga.bulkPut([primary, loser])

        const merged = await mergeMangaRecords(primary.id, [loser.id])

        expect(merged.lastReadChapterNumber).toBe(0)
        expect(merged.lastReadChapterId).toBe("ch0")
    })

    it("preserves an existing record's chapter-0 progress when a relink merges it into the resolved record (rekeyManga)", async () => {
        const oldId = "mangadex:manga:relink-old"
        const newId = "mangadex:manga:relink-new"
        // A record already exists at the canonical new id, at chapter 0.
        await db.manga.put({
            ...manga,
            id: newId,
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/relink-new",
            mangaUrl: "https://mangadex.org/title/relink-new",
            lastReadChapterNumber: 0,
            lastReadChapterId: "ch0"
        })
        // The old record being relinked away.
        await db.manga.put({
            ...manga,
            id: oldId,
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/relink-old"
        })
        // The resolved "next" record carries no read progress of its own - the merge
        // must pull the existing record's chapter-0 forward, not wipe it.
        const next: LibraryManga = {
            ...manga,
            id: newId,
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/relink-new",
            mangaUrl: "https://mangadex.org/title/relink-new"
        }
        const newSourceLink: SourceLinkRecord = {
            mangaId: newId,
            sourceId: "mangadex",
            url: "https://mangadex.org/title/relink-new",
            addedAt: 1,
            updatedAt: 1
        }

        await rekeyManga(oldId, next, newSourceLink)

        const restored = await db.manga.get(newId)
        expect(restored?.lastReadChapterNumber).toBe(0)
    })

    it("preserves an existing chapter-0 progress across a merge import when the imported side has none", async () => {
        // Build a valid backup envelope for the imported side (no chapter numbers set).
        const importedManga: LibraryManga = {
            ...manga,
            id: "mangadex:manga:import-zero",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/import-zero",
            mangaUrl: "https://mangadex.org/title/import-zero"
        }
        await db.manga.put(importedManga)
        const envelope = await exportDatabase()
        await db.manga.clear()

        // The record already in the library is at chapter 0.
        await db.manga.put({ ...importedManga, lastReadChapterNumber: 0, lastReadChapterId: "ch0" })

        // Default resolution is "merge" - the merge must not wipe the local 0.
        await importDatabase(envelope)

        const restored = await db.manga.get(importedManga.id)
        expect(restored?.lastReadChapterNumber).toBe(0)
    })
})

// The cleanup tool's core correctness requirements (see handlers/library.ts) - two
// separate adversarial reviews of the original plan caught real bugs here: a naive
// per-loser (not per-chapter) remap corrupts history for any loser that tracked more
// than one external chapter, and a naive "only fix lastReadChapterId if the number
// increased" post-merge check misses the dangling-id-with-no-number-change case.
describe("remapExternalChapterProgress", () => {
    const canonicalChapters: ChapterRecord[] = [
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

    it("remaps a loser with TWO tracked external chapters onto two different canonical chapters with no cross-contamination", async () => {
        const loserId = "mangafreak:manga:read1-foo-1"
        await db.manga.put({
            ...manga,
            id: loserId,
            sourceId: "mangafreak",
            sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_1"
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
        await db.historyEvents.bulkAdd([
            { mangaId: loserId, chapterId: `${loserId}:ext:ch-1`, type: "completed", occurredAt: 10 },
            { mangaId: loserId, chapterId: `${loserId}:ext:ch-2`, type: "started", occurredAt: 20 }
        ])

        await remapExternalChapterProgress(loserId, canonicalChapters)

        const p1 = await db.progress.get("mangafreak:chapter:Foo:1")
        const p2 = await db.progress.get("mangafreak:chapter:Foo:2")
        expect(p1).toMatchObject({ completed: true, updatedAt: 10 })
        expect(p2).toMatchObject({ completed: false, updatedAt: 20 })
        // The old ext-chapter-keyed rows are gone - re-keyed, not duplicated.
        expect(await db.progress.get(`${loserId}:ext:ch-1`)).toBeUndefined()
        expect(await db.progress.get(`${loserId}:ext:ch-2`)).toBeUndefined()

        const eventsForCh1 = await db.historyEvents.where("chapterId").equals("mangafreak:chapter:Foo:1").toArray()
        const eventsForCh2 = await db.historyEvents.where("chapterId").equals("mangafreak:chapter:Foo:2").toArray()
        expect(eventsForCh1).toHaveLength(1)
        expect(eventsForCh1[0]?.type).toBe("completed")
        expect(eventsForCh2).toHaveLength(1)
        expect(eventsForCh2[0]?.type).toBe("started")
    })

    it("merges (not overwrites) when two different losers' chapters map onto the same canonical chapter", async () => {
        const loserA = "mangafreak:manga:read1-foo-1a"
        const loserB = "mangafreak:manga:read1-foo-1b"
        await db.manga.bulkPut([
            { ...manga, id: loserA, sourceId: "mangafreak", sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_1" },
            { ...manga, id: loserB, sourceId: "mangafreak", sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_1" }
        ])
        await db.chapters.bulkPut([
            {
                id: `${loserA}:ext:ch-1`,
                mangaId: loserA,
                sourceId: "mangafreak",
                title: "Chapter 1",
                url: "https://ww2.mangafreak.me/Read1_Foo_1",
                sortKey: 1
            },
            {
                id: `${loserB}:ext:ch-1`,
                mangaId: loserB,
                sourceId: "mangafreak",
                title: "Chapter 1",
                url: "https://ww2.mangafreak.me/Read1_Foo_1",
                sortKey: 1
            }
        ])
        await db.progress.bulkPut([
            {
                mangaId: loserA,
                chapterId: `${loserA}:ext:ch-1`,
                pageIndex: 0,
                pageCount: 1,
                completed: false,
                updatedAt: 10
            },
            {
                mangaId: loserB,
                chapterId: `${loserB}:ext:ch-1`,
                pageIndex: 0,
                pageCount: 1,
                completed: true,
                updatedAt: 5
            }
        ])

        await remapExternalChapterProgress(loserA, canonicalChapters)
        await remapExternalChapterProgress(loserB, canonicalChapters)

        const merged = await db.progress.get("mangafreak:chapter:Foo:1")
        // completed is OR'd (loserB's true wins even though it's the older update)...
        expect(merged?.completed).toBe(true)
        // ...but pageIndex/pageCount/updatedAt come from whichever side is more recent.
        expect(merged?.updatedAt).toBe(10)
    })

    it("does not duplicate a completed history row when two losers' chapters merge onto one canonical chapter", async () => {
        const loserA = "mangafreak:manga:read1-foo-1a"
        const loserB = "mangafreak:manga:read1-foo-1b"
        await db.manga.bulkPut([
            { ...manga, id: loserA, sourceId: "mangafreak", sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_1" },
            { ...manga, id: loserB, sourceId: "mangafreak", sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_1" }
        ])
        await db.chapters.bulkPut([
            {
                id: `${loserA}:ext:ch-1`,
                mangaId: loserA,
                sourceId: "mangafreak",
                title: "Chapter 1",
                url: "https://ww2.mangafreak.me/Read1_Foo_1",
                sortKey: 1
            },
            {
                id: `${loserB}:ext:ch-1`,
                mangaId: loserB,
                sourceId: "mangafreak",
                title: "Chapter 1",
                url: "https://ww2.mangafreak.me/Read1_Foo_1",
                sortKey: 1
            }
        ])
        const day = 86_400_000
        const base = Date.parse("2026-06-10T12:00:00Z")
        await db.historyEvents.bulkAdd([
            { mangaId: loserA, chapterId: `${loserA}:ext:ch-1`, type: "completed", occurredAt: base },
            { mangaId: loserB, chapterId: `${loserB}:ext:ch-1`, type: "completed", occurredAt: base + day }
        ])

        await remapExternalChapterProgress(loserA, canonicalChapters)
        await remapExternalChapterProgress(loserB, canonicalChapters)

        const events = await db.historyEvents.where("chapterId").equals("mangafreak:chapter:Foo:1").toArray()
        // One chapter was completed once - one completed row, keeping the earliest occurredAt.
        const completed = events.filter(e => e.type === "completed")
        expect(completed).toHaveLength(1)
        expect(completed[0]?.occurredAt).toBe(base)
    })

    it("leaves an ext chapter's progress/history alone when it can't be matched to any canonical chapter", async () => {
        const loserId = "mangafreak:manga:read1-unmatched"
        await db.manga.put({
            ...manga,
            id: loserId,
            sourceId: "mangafreak",
            sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_99"
        })
        await db.chapters.put({
            id: `${loserId}:ext:ch-99`,
            mangaId: loserId,
            sourceId: "mangafreak",
            title: "Chapter 99",
            url: "https://ww2.mangafreak.me/Read1_Foo_99",
            sortKey: 99
        })
        await db.progress.put({
            mangaId: loserId,
            chapterId: `${loserId}:ext:ch-99`,
            pageIndex: 0,
            pageCount: 1,
            completed: true,
            updatedAt: 1
        })

        await remapExternalChapterProgress(loserId, canonicalChapters)

        expect(await db.progress.get(`${loserId}:ext:ch-99`)).toBeDefined()
    })

    it("falls through to the pathname match for an unnumbered (Infinity sortKey) ext chapter instead of matching the first unnumbered canonical chapter (Infinity === Infinity bug)", async () => {
        const loserId = "mangafreak:manga:read1-unnumbered"
        await db.manga.put({
            ...manga,
            id: loserId,
            sourceId: "mangafreak",
            sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_extra"
        })
        await db.chapters.put({
            id: `${loserId}:ext:extra`,
            mangaId: loserId,
            sourceId: "mangafreak",
            title: "Extra",
            url: "https://ww2.mangafreak.me/Read1_Foo_extra",
            sortKey: Number.POSITIVE_INFINITY
        })
        await db.progress.put({
            mangaId: loserId,
            chapterId: `${loserId}:ext:extra`,
            pageIndex: 0,
            pageCount: 1,
            completed: true,
            updatedAt: 1
        })

        const unnumberedCanonicalChapters: ChapterRecord[] = [
            // Listed FIRST on purpose - an unguarded `extChapter.sortKey > 0` /
            // `c.sortKey === extChapter.sortKey` match would land on this UNRELATED
            // chapter (Infinity === Infinity), transplanting progress onto the wrong row.
            {
                id: "mangafreak:chapter:Foo:unrelated-extra",
                mangaId: "mangafreak:manga:Foo",
                sourceId: "mangafreak",
                title: "Unrelated Extra",
                url: "https://ww2.mangafreak.me/Read1_Foo_unrelated",
                sortKey: Number.POSITIVE_INFINITY
            },
            {
                id: "mangafreak:chapter:Foo:extra",
                mangaId: "mangafreak:manga:Foo",
                sourceId: "mangafreak",
                title: "Extra",
                url: "https://ww2.mangafreak.me/Read1_Foo_extra",
                sortKey: Number.POSITIVE_INFINITY
            }
        ]

        const translated = await remapExternalChapterProgress(loserId, unnumberedCanonicalChapters)

        expect(translated.map(c => c.id)).toEqual(["mangafreak:chapter:Foo:extra"])
        const remapped = await db.progress.get("mangafreak:chapter:Foo:extra")
        expect(remapped?.completed).toBe(true)
        expect(await db.progress.get("mangafreak:chapter:Foo:unrelated-extra")).toBeUndefined()
    })
})

describe("fixupDanglingChapterIds", () => {
    const canonicalChapters: ChapterRecord[] = [
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

    it("replaces a dangling lastReadChapterId with a real canonical chapter matching the stored number, unconditionally - not gated on the number having increased", async () => {
        const mangaId = "mangafreak:manga:Foo"
        await db.manga.put({
            ...manga,
            id: mangaId,
            sourceId: "mangafreak",
            sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_1",
            lastReadChapterNumber: 1,
            // Points at a chapter id that doesn't exist in db.chapters at all (e.g. a
            // dangling id adopted from a deleted loser) - the number itself did NOT
            // change, which is exactly the case a naive "only fix if number increased"
            // check would miss.
            lastReadChapterId: "some-deleted-loser:ext:ch-1"
        })
        await db.chapters.bulkPut(canonicalChapters)

        await fixupDanglingChapterIds(mangaId, canonicalChapters, [])

        const stored = await db.manga.get(mangaId)
        expect(stored?.lastReadChapterId).toBe("mangafreak:chapter:Foo:1")
        expect(stored?.lastReadChapterNumber).toBe(1)
    })

    it("clears lastReadChapterId to undefined (keeping the number) when no canonical chapter matches at all", async () => {
        const mangaId = "mangafreak:manga:Foo"
        await db.manga.put({
            ...manga,
            id: mangaId,
            sourceId: "mangafreak",
            sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_1",
            lastReadChapterNumber: 999,
            lastReadChapterId: "some-deleted-loser:ext:ch-1"
        })
        await db.chapters.bulkPut(canonicalChapters)

        await fixupDanglingChapterIds(mangaId, canonicalChapters, [])

        const stored = await db.manga.get(mangaId)
        expect(stored?.lastReadChapterId).toBeUndefined()
        expect(stored?.lastReadChapterNumber).toBe(999)
    })

    it("leaves lastReadChapterId untouched when it still points at a real chapter", async () => {
        const mangaId = "mangafreak:manga:Foo"
        await db.manga.put({
            ...manga,
            id: mangaId,
            sourceId: "mangafreak",
            sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_1",
            lastReadChapterNumber: 2,
            lastReadChapterId: "mangafreak:chapter:Foo:2"
        })
        await db.chapters.bulkPut(canonicalChapters)

        await fixupDanglingChapterIds(mangaId, canonicalChapters, [])

        const stored = await db.manga.get(mangaId)
        expect(stored?.lastReadChapterId).toBe("mangafreak:chapter:Foo:2")
    })

    it("also fixes a dangling latestChapterId", async () => {
        const mangaId = "mangafreak:manga:Foo"
        await db.manga.put({
            ...manga,
            id: mangaId,
            sourceId: "mangafreak",
            sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_1",
            latestChapterNumber: 2,
            latestChapterId: "some-deleted-loser:ext:ch-2"
        })
        await db.chapters.bulkPut(canonicalChapters)

        await fixupDanglingChapterIds(mangaId, canonicalChapters, [])

        const stored = await db.manga.get(mangaId)
        expect(stored?.latestChapterId).toBe("mangafreak:chapter:Foo:2")
    })
})

describe("applyCleanupGroup", () => {
    const canonicalChapters: ChapterRecord[] = [
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

    // This is the empirical check that Dexie really does nest applyCleanupGroup's
    // outer transaction with mergeMangaRecords' own internal db.transaction() call
    // (same tables, same "rw" mode) instead of deadlocking or throwing - see
    // applyCleanupGroup's doc comment in database.ts.
    it("runs remap + merge + the dangling-id fixup in one call without deadlocking or throwing (Dexie nested-transaction check)", async () => {
        const canonicalId = "mangafreak:manga:Foo"
        const loserId = "mangafreak:manga:read1-foo-1"
        await db.manga.bulkPut([
            { ...manga, id: canonicalId, sourceId: "mangafreak", sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_2" },
            { ...manga, id: loserId, sourceId: "mangafreak", sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_1" }
        ])
        await db.chapters.put({
            id: `${loserId}:ext:ch-1`,
            mangaId: loserId,
            sourceId: "mangafreak",
            title: "Chapter 1",
            url: "https://ww2.mangafreak.me/Read1_Foo_1",
            sortKey: 1
        })
        await db.progress.put({
            mangaId: loserId,
            chapterId: `${loserId}:ext:ch-1`,
            pageIndex: 0,
            pageCount: 1,
            completed: true,
            updatedAt: 1
        })
        await db.chapters.bulkPut(canonicalChapters)

        const merged = await applyCleanupGroup(canonicalId, [loserId], canonicalChapters)

        expect(merged.id).toBe(canonicalId)
        expect(await db.manga.get(loserId)).toBeUndefined()
        expect((await db.progress.get("mangafreak:chapter:Foo:1"))?.completed).toBe(true)
    })

    it("fixes a dangling lastReadChapterId produced by the merge itself, inside the same call", async () => {
        const canonicalId = "mangafreak:manga:Foo"
        const loserId = "mangafreak:manga:read1-foo-2"
        // Primary has no lastReadChapterNumber/Id set - the loser's same-source pair
        // fills the empty slot (mergeMangaRecords' documented "fill" behavior), but the
        // loser's chapter id is an ext-chapter that gets deleted by the merge itself.
        await db.manga.bulkPut([
            { ...manga, id: canonicalId, sourceId: "mangafreak", sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_2" },
            {
                ...manga,
                id: loserId,
                sourceId: "mangafreak",
                sourceUrl: "https://ww2.mangafreak.me/Read1_Foo_2",
                lastReadChapterNumber: 2,
                lastReadChapterId: `${loserId}:ext:ch-2`
            }
        ])
        await db.chapters.put({
            id: `${loserId}:ext:ch-2`,
            mangaId: loserId,
            sourceId: "mangafreak",
            title: "Chapter 2",
            url: "https://ww2.mangafreak.me/Read1_Foo_2",
            sortKey: 2
        })
        // In the real apply flow, saveResolvedChapter already persisted the freshly-
        // fetched canonical chapters into db.chapters before applyCleanupGroup runs.
        await db.chapters.bulkPut(canonicalChapters)

        const merged = await applyCleanupGroup(canonicalId, [loserId], canonicalChapters)

        // The dangling ext-chapter id must have been replaced by the real canonical one -
        // not left pointing at a row mergeMangaRecords just deleted.
        expect(merged.lastReadChapterId).toBe("mangafreak:chapter:Foo:2")
        expect(await db.chapters.get(merged.lastReadChapterId!)).toBeDefined()
    })
})

describe("export / import integrity", () => {
    it("export→import→export produces identical data", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })
        await db.manga.update(manga.id, { rating: 4, categories: ["action"], lastReadChapterNumber: 3 })

        const first = await exportDatabase()

        await db.manga.clear()
        await db.chapters.clear()
        await db.sourceLinks.clear()
        await db.progress.clear()
        await db.historyEvents.clear()

        await importDatabase(first)
        const second = await exportDatabase()

        expect(second.data.manga).toEqual(first.data.manga)
        expect(second.data.chapters).toEqual(first.data.chapters)
        expect(second.data.sourceLinks).toEqual(first.data.sourceLinks)
        expect(second.data.progress).toEqual(first.data.progress)
        expect(second.data.historyEvents).toEqual(first.data.historyEvents)
    })
})

// Fix 6: the 6 table reads used to be independent toArray() calls, each its own
// transaction - a concurrent write could commit in the gaps and produce a torn
// snapshot. They're now one "r" (read-only) transaction across all 6 tables.
describe("exportDatabase reads via one snapshot transaction (Fix 6)", () => {
    it("wraps all table reads in a single read-only transaction over exactly the exported tables", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })
        const transactionSpy = vi.spyOn(db, "transaction")

        await exportDatabase()

        const exportCall = transactionSpy.mock.calls.find(call => call[0] === "r")
        expect(exportCall).toBeDefined()
        const tables = exportCall?.[1] as unknown as unknown[]
        expect(tables).toEqual(
            expect.arrayContaining([
                db.manga,
                db.sourceLinks,
                db.chapters,
                db.progress,
                db.historyEvents,
                db.pageBookmarks,
                db.archProfiles,
                db.versions,
                db.workOverrides
            ])
        )
        expect(tables).toHaveLength(9)

        transactionSpy.mockRestore()
    })
})

describe("archProfiles round-trip through export/import (Arch A)", () => {
    it("exports and re-imports a user-imported source profile", async () => {
        await putArchProfile("x-src", { profileFormat: 1, id: "x-src", name: "X Source" })
        const envelope = await exportDatabase()
        expect(envelope.data.archProfiles?.some(p => p.id === "x-src")).toBe(true)

        await db.archProfiles.clear()
        expect(await listArchProfiles()).toHaveLength(0)

        await importDatabase(envelope)
        const restored = await listArchProfiles()
        expect(restored).toHaveLength(1)
        expect((restored[0] as { id: string }).id).toBe("x-src")
    })

    it("keeps a valid row origin through a restore and drops an unrecognised one", async () => {
        await putArchProfile("seeded-src", { id: "seeded-src" }, "seed")
        await putArchProfile("user-src", { id: "user-src" }, "user")
        const envelope = await exportDatabase()
        const rows = envelope.data.archProfiles!.map(row =>
            row.id === "user-src" ? { ...row, origin: "admin" as never } : row
        )
        await db.archProfiles.clear()

        await importDatabase({ ...envelope, data: { ...envelope.data, archProfiles: rows } })

        expect((await db.archProfiles.get("seeded-src"))?.origin).toBe("seed")
        expect((await db.archProfiles.get("user-src"))?.origin).toBeUndefined()
    })
})

// Last line of defense for the UNNUMBERED_SORT_KEY (Infinity) leak class: the db.manga
// hook tripwire already refuses to WRITE a non-finite latestChapterNumber through the
// app's own Dexie instance, and the v9 migration heals already-corrupt rows on open -
// but exportDatabase() must never emit one anyway, since JSON.stringify turns Infinity
// into null and schema.ts's z.number().finite() then rejects the whole record on
// restore.
describe("exportDatabase strips a non-finite latestChapterNumber defensively", () => {
    it("omits latestChapterNumber entirely for a manga record that is somehow non-finite, without touching other fields", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })

        // Simulate a record reaching this state some other way (a gap in the repair
        // migration, or a future write path that bypasses the app's own hooks) by
        // writing directly to the physical IndexedDB through a second, hook-free
        // Dexie connection at the same schema version - the same technique the
        // version 8/9 migration tests above use to seed a pre-fix physical database.
        const bypass = new Dexie("all-mangas-reader")
        bypass.version(9).stores({
            manga: "id, normalizedTitle, sourceId, addedAt, updatedAt",
            sourceLinks: "mangaId, sourceId, sourceMangaId, updatedAt",
            chapters: "id, mangaId, sourceId, sortKey, url",
            progress: "chapterId, mangaId, updatedAt, completed",
            historyEvents: "++id, mangaId, chapterId, type, occurredAt",
            downloads: "chapterId, mangaId, downloadedAt",
            covers: "mangaId",
            pageBookmarks: "id, mangaId, chapterId, addedAt",
            analyticsEvents: "++id, event, ts, sourceId",
            backups: "++id, createdAt, reason"
        })
        await bypass.open()
        await bypass.table("manga").update(manga.id, { latestChapterNumber: Number.POSITIVE_INFINITY })
        bypass.close()

        const envelope = await exportDatabase()

        const exportedManga = envelope.data.manga.find(m => m.id === manga.id)
        expect(exportedManga).toBeDefined()
        expect("latestChapterNumber" in (exportedManga as Record<string, unknown>)).toBe(false)
        expect(exportedManga?.title).toBe(manga.title)
    })
})

// Bug 5: the tests below are what should have caught Bugs 1 and 2 in the first
// place - a full-fidelity round-trip across every table and every optional field,
// a structural guard against future DB-shape/import-schema drift, and coverage for
// the partial-success import path from Bug 3.
describe("export / import full round-trip (Bug 5)", () => {
    it("preserves every table and every optional manga/chapter field (modulo autoincrement history ids)", async () => {
        const fullManga: LibraryManga = {
            id: "mangadex:manga:full",
            title: "Full Fixture Manga",
            normalizedTitle: "full fixture manga",
            coverUrl: "https://mangadex.org/covers/full.jpg",
            description: "A manga with every optional field set.",
            rating: 5,
            authors: ["Author One", "Author Two"],
            status: "ongoing",
            addedAt: 1_000,
            updatedAt: 2_000,
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/full-1",
            sourceMangaId: "full-src-id",
            mangaUrl: "https://mangadex.org/title/full-src-id",
            latestChapterId: "mangadex:chapter:full-2",
            lastReadChapterId: "mangadex:chapter:full-1",
            latestChapterNumber: 2,
            lastReadChapterNumber: 1,
            lastReadAt: 1_500,
            manualTracking: true,
            categories: ["favorites", "action"],
            nsfw: true,
            notes: "Reread before the next volume drops.",
            genres: ["Action", "Drama"],
            noGapContinuous: true,
            onHold: false,
            readingDirection: "rtl",
            pageFit: "height"
        }
        const fullSourceLink: SourceLinkRecord = {
            mangaId: fullManga.id,
            sourceId: "mangadex",
            url: fullManga.mangaUrl!,
            sourceMangaId: fullManga.sourceMangaId,
            title: fullManga.title,
            language: "en",
            addedAt: 1_000,
            updatedAt: 2_000
        }
        // DB-shaped chapters: every real chapter-write path stores a SourceChapter
        // (ChapterRecord & { sourceChapterId, language }), never a bare ChapterRecord -
        // this is exactly the shape that used to break import (Bug 1).
        const fullChapter1: SourceChapter = {
            id: "mangadex:chapter:full-1",
            mangaId: fullManga.id,
            sourceId: "mangadex",
            title: "Chapter 1",
            url: "https://mangadex.org/chapter/full-1",
            sortKey: 1,
            chapterNumber: 1,
            volumeNumber: 1,
            publishedAt: 900,
            fetchedAt: 950,
            sourceChapterId: "full-1",
            language: "en"
        }
        const fullChapter2: SourceChapter = {
            ...fullChapter1,
            id: "mangadex:chapter:full-2",
            title: "Chapter 2",
            url: "https://mangadex.org/chapter/full-2",
            sortKey: 2,
            chapterNumber: 2,
            sourceChapterId: "full-2"
        }

        await db.transaction("rw", db.manga, db.sourceLinks, db.chapters, async () => {
            await db.manga.put(fullManga)
            await db.sourceLinks.put(fullSourceLink)
            await db.chapters.bulkPut([fullChapter1, fullChapter2])
        })
        await db.progress.put({
            mangaId: fullManga.id,
            chapterId: fullChapter1.id,
            pageIndex: 9,
            pageCount: 10,
            completed: true,
            updatedAt: 1_400
        })
        await db.historyEvents.bulkAdd([
            { mangaId: fullManga.id, chapterId: fullChapter1.id, type: "started", occurredAt: 1_300 },
            { mangaId: fullManga.id, chapterId: fullChapter1.id, type: "completed", occurredAt: 1_400 }
        ])
        const bookmark: PageBookmark = {
            id: `${fullChapter1.id}:0`,
            mangaId: fullManga.id,
            chapterId: fullChapter1.id,
            pageIndex: 0,
            mangaTitle: fullManga.title,
            chapterTitle: fullChapter1.title,
            chapterUrl: fullChapter1.url,
            addedAt: 1_350
        }
        await db.pageBookmarks.put(bookmark)

        const exported = await exportDatabase()

        await Promise.all([
            db.manga.clear(),
            db.sourceLinks.clear(),
            db.chapters.clear(),
            db.progress.clear(),
            db.historyEvents.clear(),
            db.pageBookmarks.clear()
        ])

        const result = await importDatabase(exported)
        expect(result.skipped).toEqual([])

        const reimported = await exportDatabase()

        expect(reimported.data.manga).toEqual(exported.data.manga)
        expect(reimported.data.sourceLinks).toEqual(exported.data.sourceLinks)
        expect(reimported.data.chapters).toEqual(exported.data.chapters)
        expect(reimported.data.progress).toEqual(exported.data.progress)
        expect(reimported.data.pageBookmarks).toEqual(exported.data.pageBookmarks)
        // historyEvents ids are intentionally NOT preserved on import (see
        // importDatabase's comment on stripping foreign auto-increment ids) - compare
        // modulo id, but still assert both events survived the round-trip.
        expect(reimported.data.historyEvents.map(({ id: _id, ...rest }) => rest)).toEqual(
            exported.data.historyEvents.map(({ id: _id, ...rest }) => rest)
        )
        expect(reimported.data.historyEvents).toHaveLength(2)
    })
})

describe("chapter DB-shape vs import-schema drift guard (Bug 5)", () => {
    it("chapters written through saveResolvedChapter (the real chapter-write path) validate cleanly against the export/import schema", async () => {
        // sourceChapter is typed as the real @amr/source-sdk SourceChapter - if that
        // type ever grows a new required field, this object literal fails to compile,
        // forcing the schema below to be updated in the same change instead of a user
        // discovering the mismatch via a failed import.
        const sourceChapter: SourceChapter = {
            id: "mangadex:chapter:drift-1",
            mangaId: manga.id,
            sourceId: "mangadex",
            title: "Chapter 1",
            url: "https://mangadex.org/chapter/drift-1",
            sortKey: 1,
            sourceChapterId: "drift-1",
            language: "en"
        }
        await saveResolvedChapter({ manga, chapter: sourceChapter, sourceLink })

        const exported = await exportDatabase()
        const parsed = exportEnvelopeSchema.safeParse(exported)
        expect(parsed.success).toBe(true)
    })
})

describe("partial-success import (Bug 3)", () => {
    it("imports valid chapters and reports the invalid one instead of aborting the whole import", async () => {
        const envelope = {
            format: "all-mangas-reader" as const,
            version: 1 as const,
            data: {
                manga: [{ ...manga, sourceId: "mangadex", sourceUrl: "https://mangadex.org/chapter/1" }],
                sourceLinks: [sourceLink],
                chapters: [
                    {
                        id: "mangadex:chapter:1",
                        mangaId: manga.id,
                        sourceId: "mangadex",
                        title: "Chapter 1",
                        url: "https://mangadex.org/chapter/1",
                        sortKey: 1
                    },
                    // Deliberately broken: missing the required `url` field.
                    {
                        id: "mangadex:chapter:2",
                        mangaId: manga.id,
                        sourceId: "mangadex",
                        title: "Chapter 2",
                        sortKey: 2
                    },
                    {
                        id: "mangadex:chapter:3",
                        mangaId: manga.id,
                        sourceId: "mangadex",
                        title: "Chapter 3",
                        url: "https://mangadex.org/chapter/3",
                        sortKey: 3
                    }
                ],
                progress: [],
                historyEvents: [],
                pageBookmarks: []
            }
        }

        const result = await importDatabase(envelope)

        expect(result.manga).toBe(1)
        expect(result.chapters).toBe(2)
        expect(await db.chapters.get("mangadex:chapter:1")).toBeDefined()
        expect(await db.chapters.get("mangadex:chapter:2")).toBeUndefined()
        expect(await db.chapters.get("mangadex:chapter:3")).toBeDefined()

        expect(result.skipped).toHaveLength(1)
        expect(result.skipped[0]).toMatchObject({
            table: "chapters",
            index: 1,
            id: "mangadex:chapter:2",
            code: "MISSING_REQUIRED_FIELD"
        })
    })

    it("skips dependents of a manga record that itself failed validation (referential integrity)", async () => {
        const envelope = {
            format: "all-mangas-reader" as const,
            version: 1 as const,
            data: {
                manga: [
                    // Missing required sourceId/sourceUrl - fails libraryMangaSchema.
                    {
                        id: "broken:manga:1",
                        title: "Broken Manga",
                        normalizedTitle: "broken manga",
                        authors: [],
                        status: "ongoing",
                        addedAt: 1,
                        updatedAt: 1
                    }
                ],
                sourceLinks: [],
                chapters: [
                    {
                        id: "broken:chapter:1",
                        mangaId: "broken:manga:1",
                        sourceId: "mangadex",
                        title: "Chapter 1",
                        url: "https://mangadex.org/chapter/1",
                        sortKey: 1
                    }
                ],
                progress: [],
                historyEvents: [],
                pageBookmarks: []
            }
        }

        const result = await importDatabase(envelope)

        expect(result.manga).toBe(0)
        expect(result.chapters).toBe(0)
        expect(result.skipped).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ table: "manga", index: 0, id: "broken:manga:1" }),
                expect.objectContaining({ table: "chapters", index: 0, id: "broken:manga:1", code: "PARENT_SKIPPED" })
            ])
        )
        expect(await db.chapters.get("broken:chapter:1")).toBeUndefined()
    })
})

describe("pre-import backups (Bug 4)", () => {
    it("createBackup snapshots the current library and listBackups returns it without the full envelope", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })

        await createBackup("pre-import")

        const summaries = await listBackups()
        expect(summaries).toHaveLength(1)
        expect(summaries[0]).toMatchObject({ reason: "pre-import" })
        expect(summaries[0]).not.toHaveProperty("envelope")

        const stored = await db.backups.toArray()
        expect(stored[0]?.envelope.data.manga).toHaveLength(1)
    })

    it("partitioned retention: autos and pre-op snapshots are pruned independently and never evict each other", async () => {
        for (let i = 0; i < 10; i++) await createBackup("auto")
        for (let i = 0; i < 6; i++) await createBackup("pre-import")

        const all = await db.backups.toArray()
        const autos = all.filter(b => b.reason === "auto")
        const safety = all.filter(b => b.reason !== "auto")

        // At most AUTO_MAX (=7) autos and SAFETY_MAX (=5) pre-op snapshots survive.
        expect(autos.length).toBe(7)
        expect(safety.length).toBe(5)
        // A pre-op snapshot survives despite the flood of autos, and vice versa.
        expect(safety.length).toBeGreaterThan(0)
        expect(autos.length).toBeGreaterThan(0)
    })

    it("a burst of daily autos never evicts an existing pre-op safety snapshot", async () => {
        const safetyId = await createBackup("pre-import")
        for (let i = 0; i < 20; i++) await createBackup("auto")

        expect(await db.backups.get(safetyId)).toBeDefined()
        const autos = (await db.backups.toArray()).filter(b => b.reason === "auto")
        expect(autos.length).toBe(7)
    })

    it("many pre-op snapshots never evict an existing auto snapshot", async () => {
        const autoId = await createBackup("auto")
        for (let i = 0; i < 20; i++) await createBackup("pre-import")

        expect(await db.backups.get(autoId)).toBeDefined()
        const safety = (await db.backups.toArray()).filter(b => b.reason !== "auto")
        expect(safety.length).toBe(5)
    })

    it("libraryChangeSignature is 0:0 when empty and changes when a manga is added or updated", async () => {
        expect(await libraryChangeSignature()).toBe("0:0")

        await saveResolvedChapter({ manga, chapter, sourceLink })
        const afterAdd = await libraryChangeSignature()
        expect(afterAdd).not.toBe("0:0")

        await db.manga.update(manga.id, { updatedAt: 9_999_999 })
        const afterUpdate = await libraryChangeSignature()
        expect(afterUpdate).not.toBe(afterAdd)
    })

    it("libraryChangeSignature flips on a metadata-only change that does NOT bump updatedAt", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })
        const before = await libraryChangeSignature()

        // Enrichment path (backfillMangaGenres / refreshExternalMangaMetadata) writes
        // genres/status via a bare db.manga.update that deliberately never bumps
        // updatedAt (so the recently-updated sort doesn't jump). count + max(updatedAt)
        // are therefore unchanged - only the folded metadata hash catches this.
        await db.manga.update(manga.id, { genres: ["Action", "Fantasy"], status: "completed" })
        const afterMeta = await libraryChangeSignature()
        expect(afterMeta).not.toBe(before)

        // A cover-only change is likewise caught.
        const afterMetaCover = await (async () => {
            await db.manga.update(manga.id, { coverUrl: "https://example.com/cover.jpg" })
            return libraryChangeSignature()
        })()
        expect(afterMetaCover).not.toBe(afterMeta)
    })

    it("restoreBackup re-imports the snapshot and itself snapshots a pre-restore backup first", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })
        await createBackup("pre-import")
        const [backup] = await listBackups()

        // Simulate a bad import wiping the library after the backup was taken.
        await db.manga.clear()
        await db.chapters.clear()
        await db.sourceLinks.clear()

        const result = await restoreBackup(backup!.id)

        expect(result.manga).toBe(1)
        expect(await db.manga.get(manga.id)).toBeDefined()
        // Restoring is itself undoable: it should have snapshotted the (now-empty)
        // pre-restore state before applying the restore.
        expect(await db.backups.count()).toBe(2)
    })

    it("restoreBackup throws for an unknown id", async () => {
        await expect(restoreBackup(999)).rejects.toThrow(/no backup/i)
    })

    // The cleanup tool's apply handler needs the id back to hand the user an "Undo"
    // affordance (see handlers/library.ts and App.svelte's cleanup apply flow).
    it("createBackup returns the new backup's id, and accepts the pre-cleanup reason", async () => {
        const id = await createBackup("pre-cleanup")
        expect(typeof id).toBe("number")
        const summaries = await listBackups()
        expect(summaries.find(b => b.id === id)).toMatchObject({ reason: "pre-cleanup" })
    })
})

// Regression for the import/export audit's Bug 2: restoreBackup used to call
// importDatabase(backup.envelope) with no resolutions argument, which defaults to
// merge-style import (existing-wins on most fields, Math.max on chapter numbers).
// A "restore" that merges on top of a bad import instead of replacing it defeats the
// entire point of the safety-net backup feature.
describe("restoreBackup replaces state instead of merging (Bug 2)", () => {
    it("exactly reverts a bad import - junk manga is gone and notes/rating/chapter numbers are back to the pre-import originals, not a merge of the two", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })
        await db.manga.update(manga.id, { notes: "original notes", rating: 3, lastReadChapterNumber: 2 })

        await createBackup("pre-import")
        const [backup] = await listBackups()

        // Apply a "bad" import: existing manga's notes/rating/chapter number clobbered
        // with junk values, plus an unrelated junk manga record added.
        const badEnvelope = {
            format: "all-mangas-reader" as const,
            version: 1 as const,
            data: {
                manga: [
                    {
                        ...manga,
                        sourceId: "mangadex",
                        sourceUrl: sourceLink.url,
                        notes: "BAD notes",
                        rating: 1,
                        lastReadChapterNumber: 999,
                        updatedAt: manga.updatedAt + 10_000
                    },
                    {
                        id: "junk:manga:1",
                        title: "Junk Manga",
                        normalizedTitle: "junk manga",
                        authors: [],
                        status: "ongoing",
                        addedAt: 1,
                        updatedAt: 1,
                        sourceId: "mangadex",
                        sourceUrl: "https://mangadex.org/chapter/junk"
                    }
                ],
                sourceLinks: [],
                chapters: [],
                progress: [],
                historyEvents: [],
                pageBookmarks: []
            }
        }
        await importDatabase(badEnvelope)

        // Sanity check: the bad import actually took effect (merge-mode, existing rating
        // wins... but lastReadChapterNumber uses Math.max, so 999 clobbers in either mode).
        const afterBadImport = await db.manga.get(manga.id)
        expect(afterBadImport?.lastReadChapterNumber).toBe(999)
        expect(await db.manga.get("junk:manga:1")).toBeDefined()

        const result = await restoreBackup(backup!.id)

        expect(result.manga).toBe(1)
        const restored = await db.manga.get(manga.id)
        expect(restored?.notes).toBe("original notes")
        expect(restored?.rating).toBe(3)
        expect(restored?.lastReadChapterNumber).toBe(2)
        expect(await db.manga.get("junk:manga:1")).toBeUndefined()
        expect(await db.manga.count()).toBe(1)
    })

    it("does not wipe db.downloads or db.covers, which are intentionally outside the backup envelope", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })
        await createBackup("pre-import")
        const [backup] = await listBackups()

        await db.downloads.put({
            chapterId: chapter.id,
            mangaId: manga.id,
            pageBlobs: [],
            pageCount: 0,
            downloadedAt: 1
        })
        await db.covers.put({ mangaId: manga.id, blob: new Blob(["x"]), cachedAt: 1 })

        await restoreBackup(backup!.id)

        expect(await db.downloads.get(chapter.id)).toBeDefined()
        expect(await db.covers.get(manga.id)).toBeDefined()
    })
})

// Fix 2: clearImportableTables() and importDatabase() used to be three independent
// commits (createBackup, clear, import) - an SW restart between the clear and the
// import left an empty library with no recovery. They're now wrapped in one
// transaction together (createBackup stays outside it deliberately - see the doc
// comment on restoreBackup). Proving this needs a genuine mid-import write failure,
// not a mock of importDatabase itself (restoreBackup calls it as a same-module
// direct function reference, which a spy on the module's export wouldn't intercept)
// - so this forces db.manga.bulkPut (importDatabase's own write, once the clear has
// already emptied db.manga so the incoming record resolves to "overwrite") to
// reject, and checks the clear was rolled back along with it.
describe("restoreBackup clear+import atomicity (Fix 2)", () => {
    it("rolls back clearImportableTables if importDatabase's own write fails partway through, leaving the library intact", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })
        await createBackup("pre-import")
        const [backup] = await listBackups()

        const bulkPutSpy = vi.spyOn(db.manga, "bulkPut").mockRejectedValueOnce(new Error("boom"))

        await expect(restoreBackup(backup!.id)).rejects.toThrow("boom")

        bulkPutSpy.mockRestore()
        // The clear must have been rolled back along with the failed import - the
        // library must NOT be left empty.
        expect(await db.manga.get(manga.id)).toBeDefined()
        expect(await db.chapters.get(chapter.id)).toBeDefined()
        expect(await db.sourceLinks.get(manga.id)).toBeDefined()
    })
})

describe("import merge - progress and history", () => {
    it("does not regress a completed chapter when the imported progress record is older", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })
        await saveProgress({
            mangaId: manga.id,
            chapterId: chapter.id,
            pageIndex: 9,
            pageCount: 10,
            completed: true,
            updatedAt: 2_000
        })

        const staleEnvelope = {
            format: "all-mangas-reader" as const,
            version: 1 as const,
            data: {
                manga: [],
                sourceLinks: [],
                chapters: [],
                progress: [
                    {
                        mangaId: manga.id,
                        chapterId: chapter.id,
                        pageIndex: 2,
                        pageCount: 10,
                        completed: false,
                        updatedAt: 1_000 // older than what's stored
                    }
                ],
                historyEvents: []
            }
        }

        await importDatabase(staleEnvelope)
        const stored = await db.progress.get(chapter.id)
        expect(stored?.completed).toBe(true)
        expect(stored?.updatedAt).toBe(2_000)
    })

    it("does overwrite when the imported progress record is newer", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })
        await saveProgress({
            mangaId: manga.id,
            chapterId: chapter.id,
            pageIndex: 2,
            pageCount: 10,
            completed: false,
            updatedAt: 1_000
        })

        await importDatabase({
            format: "all-mangas-reader",
            version: 1,
            data: {
                manga: [],
                sourceLinks: [],
                chapters: [],
                progress: [
                    {
                        mangaId: manga.id,
                        chapterId: chapter.id,
                        pageIndex: 9,
                        pageCount: 10,
                        completed: true,
                        updatedAt: 2_000
                    }
                ],
                historyEvents: []
            }
        })
        const stored = await db.progress.get(chapter.id)
        expect(stored?.completed).toBe(true)
    })

    it("does not let a foreign backup's history event id collide with local history", async () => {
        // Simulate a local history event that happens to occupy auto-increment id 1.
        await db.historyEvents.add({
            mangaId: manga.id,
            chapterId: "local-chapter",
            type: "started",
            occurredAt: 1_000
        })
        const localEvents = await db.historyEvents.toArray()
        expect(localEvents).toHaveLength(1)
        const localId = localEvents[0]!.id!

        // A backup from a different profile whose own auto-increment also started at 1 -
        // importing it must not silently overwrite the unrelated local event above. The
        // event's parent manga travels in the same envelope so it isn't dropped as an
        // orphan (see the parent-validity guard in importDatabase).
        await importDatabase({
            format: "all-mangas-reader",
            version: 1,
            data: {
                manga: [
                    {
                        id: "other:manga:xyz",
                        title: "Other Manga",
                        normalizedTitle: "other manga",
                        authors: [],
                        status: "ongoing",
                        addedAt: 1,
                        updatedAt: 1,
                        sourceId: "mangadex",
                        sourceUrl: "https://mangadex.org/chapter/other"
                    }
                ],
                sourceLinks: [],
                chapters: [],
                progress: [],
                historyEvents: [
                    {
                        id: localId,
                        mangaId: "other:manga:xyz",
                        chapterId: "foreign-chapter",
                        type: "completed",
                        occurredAt: 5_000
                    }
                ]
            }
        })

        const allEvents = await db.historyEvents.toArray()
        expect(allEvents).toHaveLength(2)
        expect(allEvents.some(e => e.chapterId === "local-chapter")).toBe(true)
        expect(allEvents.some(e => e.chapterId === "foreign-chapter")).toBe(true)
    })

    it("unions categories instead of one side winning outright on merge", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })
        await db.manga.update(manga.id, { categories: ["local-tag"] })

        const importedManga: LibraryManga = {
            ...manga,
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/title/abc",
            categories: ["imported-tag"]
        }

        await importDatabase(
            {
                format: "all-mangas-reader",
                version: 1,
                data: {
                    manga: [importedManga],
                    sourceLinks: [],
                    chapters: [],
                    progress: [],
                    historyEvents: []
                }
            },
            { [manga.id]: "merge" }
        )

        const stored = await db.manga.get(manga.id)
        expect(stored?.categories?.sort()).toEqual(["imported-tag", "local-tag"])
    })

    it("preserves an existing per-series noGapContinuous override over an imported one", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })
        await db.manga.update(manga.id, { noGapContinuous: true })

        const importedManga: LibraryManga = {
            ...manga,
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/title/abc",
            noGapContinuous: false
        }

        await importDatabase(
            {
                format: "all-mangas-reader",
                version: 1,
                data: {
                    manga: [importedManga],
                    sourceLinks: [],
                    chapters: [],
                    progress: [],
                    historyEvents: []
                }
            },
            { [manga.id]: "merge" }
        )

        const stored = await db.manga.get(manga.id)
        expect(stored?.noGapContinuous).toBe(true)
    })
})

describe("cacheCover orphan guard", () => {
    it("skips writing a covers row for a manga that no longer exists", async () => {
        const blob = new Blob(["x"], { type: "image/jpeg" })
        await cacheCover("nonexistent:manga:gone", blob)
        expect(await db.covers.get("nonexistent:manga:gone")).toBeUndefined()
    })

    it("still caches the cover when the manga exists", async () => {
        const manga: LibraryManga = {
            id: "src:manga:live",
            title: "Live",
            normalizedTitle: "live",
            authors: [],
            status: "unknown",
            addedAt: 1,
            updatedAt: 1,
            sourceId: "src",
            sourceUrl: "https://example.test/c1"
        }
        await db.manga.put(manga)
        await cacheCover(manga.id, new Blob(["y"], { type: "image/jpeg" }))
        expect(await db.covers.get(manga.id)).toBeDefined()
    })
})

describe("trackExternalChapter", () => {
    it("derives distinct chapter records from episode_no query params, not just the word 'chapter'", async () => {
        const first = await trackExternalChapter({
            url: "https://www.webtoons.com/en/fantasy/slug/ep-1/viewer?title_no=99&episode_no=1",
            sourceId: "webtoons",
            mangaInfo: { sourceMangaId: "99", mangaUrl: "https://www.webtoons.com/en/fantasy/slug/" }
        })
        const second = await trackExternalChapter({
            url: "https://www.webtoons.com/en/fantasy/slug/ep-2/viewer?title_no=99&episode_no=2",
            sourceId: "webtoons",
            mangaInfo: { sourceMangaId: "99", mangaUrl: "https://www.webtoons.com/en/fantasy/slug/" }
        })

        expect(first.mangaId).toBe(second.mangaId)
        expect(first.chapterNumber).toBe(1)
        expect(second.chapterNumber).toBe(2)

        const chapters = await db.chapters.where("mangaId").equals(first.mangaId).toArray()
        expect(chapters).toHaveLength(2)
        expect(new Set(chapters.map(c => c.id)).size).toBe(2)
    })

    it("matches a rotated Asura slug to the existing entry + parses /chapter/N, no duplicate (S2/S3)", async () => {
        const base = (s: string) => s.replace(/^\d{4,}-/, "").replace(/-[a-f0-9]{8}$/i, "")
        await db.manga.put({
            id: "asurascans:manga:dungeon-odyssey-aaaa1111",
            title: "Dungeon Odyssey",
            normalizedTitle: "dungeon odyssey",
            sourceId: "asurascans",
            authors: [],
            status: "unknown",
            addedAt: 1,
            updatedAt: 1,
            sourceMangaId: "dungeon-odyssey-aaaa1111",
            mangaUrl: "https://asuracomic.net/series/dungeon-odyssey-aaaa1111/",
            sourceUrl: "https://asuracomic.net/series/dungeon-odyssey-aaaa1111/"
        })

        const res = await trackExternalChapter({
            url: "https://asuracomic.net/series/dungeon-odyssey-bbbb2222/chapter/100",
            sourceId: "asurascans",
            mangaInfo: {
                sourceMangaId: "dungeon-odyssey-bbbb2222",
                mangaUrl: "https://asuracomic.net/series/dungeon-odyssey-bbbb2222/"
            },
            normalizeSlug: base
        })

        expect(res.created).toBe(false)
        expect(res.mangaId).toBe("asurascans:manga:dungeon-odyssey-aaaa1111")
        expect(res.chapterNumber).toBe(100)
        expect(await db.manga.count()).toBe(1)
        const stored = await db.manga.get("asurascans:manga:dungeon-odyssey-aaaa1111")
        expect(stored?.sourceMangaId).toBe("dungeon-odyssey-bbbb2222")
        expect(stored?.mangaUrl).toContain("bbbb2222")
        // The tracked chapter parsed a real number, not an "External chapter" placeholder.
        const chapters = await db.chapters.where("mangaId").equals(res.mangaId).toArray()
        expect(chapters.some(c => c.sortKey === 100 && /100/.test(c.title))).toBe(true)
    })

    it("persists sourceMangaId on the created manga AND source link so future refreshes can run", async () => {
        // Without sourceMangaId on the link, listMangaChapters throws "The source link
        // cannot be refreshed" on every background update - the external-tracked title
        // would show a chapter count once (from the add-time list prime) and never again.
        const result = await trackExternalChapter({
            url: "https://mangahub.io/chapter/solo-leveling/chapter-105",
            sourceId: "mangahub",
            mangaInfo: { sourceMangaId: "solo-leveling", mangaUrl: "https://mangahub.io/manga/solo-leveling" }
        })

        expect(result.created).toBe(true)
        const manga = await db.manga.get(result.mangaId)
        expect(manga?.sourceMangaId).toBe("solo-leveling")
        const link = await db.sourceLinks.get(result.mangaId)
        expect(link?.sourceMangaId).toBe("solo-leveling")
    })

    it("does not treat a MangaHub internal-id chapter URL as a real chapter number", async () => {
        // MangaHub URLs are /chapter/{slug}/chapter-{N} where N can be an internal id
        // (>= 100_000). Parsing it verbatim poisoned the row title/sortKey and the manga's
        // lastReadChapterNumber, showing garbage numbers on the Updates page.
        const result = await trackExternalChapter({
            url: "https://mangahub.io/chapter/solo-leveling_105/chapter-2650123",
            sourceId: "mangahub",
            mangaInfo: { sourceMangaId: "solo-leveling", mangaUrl: "https://mangahub.io/manga/solo-leveling" }
        })

        expect(result.chapterNumber).toBeNull()
        const chapter = await db.chapters.get(`${result.mangaId}:ext:chapter-2650123`)
        expect(chapter?.sortKey).not.toBe(2650123)
        expect(Number.isFinite(chapter?.sortKey ?? Infinity)).toBe(false)
        const manga = await db.manga.get(result.mangaId)
        expect(manga?.lastReadChapterNumber).toBeUndefined()

        // A below-threshold number is still a real chapter number (regression guard).
        const real = await trackExternalChapter({
            url: "https://mangahub.io/chapter/solo-leveling/chapter-42",
            sourceId: "mangahub",
            mangaInfo: { sourceMangaId: "solo-leveling", mangaUrl: "https://mangahub.io/manga/solo-leveling" }
        })
        expect(real.chapterNumber).toBe(42)
    })

    it("marks the visited chapter read and ratchets lastReadChapterNumber forward only", async () => {
        // Reading on the source site (auto-capture -> completed:true) must advance progress.
        await trackExternalChapter({
            url: "https://mangahub.io/chapter/x-title/chapter-5",
            sourceId: "mangahub",
            completed: true,
            mangaInfo: { sourceMangaId: "x-title", mangaUrl: "https://mangahub.io/manga/x-title" }
        })
        let manga = await trackExternalChapter({
            url: "https://mangahub.io/chapter/x-title/chapter-10",
            sourceId: "mangahub",
            completed: true,
            mangaInfo: { sourceMangaId: "x-title", mangaUrl: "https://mangahub.io/manga/x-title" }
        }).then(r => db.manga.get(r.mangaId))
        expect(manga?.lastReadChapterNumber).toBe(10)

        // Re-opening an earlier chapter must NOT regress the furthest-read position.
        manga = await trackExternalChapter({
            url: "https://mangahub.io/chapter/x-title/chapter-3",
            sourceId: "mangahub",
            completed: true,
            mangaInfo: { sourceMangaId: "x-title", mangaUrl: "https://mangahub.io/manga/x-title" }
        }).then(r => db.manga.get(r.mangaId))
        expect(manga?.lastReadChapterNumber).toBe(10)
    })

    it("createIfMissing:false marks read for an existing title but never creates a new one", async () => {
        // mark-read-on-visit with auto-add off: an untracked title records nothing.
        const missing = await trackExternalChapter({
            url: "https://mangahub.io/chapter/never-added/chapter-1",
            sourceId: "mangahub",
            completed: true,
            createIfMissing: false,
            mangaInfo: { sourceMangaId: "never-added", mangaUrl: "https://mangahub.io/manga/never-added" }
        })
        expect(missing.tracked).toBe(false)
        expect(await db.manga.get("mangahub:manga:never-added")).toBeUndefined()

        // An already-tracked title still advances.
        await db.manga.put({
            id: "mangahub:manga:tracked",
            title: "Tracked",
            normalizedTitle: "tracked",
            sourceId: "mangahub",
            authors: [],
            status: "unknown",
            addedAt: 1,
            updatedAt: 1,
            sourceMangaId: "tracked",
            mangaUrl: "https://mangahub.io/manga/tracked",
            sourceUrl: "https://mangahub.io/manga/tracked"
        })
        const hit = await trackExternalChapter({
            url: "https://mangahub.io/chapter/tracked/chapter-7",
            sourceId: "mangahub",
            completed: true,
            createIfMissing: false,
            mangaInfo: { sourceMangaId: "tracked", mangaUrl: "https://mangahub.io/manga/tracked" }
        })
        expect(hit.tracked).toBe(true)
        expect((await db.manga.get("mangahub:manga:tracked"))?.lastReadChapterNumber).toBe(7)
    })

    it("does not adopt an internal-id-sized /chapter/<id> as a number for any source", async () => {
        // The widened regex now parses a bare /chapter/<numericId>, so the internal-id floor
        // must apply to every source (not just mangahub) or a numeric-id site mints a poisoned
        // row with a bogus sortKey that freezes lastReadChapterNumber.
        const result = await trackExternalChapter({
            url: "https://somesite.com/chapter/998877",
            sourceId: "somesite",
            mangaInfo: { sourceMangaId: "some-series", mangaUrl: "https://somesite.com/manga/some-series" }
        })
        expect(result.chapterNumber).toBeNull()
        expect((await db.manga.get(result.mangaId))?.lastReadChapterNumber).toBeUndefined()

        // A normal chapter number on the same non-mangahub source is still parsed.
        const real = await trackExternalChapter({
            url: "https://somesite.com/chapter/42",
            sourceId: "somesite",
            mangaInfo: { sourceMangaId: "some-series", mangaUrl: "https://somesite.com/manga/some-series" }
        })
        expect(real.chapterNumber).toBe(42)
    })

    it("clampPoisonedMangahubLocally cascades: deletes progress/history for the phantom chapters it removes", async () => {
        const mangaId = "mangahub:manga:x"
        await db.manga.put({
            id: mangaId,
            title: "X",
            normalizedTitle: "x",
            sourceId: "mangahub",
            sourceUrl: "https://mangahub.io/manga/x",
            authors: [],
            status: "unknown",
            addedAt: 1,
            updatedAt: 1,
            latestChapterNumber: 2650123
        })
        const realId = `${mangaId}:c5`
        const poisonId = `${mangaId}:ext:chapter-2650123`
        await db.chapters.bulkPut([
            { id: realId, mangaId, sourceId: "mangahub", title: "Chapter 5", url: "u5", sortKey: 5 },
            { id: poisonId, mangaId, sourceId: "mangahub", title: "x", url: "u-poison", sortKey: 2650123 }
        ])
        await db.progress.put({
            chapterId: poisonId,
            mangaId,
            pageIndex: 0,
            pageCount: 1,
            completed: true,
            updatedAt: 1
        } as ReadingProgress)
        await db.historyEvents.add({ mangaId, chapterId: poisonId, type: "completed", occurredAt: 1 } as never)

        const changed = await clampPoisonedMangahubLocally(mangaId)

        expect(changed).toBe(true)
        expect(await db.chapters.get(poisonId)).toBeUndefined()
        expect(await db.progress.get(poisonId)).toBeUndefined()
        expect(await db.historyEvents.where("chapterId").equals(poisonId).count()).toBe(0)
        // The real chapter and its badge survive.
        expect(await db.chapters.get(realId)).toBeDefined()
        expect((await db.manga.get(mangaId))?.latestChapterNumber).toBe(5)
    })

    it("backfills sourceMangaId onto a fallback-matched legacy record (manga + link) when mangaInfo is now available", async () => {
        // Legacy fallback-created record: id derived from a bare slug, and NO sourceMangaId
        // on either the manga or its link. A later capture that DOES carry mangaInfo (the
        // correct id) matches this via the slug fallback (not the direct id lookup) and
        // must heal both records - previously only the created branch stored the id, so
        // this stayed broken forever.
        const legacy: LibraryManga = {
            id: "mangakatana:manga:the-archmages-restaurant",
            title: "The Archmages Restaurant",
            normalizedTitle: "the archmages restaurant",
            authors: [],
            status: "unknown",
            addedAt: 1,
            updatedAt: 1,
            sourceId: "mangakatana",
            sourceUrl: "https://mangakatana.com/manga/the-archmages-restaurant.27314/c100",
            mangaUrl: "https://mangakatana.com/manga/the-archmages-restaurant.27314"
        }
        await db.manga.put(legacy)
        await db.sourceLinks.put({
            mangaId: legacy.id,
            sourceId: "mangakatana",
            url: legacy.mangaUrl!,
            title: legacy.title,
            addedAt: 1,
            updatedAt: 1
        })

        const result = await trackExternalChapter({
            url: "https://mangakatana.com/manga/the-archmages-restaurant.27314/c143",
            sourceId: "mangakatana",
            mangaInfo: {
                sourceMangaId: "the-archmages-restaurant.27314",
                mangaUrl: "https://mangakatana.com/manga/the-archmages-restaurant.27314"
            }
        })

        expect(result.created).toBe(false)
        expect(result.mangaId).toBe(legacy.id)
        expect(await db.manga.count()).toBe(1)
        expect((await db.manga.get(legacy.id))?.sourceMangaId).toBe("the-archmages-restaurant.27314")
        expect((await db.sourceLinks.get(legacy.id))?.sourceMangaId).toBe("the-archmages-restaurant.27314")
    })

    it("matches an existing manga by sourceId:manga:sourceMangaId instead of creating a duplicate", async () => {
        const existing: LibraryManga = {
            id: "webtoons:manga:99",
            title: "Existing Series",
            normalizedTitle: "existing series",
            authors: [],
            status: "ongoing",
            addedAt: 1,
            updatedAt: 1,
            sourceId: "webtoons",
            sourceUrl: "https://www.webtoons.com/en/fantasy/slug/",
            mangaUrl: "https://www.webtoons.com/en/fantasy/slug/"
        }
        await db.manga.put(existing)

        const result = await trackExternalChapter({
            url: "https://www.webtoons.com/en/fantasy/slug/ep-3/viewer?title_no=99&episode_no=3",
            sourceId: "webtoons",
            mangaInfo: { sourceMangaId: "99", mangaUrl: "https://www.webtoons.com/en/fantasy/slug/" }
        })

        expect(result.mangaId).toBe(existing.id)
        expect(await db.manga.count()).toBe(1)
    })

    it("does not cross-contaminate progress onto an unrelated Webtoons title when the direct id lookup misses", async () => {
        // Every Webtoons URL has the shape /<locale>/<genre>/<slug>/... - none of that
        // matches MANGA_PATH_MARKERS, so a naive slug fallback degenerates to the locale
        // token ("en") for every title and spuriously "matches" any two Webtoons titles.
        const unrelated: LibraryManga = {
            id: "webtoons:manga:legacy-unrelated",
            title: "Unrelated Manga",
            normalizedTitle: "unrelated manga",
            authors: [],
            status: "ongoing",
            addedAt: 1,
            updatedAt: 1,
            sourceId: "webtoons",
            sourceUrl: "https://www.webtoons.com/en/fantasy/some-other-manga/list?title_no=1111",
            mangaUrl: "https://www.webtoons.com/en/fantasy/some-other-manga/list?title_no=1111"
        }
        await db.manga.put(unrelated)

        const result = await trackExternalChapter({
            url: "https://www.webtoons.com/en/action/hero-killer/episode-271/viewer?title_no=2745&episode_no=271",
            sourceId: "webtoons",
            mangaInfo: {
                sourceMangaId: "2745",
                mangaUrl: "https://www.webtoons.com/en/action/hero-killer/list?title_no=2745"
            }
        })

        // Must create/track a distinct "Hero Killer" (title_no=2745) record - not silently
        // attach progress to the unrelated title_no=1111 record via the degenerate
        // host+locale slug match.
        expect(result.mangaId).not.toBe(unrelated.id)
        expect(await db.manga.count()).toBe(2)
        const untouched = await db.manga.get(unrelated.id)
        expect(untouched?.lastReadChapterNumber).toBeUndefined()
    })

    it("reuses an existing Webtoons entry matched by title_no when its id predates the sourceId:manga:sourceMangaId scheme", async () => {
        // Simulates a legacy-imported (or otherwise differently-keyed) library entry whose
        // stored mangaUrl is the older .../list?title_no=X shape, matched against a newer
        // series-prefix chapter URL that also carries title_no.
        const legacyHeroKiller: LibraryManga = {
            id: "webtoons:manga:legacy-hero-killer",
            title: "Hero Killer",
            normalizedTitle: "hero killer",
            authors: [],
            status: "ongoing",
            addedAt: 1,
            updatedAt: 1,
            sourceId: "webtoons",
            sourceUrl: "https://www.webtoons.com/en/action/hero-killer/list?title_no=2745",
            mangaUrl: "https://www.webtoons.com/en/action/hero-killer/list?title_no=2745"
        }
        await db.manga.put(legacyHeroKiller)

        const result = await trackExternalChapter({
            url: "https://www.webtoons.com/en/action/hero-killer/episode-271/viewer?title_no=2745&episode_no=271",
            sourceId: "webtoons",
            mangaInfo: {
                sourceMangaId: "2745",
                mangaUrl: "https://www.webtoons.com/en/action/hero-killer/list?title_no=2745"
            }
        })

        expect(result.mangaId).toBe(legacyHeroKiller.id)
        expect(await db.manga.count()).toBe(1)
        const stored = await db.manga.get(legacyHeroKiller.id)
        expect(stored?.lastReadChapterNumber).toBe(271)
    })

    it("still matches non-Webtoons hosts via the path-marker slug fallback (regression guard)", async () => {
        const existing: LibraryManga = {
            id: "genericsource:manga:legacy-one-piece",
            title: "One Piece",
            normalizedTitle: "one piece",
            authors: [],
            status: "ongoing",
            addedAt: 1,
            updatedAt: 1,
            sourceId: "genericsource",
            sourceUrl: "https://example.com/manga/one-piece/",
            mangaUrl: "https://example.com/manga/one-piece/"
        }
        await db.manga.put(existing)

        // Different marker segment ("read" vs "manga") so the raw startsWith prefix check
        // fails and this only succeeds via the marker-based slug fallback.
        const result = await trackExternalChapter({
            url: "https://example.com/read/one-piece/chapter-5",
            sourceId: "genericsource"
        })

        expect(result.mangaId).toBe(existing.id)
        expect(await db.manga.count()).toBe(1)
    })

    // Regression for the import/export audit's Bug 3: the mangaUrl prefix match used
    // `input.url.startsWith(m.mangaUrl.replace(/\/$/, ""))` with no word-boundary check,
    // so ".../manga/solo-leveling" was treated as a prefix match for
    // ".../manga/solo-leveling-ragnarok/chapter-3" - a real, different manga with a
    // similarly-prefixed slug - incorrectly attributing its reading progress to the
    // wrong title instead of failing to match (or creating a new entry).
    it("does not attribute a chapter to an unrelated manga whose mangaUrl is a prefix of the chapter URL's slug, without a '/' boundary (Bug 3)", async () => {
        const soloLeveling: LibraryManga = {
            id: "genericsource:manga:solo-leveling",
            title: "Solo Leveling",
            normalizedTitle: "solo leveling",
            authors: [],
            status: "ongoing",
            addedAt: 1,
            updatedAt: 1,
            sourceId: "genericsource",
            sourceUrl: "https://example.com/manga/solo-leveling/",
            mangaUrl: "https://example.com/manga/solo-leveling"
        }
        await db.manga.put(soloLeveling)

        const result = await trackExternalChapter({
            url: "https://example.com/manga/solo-leveling-ragnarok/chapter-3",
            sourceId: "genericsource"
        })

        expect(result.mangaId).not.toBe(soloLeveling.id)
        expect(await db.manga.count()).toBe(2)
        const untouched = await db.manga.get(soloLeveling.id)
        expect(untouched?.lastReadChapterNumber).toBeUndefined()
    })

    it("still matches via mangaUrl prefix when the boundary is a '/' (regression guard for the Bug 3 fix)", async () => {
        const existing: LibraryManga = {
            id: "genericsource:manga:solo-leveling",
            title: "Solo Leveling",
            normalizedTitle: "solo leveling",
            authors: [],
            status: "ongoing",
            addedAt: 1,
            updatedAt: 1,
            sourceId: "genericsource",
            sourceUrl: "https://example.com/manga/solo-leveling/",
            mangaUrl: "https://example.com/manga/solo-leveling/"
        }
        await db.manga.put(existing)

        const result = await trackExternalChapter({
            url: "https://example.com/manga/solo-leveling/chapter-3",
            sourceId: "genericsource"
        })

        expect(result.mangaId).toBe(existing.id)
        expect(await db.manga.count()).toBe(1)
    })

    it("prefers a same-source slug match over a cross-source URL-prefix match now that same-source candidates are checked first (indexed reorder)", async () => {
        // Neither row satisfies the other row's matcher: the same-source row's mangaUrl isn't
        // a URL-prefix of the chapter URL, and the cross-source row's mangaUrl derives a
        // different slug. Under the old full-scan-first ordering the cross-source prefix
        // matcher ran first and would have won; the indexed same-source pass now runs first
        // and wins instead.
        const sameSourceMatch: LibraryManga = {
            id: "sourceA:manga:foo",
            title: "Foo Same Source",
            normalizedTitle: "foo same source",
            authors: [],
            status: "ongoing",
            addedAt: 1,
            updatedAt: 1,
            sourceId: "sourceA",
            sourceUrl: "https://sitea.com/comic/foo/details",
            mangaUrl: "https://sitea.com/comic/foo/details"
        }
        const crossSourceMatch: LibraryManga = {
            id: "sourceB:manga:foo",
            title: "Foo Cross Source",
            normalizedTitle: "foo cross source",
            authors: [],
            status: "ongoing",
            addedAt: 1,
            updatedAt: 1,
            sourceId: "sourceB",
            sourceUrl: "https://sitea.com/manga/foo",
            mangaUrl: "https://sitea.com/manga/foo"
        }
        await db.manga.put(sameSourceMatch)
        await db.manga.put(crossSourceMatch)

        const result = await trackExternalChapter({
            url: "https://sitea.com/manga/foo/chapter-5",
            sourceId: "sourceA"
        })

        expect(result.mangaId).toBe(sameSourceMatch.id)
        expect(await db.manga.count()).toBe(2)
    })

    it("still finds a hostname-as-sourceId legacy row via the full-scan cross-source fallback when no same-source candidate exists", async () => {
        // Some legacy/broken-import rows have sourceId set to a bare hostname instead of a real
        // source id (see library:dismiss's hostname-shaped sourceId handling). The indexed
        // same-source query can never find these since their sourceId never equals the real
        // source id being tracked, so they must still be reachable via the full-scan pass.
        const legacyHostnameRow: LibraryManga = {
            id: "example.com:manga:legacy-foo",
            title: "Legacy Foo",
            normalizedTitle: "legacy foo",
            authors: [],
            status: "ongoing",
            addedAt: 1,
            updatedAt: 1,
            sourceId: "example.com",
            sourceUrl: "https://example.com/manga/foo/",
            mangaUrl: "https://example.com/manga/foo/"
        }
        await db.manga.put(legacyHostnameRow)

        const result = await trackExternalChapter({
            url: "https://example.com/manga/foo/chapter-5",
            sourceId: "genericsource"
        })

        expect(result.mangaId).toBe(legacyHostnameRow.id)
        expect(await db.manga.count()).toBe(1)
    })

    // Fix 1: the whole function now runs inside one db.transaction, so an SW-restart-
    // equivalent partial failure (a later write in the same call throwing) rolls back
    // everything, including the manga/sourceLinks rows created earlier in the SAME
    // call - before this fix those committed independently and would have survived.
    it("rolls back the newly-created manga + sourceLink when a later write in the same call fails (atomicity)", async () => {
        const putSpy = vi.spyOn(db.chapters, "put").mockRejectedValueOnce(new Error("boom"))

        await expect(
            trackExternalChapter({
                url: "https://example.com/manga/brand-new-title/chapter-1",
                sourceId: "genericsource"
            })
        ).rejects.toThrow("boom")

        putSpy.mockRestore()
        expect(await db.manga.count()).toBe(0)
        expect(await db.sourceLinks.count()).toBe(0)
        expect(await db.chapters.count()).toBe(0)
    })

    // Fix 7: chapter number lives only in a query string the number regex doesn't
    // recognize (an opaque, non-"no="-suffixed param) - the old fallback key (bare
    // last pathname segment) collided these onto the same chapterId, silently
    // overwriting one chapter's progress with the other's.
    it("gives distinct chapter keys to same-path chapters that differ only by a non-volatile query param the number regex can't parse (Fix 7)", async () => {
        const mangaInfo = { sourceMangaId: "x1", mangaUrl: "https://example.com/manga/x1/" }
        const first = await trackExternalChapter({
            url: "https://example.com/manga/x1/reader?id=7",
            sourceId: "genericsource",
            mangaInfo
        })
        const second = await trackExternalChapter({
            url: "https://example.com/manga/x1/reader?id=8",
            sourceId: "genericsource",
            mangaInfo
        })

        expect(first.mangaId).toBe(second.mangaId)
        const chapters = await db.chapters.where("mangaId").equals(first.mangaId).toArray()
        expect(chapters).toHaveLength(2)
        expect(new Set(chapters.map(c => c.id)).size).toBe(2)
        const p1 = await db.progress.get(chapters.find(c => c.url.endsWith("id=7"))!.id)
        const p2 = await db.progress.get(chapters.find(c => c.url.endsWith("id=8"))!.id)
        expect(p1).toBeDefined()
        expect(p2).toBeDefined()
    })

    // Fix 7: a bare `ch=` param (no "no=" suffix) is now routed into the well-
    // supported ch-N key shape via the extended numberMatch regex - the "better
    // outcome" the fix prefers over falling back to query-string disambiguation.
    it("parses a bare ch= query param (no 'no=' suffix) as the chapter number (Fix 7 regex extension)", async () => {
        const mangaInfo = { sourceMangaId: "x2", mangaUrl: "https://example.com/manga/x2/" }
        const first = await trackExternalChapter({
            url: "https://example.com/manga/x2/reader?ch=7",
            sourceId: "genericsource",
            mangaInfo
        })
        const second = await trackExternalChapter({
            url: "https://example.com/manga/x2/reader?ch=8",
            sourceId: "genericsource",
            mangaInfo
        })

        expect(first.chapterNumber).toBe(7)
        expect(second.chapterNumber).toBe(8)
        expect(first.mangaId).toBe(second.mangaId)
        const chapters = await db.chapters.where("mangaId").equals(first.mangaId).toArray()
        expect(new Set(chapters.map(c => c.id)).size).toBe(2)
    })

    // Fix 7 regression guard: a URL with no query string, and an otherwise-identical
    // URL with only VOLATILE params (utm_source etc.), must still collapse onto the
    // exact same fallback key as before the fix - no migration, no existing tracked
    // chapter loses its id just because a tracking param happens to be present.
    it("keeps the same fallback key for a URL with only volatile query params (Fix 7 regression guard)", async () => {
        const mangaInfo = { sourceMangaId: "x3", mangaUrl: "https://example.com/manga/x3/" }
        const first = await trackExternalChapter({
            url: "https://example.com/manga/x3/reader",
            sourceId: "genericsource",
            mangaInfo
        })
        const second = await trackExternalChapter({
            url: "https://example.com/manga/x3/reader?utm_source=newsletter&fbclid=abc",
            sourceId: "genericsource",
            mangaInfo
        })

        expect(second.mangaId).toBe(first.mangaId)
        const chapters = await db.chapters.where("mangaId").equals(first.mangaId).toArray()
        // Both calls collapsed onto the exact same chapterId - the volatile-only
        // query string never changed the fallback key.
        expect(chapters).toHaveLength(1)
    })

    // Bug fix: a URL with no regex-parseable chapter number used to store sortKey
    // as 0 instead of following the same "no number" sentinel the function's own
    // return value uses (chapterNumber: null). A sortKey of 0 sorted this external
    // chapter before every real numbered chapter in chapter:siblings/chapter:adjacent,
    // and saveProgress's Number.isFinite(chapter.sortKey) guard treated 0 as a real,
    // finite chapter number and clobbered lastReadChapterNumber to 0. sortKey must now
    // be +Infinity - consistent with the same sentinel dynasty-scans.ts/weebcentral.ts/
    // kagane.ts use for an isolated, unparseable chapter - and Number.isFinite(Infinity)
    // is false, so saveProgress correctly leaves lastReadChapterNumber untouched.
    it("stores sortKey as +Infinity, not 0, for an unparseable chapter number, and does not clobber lastReadChapterNumber", async () => {
        const result = await trackExternalChapter({
            url: "https://example.com/manga/x5/reader",
            sourceId: "genericsource"
        })

        expect(result.chapterNumber).toBeNull()
        const chapters = await db.chapters.where("mangaId").equals(result.mangaId).toArray()
        expect(chapters).toHaveLength(1)
        expect(chapters[0]!.sortKey).toBe(Number.POSITIVE_INFINITY)

        const storedManga = await db.manga.get(result.mangaId)
        expect(storedManga?.lastReadChapterNumber).toBeUndefined()
    })
})

describe("rekeyManga", () => {
    const oldId = manga.id
    const newId = "mangadex:manga:new"
    const newSourceLink: SourceLinkRecord = { ...sourceLink, mangaId: newId }

    it("preserves onHold, unions categories, and deletes old-id chapters when merging into an existing duplicate", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })
        await db.manga.update(oldId, {
            onHold: true,
            categories: ["old-tag"],
            rating: 5,
            notes: "old notes",
            noGapContinuous: true
        })

        // A duplicate already exists at the new canonical id (e.g. auto-captured earlier).
        const duplicate: LibraryManga = {
            ...manga,
            id: newId,
            sourceId: "mangadex",
            sourceUrl: newSourceLink.url,
            categories: ["new-tag"],
            addedAt: 500
        }
        await db.manga.put(duplicate)

        // Mirrors what library:relink actually does: build `next` from the old record's
        // preserved user fields before calling rekeyManga - rekeyManga only merges
        // whatever `next` is handed against whatever's already at the new id, it doesn't
        // re-fetch the old record itself.
        const existing = await db.manga.get(oldId)
        const next: LibraryManga = {
            ...manga,
            id: newId,
            sourceId: "mangadex",
            sourceUrl: newSourceLink.url,
            ...(existing?.onHold !== undefined ? { onHold: existing.onHold } : {}),
            ...(existing?.categories !== undefined ? { categories: existing.categories } : {}),
            ...(existing?.rating !== undefined ? { rating: existing.rating } : {}),
            ...(existing?.notes !== undefined ? { notes: existing.notes } : {}),
            ...(existing?.noGapContinuous !== undefined ? { noGapContinuous: existing.noGapContinuous } : {})
        }

        await rekeyManga(oldId, next, newSourceLink)

        const merged = await db.manga.get(newId)
        expect(merged?.onHold).toBe(true)
        expect(merged?.categories?.sort()).toEqual(["new-tag", "old-tag"])
        expect(merged?.rating).toBe(5)
        expect(merged?.notes).toBe("old notes")
        expect(merged?.noGapContinuous).toBe(true)
        expect(merged?.addedAt).toBe(1) // min() of the two addedAt values (1 from `manga`, 500 from the duplicate)

        expect(await db.manga.get(oldId)).toBeUndefined()
        expect(await db.chapters.where("mangaId").equals(oldId).count()).toBe(0)
    })

    it("migrates progress and history events to the new id", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })
        await saveProgress({
            mangaId: oldId,
            chapterId: chapter.id,
            pageIndex: 9,
            pageCount: 10,
            completed: true,
            updatedAt: 1_700_000_000_000
        })

        const next: LibraryManga = { ...manga, id: newId, sourceId: "mangadex", sourceUrl: newSourceLink.url }
        await rekeyManga(oldId, next, newSourceLink)

        expect(await db.progress.where("mangaId").equals(oldId).count()).toBe(0)
        expect(await db.progress.where("mangaId").equals(newId).count()).toBe(1)
        expect(await db.historyEvents.where("mangaId").equals(oldId).count()).toBe(0)
        expect(await db.historyEvents.where("mangaId").equals(newId).count()).toBeGreaterThan(0)
    })

    it("re-keys the manga's cover to the new id (Bug 3)", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })
        await db.covers.put({ mangaId: oldId, blob: new Blob(["old-cover"]), cachedAt: 1 })

        const next: LibraryManga = { ...manga, id: newId, sourceId: "mangadex", sourceUrl: newSourceLink.url }
        await rekeyManga(oldId, next, newSourceLink)

        expect(await db.covers.get(oldId)).toBeUndefined()
        const newCover = await db.covers.get(newId)
        expect(newCover).toBeDefined()
        const bytes = new Uint8Array(await newCover!.blob.arrayBuffer())
        expect(new TextDecoder().decode(bytes)).toBe("old-cover")
    })
})

// Step 1 of the red-teamed performance plan: covers used to be inlined as base64
// data: URIs directly into LibraryManga.coverUrl, bloating library:list, every
// export, and every retained backup. The v8 migration below moves any already-
// inlined cover into the covers table and clears the data: URI off the manga
// record. This exercises the real upgrade path (not a re-implementation of it) by
// seeding a physical v7 database, then reopening the real `db` singleton - whose
// version chain already includes v8 - so Dexie itself detects the stale physical
// version and runs the declared .version(8).upgrade() callback.
describe("database version 8 migration (cover blob extraction)", () => {
    it("moves a data: cover into the covers table and clears coverUrl, leaves http/undefined covers untouched, and skips a malformed record without aborting the migration", async () => {
        db.close()
        await Dexie.delete("all-mangas-reader")

        const validBase64 = btoa("fake-image-bytes")
        const v7Manga = [
            {
                id: "data-uri-manga",
                title: "Data URI Manga",
                normalizedTitle: "data uri manga",
                coverUrl: `data:image/jpeg;base64,${validBase64}`,
                authors: [],
                status: "ongoing",
                sourceId: "mangadex",
                sourceUrl: "https://mangadex.org/chapter/1",
                mangaUrl: "https://mangadex.org/title/1",
                addedAt: 1,
                updatedAt: 1
            },
            {
                id: "http-manga",
                title: "HTTP Manga",
                normalizedTitle: "http manga",
                coverUrl: "https://cdn.example/cover.jpg",
                authors: [],
                status: "ongoing",
                sourceId: "mangadex",
                sourceUrl: "https://mangadex.org/chapter/2",
                mangaUrl: "https://mangadex.org/title/2",
                addedAt: 2,
                updatedAt: 2
            },
            {
                id: "no-cover-manga",
                title: "No Cover Manga",
                normalizedTitle: "no cover manga",
                authors: [],
                status: "ongoing",
                sourceId: "mangadex",
                sourceUrl: "https://mangadex.org/chapter/3",
                mangaUrl: "https://mangadex.org/title/3",
                addedAt: 3,
                updatedAt: 3
            },
            {
                id: "malformed-data-uri-manga",
                title: "Malformed Manga",
                normalizedTitle: "malformed manga",
                coverUrl: "data:image/jpeg;base64,not-valid-base64!!!",
                authors: [],
                status: "ongoing",
                sourceId: "mangadex",
                sourceUrl: "https://mangadex.org/chapter/4",
                mangaUrl: "https://mangadex.org/title/4",
                addedAt: 4,
                updatedAt: 4
            }
        ]

        const legacy = new Dexie("all-mangas-reader")
        legacy.version(7).stores({
            manga: "id, normalizedTitle, sourceId, addedAt, updatedAt",
            sourceLinks: "mangaId, sourceId, sourceMangaId, updatedAt",
            chapters: "id, mangaId, sourceId, sortKey",
            progress: "chapterId, mangaId, updatedAt, completed",
            historyEvents: "++id, mangaId, chapterId, type, occurredAt",
            downloads: "chapterId, mangaId, downloadedAt",
            covers: "mangaId",
            pageBookmarks: "id, mangaId, chapterId, addedAt",
            analyticsEvents: "++id, event, ts, sourceId",
            backups: "++id, createdAt, reason"
        })
        await legacy.open()
        await legacy.table("manga").bulkAdd(v7Manga)
        legacy.close()

        // Reopening the real singleton re-runs Dexie's declared version chain against
        // the physical v7 database just seeded above, executing the real v8 .upgrade().
        await db.open()

        // (a) data: cover -> moved to the covers table, coverUrl cleared.
        const dataUriAfter = await db.manga.get("data-uri-manga")
        expect(dataUriAfter?.coverUrl).toBeUndefined()
        const cachedCover = await db.covers.get("data-uri-manga")
        expect(cachedCover?.blob).toBeInstanceOf(Blob)
        expect(cachedCover?.blob.type).toBe("image/jpeg")
        const bytes = new Uint8Array(await cachedCover!.blob.arrayBuffer())
        expect(new TextDecoder().decode(bytes)).toBe("fake-image-bytes")

        // (b) http:// cover -> completely untouched.
        const httpAfter = await db.manga.get("http-manga")
        expect(httpAfter?.coverUrl).toBe("https://cdn.example/cover.jpg")
        expect(await db.covers.get("http-manga")).toBeUndefined()

        // (c) no cover -> completely untouched.
        const noCoverAfter = await db.manga.get("no-cover-manga")
        expect(noCoverAfter?.coverUrl).toBeUndefined()
        expect(await db.covers.get("no-cover-manga")).toBeUndefined()

        // (d) malformed data: URI -> skipped, doesn't abort the migration for other
        // records (all of the above still ran correctly).
        const malformedAfter = await db.manga.get("malformed-data-uri-manga")
        expect(malformedAfter?.coverUrl).toBe("data:image/jpeg;base64,not-valid-base64!!!")
        expect(await db.covers.get("malformed-data-uri-manga")).toBeUndefined()
    })
})

// Repair migration for the UNNUMBERED_SORT_KEY (Infinity) leak class: profiles
// poisoned by pre-fix aggregation bugs (chapter-cache.ts, updates-sources.ts) already
// carry a non-finite latestChapterNumber in IndexedDB (structured clone keeps
// Infinity), and their backups already fail to restore (JSON.stringify turns it into
// null, then schema.ts's z.number().finite() rejects the whole record). Seeds a
// physical v8 database directly (bypassing the app's own hooks, simulating an
// already-corrupted pre-fix install) then reopens the real singleton so Dexie runs
// the declared v9 .upgrade() for real.
describe("database version 9 migration (Infinity latestChapterNumber repair)", () => {
    it("deletes a non-finite latestChapterNumber field, leaves finite values (including a genuine Chapter 0) and absent fields untouched", async () => {
        db.close()
        await Dexie.delete("all-mangas-reader")

        const v8Manga = [
            {
                id: "poisoned-manga",
                title: "Poisoned Manga",
                normalizedTitle: "poisoned manga",
                authors: [],
                status: "ongoing",
                sourceId: "mangadex",
                sourceUrl: "https://mangadex.org/chapter/1",
                addedAt: 1,
                updatedAt: 1,
                latestChapterNumber: Number.POSITIVE_INFINITY
            },
            {
                id: "nan-manga",
                title: "NaN Manga",
                normalizedTitle: "nan manga",
                authors: [],
                status: "ongoing",
                sourceId: "mangadex",
                sourceUrl: "https://mangadex.org/chapter/2",
                addedAt: 2,
                updatedAt: 2,
                latestChapterNumber: Number.NaN
            },
            {
                id: "healthy-manga",
                title: "Healthy Manga",
                normalizedTitle: "healthy manga",
                authors: [],
                status: "ongoing",
                sourceId: "mangadex",
                sourceUrl: "https://mangadex.org/chapter/3",
                addedAt: 3,
                updatedAt: 3,
                latestChapterNumber: 12
            },
            {
                id: "chapter-zero-manga",
                title: "Chapter Zero Manga",
                normalizedTitle: "chapter zero manga",
                authors: [],
                status: "ongoing",
                sourceId: "mangadex",
                sourceUrl: "https://mangadex.org/chapter/4",
                addedAt: 4,
                updatedAt: 4,
                latestChapterNumber: 0
            },
            {
                id: "no-number-manga",
                title: "No Number Manga",
                normalizedTitle: "no number manga",
                authors: [],
                status: "ongoing",
                sourceId: "mangadex",
                sourceUrl: "https://mangadex.org/chapter/5",
                addedAt: 5,
                updatedAt: 5
            }
        ]

        const legacy = new Dexie("all-mangas-reader")
        legacy.version(8).stores({
            manga: "id, normalizedTitle, sourceId, addedAt, updatedAt",
            sourceLinks: "mangaId, sourceId, sourceMangaId, updatedAt",
            chapters: "id, mangaId, sourceId, sortKey, url",
            progress: "chapterId, mangaId, updatedAt, completed",
            historyEvents: "++id, mangaId, chapterId, type, occurredAt",
            downloads: "chapterId, mangaId, downloadedAt",
            covers: "mangaId",
            pageBookmarks: "id, mangaId, chapterId, addedAt",
            analyticsEvents: "++id, event, ts, sourceId",
            backups: "++id, createdAt, reason"
        })
        await legacy.open()
        await legacy.table("manga").bulkAdd(v8Manga)
        legacy.close()

        // Reopening the real singleton re-runs Dexie's declared version chain against
        // the physical v8 database just seeded above, executing the real v9 .upgrade().
        await db.open()

        const poisoned = await db.manga.get("poisoned-manga")
        expect(poisoned).toBeDefined()
        expect("latestChapterNumber" in (poisoned as Record<string, unknown>)).toBe(false)

        const nanManga = await db.manga.get("nan-manga")
        expect("latestChapterNumber" in (nanManga as Record<string, unknown>)).toBe(false)

        const healthy = await db.manga.get("healthy-manga")
        expect(healthy?.latestChapterNumber).toBe(12)

        const chapterZero = await db.manga.get("chapter-zero-manga")
        expect(chapterZero?.latestChapterNumber).toBe(0)

        const noNumber = await db.manga.get("no-number-manga")
        expect(noNumber?.latestChapterNumber).toBeUndefined()
    })
})

// v11 extends the v9 repair sweep to lastReadChapterNumber. v9 only deleted a
// non-finite latestChapterNumber, so a row with a persisted Infinity in
// lastReadChapterNumber (from a pre-guard cross-source merge or a bad import) never
// self-heals: saveProgress's ratchet gates on `reported >= lastReadChapterNumber`,
// and `>= Infinity` is always false, freezing the read position. Seeds a physical v10
// database directly (pre-fix install), reopens the real singleton so Dexie runs the
// declared v11 .upgrade(), then confirms a subsequent read advances the position.
describe("database version 11 migration (Infinity lastReadChapterNumber repair)", () => {
    it("deletes a non-finite lastReadChapterNumber, keeps finite values (incl. Chapter 0), and unfreezes reading", async () => {
        db.close()
        await Dexie.delete("all-mangas-reader")

        const v10Manga = [
            {
                id: "frozen-manga",
                title: "Frozen Manga",
                normalizedTitle: "frozen manga",
                authors: [],
                status: "ongoing",
                sourceId: "mangadex",
                sourceUrl: "https://mangadex.org/chapter/frozen",
                addedAt: 1,
                updatedAt: 1,
                lastReadChapterId: "mangadex:chapter:frozen-old",
                lastReadChapterNumber: Number.POSITIVE_INFINITY,
                latestChapterNumber: Number.POSITIVE_INFINITY
            },
            {
                id: "healthy-read-manga",
                title: "Healthy Read Manga",
                normalizedTitle: "healthy read manga",
                authors: [],
                status: "ongoing",
                sourceId: "mangadex",
                sourceUrl: "https://mangadex.org/chapter/healthy",
                addedAt: 2,
                updatedAt: 2,
                lastReadChapterNumber: 7
            },
            {
                id: "chapter-zero-read-manga",
                title: "Chapter Zero Read Manga",
                normalizedTitle: "chapter zero read manga",
                authors: [],
                status: "ongoing",
                sourceId: "mangadex",
                sourceUrl: "https://mangadex.org/chapter/zero",
                addedAt: 3,
                updatedAt: 3,
                lastReadChapterNumber: 0
            }
        ]

        const legacy = new Dexie("all-mangas-reader")
        legacy.version(10).stores({
            manga: "id, normalizedTitle, sourceId, addedAt, updatedAt",
            sourceLinks: "mangaId, sourceId, sourceMangaId, updatedAt",
            chapters: "id, mangaId, sourceId, sortKey, url",
            progress: "chapterId, mangaId, updatedAt, completed",
            historyEvents: "++id, mangaId, chapterId, type, occurredAt",
            downloads: "chapterId, mangaId, downloadedAt",
            covers: "mangaId",
            pageBookmarks: "id, mangaId, chapterId, addedAt",
            analyticsEvents: "++id, event, ts, sourceId",
            backups: "++id, createdAt, reason",
            logs: "++id, ts, level"
        })
        await legacy.open()
        await legacy.table("manga").bulkAdd(v10Manga)
        legacy.close()

        // Reopening the real singleton re-runs Dexie's declared version chain against
        // the physical v10 database just seeded above, executing the real v11 .upgrade().
        await db.open()

        const frozen = await db.manga.get("frozen-manga")
        expect(frozen).toBeDefined()
        expect("lastReadChapterNumber" in (frozen as Record<string, unknown>)).toBe(false)
        expect("latestChapterNumber" in (frozen as Record<string, unknown>)).toBe(false)

        const healthy = await db.manga.get("healthy-read-manga")
        expect(healthy?.lastReadChapterNumber).toBe(7)

        const chapterZero = await db.manga.get("chapter-zero-read-manga")
        expect(chapterZero?.lastReadChapterNumber).toBe(0)

        // The read position is no longer frozen: a real read of Ch 42 now advances the
        // ratchet, which the Infinity value would have blocked (42 >= Infinity is false).
        const ch42: ChapterRecord = {
            id: "mangadex:chapter:frozen-42",
            mangaId: "frozen-manga",
            sourceId: "mangadex",
            title: "Chapter 42",
            url: "https://mangadex.org/chapter/frozen-42",
            sortKey: 42
        }
        await db.chapters.put(ch42)
        await saveProgress({
            mangaId: "frozen-manga",
            chapterId: ch42.id,
            pageIndex: 9,
            pageCount: 10,
            completed: true,
            updatedAt: 5_000
        })

        const advanced = await db.manga.get("frozen-manga")
        expect(advanced?.lastReadChapterNumber).toBe(42)
        expect(advanced?.lastReadChapterId).toBe(ch42.id)
    })
})

// library:switch clears a dangling lastReadChapterId (Bug 7). When the read position
// can't be remapped onto the new mirror, the handler passes lastReadChapterId:
// undefined in the patch so switchMangaSource clears it - otherwise the old id would
// keep pointing at the old-source chapter row this same call deletes, breaking
// chapter:resume. lastReadChapterNumber (the source-independent position) is preserved.
describe("switchMangaSource clears a dangling lastReadChapterId (Bug 7)", () => {
    it("drops old-source chapters and clears lastReadChapterId when the patch passes undefined, keeping lastReadChapterNumber", async () => {
        const m: LibraryManga = {
            ...manga,
            id: "switch:manga:1",
            sourceId: "old-source",
            sourceUrl: "https://old.example/chapter/9",
            lastReadChapterId: "old-source:chapter:9",
            lastReadChapterNumber: 9
        }
        const oldChapter: ChapterRecord = {
            id: "old-source:chapter:9",
            mangaId: m.id,
            sourceId: "old-source",
            title: "Chapter 9",
            url: "https://old.example/chapter/9",
            sortKey: 9
        }
        await db.manga.put(m)
        await db.chapters.put(oldChapter)

        const newChapter: ChapterRecord = {
            id: "new-source:chapter:20",
            mangaId: m.id,
            sourceId: "new-source",
            title: "Chapter 20",
            url: "https://new.example/chapter/20",
            sortKey: 20
        }

        await switchMangaSource({
            mangaId: m.id,
            sourceId: "new-source",
            chapters: [newChapter],
            mangaPatch: {
                sourceId: "new-source",
                mangaUrl: "https://new.example/title",
                sourceUrl: newChapter.url,
                latestChapterId: newChapter.id,
                latestChapterNumber: 20,
                // Bug 7: the read position (Ch 9) is below the new mirror's lowest
                // chapter (Ch 20), so it can't be remapped - the handler clears the id.
                lastReadChapterId: undefined,
                updatedAt: Date.now()
            } as unknown as Partial<LibraryManga>,
            numberingUnreliable: false,
            sourceLink: {
                mangaId: m.id,
                sourceId: "new-source",
                url: "https://new.example/title",
                addedAt: m.addedAt,
                updatedAt: Date.now()
            }
        })

        // Old-source chapter row is gone, so the old id would dangle if not cleared.
        expect(await db.chapters.get(oldChapter.id)).toBeUndefined()

        const switched = await db.manga.get(m.id)
        expect(switched?.lastReadChapterId).toBeUndefined()
        // The source-independent read position survives the switch.
        expect(switched?.lastReadChapterNumber).toBe(9)
        expect(switched?.latestChapterId).toBe(newChapter.id)
    })
})

// Choke-point tripwire: a Dexie creating/updating hook on db.manga that throws when
// latestChapterNumber is present and non-finite, so a future unguarded aggregation
// site fails loudly in tests instead of silently corrupting backups. Deleting the
// field (the migration above and the mangahub repair sweep's pattern) must stay legal.
describe("db.manga hook tripwire (non-finite latestChapterNumber)", () => {
    const tripwireManga = (id: string, latestChapterNumber: number): LibraryManga => ({
        ...manga,
        id,
        sourceId: "mangadex",
        sourceUrl: "https://mangadex.org/chapter/1",
        latestChapterNumber
    })

    it("throws when a new manga record is created with a non-finite latestChapterNumber", async () => {
        await expect(db.manga.put(tripwireManga("tripwire-creating", Number.POSITIVE_INFINITY))).rejects.toThrow(
            /non-finite latestChapterNumber/
        )
        expect(await db.manga.get("tripwire-creating")).toBeUndefined()
    })

    it("throws when an existing manga record is updated to a non-finite latestChapterNumber", async () => {
        await db.manga.put(tripwireManga("tripwire-updating", 3))

        await expect(
            db.manga.update("tripwire-updating", { latestChapterNumber: Number.POSITIVE_INFINITY })
        ).rejects.toThrow(/non-finite latestChapterNumber/)

        const stillHealthy = await db.manga.get("tripwire-updating")
        expect(stillHealthy?.latestChapterNumber).toBe(3)
    })

    it("throws for NaN as well as Infinity", async () => {
        await expect(db.manga.put(tripwireManga("tripwire-nan", Number.NaN))).rejects.toThrow(
            /non-finite latestChapterNumber/
        )
    })

    it("allows clearing the field (setting it to undefined) - the repair paths must still work", async () => {
        await db.manga.put(tripwireManga("tripwire-clear", 3))

        // Same idiom the version 8/9 migrations use (tx.table(...) instead of the
        // strongly-typed db.manga) to delete an optional field via update() -
        // exactOptionalPropertyTypes forbids `{ latestChapterNumber: undefined }`
        // against LibraryManga's own optional-but-not-undefined field type.
        await expect(db.table("manga").update("tripwire-clear", { latestChapterNumber: undefined })).resolves.toBe(1)

        const cleared = await db.manga.get("tripwire-clear")
        expect(cleared?.latestChapterNumber).toBeUndefined()
    })

    it("allows a normal finite write through unaffected", async () => {
        await expect(db.manga.put(tripwireManga("tripwire-finite", 7))).resolves.toBe("tripwire-finite")
        expect((await db.manga.get("tripwire-finite"))?.latestChapterNumber).toBe(7)
    })
})

// Verifies the write paths that used to call inlineCover (capture + covers backfill)
// no longer produce a data: URI, and that this holds across an export/import cycle.
describe("export never contains an inlined data: URI cover (Step 1 performance plan)", () => {
    it("round-trips a manga's remote coverUrl through export/import without ever inlining it", async () => {
        const withCover: MangaRecord = {
            ...manga,
            id: "mangadex:manga:with-cover",
            coverUrl: "https://mangadex.org/covers/remote.jpg"
        }
        const chapterForCover: ChapterRecord = {
            ...chapter,
            id: "mangadex:chapter:with-cover",
            mangaId: withCover.id
        }
        const linkForCover: SourceLinkRecord = { ...sourceLink, mangaId: withCover.id }

        await saveResolvedChapter({ manga: withCover, chapter: chapterForCover, sourceLink: linkForCover })

        const exported = await exportDatabase()
        expect(JSON.stringify(exported)).not.toContain("data:image")
        expect(exported.data.manga.find(m => m.id === withCover.id)?.coverUrl).toBe(
            "https://mangadex.org/covers/remote.jpg"
        )

        await db.manga.clear()
        await db.chapters.clear()
        await db.sourceLinks.clear()

        await importDatabase(exported)
        const reimported = await exportDatabase()
        expect(JSON.stringify(reimported)).not.toContain("data:image")
    })
})

describe("getCachedCovers", () => {
    it("returns the full cover row (blob + cachedAt) per requested id and omits ids without a cover", async () => {
        await db.covers.put({ mangaId: "a", blob: new Blob(["x"]), cachedAt: 111 })

        const result = await getCachedCovers(["a", "missing"])

        expect(result.size).toBe(1)
        const row = result.get("a")
        expect(row).toBeDefined()
        expect(row!.cachedAt).toBe(111)
        const bytes = new Uint8Array(await row!.blob.arrayBuffer())
        expect(new TextDecoder().decode(bytes)).toBe("x")
        expect(result.has("missing")).toBe(false)
    })

    it("cacheCover overwrites the row with a fresh cachedAt", async () => {
        // fake-indexeddb's internal scheduling relies on real timers, so the clock
        // is controlled by mocking Date.now directly instead of vi.useFakeTimers(),
        // which would also fake setTimeout and can deadlock an await db.covers.put(...).
        // cacheCover now no-ops for a manga that doesn't exist, so the row must have a
        // backing manga record for this overwrite test to exercise the write path.
        await db.manga.put({
            id: "a",
            title: "A",
            normalizedTitle: "a",
            authors: [],
            status: "unknown",
            addedAt: 1,
            updatedAt: 1,
            sourceId: "src",
            sourceUrl: "https://example.test/c1"
        })
        const nowSpy = vi.spyOn(Date, "now")
        try {
            nowSpy.mockReturnValue(1000)
            await cacheCover("a", new Blob(["v1"]))

            nowSpy.mockReturnValue(2000)
            await cacheCover("a", new Blob(["v2"]))

            const row = await db.covers.get("a")
            expect(row).toBeDefined()
            expect(row!.cachedAt).toBe(2000)
            const bytes = new Uint8Array(await row!.blob.arrayBuffer())
            expect(new TextDecoder().decode(bytes)).toBe("v2")
        } finally {
            nowSpy.mockRestore()
        }
    })
})

describe("addImportedManga dedup (Fixes 1-4)", () => {
    function candidate(o: Partial<LibraryManga> & { id: string; title: string }): LibraryManga {
        return {
            normalizedTitle: normalizeTitle(o.title),
            authors: [],
            status: "ongoing",
            addedAt: 1,
            updatedAt: 1,
            sourceId: "anilist.co",
            sourceUrl: "https://anilist.co/manga/x",
            ...o
        }
    }

    it("dedups against an existing row whose stored normalizedTitle was written under weaker rules (Fix 1)", async () => {
        // Stored normalizedTitle has a trailing space (a weaker write path), so keying off
        // the stored field would miss the match. addImportedManga must recompute both sides.
        await db.manga.put({
            ...manga,
            id: "src:manga:solo",
            title: "Solo Leveling ",
            normalizedTitle: "solo leveling ",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/title/solo"
        })

        const result = await addImportedManga([candidate({ id: "anilist:manga:1", title: "Solo Leveling" })])

        expect(result).toEqual({ imported: 0, skipped: 1 })
        expect(await db.manga.get("anilist:manga:1")).toBeUndefined()
    })

    it("imports two distinct media that share a normalized title within one batch (Fix 2)", async () => {
        const result = await addImportedManga([
            candidate({ id: "anilist:manga:1", title: "ReLIFE", anilistId: 1 }),
            candidate({ id: "anilist:manga:2", title: "ReLIFE", anilistId: 2 })
        ])

        expect(result).toEqual({ imported: 2, skipped: 0 })
        expect(await db.manga.get("anilist:manga:1")).toBeDefined()
        expect(await db.manga.get("anilist:manga:2")).toBeDefined()
    })

    it("backfills anilistId onto a title-colliding existing entry that has none, counting the candidate as skipped (Fix 3)", async () => {
        await db.manga.put({
            ...manga,
            id: "src:manga:berserk",
            title: "Berserk",
            normalizedTitle: "berserk",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/title/berserk"
        })

        const result = await addImportedManga([candidate({ id: "anilist:manga:42", title: "Berserk", anilistId: 42 })])

        expect(result).toEqual({ imported: 0, skipped: 1 })
        expect((await db.manga.get("src:manga:berserk"))?.anilistId).toBe(42)
        expect(await db.manga.get("anilist:manga:42")).toBeUndefined()
    })

    it("dedups two candidates that share an id so bulkPut can't collapse them into one silent import (Fix 4)", async () => {
        const result = await addImportedManga([
            candidate({ id: "dup:manga:1", title: "First" }),
            candidate({ id: "dup:manga:1", title: "Second" })
        ])

        expect(result).toEqual({ imported: 1, skipped: 1 })
        expect(await db.manga.count()).toBe(1)
    })
})

describe("saveProgress ratchets the furthest-read position (Fix 5)", () => {
    it("does not regress lastReadChapterNumber when an earlier chapter is re-read", async () => {
        const m: MangaRecord = { ...manga, id: "ratchet:manga:1" }
        const ch100: ChapterRecord = {
            id: "ratchet:ch100",
            mangaId: m.id,
            sourceId: "mangadex",
            title: "Chapter 100",
            url: "https://mangadex.org/chapter/ratchet-100",
            sortKey: 100
        }
        const ch5: ChapterRecord = {
            id: "ratchet:ch5",
            mangaId: m.id,
            sourceId: "mangadex",
            title: "Chapter 5",
            url: "https://mangadex.org/chapter/ratchet-5",
            sortKey: 5
        }
        await saveResolvedChapter({
            manga: m,
            chapter: ch100,
            sourceLink: { ...sourceLink, mangaId: m.id },
            chapters: [ch100, ch5]
        })

        await saveProgress({
            mangaId: m.id,
            chapterId: ch100.id,
            pageIndex: 9,
            pageCount: 10,
            completed: true,
            updatedAt: 1_000
        })
        await saveProgress({
            mangaId: m.id,
            chapterId: ch5.id,
            pageIndex: 3,
            pageCount: 10,
            completed: true,
            updatedAt: 2_000
        })

        const stored = await db.manga.get(m.id)
        // Furthest position stays at ch100; re-reading ch5 must not un-read ch6-100.
        expect(stored?.lastReadChapterNumber).toBe(100)
        expect(stored?.lastReadChapterId).toBe(ch100.id)
        expect(stored?.lastReadAt).toBe(1_000)
        // The re-read is still recorded on ch5's own progress row.
        expect((await db.progress.get(ch5.id))?.completed).toBe(true)
    })
})

describe("mergeMangaRecords repairs a dangling id it creates (Fix 6)", () => {
    it("repoints an adopted-then-deleted loser latestChapterId onto a surviving chapter", async () => {
        const primary: LibraryManga = {
            ...manga,
            id: "mangadex:manga:danglingprimary",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/danglingprimary",
            mangaUrl: "https://mangadex.org/title/danglingprimary",
            latestChapterNumber: 3,
            latestChapterId: "p:ch3"
        }
        const loser: LibraryManga = {
            ...manga,
            id: "mangadex:manga:danglingloser",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/danglingloser",
            mangaUrl: "https://mangadex.org/title/danglingloser",
            latestChapterNumber: 10,
            latestChapterId: "l:ch10"
        }
        await db.manga.bulkPut([primary, loser])
        await db.chapters.bulkPut([
            { id: "p:ch3", mangaId: primary.id, sourceId: "mangadex", title: "Ch.3", url: "https://x/p3", sortKey: 3 },
            { id: "l:ch10", mangaId: loser.id, sourceId: "mangadex", title: "Ch.10", url: "https://x/l10", sortKey: 10 }
        ])

        const merged = await mergeMangaRecords(primary.id, [loser.id])

        // The merge adopted the loser's higher number but its chapter row was deleted -
        // latestChapterId must resolve to a chapter that still exists, not the dangling one.
        expect(merged.latestChapterId).toBe("p:ch3")
        expect(await db.chapters.get(merged.latestChapterId!)).toBeDefined()
    })
})

describe("restoreBackup sweeps orphaned covers/downloads (Fix 7)", () => {
    it("deletes a cover row whose manga is absent from the restored backup", async () => {
        await saveResolvedChapter({ manga, chapter, sourceLink })
        await createBackup("pre-import")
        const [backup] = await listBackups()

        // A title added AFTER the backup, with a cover - absent from the backup envelope.
        await db.manga.put({
            ...manga,
            id: "later:manga:b",
            title: "Later B",
            normalizedTitle: "later b",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/chapter/later-b"
        })
        await db.covers.put({ mangaId: "later:manga:b", blob: new Blob(["b-cover"]), cachedAt: 1 })

        await restoreBackup(backup!.id)

        expect(await db.manga.get("later:manga:b")).toBeUndefined()
        expect(await db.covers.get("later:manga:b")).toBeUndefined()
    })
})

describe("mergeManga keeps live identity + enrichment over an older import (Fix 8)", () => {
    it("does not revert sourceId or drop anilistId/genres when merging an older backup with a higher updatedAt", async () => {
        const live: LibraryManga = {
            ...manga,
            id: "mangadex:manga:enriched",
            sourceId: "newsource",
            sourceUrl: "https://newsource.example/chapter/enriched",
            mangaUrl: "https://newsource.example/title/enriched",
            anilistId: 12345,
            genres: ["Action"],
            metadataUpdatedAt: 5_000,
            addedAt: 50,
            updatedAt: 100
        }
        await db.manga.put(live)

        const olderBackup = {
            format: "all-mangas-reader" as const,
            version: 1 as const,
            data: {
                manga: [
                    {
                        ...manga,
                        id: live.id,
                        sourceId: "mangadex",
                        sourceUrl: "https://mangadex.org/chapter/enriched",
                        mangaUrl: "https://mangadex.org/title/enriched",
                        addedAt: 40,
                        updatedAt: 200
                    }
                ],
                sourceLinks: [],
                chapters: [],
                progress: [],
                historyEvents: [],
                pageBookmarks: []
            }
        }

        await importDatabase(olderBackup)

        const merged = await db.manga.get(live.id)
        expect(merged?.anilistId).toBe(12345)
        expect(merged?.genres).toEqual(["Action"])
        expect(merged?.metadataUpdatedAt).toBe(5_000)
        expect(merged?.sourceId).toBe("newsource")
        expect(merged?.sourceUrl).toBe("https://newsource.example/chapter/enriched")
        expect(merged?.mangaUrl).toBe("https://newsource.example/title/enriched")
        // Timestamps still move forward.
        expect(merged?.updatedAt).toBe(200)
        expect(merged?.addedAt).toBe(40)
    })
})

describe("importDatabase drops dependents with no parent manga anywhere (Fix 9)", () => {
    it("does not write a progress row whose mangaId is absent from the envelope and the local library", async () => {
        const envelope = {
            format: "all-mangas-reader" as const,
            version: 1 as const,
            data: {
                manga: [],
                sourceLinks: [],
                chapters: [],
                progress: [
                    {
                        mangaId: "ghost",
                        chapterId: "ghost:ch1",
                        pageIndex: 0,
                        pageCount: 10,
                        completed: false,
                        updatedAt: 1_000
                    }
                ],
                historyEvents: [],
                pageBookmarks: []
            }
        }

        await importDatabase(envelope)

        expect(await db.progress.get("ghost:ch1")).toBeUndefined()
        expect(await db.progress.count()).toBe(0)
    })
})

describe("getAnalyticsSummary (Stats tab data)", () => {
    beforeEach(async () => {
        // The shared beforeEach clears db.manga but not the events table.
        await db.analyticsEvents.clear()
    })

    const put = (id: string, over: Partial<LibraryManga>) =>
        db.manga.put({
            id,
            title: id,
            normalizedTitle: normalizeTitle(id),
            authors: [],
            status: "ongoing",
            addedAt: 1,
            updatedAt: 1,
            sourceId: "mangadex",
            sourceUrl: `https://mangadex.org/title/${id}`,
            ...over
        })

    it("aggregates status, genre and author distributions across the whole library", async () => {
        await put("a", { status: "ongoing", genres: ["Action", "Drama"], authors: ["Kubo"] })
        await put("b", { status: "ongoing", genres: ["Action"], authors: ["Kubo"] })
        await put("c", { status: "completed", genres: ["Comedy"], authors: ["Oda"] })
        await put("d", { status: "unknown" })

        const s = await getAnalyticsSummary()

        expect(Object.fromEntries(s.statusBreakdown.map(x => [x.status, x.count]))).toEqual({
            ongoing: 2,
            completed: 1,
            unknown: 1
        })
        const genres = Object.fromEntries(s.topGenres.map(x => [x.genre, x.count]))
        expect(genres.Action).toBe(2)
        expect(genres.Drama).toBe(1)
        expect(genres.Comedy).toBe(1)
        const authors = Object.fromEntries(s.topAuthors.map(x => [x.author, x.count]))
        expect(authors.Kubo).toBe(2)
        expect(authors.Oda).toBe(1)
    })

    it("computes capture/reader/error rates from recent events and ignores events outside the window", async () => {
        const now = Date.now()
        await recordAnalyticsEvent({ event: "capture_ok", sourceId: "mangadex", ts: now })
        await recordAnalyticsEvent({ event: "capture_ok", sourceId: "mangadex", ts: now })
        await recordAnalyticsEvent({ event: "capture_ok", sourceId: "mangahub", ts: now })
        await recordAnalyticsEvent({
            event: "capture_error",
            sourceId: "mangahub",
            ts: now,
            detail: JSON.stringify({ errorType: "cf_block" })
        })
        await recordAnalyticsEvent({ event: "reader_opened", ts: now })
        await recordAnalyticsEvent({ event: "reader_opened", ts: now })
        // Older than the default 30-day window - must not be counted.
        await recordAnalyticsEvent({ event: "capture_ok", sourceId: "mangadex", ts: now - 40 * 86_400_000 })

        const s = await getAnalyticsSummary()

        expect(s.captureOk).toBe(3)
        expect(s.captureErrors).toBe(1)
        expect(s.readerOpened).toBe(2)
        expect(s.readerRate).toBe(67) // round(2/3 * 100)
        expect(s.errorRate).toBe(25) // round(1/(3+1) * 100)
        expect(Object.fromEntries(s.topSources.map(x => [x.sourceId, x.count]))).toMatchObject({
            mangadex: 2,
            mangahub: 1
        })
        expect(Object.fromEntries(s.errorTypes.map(x => [x.type, x.count]))).toMatchObject({ cf_block: 1 })
    })

    it("returns zeroed rates and empty breakdowns for an empty library", async () => {
        const s = await getAnalyticsSummary()
        expect(s.captureOk).toBe(0)
        expect(s.readerRate).toBe(0)
        expect(s.errorRate).toBe(0)
        expect(s.statusBreakdown).toEqual([])
        expect(s.topGenres).toEqual([])
    })
})
