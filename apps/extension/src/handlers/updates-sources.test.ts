import "fake-indexeddb/auto"
import type { ChapterRecord, MangaRecord, SourceLinkRecord } from "@amr/contracts"
import { SourceRequestError } from "@amr/source-sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { db } from "../database"
import type { LibraryManga } from "../database"

const {
    listMangaChaptersMock,
    listChaptersForSourceMock,
    resolveGenresForMock,
    resolveCoverForMock,
    resolveMetadataMock,
    publishLiveMock,
    purgeStaleMangahubChapterRowsMock,
    trackingOnlyIds,
    profileIds
} = vi.hoisted(() => ({
    listMangaChaptersMock: vi.fn(),
    listChaptersForSourceMock: vi.fn(),
    resolveGenresForMock: vi.fn(),
    resolveCoverForMock: vi.fn(),
    resolveMetadataMock: vi.fn(),
    publishLiveMock: vi.fn(),
    purgeStaleMangahubChapterRowsMock: vi.fn(),
    trackingOnlyIds: new Set<string>(),
    profileIds: new Set<string>()
}))

vi.mock("../arch-sources", () => ({
    isTrackingOnlySource: (id: string) => trackingOnlyIds.has(id),
    isProfileSource: (id: string) => profileIds.has(id)
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
    searchManga: vi.fn()
}))

vi.mock("../background/covers", () => ({
    fetchCoverBlob: vi.fn(async () => undefined)
}))

vi.mock("../live", () => ({
    publishLive: publishLiveMock
}))

const MANGAHUB_INTERNAL_ID_MIN = 100_000

vi.mock("../background/chapter-cache", () => ({
    purgeStaleMangahubChapterRows: purgeStaleMangahubChapterRowsMock,
    MANGAHUB_INTERNAL_ID_MIN
}))

// Minimal in-memory stand-in for browser.storage.local - a plain Map-backed
// get/set/remove is enough for these tests; no existing helper covers this
// (settings.ts/background.ts use the real WXT-injected `browser` global at
// runtime, which vitest never provides).
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
    trackingOnlyIds.clear()
    profileIds.clear()
})

afterEach(() => {
    vi.restoreAllMocks()
})

