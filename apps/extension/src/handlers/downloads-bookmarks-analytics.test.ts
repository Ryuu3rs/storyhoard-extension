import "fake-indexeddb/auto"
import type { ChapterRecord, MangaRecord } from "@amr/contracts"
import type { ResolvedChapter } from "@amr/source-sdk"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { db } from "../database"
import type { HandlerContext } from "../background/handler-types"

vi.mock("../sources", () => ({
    resolveChapterUrl: vi.fn()
}))

import { resolveChapterUrl } from "../sources"
import { downloadsBookmarksAnalyticsHandlers } from "./downloads-bookmarks-analytics"

const ctx = {} as HandlerContext

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
    title: "Chapter 1",
    url: "https://mangadex.org/chapter/1",
    sortKey: 1
}

function makeResolved(pageUrls: string[]): ResolvedChapter {
    return {
        manga: { manga, sourceId: "mangadex", sourceMangaId: "abc", url: "https://mangadex.org/title/abc" },
        chapter: { ...chapter, sourceChapterId: "1", language: "en" },
        pages: pageUrls.map((url, i) => ({ id: String(i), url }))
    }
}

function jsonBlob(): Blob {
    return new Blob(["x"], { type: "image/jpeg" })
}

beforeEach(async () => {
    vi.clearAllMocks()
    vi.useRealTimers()
    await Promise.all([db.downloads.clear(), db.pageBookmarks.clear(), db.analyticsEvents.clear(), db.manga.clear()])
    // chapter:download now requires the title to be in the library (anti-orphan guard).
    await db.manga.put({ ...manga, sourceId: "mangadex", sourceUrl: "https://mangadex.org/title/abc" })
})

describe("chapter:download library guard", () => {
    it("does NOT persist a download for a title that is not in the library (anti-orphan)", async () => {
        await db.manga.clear() // title was never added
        vi.mocked(resolveChapterUrl).mockResolvedValue(makeResolved(["https://cdn.example/p0.jpg"]))
        const fetchMock = vi.fn(
            async () => ({ ok: true, status: 200, blob: async () => jsonBlob() }) as unknown as Response
        )
        vi.stubGlobal("fetch", fetchMock)

        const handler = downloadsBookmarksAnalyticsHandlers["chapter:download"]!
        await expect(
            handler({ type: "chapter:download", url: "https://mangadex.org/chapter/1" }, ctx)
        ).rejects.toThrow()
        expect(await db.downloads.count()).toBe(0)
        // Should fail fast BEFORE fetching any page blob.
        expect(fetchMock).not.toHaveBeenCalled()

        vi.unstubAllGlobals()
    })

    it("dedups two concurrent downloads of the same chapter URL into one resolve+fetch pass", async () => {
        vi.mocked(resolveChapterUrl).mockResolvedValue(makeResolved(["https://cdn.example/p1.jpg"]))
        const fetchMock = vi.fn(
            async () => ({ ok: true, status: 200, blob: async () => jsonBlob() }) as unknown as Response
        )
        vi.stubGlobal("fetch", fetchMock)

        const handler = downloadsBookmarksAnalyticsHandlers["chapter:download"]!
        const url = "https://mangadex.org/chapter/1"
        const [a, b] = await Promise.all([
            handler({ type: "chapter:download", url }, ctx),
            handler({ type: "chapter:download", url }, ctx)
        ])
        expect(a).toEqual(b)
        expect(resolveChapterUrl).toHaveBeenCalledTimes(1) // shared promise, not 2

        vi.unstubAllGlobals()
    })
})

