import "fake-indexeddb/auto"
import type { ChapterRecord, MangaRecord, SourceLinkRecord } from "@amr/contracts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyUpdateCheckResult, db } from "../database"
import type { LibraryManga } from "../database"

// Regression "tripwire" for a reported data-loss symptom: updating 0.17->0.19 and
// running an update check appeared to reset a MangaDex title's read progress.
// Adversarial tracing found NO code path that clears finite lastRead* on an update -
// applyUpdateCheckResult is a partial patch that only ever re-points the latest*/
// sourceUrl/updatedAt fields on an id change, MangaDex ids are stable UUIDs, and the
// MangaHub repair is scoped to sourceId="mangahub" + internal-id-sized numbers. These
// tests make that invariant permanent so it can never silently regress: an update
// check must leave lastReadChapterId / lastReadChapterNumber / lastReadAt untouched.

const {
    listMangaChaptersMock,
    listChaptersForSourceMock,
    resolveGenresForMock,
    resolveCoverForMock,
    resolveMetadataMock,
    publishLiveMock,
    purgeStaleMangahubChapterRowsMock,
    notifyNewChaptersMock
} = vi.hoisted(() => ({
    listMangaChaptersMock: vi.fn(),
    listChaptersForSourceMock: vi.fn(),
    resolveGenresForMock: vi.fn(),
    resolveCoverForMock: vi.fn(),
    resolveMetadataMock: vi.fn(),
    publishLiveMock: vi.fn(),
    purgeStaleMangahubChapterRowsMock: vi.fn(),
    notifyNewChaptersMock: vi.fn()
}))

vi.mock("../metadata", () => ({
    resolveMetadata: resolveMetadataMock
}))

vi.mock("../sources", () => ({
    listMangaChapters: listMangaChaptersMock,
    listChaptersForSource: listChaptersForSourceMock,
    checkSourcePermission: vi.fn(),
    getMangaChapters: vi.fn(),
    resolveGenresFor: resolveGenresForMock,
    resolveCoverFor: resolveCoverForMock,
    searchManga: vi.fn(),
    // Real pure implementation (mirrors sources.ts): keep untagged chapters, fall back
    // to the full list when nothing matches the preferred language.
    chaptersForLanguage: <T extends { language?: string | undefined }>(chapters: T[], language: string | undefined) => {
        if (!language) return chapters
        const matched = chapters.filter(c => !c.language || c.language === language)
        return matched.length > 0 ? matched : chapters
    }
}))

vi.mock("../background/covers", () => ({
    fetchCoverBlob: vi.fn(async () => undefined)
}))

vi.mock("../live", () => ({
    publishLive: publishLiveMock
}))

vi.mock("../notifications", () => ({
    notifyNewChapters: notifyNewChaptersMock
}))

const MANGAHUB_INTERNAL_ID_MIN = 100_000

vi.mock("../background/chapter-cache", () => ({
    purgeStaleMangahubChapterRows: purgeStaleMangahubChapterRowsMock,
    MANGAHUB_INTERNAL_ID_MIN
}))

// Minimal Map-backed stand-in for browser.storage.local - matches updates-sources.test.ts.
function createStorageLocalStub() {
    const store = new Map<string, unknown>()
    return {
        store,
        get: vi.fn(async (key?: string | string[] | Record<string, unknown> | null) => {
            if (key == null) return Object.fromEntries(store)
            const keys = typeof key === "string" ? [key] : Array.isArray(key) ? key : Object.keys(key)
            const result: Record<string, unknown> = {}
            for (const k of keys) if (store.has(k)) result[k] = store.get(k)
            return result
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(items)) store.set(k, v)
        }),
        remove: vi.fn(async (key: string | string[]) => {
            const keys = typeof key === "string" ? [key] : key
            for (const k of keys) store.delete(k)
        }),
        clear: vi.fn(async () => store.clear())
    }
}

let storageLocal: ReturnType<typeof createStorageLocalStub>

beforeEach(async () => {
    await Promise.all([db.manga.clear(), db.sourceLinks.clear(), db.chapters.clear()])
    storageLocal = createStorageLocalStub()
    // @ts-expect-error -- test-only global shim; WXT injects the real `browser`
    // global at build time, but vitest runs modules directly with no polyfill.
    globalThis.browser = {
        storage: { local: storageLocal },
        runtime: { getManifest: () => ({ version: "1.0.0" }) }
    }
    listMangaChaptersMock.mockReset()
    listChaptersForSourceMock.mockReset()
    resolveGenresForMock.mockReset()
    resolveCoverForMock.mockReset()
    resolveMetadataMock.mockReset()
    resolveMetadataMock.mockResolvedValue(null)
    publishLiveMock.mockReset()
    purgeStaleMangahubChapterRowsMock.mockReset()
    notifyNewChaptersMock.mockReset()
    notifyNewChaptersMock.mockResolvedValue(undefined)
})

afterEach(() => {
    vi.restoreAllMocks()
})

function makeManga(overrides: Partial<LibraryManga> = {}): LibraryManga {
    const id = overrides.id ?? `mangadex:manga:${Math.random().toString(36).slice(2)}`
    const base: MangaRecord = {
        id,
        title: "Test Manga",
        normalizedTitle: "test manga",
        authors: [],
        status: "ongoing",
        addedAt: 1,
        updatedAt: 1
    }
    return {
        ...base,
        sourceId: "mangadex",
        sourceUrl: "https://mangadex.org/chapter/read-uuid",
        ...overrides
    }
}