function makeManga(overrides: Partial<LibraryManga> = {}): LibraryManga {
    const id = overrides.id ?? `src:manga:${Math.random().toString(36).slice(2)}`
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
        sourceUrl: "https://mangadex.org/chapter/1",
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

describe("checkUpdates", () => {
    it("skips manualTracking, onHold, and manga without a sourceLink", async () => {
        const { checkUpdates } = await import("./updates-sources")

        const manual = makeManga({ id: "m-manual", manualTracking: true })
        const onHold = makeManga({ id: "m-hold", onHold: true })
        const noLink = makeManga({ id: "m-nolink" })
        const normal = makeManga({ id: "m-normal" })

        await db.manga.bulkPut([manual, onHold, noLink, normal])
        await db.sourceLinks.bulkPut([makeLink(manual.id), makeLink(onHold.id), makeLink(normal.id)])
        // Intentionally no sourceLink for noLink.

        listMangaChaptersMock.mockResolvedValue([])

        await checkUpdates()

        expect(listMangaChaptersMock).toHaveBeenCalledTimes(1)
        expect(listMangaChaptersMock.mock.calls[0]?.[0]?.id).toBe("m-normal")
    })

    it("writes an update-check run summary to the diagnostic log (not only on failure)", async () => {
        const { checkUpdates } = await import("./updates-sources")
        await db.logs.clear()

        const normal = makeManga({ id: "m-run" })
        await db.manga.bulkPut([normal])
        await db.sourceLinks.bulkPut([makeLink(normal.id)])
        listMangaChaptersMock.mockResolvedValue([])

        await checkUpdates()

        const logs = await db.logs.toArray()
        const run = logs.find(l => l.scope === "update-check" && l.level === "info" && /^run /.test(l.message))
        expect(run).toBeDefined()
        expect(run?.message).toContain("checked 1")
    })
})

describe("checkUpdates cold start", () => {
    afterEach(async () => {
        const { beginUserSourcesInit } = await import("../background/user-sources-ready")
        await beginUserSourcesInit(async () => undefined)
    })

    it("does not read or bucket the library until the added sources are registered", async () => {
        const { beginUserSourcesInit } = await import("../background/user-sources-ready")
        const { checkUpdates } = await import("./updates-sources")
        const normal = makeManga({ id: "m-added" })
        await db.manga.bulkPut([normal])
        await db.sourceLinks.bulkPut([makeLink(normal.id)])
        listMangaChaptersMock.mockResolvedValue([])
        const readLibrary = vi.spyOn(db.manga, "toArray")

        let release!: () => void
        void beginUserSourcesInit(() => new Promise<void>(resolve => (release = resolve)))

        const pending = checkUpdates()
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(readLibrary).not.toHaveBeenCalled()
        expect(listMangaChaptersMock).not.toHaveBeenCalled()

        release()
        await pending
        expect(readLibrary).toHaveBeenCalled()
        expect(listMangaChaptersMock).toHaveBeenCalledTimes(1)
    })
})

describe("checkUpdates per-title error handling", () => {
    // A non-bot-block-shaped failure (plain network/parse error, or a status this
    // codebase's isBotBlocked() doesn't recognize) must still go through the
    // ordinary failed+errors bookkeeping - only the bot-blocked branch (see the
    // "checkUpdates bot-block suppression" describe block below) is suppressed.
    it("records an ordinary per-title failure without aborting the rest of the run", async () => {
        const { checkUpdates } = await import("./updates-sources")

        const broken = makeManga({ id: "m-broken", sourceId: "mangadex" })
        const normal = makeManga({ id: "m-normal" })
        await db.manga.bulkPut([broken, normal])
        await db.sourceLinks.bulkPut([makeLink(broken.id, "mangadex"), makeLink(normal.id)])

        listMangaChaptersMock.mockImplementation(async (item: LibraryManga) => {
            if (item.id === "m-broken") throw new Error("Request failed with status 500")
            return []
        })

        await checkUpdates()

        expect(listMangaChaptersMock).toHaveBeenCalledTimes(2)
        const status = storageLocal.store.get("updateStatus") as {
            failed: number
            checked: number
            errors: Array<{ mangaId: string; title: string; message: string }>
        }
        expect(status.failed).toBe(1)
        // Both titles were attempted, so both count toward `checked` (the success and
        // the hard failure). Only bot-block skips stay out of `checked` - see the
        // "bot-block suppression" block below.
        expect(status.checked).toBe(2)
        expect(status.errors).toContainEqual(
            expect.objectContaining({ mangaId: "m-broken", message: "Request failed with status 500" })
        )
        expect(status).toMatchObject({ failuresBySource: { mangadex: 1 } })
    })
})

// Fix 9: kagane.ts's listChapters() now propagates a Cloudflare-blocked series-page
// fetch as a real SourceRequestError instead of swallowing it to []. The routine
// background checkUpdates loop has no tab-fallback (unlike library:switch's manual
// path), so treating that as an ordinary per-title failure surfaced a persistent,
// unactionable "failed to update" row for every kagane-linked title on every check.
// isBotBlocked() gates this on the error shape (403/502/503 status, or a "blocked"
// message), not on sourceId - it's a bot-block detector, not a kagane-specific one.
describe("checkUpdates bot-block suppression (Fix 9)", () => {
    it("does not count a bot-blocked title as failed, still advances checked/done for the rest of the run, and records exactly one skipped-source tally", async () => {
        const { checkUpdates } = await import("./updates-sources")

        const blocked = makeManga({ id: "m-blocked", sourceId: "kagane" })
        const normal = makeManga({ id: "m-normal", sourceId: "mangadex" })
        await db.manga.bulkPut([blocked, normal])
        await db.sourceLinks.bulkPut([makeLink(blocked.id, "kagane"), makeLink(normal.id, "mangadex")])

        listMangaChaptersMock.mockImplementation(async (item: LibraryManga) => {
            if (item.id === "m-blocked") throw new SourceRequestError("Request failed with status 403", 403)
            return []
        })

        await checkUpdates()

        expect(listMangaChaptersMock).toHaveBeenCalledTimes(2)
        const status = storageLocal.store.get("updateStatus") as {
            checked: number
            failed: number
            errors: Array<{ mangaId: string; title: string; message: string }>
            skippedSources: Record<string, number>
        }
        // The blocked title is neither counted as failed nor given its own errors
        // entry - only the normal title counts toward `checked`.
        expect(status.failed).toBe(0)
        expect(status.checked).toBe(1)
        expect(status.errors.filter(e => e.mangaId === "m-blocked")).toHaveLength(0)
        // Bot-block skips live in skippedSources, NOT in the failure rows - so the
        // failure list stays clean and the log/UI can label them as an expected skip.
        expect(status.errors.filter(e => e.mangaId === "")).toHaveLength(0)
        expect(status.skippedSources.kagane).toBe(1)

        const finalProgress = storageLocal.store.get("updateProgress") as { done: number }
        expect(finalProgress.done).toBe(2)
    })

    it("does not suppress a non-bot-block error even when it comes from the same source as a blocked title", async () => {
        const { checkUpdates } = await import("./updates-sources")

        const blocked = makeManga({ id: "m-blocked", sourceId: "kagane" })
        const genuinelyBroken = makeManga({ id: "m-broken", sourceId: "kagane" })
        await db.manga.bulkPut([blocked, genuinelyBroken])
        await db.sourceLinks.bulkPut([makeLink(blocked.id, "kagane"), makeLink(genuinelyBroken.id, "kagane")])

        listMangaChaptersMock.mockImplementation(async (item: LibraryManga) => {
            if (item.id === "m-blocked") throw new SourceRequestError("Request failed with status 403", 403)
            throw new Error("totally unrelated failure")
        })

        await checkUpdates()

        const status = storageLocal.store.get("updateStatus") as {
            failed: number
            errors: Array<{ mangaId: string; title: string; message: string }>
            skippedSources: Record<string, number>
        }
        expect(status.failed).toBe(1)
        expect(status.errors).toContainEqual(
            expect.objectContaining({ mangaId: "m-broken", message: "totally unrelated failure" })
        )
        // The genuine failure is a failure row; the bot-blocked sibling is a skip.
        expect(status.errors.filter(e => e.mangaId === "")).toHaveLength(0)
        expect(status.skippedSources.kagane).toBe(1)
    })
})

describe("checkUpdates storage writes", () => {
    it("does not write updateStatus for a scoped (sourceId) check but does for a full check", async () => {
        const { checkUpdates } = await import("./updates-sources")

        const manga = makeManga({ id: "m-1", sourceId: "mangadex" })
        await db.manga.put(manga)
        await db.sourceLinks.put(makeLink(manga.id))
        listMangaChaptersMock.mockResolvedValue([])

        await checkUpdates("mangadex")
        expect(storageLocal.store.has("updateStatus")).toBe(false)

        await checkUpdates()
        expect(storageLocal.store.has("updateStatus")).toBe(true)
    })
})

describe("checkUpdates live-bus publishing", () => {
    it("publishes chapters+library for a title whose latest chapter changed", async () => {
        const { checkUpdates } = await import("./updates-sources")

        const manga = makeManga({ id: "m-1", latestChapterId: "old-chapter" })
        await db.manga.put(manga)
        await db.sourceLinks.put(makeLink(manga.id))
        const chapters: ChapterRecord[] = [
            {
                id: "old-chapter",
                mangaId: manga.id,
                sourceId: "mangadex",
                title: "Ch 1",
                url: "https://x/1",
                sortKey: 1
            },
            {
                id: "new-chapter",
                mangaId: manga.id,
                sourceId: "mangadex",
                title: "Ch 2",
                url: "https://x/2",
                sortKey: 2
            }
        ]
        listMangaChaptersMock.mockResolvedValue(chapters)

        await checkUpdates()

        expect(publishLiveMock).toHaveBeenCalledWith(["chapters", "library"], [manga.id])
    })

    it("does not publish for a title whose latest chapter did not change", async () => {
        const { checkUpdates } = await import("./updates-sources")

        const manga = makeManga({ id: "m-1", latestChapterId: "only-chapter" })
        await db.manga.put(manga)
        await db.sourceLinks.put(makeLink(manga.id))
        const chapters: ChapterRecord[] = [
            {
                id: "only-chapter",
                mangaId: manga.id,
                sourceId: "mangadex",
                title: "Ch 1",
                url: "https://x/1",
                sortKey: 1
            }
        ]
        listMangaChaptersMock.mockResolvedValue(chapters)

        await checkUpdates()

        expect(publishLiveMock).not.toHaveBeenCalled()
    })
})

describe("checkUpdates latestChapterNumber advance gate", () => {
    it("re-points a foreign latestChapterId without counting it as updated when the number did not advance", async () => {
        const { checkUpdates } = await import("./updates-sources")

        const manga = makeManga({ id: "m-1", latestChapterId: "webtoons:ch22", latestChapterNumber: 22 })
        await db.manga.put(manga)
        await db.sourceLinks.put(makeLink(manga.id))
        const chapters: ChapterRecord[] = [
            {
                id: "mangadex:ch20",
                mangaId: manga.id,
                sourceId: "mangadex",
                title: "Chapter 20",
                url: "https://mangadex.org/chapter/20",
                sortKey: 20
            }
        ]
        listMangaChaptersMock.mockResolvedValue(chapters)

        await checkUpdates()

        const updatedManga = await db.manga.get(manga.id)
        expect(updatedManga?.latestChapterId).toBe("mangadex:ch20")
        expect(updatedManga?.latestChapterNumber).toBe(20)
        expect(publishLiveMock).not.toHaveBeenCalled()
        const status = storageLocal.store.get("updateStatus") as { updated: number }
        expect(status.updated).toBe(0)
    })

    it("counts and publishes when the id changed and the number advanced", async () => {
        const { checkUpdates } = await import("./updates-sources")

        const manga = makeManga({ id: "m-1", latestChapterId: "old", latestChapterNumber: 20 })
        await db.manga.put(manga)
        await db.sourceLinks.put(makeLink(manga.id))
        const chapters: ChapterRecord[] = [
            {
                id: "new",
                mangaId: manga.id,
                sourceId: "mangadex",
                title: "Chapter 21",
                url: "https://mangadex.org/chapter/21",
                sortKey: 21
            }
        ]
        listMangaChaptersMock.mockResolvedValue(chapters)

        await checkUpdates()

        const status = storageLocal.store.get("updateStatus") as { updated: number }
        expect(status.updated).toBe(1)
        expect(publishLiveMock).toHaveBeenCalledWith(["chapters", "library"], [manga.id])
    })

    it("keeps counting an id change whose latest has a non-finite sortKey", async () => {
        const { checkUpdates } = await import("./updates-sources")

        const manga = makeManga({ id: "m-1", latestChapterId: "old", latestChapterNumber: 20 })
        await db.manga.put(manga)
        await db.sourceLinks.put(makeLink(manga.id))
        // IndexedDB keys (chapters is indexed on sortKey) can't be NaN, so use
        // Infinity to get a realistic non-finite sortKey - Number.isFinite(Infinity)
        // is false, which is what the guard actually checks.
        const chapters: ChapterRecord[] = [
            {
                id: "new",
                mangaId: manga.id,
                sourceId: "mangadex",
                title: "Chapter ?",
                url: "https://mangadex.org/chapter/new",
                sortKey: Infinity
            }
        ]
        listMangaChaptersMock.mockResolvedValue(chapters)

        await checkUpdates()

        const status = storageLocal.store.get("updateStatus") as { updated: number }
        expect(status.updated).toBe(1)
        const updatedManga = await db.manga.get(manga.id)
        expect(updatedManga?.latestChapterId).toBe("new")
        expect(updatedManga?.latestChapterNumber).toBe(20)
    })
})

// Regression test for the UNNUMBERED_SORT_KEY (Infinity) leak class, site 4 (wrong
// latest pointer): the reduce that picks `latest` used to key purely on `>`, so a
// single unnumbered chapter (sortKey: Infinity) always won and became
// latestChapterId/sourceUrl - pointing the manga at a chapter with no real number, even
// though a genuinely numbered, higher chapter was fetched in the same batch.
describe("checkUpdates unnumbered-chapter guard (Infinity leak class, site 4)", () => {
    it("points latestChapterId/sourceUrl at the highest NUMBERED chapter, ignoring an unnumbered one fetched alongside it", async () => {
        const { checkUpdates } = await import("./updates-sources")

        const manga = makeManga({ id: "m-1", latestChapterId: "old", latestChapterNumber: 5 })
        await db.manga.put(manga)
        await db.sourceLinks.put(makeLink(manga.id))
        const chapters: ChapterRecord[] = [
            {
                id: "ch-6",
                mangaId: manga.id,
                sourceId: "mangadex",
                title: "Chapter 6",
                url: "https://mangadex.org/chapter/6",
                sortKey: 6
            },
            {
                id: "ch-extra",
                mangaId: manga.id,
                sourceId: "mangadex",
                title: "Extra",
                url: "https://mangadex.org/chapter/extra",
                sortKey: Number.POSITIVE_INFINITY
            }
        ]
        listMangaChaptersMock.mockResolvedValue(chapters)

        await checkUpdates()

        const updated = await db.manga.get(manga.id)
        expect(updated?.latestChapterId).toBe("ch-6")
        expect(updated?.sourceUrl).toBe("https://mangadex.org/chapter/6")
        expect(updated?.latestChapterNumber).toBe(6)
    })
})

describe("checkUpdates MangaHub junk-row purge wiring", () => {
    it("calls the shared purge helper for a mangahub title after a successful chapter-list fetch", async () => {
        const { checkUpdates } = await import("./updates-sources")

        const manga = makeManga({ id: "m-mangahub", sourceId: "mangahub" })
        await db.manga.put(manga)
        await db.sourceLinks.put(makeLink(manga.id, "mangahub"))
        const chapters: ChapterRecord[] = [
            {
                id: "mangahub:chapter:some-series:1",
                mangaId: manga.id,
                sourceId: "mangahub",
                title: "Chapter 1",
                url: "https://mangahub.io/chapter/some-series/chapter-1",
                sortKey: 1
            }
        ]
        listMangaChaptersMock.mockResolvedValue(chapters)

        await checkUpdates()

        expect(purgeStaleMangahubChapterRowsMock).toHaveBeenCalledTimes(1)
        expect(purgeStaleMangahubChapterRowsMock).toHaveBeenCalledWith(
            manga.id,
            new Set(["mangahub:chapter:some-series:1"])
        )
    })

    it("does not call the purge helper for a non-mangahub title", async () => {
        const { checkUpdates } = await import("./updates-sources")

        const manga = makeManga({ id: "m-mangadex", sourceId: "mangadex" })
        await db.manga.put(manga)
        await db.sourceLinks.put(makeLink(manga.id, "mangadex"))
        listMangaChaptersMock.mockResolvedValue([])

        await checkUpdates()

        expect(purgeStaleMangahubChapterRowsMock).not.toHaveBeenCalled()
    })
})

describe("repairMangahubChapterNumbers one-shot poisoned-library sweep", () => {
    it("corrects a poisoned mangahub manga's latestChapterNumber even when manualTracking/onHold would make checkUpdates skip it", async () => {
        const { repairMangahubChapterNumbers } = await import("./updates-sources")

        const poisoned = makeManga({
            id: "mangahub:manga:some-series",
            sourceId: "mangahub",
            sourceMangaId: "some-series",
            mangaUrl: "https://mangahub.io/manga/some-series",
            latestChapterNumber: 2650711,
            latestChapterId: "mangahub:chapter:some-series:2650711",
            manualTracking: true,
            onHold: true
        })
        await db.manga.put(poisoned)
        const freshChapters: ChapterRecord[] = [
            {
                id: "mangahub:chapter:some-series:1",
                mangaId: poisoned.id,
                sourceId: "mangahub",
                title: "Chapter 1",
                url: "https://mangahub.io/chapter/some-series/chapter-1",
                sortKey: 1
            },
            {
                id: "mangahub:chapter:some-series:2",
                mangaId: poisoned.id,
                sourceId: "mangahub",
                title: "Chapter 2",
                url: "https://mangahub.io/chapter/some-series/chapter-2",
                sortKey: 2
            }
        ]
        listChaptersForSourceMock.mockResolvedValue(freshChapters)

        await repairMangahubChapterNumbers()

        expect(listChaptersForSourceMock).toHaveBeenCalledTimes(1)
        const updated = await db.manga.get(poisoned.id)
        expect(updated?.latestChapterNumber).toBe(2)
        expect(updated?.latestChapterId).toBe("mangahub:chapter:some-series:2")
        // manualTracking/onHold are untouched by the repair - only the poisoned numbers are.
        expect(updated?.manualTracking).toBe(true)
        expect(updated?.onHold).toBe(true)
        expect(purgeStaleMangahubChapterRowsMock).toHaveBeenCalledWith(
            poisoned.id,
            new Set(["mangahub:chapter:some-series:1", "mangahub:chapter:some-series:2"])
        )
    })

    it("ignores non-mangahub and non-poisoned manga", async () => {
        const { repairMangahubChapterNumbers } = await import("./updates-sources")

        const healthy = makeManga({
            id: "mangahub:manga:healthy",
            sourceId: "mangahub",
            sourceMangaId: "healthy",
            mangaUrl: "https://mangahub.io/manga/healthy",
            latestChapterNumber: 42
        })
        const otherSourcePoisoned = makeManga({
            id: "other:manga:weird",
            sourceId: "mangadex",
            sourceMangaId: "weird",
            mangaUrl: "https://mangadex.org/title/weird",
            latestChapterNumber: 2_000_000
        })
        await db.manga.bulkPut([healthy, otherSourcePoisoned])

        await repairMangahubChapterNumbers()

        expect(listChaptersForSourceMock).not.toHaveBeenCalled()
    })

    it("sets the one-time completion flag and does not re-fetch on a second invocation", async () => {
        const { repairMangahubChapterNumbers } = await import("./updates-sources")

        const poisoned = makeManga({
            id: "mangahub:manga:some-series",
            sourceId: "mangahub",
            sourceMangaId: "some-series",
            mangaUrl: "https://mangahub.io/manga/some-series",
            latestChapterNumber: 2650711
        })
        await db.manga.put(poisoned)
        listChaptersForSourceMock.mockResolvedValue([
            {
                id: "mangahub:chapter:some-series:1",
                mangaId: poisoned.id,
                sourceId: "mangahub",
                title: "Chapter 1",
                url: "https://mangahub.io/chapter/some-series/chapter-1",
                sortKey: 1
            }
        ])

        await repairMangahubChapterNumbers()
        expect(listChaptersForSourceMock).toHaveBeenCalledTimes(1)
        expect(storageLocal.store.get("mangahubChapterRepairDone3")).toBe(true)

        listChaptersForSourceMock.mockClear()
        await repairMangahubChapterNumbers()

        expect(listChaptersForSourceMock).not.toHaveBeenCalled()
    })

    it("locally heals the poisoned number even when the fetch fails (Cloudflare block)", async () => {
        const { repairMangahubChapterNumbers } = await import("./updates-sources")

        const poisoned = makeManga({
            id: "mangahub:manga:some-series",
            sourceId: "mangahub",
            sourceMangaId: "some-series",
            mangaUrl: "https://mangahub.io/manga/some-series",
            latestChapterNumber: 2650711
        })
        await db.manga.put(poisoned)
        // A real chapter row plus a poisoned internal-id row cached locally.
        await db.chapters.bulkPut([
            {
                id: "mangahub:chapter:some-series:105",
                mangaId: poisoned.id,
                sourceId: "mangahub",
                title: "Chapter 105",
                url: "https://mangahub.io/chapter/some-series/chapter-105",
                sortKey: 105
            },
            {
                id: "mangahub:chapter:some-series:2650711",
                mangaId: poisoned.id,
                sourceId: "mangahub",
                title: "External chapter",
                url: "https://mangahub.io/chapter/some-series/chapter-2650711",
                sortKey: 2650711
            }
        ])
        listChaptersForSourceMock.mockRejectedValue(new Error("cloudflare 403"))

        await expect(repairMangahubChapterNumbers()).resolves.toBeUndefined()

        expect(storageLocal.store.get("mangahubChapterRepairDone3")).toBe(true)
        // The local clamp heals the badge from the highest real row and deletes the poison,
        // with no network at all.
        const healed = await db.manga.get(poisoned.id)
        expect(healed?.latestChapterNumber).toBe(105)
        const remaining = await db.chapters.where("mangaId").equals(poisoned.id).toArray()
        expect(remaining.every(c => c.sortKey < 100_000)).toBe(true)
    })

    // Fix 4: guard against writing a freshly-fetched chapter list back to a manga a
    // concurrent library:remove/merge deleted while the network fetch was in flight.
    it("does not write the fetched chapters back when the manga is deleted during the fetch (race guard)", async () => {
        const { repairMangahubChapterNumbers } = await import("./updates-sources")

        const poisoned = makeManga({
            id: "mangahub:manga:some-series",
            sourceId: "mangahub",
            sourceMangaId: "some-series",
            mangaUrl: "https://mangahub.io/manga/some-series",
            latestChapterNumber: 2650711
        })
        await db.manga.put(poisoned)
        const freshChapters: ChapterRecord[] = [
            {
                id: "mangahub:chapter:some-series:1",
                mangaId: poisoned.id,
                sourceId: "mangahub",
                title: "Chapter 1",
                url: "https://mangahub.io/chapter/some-series/chapter-1",
                sortKey: 1
            }
        ]
        // Simulate a concurrent library:remove landing exactly while the network
        // fetch is in flight - by the time the fetch resolves, the manga row is gone.
        listChaptersForSourceMock.mockImplementation(async () => {
            await db.manga.delete(poisoned.id)
            return freshChapters
        })

        await repairMangahubChapterNumbers()

        expect(await db.chapters.count()).toBe(0)
        expect(purgeStaleMangahubChapterRowsMock).not.toHaveBeenCalled()
        // The local clamp healed + published while the manga still existed (before the
        // concurrent delete); the network repair below correctly writes nothing to the gone row.
        expect(publishLiveMock).toHaveBeenCalledTimes(1)
        expect(await db.manga.get(poisoned.id)).toBeUndefined()
        // The sweep still completes and sets the flag - a race on one title doesn't
        // abort the rest of the (empty, in this case) loop.
        expect(storageLocal.store.get("mangahubChapterRepairDone3")).toBe(true)
    })
})

// Same unnumbered-chapter guard as checkUpdates (Infinity leak class, site 4) - this
// reduce is a separate copy of the identical bug, not the one called out by line
// number in the spec, but it's the exact same pattern in the same file.
describe("repairMangahubChapterNumbers unnumbered-chapter guard (Infinity leak class, site 4)", () => {
    it("repairs latestChapterId to the highest NUMBERED chapter, ignoring an unnumbered one fetched alongside it", async () => {
        const { repairMangahubChapterNumbers } = await import("./updates-sources")

        const poisoned = makeManga({
            id: "mangahub:manga:some-series",
            sourceId: "mangahub",
            sourceMangaId: "some-series",
            mangaUrl: "https://mangahub.io/manga/some-series",
            latestChapterNumber: 2650711,
            latestChapterId: "mangahub:chapter:some-series:2650711"
        })
        await db.manga.put(poisoned)
        const freshChapters: ChapterRecord[] = [
            {
                id: "mangahub:chapter:some-series:1",
                mangaId: poisoned.id,
                sourceId: "mangahub",
                title: "Chapter 1",
                url: "https://mangahub.io/chapter/some-series/chapter-1",
                sortKey: 1
            },
            {
                id: "mangahub:chapter:some-series:extra",
                mangaId: poisoned.id,
                sourceId: "mangahub",
                title: "Extra",
                url: "https://mangahub.io/chapter/some-series/chapter-extra",
                sortKey: Number.POSITIVE_INFINITY
            }
        ]
        listChaptersForSourceMock.mockResolvedValue(freshChapters)

        await repairMangahubChapterNumbers()

        const updated = await db.manga.get(poisoned.id)
        expect(updated?.latestChapterId).toBe("mangahub:chapter:some-series:1")
        expect(updated?.latestChapterNumber).toBe(1)
    })
})

// Fix 8: the completion flag used to be set in a finally attached to one try that
// wrapped BOTH the initial poisoned-titles query AND the per-title loop, so a
// transient failure on the initial query alone (before any title was examined)
// permanently set the flag with no retry path. The query and the loop now have
// separate try blocks - only a run where the loop itself actually executed (even
// if every title in it failed) sets the flag.
describe("repairMangahubChapterNumbers initial-query failure (Fix 8)", () => {
    it("does not set the completion flag when the initial poisoned-titles query fails, and retries the query on the next call", async () => {
        const { repairMangahubChapterNumbers } = await import("./updates-sources")

        const whereSpy = vi.spyOn(db.manga, "where").mockImplementationOnce(() => {
            throw new Error("query exploded")
        })

        await expect(repairMangahubChapterNumbers()).resolves.toBeUndefined()

        expect(storageLocal.store.get("mangahubChapterRepairDone3")).toBeUndefined()
        expect(listChaptersForSourceMock).not.toHaveBeenCalled()
        whereSpy.mockRestore()

        // A second call must attempt the query again (not early-return because a
        // flag was wrongly set) and, this time succeeding, actually run the sweep.
        const poisoned = makeManga({
            id: "mangahub:manga:some-series",
            sourceId: "mangahub",
            sourceMangaId: "some-series",
            mangaUrl: "https://mangahub.io/manga/some-series",
            latestChapterNumber: 2650711
        })
        await db.manga.put(poisoned)
        listChaptersForSourceMock.mockResolvedValue([
            {
                id: "mangahub:chapter:some-series:1",
                mangaId: poisoned.id,
                sourceId: "mangahub",
                title: "Chapter 1",
                url: "https://mangahub.io/chapter/some-series/chapter-1",
                sortKey: 1
            }
        ])

        await repairMangahubChapterNumbers()

        expect(listChaptersForSourceMock).toHaveBeenCalledTimes(1)
        expect(storageLocal.store.get("mangahubChapterRepairDone3")).toBe(true)
    })
})

describe("backfillMangaGenres live-bus publishing", () => {
    it("publishes library once after the whole backfill loop, not per title", async () => {
        const { backfillMangaGenres } = await import("./updates-sources")

        const mangaA = makeManga({ id: "m-a", mangaUrl: "https://mangadex.org/title/a" })
        const mangaB = makeManga({ id: "m-b", mangaUrl: "https://mangadex.org/title/b" })
        await db.manga.bulkPut([mangaA, mangaB])
        resolveGenresForMock.mockResolvedValue(["Action"])

        await backfillMangaGenres()

        expect(publishLiveMock).toHaveBeenCalledTimes(1)
        expect(publishLiveMock).toHaveBeenCalledWith(["library"])
    })

    it("does not publish when nothing needed backfilling", async () => {
        const { backfillMangaGenres } = await import("./updates-sources")

        await backfillMangaGenres()

        expect(publishLiveMock).not.toHaveBeenCalled()
    })

    it("fills an unknown publication status from the metadata provider", async () => {
        const { backfillMangaGenres } = await import("./updates-sources")

        // A non-MangaDex title with genres + cover already present, only status unknown.
        const m = makeManga({
            id: "m-status",
            title: "Solo Leveling",
            sourceId: "mangakatana",
            status: "unknown",
            genres: ["Action"],
            coverUrl: "https://cdn/cover.jpg"
        })
        await db.manga.put(m)
        resolveMetadataMock.mockResolvedValue({ anilistId: 105398, title: "Solo Leveling", status: "completed" })

        await backfillMangaGenres()

        const stored = await db.manga.get("m-status")
        expect(stored?.status).toBe("completed")
        expect(stored?.anilistId).toBe(105398)
        expect(stored?.metadataUpdatedAt).toBeGreaterThan(0)
    })

    it("does not flip an ongoing title to finished (or rebind anilistId) on a wrong-title fuzzy match", async () => {
        const { backfillMangaGenres } = await import("./updates-sources")

        // Already correctly bound + genuinely ongoing. AniList's fuzzy search returns a
        // DIFFERENT, finished series - no title check would mis-file it as completed and
        // clobber the good anilistId, later pushing progress to the wrong entry.
        const m = makeManga({
            id: "m-fuzzy",
            title: "My Obscure Webtoon",
            normalizedTitle: "my obscure webtoon",
            sourceId: "mangakatana",
            status: "ongoing",
            genres: ["Action"],
            coverUrl: "https://cdn/cover.jpg",
            anilistId: 111
        })
        await db.manga.put(m)
        resolveMetadataMock.mockResolvedValue({
            anilistId: 999,
            title: "Completely Different Finished Series",
            status: "completed"
        })

        await backfillMangaGenres()

        const stored = await db.manga.get("m-fuzzy")
        expect(stored?.status).toBe("ongoing")
        expect(stored?.anilistId).toBe(111)
    })

    it("upgrades an ongoing title to the catalog's finished status so it can reach Completed (S1)", async () => {
        const { backfillMangaGenres } = await import("./updates-sources")

        // Genres + cover already present, status still "ongoing" from add-time; the series
        // has since finished upstream.
        const m = makeManga({
            id: "m-finished",
            title: "Finished Upstream",
            sourceId: "mangakatana",
            status: "ongoing",
            genres: ["Action"],
            coverUrl: "https://cdn/cover.jpg"
        })
        await db.manga.put(m)
        resolveMetadataMock.mockResolvedValue({ title: "Finished Upstream", status: "completed" })

        await backfillMangaGenres()

        expect((await db.manga.get("m-finished"))?.status).toBe("completed")
    })

    it("does not downgrade an ongoing title when the catalog still reports ongoing (S1)", async () => {
        const { backfillMangaGenres } = await import("./updates-sources")

        const m = makeManga({
            id: "m-still-ongoing",
            sourceId: "mangakatana",
            status: "ongoing",
            genres: ["Action"],
            coverUrl: "https://cdn/cover.jpg"
        })
        await db.manga.put(m)
        resolveMetadataMock.mockResolvedValue({ status: "ongoing" })

        await backfillMangaGenres()

        expect((await db.manga.get("m-still-ongoing"))?.status).toBe("ongoing")
    })

    it("stamps metadataUpdatedAt on a no-match so it is not re-queried next run", async () => {
        const { backfillMangaGenres } = await import("./updates-sources")

        const m = makeManga({ id: "m-nomatch", status: "unknown", genres: ["Action"], coverUrl: "https://cdn/c.jpg" })
        await db.manga.put(m)
        resolveMetadataMock.mockResolvedValue(null)

        await backfillMangaGenres()

        const stored = await db.manga.get("m-nomatch")
        expect(stored?.status).toBe("unknown")
        expect(stored?.metadataUpdatedAt).toBeGreaterThan(0)
    })
})

describe("checkUpdates progress writes", () => {
    it("writes incremental updateProgress and marks it done when the loop finishes", async () => {
        const { checkUpdates } = await import("./updates-sources")

        const mangaA = makeManga({ id: "m-a", title: "Manga A" })
        const mangaB = makeManga({ id: "m-b", title: "Manga B" })
        await db.manga.bulkPut([mangaA, mangaB])
        await db.sourceLinks.bulkPut([makeLink(mangaA.id), makeLink(mangaB.id)])
        listMangaChaptersMock.mockResolvedValue([])

        await checkUpdates()

        const finalProgress = storageLocal.store.get("updateProgress") as {
            running: boolean
            done: number
            total: number
        }
        expect(finalProgress.running).toBe(false)
        expect(finalProgress.done).toBe(2)
        expect(finalProgress.total).toBe(2)
    })

    it("records a failure state instead of throwing when loading the library fails", async () => {
        const { checkUpdates } = await import("./updates-sources")

        vi.spyOn(db.manga, "toArray").mockRejectedValueOnce(new Error("db exploded"))

        await expect(checkUpdates()).resolves.toBeUndefined()

        const finalProgress = storageLocal.store.get("updateProgress") as { running: boolean }
        expect(finalProgress.running).toBe(false)
        const status = storageLocal.store.get("updateStatus") as {
            errors: Array<{ message: string }>
        }
        expect(status.errors[0]?.message).toBe("db exploded")
    })
})

describe("updates:check handler", () => {
    it("acks immediately without awaiting the full check, and reports alreadyRunning on a concurrent call", async () => {
        const { updatesSourcesHandlers } = await import("./updates-sources")

        const manga = makeManga({ id: "m-1" })
        await db.manga.put(manga)
        await db.sourceLinks.put(makeLink(manga.id))

        let resolveFirst: (() => void) | undefined
        listMangaChaptersMock.mockImplementation(
            () =>
                new Promise(resolve => {
                    resolveFirst = () => resolve([])
                })
        )

        const handler = updatesSourcesHandlers["updates:check"]
        if (!handler) throw new Error("handler missing")

        const ack = (await handler({ type: "updates:check" }, { sender: {} })) as { started: boolean }
        expect(ack.started).toBe(true)

        await vi.waitFor(() => expect(listMangaChaptersMock).toHaveBeenCalledTimes(1))

        const secondAck = (await handler({ type: "updates:check" }, { sender: {} })) as {
            started: boolean
            alreadyRunning?: boolean
        }
        expect(secondAck.started).toBe(false)
        expect(secondAck.alreadyRunning).toBe(true)

        resolveFirst?.()
        await vi.waitFor(() => expect(storageLocal.store.get("updateStatus")).toBeTruthy())
    })
})

describe("updates:check handler stale-progress self-healing", () => {
    it("clears a stuck updateProgress from a crashed check and proceeds with a new check", async () => {
        const { updatesSourcesHandlers } = await import("./updates-sources")

        const manga = makeManga({ id: "m-1" })
        await db.manga.put(manga)
        await db.sourceLinks.put(makeLink(manga.id))
        listMangaChaptersMock.mockResolvedValue([])

        // Simulate a service worker that was killed mid-loop on a previous check:
        // running: true with a startedAt well past the staleness threshold, and
        // nothing left to ever flip it back to false.
        const staleStartedAt = Date.now() - 20 * 60 * 1000
        await storageLocal.set({
            updateProgress: { running: true, done: 0, total: 0, startedAt: staleStartedAt }
        })

        const handler = updatesSourcesHandlers["updates:check"]
        if (!handler) throw new Error("handler missing")

        const ack = (await handler({ type: "updates:check" }, { sender: {} })) as {
            started: boolean
            alreadyRunning?: boolean
        }

        expect(ack.started).toBe(true)
        expect(ack.alreadyRunning).toBeUndefined()

        await vi.waitFor(() => expect(listMangaChaptersMock).toHaveBeenCalledTimes(1))
        await vi.waitFor(
            () => {
                const progress = storageLocal.store.get("updateProgress") as { running: boolean; startedAt: number }
                expect(progress.running).toBe(false)
            },
            { timeout: 2000 }
        )
    })

    it("treats a recent running updateProgress as still active and reports alreadyRunning", async () => {
        const { updatesSourcesHandlers } = await import("./updates-sources")

        // Well within the staleness threshold - a check plausibly still in progress.
        const recentStartedAt = Date.now() - 30 * 1000
        await storageLocal.set({
            updateProgress: { running: true, done: 0, total: 5, startedAt: recentStartedAt }
        })

        const handler = updatesSourcesHandlers["updates:check"]
        if (!handler) throw new Error("handler missing")

        const ack = (await handler({ type: "updates:check" }, { sender: {} })) as {
            started: boolean
            alreadyRunning?: boolean
        }

        expect(ack.started).toBe(false)
        expect(ack.alreadyRunning).toBe(true)
        // The recent progress record must be left untouched, not overwritten.
        expect(listMangaChaptersMock).not.toHaveBeenCalled()
        const progress = storageLocal.store.get("updateProgress") as { running: boolean; startedAt: number }
        expect(progress.running).toBe(true)
        expect(progress.startedAt).toBe(recentStartedAt)
    })
})

describe("clearStaleUpdateProgress (startup/install proactive recovery)", () => {
    it("flips a persisted running: true to false, regardless of age", async () => {
        const { clearStaleUpdateProgress } = await import("./updates-sources")
        // Even a RECENT running record is stale at startup: the in-memory guard is
        // false in a fresh worker, so nothing is actually running to belong to it. A
        // check that crashed the extension mid-update bricked the UI on exactly this.
        await storageLocal.set({
            updateProgress: { running: true, done: 3, total: 10, startedAt: Date.now() - 5000 }
        })

        await clearStaleUpdateProgress()

        const progress = storageLocal.store.get("updateProgress") as { running: boolean; done: number; total: number }
        expect(progress.running).toBe(false)
        // Display fields are preserved so the UI can still show the last known counts.
        expect(progress.done).toBe(3)
        expect(progress.total).toBe(10)
    })

    it("is a no-op when there is no progress record or it is already not running", async () => {
        const { clearStaleUpdateProgress } = await import("./updates-sources")
        await clearStaleUpdateProgress()
        expect(storageLocal.store.get("updateProgress")).toBeUndefined()

        await storageLocal.set({ updateProgress: { running: false, done: 1, total: 1, startedAt: 1 } })
        storageLocal.set.mockClear()
        await clearStaleUpdateProgress()
        expect(storageLocal.set).not.toHaveBeenCalled()
    })

    it("does not resurrect a stale snapshot over a check that completed during its read (TOCTOU)", async () => {
        const { checkUpdates, clearStaleUpdateProgress } = await import("./updates-sources")

        // Genuinely stale record from a crashed prior check.
        await storageLocal.set({ updateProgress: { running: true, done: 3, total: 10, startedAt: 111 } })

        // Gate the FIRST get() so a whole checkUpdates cycle runs to completion before
        // clearStaleUpdateProgress proceeds past its await - the real race is the read
        // being issued before a fresh check starts but resolving after it finishes.
        const originalGet = storageLocal.get.getMockImplementation()!
        let release!: () => void
        const gate = new Promise<void>(r => (release = r))
        storageLocal.get.mockImplementationOnce(async (...args: unknown[]) => {
            await gate
            return originalGet(...(args as [string]))
        })

        const clearPromise = clearStaleUpdateProgress()
        await checkUpdates() // empty library -> writes a fresh {running:false, done:0, total:0, startedAt:T1}
        release()
        await clearPromise

        const progress = storageLocal.store.get("updateProgress") as { done: number; total: number; startedAt: number }
        // Must reflect the fresh check, not the stale done:3/total:10/startedAt:111 snapshot.
        expect(progress.done).toBe(0)
        expect(progress.total).toBe(0)
        expect(progress.startedAt).not.toBe(111)
    })
})

describe("abortLongRunningTasks covers backfillMangaGenres", () => {
    it("stops the genre backfill loop at the next title", async () => {
        const { backfillMangaGenres, abortLongRunningTasks } = await import("./updates-sources")

        for (let i = 0; i < 4; i++) {
            await db.manga.put(makeManga({ id: `g-${i}`, mangaUrl: `https://example.test/${i}`, genres: [] }))
        }
        // Abort while the first title is resolving - the loop must break before the rest.
        resolveGenresForMock.mockImplementation(async () => {
            abortLongRunningTasks()
            return []
        })

        await backfillMangaGenres()

        expect(resolveGenresForMock).toHaveBeenCalledTimes(1)
    })

    it("does not run the cover fetch for a title whose genre fetch triggered the abort", async () => {
        const { backfillMangaGenres, abortLongRunningTasks } = await import("./updates-sources")

        // Missing BOTH genres and cover, so both branches would otherwise run for this title.
        await db.manga.put(makeManga({ id: "g-both", mangaUrl: "https://example.test/x", genres: [] }))
        resolveGenresForMock.mockImplementation(async () => {
            abortLongRunningTasks()
            return []
        })
        resolveCoverForMock.mockResolvedValue("https://example.test/cover.jpg")

        await backfillMangaGenres()

        expect(resolveGenresForMock).toHaveBeenCalledTimes(1)
        expect(resolveCoverForMock).not.toHaveBeenCalled()
    })
})

describe("checkUpdates concurrency guard", () => {
    it("a second concurrent call returns immediately instead of running the loop twice", async () => {
        const { checkUpdates } = await import("./updates-sources")

        const manga = makeManga({ id: "m-1" })
        await db.manga.put(manga)
        await db.sourceLinks.put(makeLink(manga.id))

        let resolveFirst: (() => void) | undefined
        listMangaChaptersMock.mockImplementation(
            () =>
                new Promise(resolve => {
                    resolveFirst = () => resolve([])
                })
        )

        const first = checkUpdates()
        // Let the first call reach the in-flight fetch before starting the second.
        // Poll rather than a fixed tick - how many microtasks the DB reads take
        // before reaching listMangaChapters varies (much slower under coverage
        // instrumentation), so a single setTimeout(0) is not reliably enough.
        await vi.waitFor(() => expect(listMangaChaptersMock).toHaveBeenCalledTimes(1))

        const second = checkUpdates()
        const secondResult = await second
        expect(secondResult).toBeUndefined()
        expect(listMangaChaptersMock).toHaveBeenCalledTimes(1)

        resolveFirst?.()
        await first
    })

    it("abortLongRunningTasks stops the loop at the next title instead of finishing the library", async () => {
        const { checkUpdates, abortLongRunningTasks } = await import("./updates-sources")

        for (let i = 0; i < 4; i++) {
            const manga = makeManga({ id: `m-${i}` })
            await db.manga.put(manga)
            await db.sourceLinks.put(makeLink(manga.id))
        }

        // Abort as soon as the first title is being processed - the loop must break
        // before reaching the remaining three, never running the whole library.
        listMangaChaptersMock.mockImplementation(async () => {
            abortLongRunningTasks()
            return []
        })

        await checkUpdates()

        expect(listMangaChaptersMock).toHaveBeenCalledTimes(1)
        const progress = storageLocal.store.get("updateProgress") as { running: boolean }
        expect(progress.running).toBe(false)
    })

    it("an aborted check does not publish its partial counts as the library-wide status", async () => {
        const { checkUpdates, abortLongRunningTasks } = await import("./updates-sources")

        for (let i = 0; i < 4; i++) {
            const manga = makeManga({ id: `m-${i}` })
            await db.manga.put(manga)
            await db.sourceLinks.put(makeLink(manga.id))
        }
        // A previous completed check's status must survive an abort untouched, rather
        // than being overwritten with a 1-of-4 partial run shown as freshly finished.
        await storageLocal.set({
            updateStatus: { checked: 4, updated: 0, failed: 0, checkedAt: 111, errors: [] }
        })

        listMangaChaptersMock.mockImplementation(async () => {
            abortLongRunningTasks()
            return []
        })
        await checkUpdates()

        const status = storageLocal.store.get("updateStatus") as { checked: number; checkedAt: number }
        expect(status.checked).toBe(4)
        expect(status.checkedAt).toBe(111)
        const progress = storageLocal.store.get("updateProgress") as { running: boolean }
        expect(progress.running).toBe(false)
    })
})

describe("updates:new-chapters handler", () => {
    it("returns chapters newer than lastReadChapterNumber, falling back to the last 3", async () => {
        const { updatesSourcesHandlers } = await import("./updates-sources")

        const manga = makeManga({ id: "m-1", lastReadChapterNumber: 3 })
        await db.manga.put(manga)

        const chapters: ChapterRecord[] = [1, 2, 3, 4, 5].map(n => ({
            id: `ch-${n}`,
            mangaId: manga.id,
            sourceId: "mangadex",
            title: `Chapter ${n}`,
            url: `https://mangadex.org/chapter/${n}`,
            sortKey: n
        }))
        await db.chapters.bulkPut(chapters)

        const handler = updatesSourcesHandlers["updates:new-chapters"]
        if (!handler) throw new Error("handler missing")
        const result = (await handler({ type: "updates:new-chapters", mangaId: manga.id }, { sender: {} })) as Array<{
            sortKey: number
        }>

        expect(result.map(c => c.sortKey)).toEqual([4, 5])
    })

    it("falls back to the last 3 chapters when none are newer than lastReadChapterNumber", async () => {
        const { updatesSourcesHandlers } = await import("./updates-sources")

        const manga = makeManga({ id: "m-2", lastReadChapterNumber: 10 })
        await db.manga.put(manga)

        const chapters: ChapterRecord[] = [1, 2, 3, 4, 5].map(n => ({
            id: `ch2-${n}`,
            mangaId: manga.id,
            sourceId: "mangadex",
            title: `Chapter ${n}`,
            url: `https://mangadex.org/chapter/${n}`,
            sortKey: n
        }))
        await db.chapters.bulkPut(chapters)

        const handler = updatesSourcesHandlers["updates:new-chapters"]
        if (!handler) throw new Error("handler missing")
        const result = (await handler({ type: "updates:new-chapters", mangaId: manga.id }, { sender: {} })) as Array<{
            sortKey: number
        }>

        expect(result.map(c => c.sortKey)).toEqual([3, 4, 5])
    })

    // Regression test for the UNNUMBERED_SORT_KEY (Infinity) leak class, site 3
    // (permanent phantom updates): `sortKey > sinceKey` is always true for an
    // unnumbered chapter (Infinity > sinceKey), so it used to be reported as a "new"
    // chapter on every single update check, forever.
    it("never reports an unnumbered (Infinity sortKey) chapter as newer-than-lastRead, even though Infinity beats any real chapter number", async () => {
        const { updatesSourcesHandlers } = await import("./updates-sources")

        const manga = makeManga({ id: "m-3", lastReadChapterNumber: 1 })
        await db.manga.put(manga)

        const chapters: ChapterRecord[] = [
            {
                id: "ch3-1",
                mangaId: manga.id,
                sourceId: "mangadex",
                title: "Chapter 1",
                url: "https://mangadex.org/chapter/1",
                sortKey: 1
            },
            {
                id: "ch3-2",
                mangaId: manga.id,
                sourceId: "mangadex",
                title: "Chapter 2",
                url: "https://mangadex.org/chapter/2",
                sortKey: 2
            },
            {
                id: "ch3-3",
                mangaId: manga.id,
                sourceId: "mangadex",
                title: "Chapter 3",
                url: "https://mangadex.org/chapter/3",
                sortKey: 3
            },
            {
                id: "ch3-extra",
                mangaId: manga.id,
                sourceId: "mangadex",
                title: "Extra",
                url: "https://mangadex.org/chapter/extra",
                sortKey: Number.POSITIVE_INFINITY
            }
        ]
        await db.chapters.bulkPut(chapters)

        const handler = updatesSourcesHandlers["updates:new-chapters"]
        if (!handler) throw new Error("handler missing")
        const result = (await handler({ type: "updates:new-chapters", mangaId: manga.id }, { sender: {} })) as Array<{
            id: string
        }>

        expect(result.map(c => c.id)).toEqual(["ch3-2", "ch3-3"])
    })
})

describe("checkExtensionUpdate", () => {
    it("clears a stale extensionUpdate value before fetching fresh data when forced", async () => {
        const { checkExtensionUpdate } = await import("./updates-sources")

        await storageLocal.set({
            extensionUpdate: {
                available: false,
                latestVersion: "0.1.0",
                releaseUrl: "https://example.com/old",
                checkedAt: 1
            }
        })

        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => ({
                tag_name: "v2.0.0",
                html_url: "https://github.com/Ryuu3rs/storyhoard-extension/releases/tag/v2.0.0"
            })
        }))
        vi.stubGlobal("fetch", fetchMock)

        await checkExtensionUpdate(true)

        expect(storageLocal.remove).toHaveBeenCalledWith("extensionUpdate")
        const stored = storageLocal.store.get("extensionUpdate") as { latestVersion: string; available: boolean }
        expect(stored.latestVersion).toBe("2.0.0")
        expect(stored.available).toBe(true)

        vi.unstubAllGlobals()
    })
})