describe("fetchPageBlob (via chapter:download)", () => {
    it("retries a transient failure (500) with backoff and eventually succeeds", async () => {
        vi.mocked(resolveChapterUrl).mockResolvedValue(makeResolved(["https://cdn.example/p1.jpg"]))

        let calls = 0
        const fetchMock = vi.fn(async () => {
            calls += 1
            if (calls < 3) {
                return { ok: false, status: 500 } as Response
            }
            return { ok: true, status: 200, blob: async () => jsonBlob() } as unknown as Response
        })
        vi.stubGlobal("fetch", fetchMock)

        const handler = downloadsBookmarksAnalyticsHandlers["chapter:download"]!
        const result = (await handler({ type: "chapter:download", url: "https://mangadex.org/chapter/1" }, ctx)) as {
            chapterId: string
            pageCount: number
        }

        expect(fetchMock).toHaveBeenCalledTimes(3)
        expect(result.pageCount).toBe(1)

        vi.unstubAllGlobals()
    })

    it("does not retry on a 404/410 - fast-fails immediately", async () => {
        vi.mocked(resolveChapterUrl).mockResolvedValue(makeResolved(["https://cdn.example/p1.jpg"]))

        const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }) as Response)
        vi.stubGlobal("fetch", fetchMock)

        const handler = downloadsBookmarksAnalyticsHandlers["chapter:download"]!
        await expect(
            handler({ type: "chapter:download", url: "https://mangadex.org/chapter/1" }, ctx)
        ).rejects.toThrow()

        // Only 1 attempt at the fetchPageBlob level for this URL, plus the automatic
        // expired-re-resolve loop calls resolveChapterUrl again with the same single
        // page - since reResolved flips true after the first 404, the second 404 on
        // the retried page throws immediately without further fetch attempts.
        expect(fetchMock).toHaveBeenCalledTimes(2)

        vi.unstubAllGlobals()
    })
})

describe("chapter:download expired-URL re-resolve", () => {
    it("re-resolves exactly once on a 410 and restarts the download from the fresh page list", async () => {
        const staleResolved = makeResolved(["https://cdn.example/p0.jpg", "https://cdn.example/stale-p1.jpg"])
        const freshResolved = makeResolved(["https://cdn.example/p0.jpg", "https://cdn.example/fresh-p1.jpg"])

        vi.mocked(resolveChapterUrl).mockResolvedValueOnce(staleResolved).mockResolvedValueOnce(freshResolved)

        const fetchMock = vi.fn(async (url: string) => {
            if (url === "https://cdn.example/stale-p1.jpg") {
                return { ok: false, status: 410 } as Response
            }
            return { ok: true, status: 200, blob: async () => jsonBlob() } as unknown as Response
        })
        vi.stubGlobal("fetch", fetchMock)

        const handler = downloadsBookmarksAnalyticsHandlers["chapter:download"]!
        const result = (await handler({ type: "chapter:download", url: "https://mangadex.org/chapter/1" }, ctx)) as {
            chapterId: string
            pageCount: number
        }

        expect(resolveChapterUrl).toHaveBeenCalledTimes(2)
        expect(result.pageCount).toBe(2)
        // The blob from the stale list is discarded and the whole chapter is re-fetched
        // from the fresh list: p0(stale), stale-p1(410), then restart p0(fresh), fresh-p1.
        expect(fetchMock).toHaveBeenCalledTimes(4)
        const fetched = fetchMock.mock.calls.map(c => c[0])
        expect(fetched.filter(u => u === "https://cdn.example/stale-p1.jpg")).toHaveLength(1)
        expect(fetched).toContain("https://cdn.example/fresh-p1.jpg")

        vi.unstubAllGlobals()
    })

    it("keeps saved pages consistent when the refreshed list has a different page count", async () => {
        // Reconciliation bug: the stale resolution had 3 pages and one blob was already
        // fetched; the refreshed resolution has only 2, different URLs. Interleaving the
        // stale blob with the fresh list would misalign pages, so the saved download must
        // contain exactly the fresh list, fetched fresh.
        const staleResolved = makeResolved([
            "https://cdn.example/s0.jpg",
            "https://cdn.example/s1.jpg",
            "https://cdn.example/s2.jpg"
        ])
        const freshResolved = makeResolved(["https://cdn.example/f0.jpg", "https://cdn.example/f1.jpg"])

        vi.mocked(resolveChapterUrl).mockResolvedValueOnce(staleResolved).mockResolvedValueOnce(freshResolved)

        const fetchMock = vi.fn(async (url: string) => {
            if (url === "https://cdn.example/s1.jpg") {
                return { ok: false, status: 404 } as Response
            }
            return { ok: true, status: 200, blob: async () => jsonBlob() } as unknown as Response
        })
        vi.stubGlobal("fetch", fetchMock)

        const handler = downloadsBookmarksAnalyticsHandlers["chapter:download"]!
        const result = (await handler({ type: "chapter:download", url: "https://mangadex.org/chapter/1" }, ctx)) as {
            chapterId: string
            pageCount: number
        }

        expect(result.pageCount).toBe(2)
        const fetched = fetchMock.mock.calls.map(c => c[0])
        // No stale-list URL survives into the completed download.
        expect(fetched).toContain("https://cdn.example/f0.jpg")
        expect(fetched).toContain("https://cdn.example/f1.jpg")
        const getHandler = downloadsBookmarksAnalyticsHandlers["chapter:download:get"]!
        const stored = (await getHandler({ type: "chapter:download:get", chapterId: result.chapterId }, ctx)) as {
            pageCount: number
        } | null
        expect(stored?.pageCount).toBe(2)

        vi.unstubAllGlobals()
    })

    it("does not loop infinitely if the re-resolved chapter also 410s on the same page", async () => {
        const staleResolved = makeResolved(["https://cdn.example/dead.jpg"])
        vi.mocked(resolveChapterUrl).mockResolvedValue(staleResolved)

        const fetchMock = vi.fn(async () => ({ ok: false, status: 410 }) as Response)
        vi.stubGlobal("fetch", fetchMock)

        const handler = downloadsBookmarksAnalyticsHandlers["chapter:download"]!
        await expect(
            handler({ type: "chapter:download", url: "https://mangadex.org/chapter/1" }, ctx)
        ).rejects.toThrow()

        expect(resolveChapterUrl).toHaveBeenCalledTimes(2)
        expect(fetchMock).toHaveBeenCalledTimes(2)

        vi.unstubAllGlobals()
    })
})