function makeLink(mangaId: string, sourceId = "mangadex"): SourceLinkRecord {
    return {
        mangaId,
        sourceId,
        sourceMangaId: "abc",
        url: "https://mangadex.org/title/abc",
        addedAt: 1,
        updatedAt: 1
    }
}

function makeChapter(overrides: Partial<ChapterRecord> & Pick<ChapterRecord, "id" | "mangaId">): ChapterRecord {
    return {
        sourceId: "mangadex",
        title: "Chapter",
        url: `https://mangadex.org/chapter/${overrides.id}`,
        sortKey: 1,
        ...overrides
    }
}

// A MangaDex title the user has read up to chapter 5, then the source publishes
// chapter 6. Stable UUID-style ids on both the read chapter and the new one.
const READ_CHAPTER_ID = "mangadex:ch:11111111-1111-1111-1111-111111111111"
const NEW_CHAPTER_ID = "mangadex:ch:99999999-9999-9999-9999-999999999999"
const LAST_READ_AT = 1_700_000_000_000
const LAST_READ_NUMBER = 5

describe("update check never resets read progress (MangaDex data-loss tripwire)", () => {
    it("leaves lastReadChapterId/Number/At byte-identical when new chapters are discovered (public checkUpdates path)", async () => {
        const { checkUpdates } = await import("./updates-sources")

        const manga = makeManga({
            id: "md-read-progress",
            lastReadChapterId: READ_CHAPTER_ID,
            lastReadChapterNumber: LAST_READ_NUMBER,
            lastReadAt: LAST_READ_AT,
            latestChapterId: READ_CHAPTER_ID,
            latestChapterNumber: LAST_READ_NUMBER,
            updatedAt: 1
        })
        await db.manga.put(manga)
        await db.sourceLinks.put(makeLink(manga.id))

        // The source now lists a genuinely newer chapter (6 > 5) with a fresh id, so
        // applyUpdateCheckResult's advance branch fires and re-points the latest* fields.
        listMangaChaptersMock.mockResolvedValue([
            makeChapter({ id: READ_CHAPTER_ID, mangaId: manga.id, sortKey: 5, title: "Ch 5" }),
            makeChapter({ id: NEW_CHAPTER_ID, mangaId: manga.id, sortKey: 6, title: "Ch 6" })
        ])

        await checkUpdates()

        const after = await db.manga.get(manga.id)
        expect(after).toBeDefined()

        // The read-progress trio must survive the update check byte-for-byte.
        expect(after!.lastReadChapterId).toBe(READ_CHAPTER_ID)
        expect(after!.lastReadChapterNumber).toBe(LAST_READ_NUMBER)
        expect(after!.lastReadAt).toBe(LAST_READ_AT)
        // Object.is guards against any silent type coercion (e.g. 5 -> "5", or -> NaN).
        expect(Object.is(after!.lastReadChapterNumber, LAST_READ_NUMBER)).toBe(true)
        expect(Object.is(after!.lastReadAt, LAST_READ_AT)).toBe(true)

        // Sanity: the update actually happened - only the latest* / sourceUrl / updatedAt
        // fields moved. If none of these changed the test would be vacuously green.
        expect(after!.latestChapterId).toBe(NEW_CHAPTER_ID)
        expect(after!.latestChapterNumber).toBe(6)
        expect(after!.sourceUrl).toBe(`https://mangadex.org/chapter/${NEW_CHAPTER_ID}`)
        expect(after!.updatedAt).toBeGreaterThan(1)
    })

    it("applyUpdateCheckResult's manga patch contains none of the lastRead* keys (structural guard)", async () => {
        const manga = makeManga({
            id: "md-structural",
            lastReadChapterId: READ_CHAPTER_ID,
            lastReadChapterNumber: LAST_READ_NUMBER,
            lastReadAt: LAST_READ_AT,
            latestChapterId: READ_CHAPTER_ID,
            latestChapterNumber: LAST_READ_NUMBER,
            updatedAt: 1
        })
        await db.manga.put(manga)

        // Capture every patch handed to db.manga.update during the apply.
        const updateSpy = vi.spyOn(db.manga, "update")

        const newLatest = makeChapter({ id: NEW_CHAPTER_ID, mangaId: manga.id, sortKey: 6, title: "Ch 6" })
        const { advanced } = await applyUpdateCheckResult({
            mangaId: manga.id,
            chapters: [makeChapter({ id: READ_CHAPTER_ID, mangaId: manga.id, sortKey: 5, title: "Ch 5" }), newLatest],
            latest: newLatest,
            previousLatestChapterId: manga.latestChapterId,
            previousLatestChapterNumber: manga.latestChapterNumber
        })

        // Precondition: the write path ran (id changed -> advance branch fired). Without a
        // write there'd be no patch to inspect and the guard would be vacuous.
        expect(advanced).toBe(true)
        const mangaPatchCalls = updateSpy.mock.calls.filter(([key]) => key === manga.id)
        expect(mangaPatchCalls.length).toBeGreaterThan(0)

        const forbidden = ["lastReadChapterId", "lastReadChapterNumber", "lastReadAt"] as const
        for (const [, patch] of mangaPatchCalls) {
            for (const key of forbidden) {
                // `in` catches an explicit `undefined` too - the leak we guard against is
                // ANY appearance of a lastRead* key in the update patch, value aside.
                expect(key in (patch as Record<string, unknown>)).toBe(false)
            }
        }
    })
})