// Bug 8: the per-title db.sourceLinks.get(item.id) and writeProgress(item.title) sit
// OUTSIDE the per-title try, and checkUpdates' outer finally only reset the in-memory
// updateCheckRunning guard - not the PERSISTED updateProgress. A transient IndexedDB
// rejection there left updateProgress.running: true, blocking every future updates:check
// with alreadyRunning until the 15-minute stale timeout.
describe("checkUpdates mid-loop throw leaves persisted progress not-running (Bug 8)", () => {
    it("resets updateProgress.running to false when db.sourceLinks.get rejects mid-loop", async () => {
        const { checkUpdates } = await import("./updates-sources")

        const manga = makeManga({ id: "m-1" })
        await db.manga.put(manga)
        await db.sourceLinks.put(makeLink(manga.id))

        vi.spyOn(db.sourceLinks, "get").mockRejectedValueOnce(new Error("idb exploded"))

        await expect(checkUpdates()).resolves.toBeUndefined()

        const progress = storageLocal.store.get("updateProgress") as { running: boolean }
        expect(progress.running).toBe(false)
    })
})

// Bug 22: an extension update that arrives while the worker is idle sets a persistent
// latch; the next alarm-driven checkUpdates/backfillMangaGenres must early-return so the
// worker stays idle and the browser applies the update, instead of starting a fresh
// multi-minute loop that re-defers it.
describe("pending-update latch (Bug 22)", () => {
    it("checkUpdates early-returns without touching the library when an update is pending", async () => {
        const { checkUpdates, markUpdatePending } = await import("./updates-sources")

        const manga = makeManga({ id: "m-1" })
        await db.manga.put(manga)
        await db.sourceLinks.put(makeLink(manga.id))
        listMangaChaptersMock.mockResolvedValue([])

        await markUpdatePending()
        await checkUpdates()

        expect(listMangaChaptersMock).not.toHaveBeenCalled()
    })

    it("backfillMangaGenres early-returns when an update is pending", async () => {
        const { backfillMangaGenres, markUpdatePending } = await import("./updates-sources")

        await db.manga.put(makeManga({ id: "m-1", mangaUrl: "https://mangadex.org/title/a", genres: [] }))
        resolveGenresForMock.mockResolvedValue(["Action"])

        await markUpdatePending()
        await backfillMangaGenres()

        expect(resolveGenresForMock).not.toHaveBeenCalled()
    })

    it("clearUpdatePending re-enables the checks", async () => {
        const { checkUpdates, markUpdatePending, clearUpdatePending } = await import("./updates-sources")

        const manga = makeManga({ id: "m-1" })
        await db.manga.put(manga)
        await db.sourceLinks.put(makeLink(manga.id))
        listMangaChaptersMock.mockResolvedValue([])

        await markUpdatePending()
        await clearUpdatePending()
        await checkUpdates()

        expect(listMangaChaptersMock).toHaveBeenCalledTimes(1)
    })
})