describe("chapter:download page cap", () => {
    it("caps at 200 pages and saveDownload's pageCount matches blobs actually fetched", async () => {
        const urls = Array.from({ length: 250 }, (_, i) => `https://cdn.example/p${i}.jpg`)
        vi.mocked(resolveChapterUrl).mockResolvedValue(makeResolved(urls))

        const fetchMock = vi.fn(
            async () => ({ ok: true, status: 200, blob: async () => jsonBlob() }) as unknown as Response
        )
        vi.stubGlobal("fetch", fetchMock)

        const handler = downloadsBookmarksAnalyticsHandlers["chapter:download"]!
        const result = (await handler({ type: "chapter:download", url: "https://mangadex.org/chapter/1" }, ctx)) as {
            chapterId: string
            pageCount: number
        }

        expect(result.pageCount).toBe(200)
        expect(fetchMock).toHaveBeenCalledTimes(200)

        const stored = await db.downloads.get(chapter.id)
        expect(stored?.pageCount).toBe(200)
        expect(stored?.pageBlobs.length).toBe(200)

        vi.unstubAllGlobals()
    })
})

describe("bookmark:toggle / bookmark:pages", () => {
    it("toggling the same page twice results in net removal and bookmark:pages reflects it", async () => {
        const toggleHandler = downloadsBookmarksAnalyticsHandlers["bookmark:toggle"]!
        const pagesHandler = downloadsBookmarksAnalyticsHandlers["bookmark:pages"]!

        const request = {
            type: "bookmark:toggle" as const,
            mangaId: manga.id,
            chapterId: chapter.id,
            pageIndex: 3,
            mangaTitle: "Test Manga",
            chapterTitle: "Chapter 1",
            chapterUrl: "https://mangadex.org/chapter/1"
        }

        const first = await toggleHandler(request, ctx)
        expect(first).toBe(true)

        const afterFirst = (await pagesHandler({ type: "bookmark:pages", chapterId: chapter.id }, ctx)) as number[]
        expect(afterFirst).toEqual([3])

        const second = await toggleHandler(request, ctx)
        expect(second).toBe(false)

        const afterSecond = (await pagesHandler({ type: "bookmark:pages", chapterId: chapter.id }, ctx)) as number[]
        expect(afterSecond).toEqual([])
    })
})

describe("analytics:record", () => {
    it("returns immediately without waiting on the DB write, and the event eventually lands", async () => {
        const handler = downloadsBookmarksAnalyticsHandlers["analytics:record"]!

        // Gate db.analyticsEvents.add() so it stays pending until we release it.
        // If the handler awaited recordAnalyticsEvent, `handler(...)` below would
        // hang until releaseWrite() is called - it doesn't, proving fire-and-forget.
        let releaseWrite: () => void = () => {}
        const gate = new Promise<void>(resolve => {
            releaseWrite = resolve
        })
        const realAdd = db.analyticsEvents.add.bind(db.analyticsEvents)
        const addSpy = vi
            .spyOn(db.analyticsEvents, "add")
            .mockImplementation(((...args: Parameters<typeof realAdd>) =>
                gate.then(() => realAdd(...args))) as typeof realAdd)

        const result = await handler({ type: "analytics:record", event: "capture_ok", sourceId: "mangadex" }, ctx)

        expect(result).toBeNull()
        // The handler already resolved above even though the gated add() has not.
        expect(await db.analyticsEvents.where("event").equals("capture_ok").count()).toBe(0)

        releaseWrite()
        addSpy.mockRestore()

        // Let the now-unblocked write settle, then confirm it landed in the DB.
        await vi.waitFor(async () => {
            expect(await db.analyticsEvents.where("event").equals("capture_ok").count()).toBe(1)
        })
    })
})

describe("log:export (bughunt regression)", () => {
    it("still returns the log when a config/secret read throws", async () => {
        await db.logs.clear()
        await db.logs.add({ ts: 1, level: "warn", scope: "chapters", message: "listed 9 chapters" })

        // browser present for the manifest version, but every storage read rejects -
        // simulating a config read failure. The handler must degrade, not deny the log.
        // @ts-expect-error test-only shim
        globalThis.browser = {
            runtime: { getManifest: () => ({ version: "9.9.9" }) },
            storage: { local: { get: vi.fn(async () => Promise.reject(new Error("IDB read failed"))) } }
        }
        try {
            const res = (await downloadsBookmarksAnalyticsHandlers["log:export"]!(
                { type: "log:export" } as never,
                ctx
            )) as { text: string }
            expect(res.text).toContain("listed 9 chapters")
            expect(res.text).toContain("extension version: 9.9.9")
        } finally {
            // @ts-expect-error test-only shim
            delete globalThis.browser
        }
    })
})

describe("log:export redaction", () => {
    it("redacts the weeb.ltd device link and account id like the AniList and GitHub tokens", async () => {
        // An opaque device link with no prefix the formatter's patterns know; the known-secret list redacts it.
        const deviceToken = "k3Jx9QmZr2Lw8TnVb5HyC4dFs7GpA1eU6oYiN0tMqWcR"
        const accountId = "acct-7f3a9c21"
        await db.logs.clear()
        await db.logs.add({
            ts: 1,
            level: "warn",
            scope: "account-sync",
            message: "sync failed",
            detail: `request for ${accountId} with ${deviceToken} refused`
        })
        const store: Record<string, unknown> = {
            account: {
                token: deviceToken,
                userId: accountId,
                lastPushAt: 0,
                lastSyncAt: 0,
                invalid: false,
                autoSync: true
            }
        }
        // @ts-expect-error test-only shim
        globalThis.browser = {
            runtime: { getManifest: () => ({ version: "0.33.0" }) },
            storage: {
                local: {
                    get: vi.fn(async (key: string | string[]) => {
                        const keys = Array.isArray(key) ? key : [key]
                        return Object.fromEntries(keys.filter(k => k in store).map(k => [k, store[k]]))
                    })
                }
            }
        }
        try {
            const res = (await downloadsBookmarksAnalyticsHandlers["log:export"]!(
                { type: "log:export" } as never,
                ctx
            )) as { text: string }
            expect(res.text).toContain("sync failed")
            expect(res.text).not.toContain(deviceToken)
            expect(res.text).not.toContain(accountId)
        } finally {
            // @ts-expect-error test-only shim
            delete globalThis.browser
        }
    })
})
describe("chapter:download (bughunt regression)", () => {
    it("does not save a download when the chapter resolves to zero pages", async () => {
        vi.mocked(resolveChapterUrl).mockResolvedValue(makeResolved([]))
        await expect(
            downloadsBookmarksAnalyticsHandlers["chapter:download"]!(
                { type: "chapter:download", url: "https://mangadex.org/chapter/1" } as never,
                ctx
            )
        ).rejects.toThrow()
        expect(await db.downloads.count()).toBe(0)
    })
})