describe("checkUpdates profile-source honesty", () => {
    it("does not count a tracking-only profile title as checked; it gets its own tally and no fetch", async () => {
        const { checkUpdates } = await import("./updates-sources")
        trackingOnlyIds.add("kagane")
        const tracked = makeManga({ id: "m-tracked", sourceId: "kagane" })
        const normal = makeManga({ id: "m-normal", sourceId: "mangadex" })
        await db.manga.bulkPut([tracked, normal])
        await db.sourceLinks.bulkPut([makeLink(tracked.id, "kagane"), makeLink(normal.id, "mangadex")])
        listMangaChaptersMock.mockResolvedValue([])

        await checkUpdates()

        expect(listMangaChaptersMock).toHaveBeenCalledTimes(1)
        const status = storageLocal.store.get("updateStatus") as {
            checked: number
            failed: number
            trackingOnly: Record<string, number>
        }
        expect(status.checked).toBe(1)
        expect(status.failed).toBe(0)
        expect(status.trackingOnly).toEqual({ kagane: 1 })
        expect((storageLocal.store.get("updateProgress") as { done: number }).done).toBe(2)
    })

    it("records an empty chapter list from a profile source whose title already had a chapter", async () => {
        const { checkUpdates } = await import("./updates-sources")
        profileIds.add("kagane")
        const had = makeManga({ id: "m-had", sourceId: "kagane", latestChapterId: "kagane:chapter:x:3" })
        const fresh = makeManga({ id: "m-fresh", sourceId: "kagane" })
        await db.manga.bulkPut([had, fresh])
        await db.sourceLinks.bulkPut([makeLink(had.id, "kagane"), makeLink(fresh.id, "kagane")])
        listMangaChaptersMock.mockResolvedValue([])

        await checkUpdates()

        const status = storageLocal.store.get("updateStatus") as {
            checked: number
            emptyLists: Record<string, number>
        }
        expect(status.emptyLists).toEqual({ kagane: 1 })
        expect(status.checked).toBe(1)
        expect((storageLocal.store.get("updateProgress") as { done: number }).done).toBe(2)
    })

    it("does not flag an empty list from a bundled (non-profile) source", async () => {
        const { checkUpdates } = await import("./updates-sources")
        const had = makeManga({ id: "m-had", sourceId: "mangadex", latestChapterId: "x" })
        await db.manga.put(had)
        await db.sourceLinks.put(makeLink(had.id))
        listMangaChaptersMock.mockResolvedValue([])

        await checkUpdates()

        const status = storageLocal.store.get("updateStatus") as { checked: number; emptyLists: object }
        expect(status.emptyLists).toEqual({})
        expect(status.checked).toBe(1)
    })
})
