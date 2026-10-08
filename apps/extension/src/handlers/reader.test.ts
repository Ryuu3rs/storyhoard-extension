import "fake-indexeddb/auto"
import type { ChapterRecord } from "@amr/contracts"
import { SourceRequestError } from "@amr/source-sdk"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { HandlerContext } from "../background/handler-types"
import type { LibraryManga } from "../database"

const resolveChapterUrlMock = vi.fn()
const resolveChapterFromHtmlMock = vi.fn()
const listChaptersBySourceMock = vi.fn()
const findSourceMock = vi.fn()
const getSourceByIdMock = vi.fn()
const resolveMangaMetadataMock = vi.fn()

vi.mock("../sources", () => ({
    findSource: (...args: unknown[]) => findSourceMock(...args),
    getSourceById: (...args: unknown[]) => getSourceByIdMock(...args),
    resolveChapterUrl: (...args: unknown[]) => resolveChapterUrlMock(...args),
    resolveChapterFromHtml: (...args: unknown[]) => resolveChapterFromHtmlMock(...args),
    listChaptersBySource: (...args: unknown[]) => listChaptersBySourceMock(...args),
    resolveMangaMetadata: (...args: unknown[]) => resolveMangaMetadataMock(...args),
    // Passthrough: these tests use untagged chapters, for which the real filter is a
    // no-op anyway (chaptersForLanguage keeps untagged chapters).
    chaptersForLanguage: <T>(chapters: T[]) => chapters,
    tabOriginsForSource: () => undefined
}))

const fetchChapterHtmlViaTabMock = vi.fn()
vi.mock("../background/tab-fetch", () => ({
    fetchChapterHtmlViaTab: (...args: unknown[]) => fetchChapterHtmlViaTabMock(...args)
}))

const getSettingsMock = vi.fn()
vi.mock("../settings", () => ({
    getSettings: (...args: unknown[]) => getSettingsMock(...args)
}))
// Default so handlers that read settings.language (chapter:siblings, reader:chapters)
// always get an object; individual tests override with their own resolved value.
getSettingsMock.mockResolvedValue({ language: "en" })

// captureChapter now publishes to the live bus on a successful capture (see
// background/capture.ts) - stub it out here since these tests only stub
// `browser.action`, not `browser.storage`.
const publishLiveMock = vi.fn()
vi.mock("../live", () => ({
    publishLive: (...args: unknown[]) => publishLiveMock(...args)
}))

const { db } = await import("../database")
const { readerHandlers } = await import("./reader")
const { captureChapter } = await import("../background/capture")

vi.spyOn(await import("../background/chapter-cache"), "scheduleChapterListRefresh").mockImplementation(() => {})

// captureChapter's success/external paths call flashAddedBadge(), which touches the
// WebExtension `browser` global - not present under vitest's node environment (WXT
// normally injects it). Stub just enough of the surface for these tests.
vi.stubGlobal("browser", {
    action: {
        setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
        setBadgeText: vi.fn().mockResolvedValue(undefined)
    }
})

const mkCtx = (): HandlerContext => ({ sender: {} as HandlerContext["sender"] })

const manga: LibraryManga = {
    id: "mangadex:manga:abc",
    title: "Test Manga",
    normalizedTitle: "test manga",
    authors: [],
    status: "ongoing",
    addedAt: 1,
    updatedAt: 1,
    sourceId: "mangadex",
    sourceUrl: "https://mangadex.org/title/abc"
}

function chapter(id: string, sortKey: number, url: string): ChapterRecord {
    return {
        id,
        mangaId: manga.id,
        sourceId: "mangadex",
        title: `Chapter ${sortKey}`,
        url,
        sortKey
    }
}

beforeEach(async () => {
    vi.clearAllMocks()
    await Promise.all([db.manga.clear(), db.chapters.clear(), db.progress.clear(), db.historyEvents.clear()])
})

describe("chapter:siblings", () => {
    it("returns prev/next for a chapter in the middle of a sorted list", async () => {
        await db.manga.put(manga)
        await db.chapters.bulkPut([
            chapter("c1", 1, "https://mangadex.org/chapter/1"),
            chapter("c2", 2, "https://mangadex.org/chapter/2"),
            chapter("c3", 3, "https://mangadex.org/chapter/3")
        ])

        const result = (await readerHandlers["chapter:siblings"]!(
            { type: "chapter:siblings", url: "https://mangadex.org/chapter/2" },
            mkCtx()
        )) as { prevUrl: string | null; nextUrl: string | null }

        expect(result.prevUrl).toBe("https://mangadex.org/chapter/1")
        expect(result.nextUrl).toBe("https://mangadex.org/chapter/3")
    })

    it("returns null at both ends of the list", async () => {
        await db.manga.put(manga)
        await db.chapters.bulkPut([
            chapter("c1", 1, "https://mangadex.org/chapter/1"),
            chapter("c2", 2, "https://mangadex.org/chapter/2"),
            chapter("c3", 3, "https://mangadex.org/chapter/3")
        ])

        const first = (await readerHandlers["chapter:siblings"]!(
            { type: "chapter:siblings", url: "https://mangadex.org/chapter/1" },
            mkCtx()
        )) as { prevUrl: string | null; nextUrl: string | null }
        expect(first.prevUrl).toBeNull()
        expect(first.nextUrl).toBe("https://mangadex.org/chapter/2")

        const last = (await readerHandlers["chapter:siblings"]!(
            { type: "chapter:siblings", url: "https://mangadex.org/chapter/3" },
            mkCtx()
        )) as { prevUrl: string | null; nextUrl: string | null }
        expect(last.prevUrl).toBe("https://mangadex.org/chapter/2")
        expect(last.nextUrl).toBeNull()
    })

    it("returns null for a URL that is not in the DB at all", async () => {
        const result = (await readerHandlers["chapter:siblings"]!(
            { type: "chapter:siblings", url: "https://mangadex.org/chapter/unknown" },
            mkCtx()
        )) as { prevUrl: string | null; nextUrl: string | null; mangaTitle: string | null; chapterTitle: string | null }

        expect(result).toEqual({
            prevUrl: null,
            nextUrl: null,
            mangaTitle: null,
            chapterTitle: null,
            mangaId: null,
            workKey: null
        })
    })
})

describe("captureChapter dedup", () => {
    it("only runs the underlying capture logic once for concurrent calls with the same URL", async () => {
        const source = {
            manifest: { id: "mangadex" },
            match: vi.fn().mockReturnValue("chapter"),
            parseMangaUrl: vi.fn().mockReturnValue(null)
        }
        findSourceMock.mockReturnValue(source)
        getSettingsMock.mockResolvedValue({ autoAdd: true })

        let resolveCalls = 0
        resolveChapterUrlMock.mockImplementation(async () => {
            resolveCalls += 1
            // Simulate network latency so both calls are truly concurrent.
            await new Promise(r => setTimeout(r, 10))
            return {
                manga: {
                    manga: { ...manga, id: "mangadex:manga:dedup" },
                    sourceId: "mangadex",
                    sourceMangaId: "dedup",
                    url: "https://mangadex.org/title/dedup"
                },
                chapter: chapter("mangadex:chapter:dedup:1", 1, "https://mangadex.org/chapter/dedup-1")
            }
        })

        const url = "https://mangadex.org/chapter/dedup-1"
        const [first, second] = await Promise.all([captureChapter(url), captureChapter(url)])

        expect(resolveCalls).toBe(1)
        // One call does the real capture, the other observes the in-flight dedup guard.
        const outcomes = [first, second]
        expect(outcomes.some(o => "added" in o && o.added === true)).toBe(true)
        expect(outcomes.some(o => "added" in o && o.added === false)).toBe(true)
    })
})

describe("doCaptureChapter scrape-failure fallback", () => {
    it("still tracks the chapter externally and reports supported/added/external", async () => {
        const source = {
            manifest: { id: "mangadex" },
            match: vi.fn().mockReturnValue("chapter"),
            parseMangaUrl: vi.fn().mockReturnValue(null)
        }
        findSourceMock.mockReturnValue(source)
        getSettingsMock.mockResolvedValue({ autoAdd: true })
        resolveChapterUrlMock.mockRejectedValue(new Error("scrape failed"))

        const url = "https://mangadex.org/chapter/fallback-1"
        const result = (await captureChapter(url)) as {
            supported: boolean
            added: boolean
            external?: boolean
            title?: string
        }

        expect(result.supported).toBe(true)
        expect(result.added).toBe(true)
        expect(result.external).toBe(true)

        const tracked = await db.progress.toArray()
        expect(tracked.length).toBeGreaterThan(0)

        // The external-tracking success branch must publish to the live bus too,
        // not just the scraped-success branch a few lines below it in capture.ts.
        const [trackedManga] = await db.manga.toArray()
        expect(trackedManga).toBeDefined()
        expect(publishLiveMock).toHaveBeenCalledWith(["library", "chapters"], [trackedManga!.id])
    })
})

describe("chapter:siblings URL fallback", () => {
    it("finds the current chapter by number when the cached URL differs from the page URL", async () => {
        // Comix addresses chapters by an opaque id only its encrypted API knows, so the
        // cached list uses a placeholder-id URL the site redirects to the canonical one.
        // The user is on the canonical URL, so an exact-URL match misses and the on-page
        // panel's Next used to stay dead despite a fully cached list.
        const source = {
            manifest: { id: "comix" },
            match: vi.fn().mockReturnValue("chapter"),
            parseMangaUrl: vi
                .fn()
                .mockReturnValue({ sourceMangaId: "nk830-lord", mangaUrl: "https://comix.to/title/nk830-lord" })
        }
        findSourceMock.mockReturnValue(source)

        const mangaId = "comix:manga:nk830-lord"
        await db.manga.put({
            id: mangaId,
            title: "Lord of Goblins",
            normalizedTitle: "lord of goblins",
            authors: [],
            status: "ongoing",
            addedAt: 1,
            updatedAt: 1,
            sourceId: "comix",
            sourceUrl: "https://comix.to/title/nk830-lord/0-chapter-1"
        } satisfies LibraryManga)
        await db.chapters.bulkPut(
            [1, 2, 3].map(
                n =>
                    ({
                        id: `comix:chapter:nk830-lord:${n}`,
                        mangaId,
                        sourceId: "comix",
                        title: `Ch.${n}`,
                        // placeholder-id URLs, deliberately NOT the canonical ones
                        url: `https://comix.to/title/nk830-lord/0-chapter-${n}`,
                        sortKey: n
                    }) as ChapterRecord
            )
        )

        const handler = readerHandlers["chapter:siblings"]!
        const res = (await handler(
            // the canonical URL the user is actually on - no cached row has this exact URL
            { type: "chapter:siblings", url: "https://comix.to/title/nk830-lord/6219279-chapter-2" },
            { sender: {} } as never
        )) as { prevUrl: string | null; nextUrl: string | null; chapterTitle: string | null }

        expect(res.chapterTitle).toBe("Ch.2")
        expect(res.prevUrl).toBe("https://comix.to/title/nk830-lord/0-chapter-1")
        expect(res.nextUrl).toBe("https://comix.to/title/nk830-lord/0-chapter-3")
    })
})

describe("chapter:track (mark-read) chapter-list population", () => {
    function trackSource() {
        const source = {
            manifest: { id: "mangadex" },
            match: vi.fn().mockReturnValue("chapter"),
            parseMangaUrl: vi.fn().mockReturnValue({ sourceMangaId: "abc", mangaUrl: "https://mangadex.org/title/abc" })
        }
        findSourceMock.mockReturnValue(source)
        return source
    }

    it("does not spawn a crawl when the title already has a cached chapter list", async () => {
        const { scheduleChapterListRefresh } = await import("../background/chapter-cache")
        trackSource()
        const handler = readerHandlers["chapter:track"]!

        // First track creates the manga and its single chapter row.
        const first = (await handler({ type: "chapter:track", url: "https://mangadex.org/chapter/track-1" }, {
            sender: {}
        } as never)) as { supported: boolean; mangaId: string }
        expect(first.supported).toBe(true)

        // Give it a real cached list, as auto-capture or the reader would.
        await db.chapters.bulkPut(
            [2, 3, 4].map(
                n =>
                    ({
                        id: `mangadex:chapter:abc:${n}`,
                        mangaId: first.mangaId,
                        sourceId: "mangadex",
                        title: `Chapter ${n}`,
                        url: `https://mangadex.org/chapter/track-${n}`,
                        sortKey: n
                    }) as ChapterRecord
            )
        )
        vi.mocked(scheduleChapterListRefresh).mockClear()

        await handler({ type: "chapter:track", url: "https://mangadex.org/chapter/track-1" }, { sender: {} } as never)

        // Marking read on a populated title must not open a tab crawl - the Webtoons
        // "many quickly closing tabs" report.
        expect(scheduleChapterListRefresh).not.toHaveBeenCalled()
    })

    it("does not re-crawl a genuine oneshot (one chapter) on a later re-track", async () => {
        const { scheduleChapterListRefresh } = await import("../background/chapter-cache")
        trackSource()
        const handler = readerHandlers["chapter:track"]!

        // First track creates the manga and schedules the one populate.
        await handler({ type: "chapter:track", url: "https://mangadex.org/chapter/oneshot-1" }, { sender: {} } as never)
        vi.mocked(scheduleChapterListRefresh).mockClear()

        // Re-tracking the same single-chapter title (a real oneshot stays at one row) must
        // never reschedule the crawl - a count<=1 heuristic used to, on every revisit.
        await handler({ type: "chapter:track", url: "https://mangadex.org/chapter/oneshot-1" }, { sender: {} } as never)
        expect(scheduleChapterListRefresh).not.toHaveBeenCalled()
    })

    it("populates the list on a first track, the only path left when auto-add is off", async () => {
        const { scheduleChapterListRefresh } = await import("../background/chapter-cache")
        trackSource()
        vi.mocked(scheduleChapterListRefresh).mockClear()

        const handler = readerHandlers["chapter:track"]!
        const res = (await handler({ type: "chapter:track", url: "https://mangadex.org/chapter/track-1" }, {
            sender: {}
        } as never)) as { supported: boolean }

        expect(res.supported).toBe(true)
        // With auto-add off, auto-capture bails before scheduling anything and the on-page
        // panel's prev/next is a plain DB read - without this the title would keep exactly
        // one chapter row forever and never show navigation.
        expect(scheduleChapterListRefresh).toHaveBeenCalled()
    })

    it("adds a distinct, resolved entry per title on a source with no URL-level series id", async () => {
        // MangaDex-style source: chapter URLs are /chapter/<uuid> with no series slug, and
        // the adapter has no parseMangaUrl. A plain URL track derives the generic "chapter"
        // slug for EVERY title, so distinct titles used to collapse onto one shared
        // "mangadex:manga:chapter" record - the second mark silently merged into the first
        // and never appeared. Resolving the chapter recovers the real per-title series id.
        const source = { manifest: { id: "mangadex" }, match: vi.fn().mockReturnValue("chapter") }
        findSourceMock.mockReturnValue(source)
        getSettingsMock.mockResolvedValue({ autoAdd: false })

        const resolvedFor = (sourceMangaId: string, title: string, chUrl: string) => ({
            manga: {
                manga: {
                    ...manga,
                    id: `mangadex:manga:${sourceMangaId}`,
                    title,
                    normalizedTitle: title.toLowerCase(),
                    coverUrl: `https://cdn.example/${sourceMangaId}.jpg`
                },
                sourceId: "mangadex",
                sourceMangaId,
                url: `https://mangadex.org/title/${sourceMangaId}`
            },
            chapter: chapter(`mangadex:chapter:${sourceMangaId}:1`, 1, chUrl)
        })

        const handler = readerHandlers["chapter:track"]!

        resolveChapterUrlMock.mockResolvedValueOnce(
            resolvedFor("aaa", "Solo Leveling", "https://mangadex.org/chapter/aaa-uuid")
        )
        await handler({ type: "chapter:track", url: "https://mangadex.org/chapter/aaa-uuid" }, { sender: {} } as never)

        resolveChapterUrlMock.mockResolvedValueOnce(
            resolvedFor("bbb", "One Piece", "https://mangadex.org/chapter/bbb-uuid")
        )
        await handler({ type: "chapter:track", url: "https://mangadex.org/chapter/bbb-uuid" }, { sender: {} } as never)

        const all = await db.manga.toArray()
        // Pre-fix both marks collapse onto a single stub -> length 1.
        expect(all.length).toBe(2)
        expect(all.map(m => m.title).sort()).toEqual(["One Piece", "Solo Leveling"])
        // Every entry is a proper, non-stub record: real series id and resolved title/cover,
        // not a slug placeholder like "Chapter".
        for (const m of all) {
            expect(m.sourceMangaId).toBeTruthy()
            expect(m.coverUrl).toBeTruthy()
            expect(m.title).not.toBe("Chapter")
        }
        // The marked chapter is recorded as read and resumable.
        const solo = all.find(m => m.title === "Solo Leveling")!
        expect(solo.lastReadChapterId).toBeTruthy()
        const progress = await db.progress.get(solo.lastReadChapterId!)
        expect(progress?.completed).toBe(true)
    })

    it("still records the read as a URL-keyed entry when resolution fails (offline / bot-blocked)", async () => {
        const source = { manifest: { id: "mangadex" }, match: vi.fn().mockReturnValue("chapter") }
        findSourceMock.mockReturnValue(source)
        getSettingsMock.mockResolvedValue({ autoAdd: false })
        resolveChapterUrlMock.mockRejectedValue(new SourceRequestError("blocked", 403))

        const handler = readerHandlers["chapter:track"]!
        const res = (await handler({ type: "chapter:track", url: "https://mangadex.org/chapter/offline-uuid" }, {
            sender: {}
        } as never)) as { supported: boolean; mangaId: string; tracked: boolean }

        expect(res.supported).toBe(true)
        expect(res.tracked).toBe(true)
        const stored = await db.manga.get(res.mangaId)
        expect(stored).toBeDefined()
    })
})

describe("reader:resolve bot-block path", () => {
    it("falls back to fetchChapterHtmlViaTab when resolveChapterUrl throws a bot-block SourceRequestError", async () => {
        const source = { manifest: { id: "mangadex" }, match: vi.fn().mockReturnValue("chapter") }
        findSourceMock.mockReturnValue(source)
        resolveChapterUrlMock.mockRejectedValue(new SourceRequestError("blocked", 403))
        fetchChapterHtmlViaTabMock.mockResolvedValue("<html>fallback</html>")
        resolveChapterFromHtmlMock.mockResolvedValue({
            manga: {
                manga: { ...manga, id: "mangadex:manga:botblock" },
                sourceId: "mangadex",
                sourceMangaId: "botblock",
                url: "https://mangadex.org/title/botblock"
            },
            chapter: chapter("mangadex:chapter:botblock:1", 1, "https://mangadex.org/chapter/botblock-1")
        })

        const result = await readerHandlers["reader:resolve"]!(
            { type: "reader:resolve", url: "https://mangadex.org/chapter/botblock-1" },
            mkCtx()
        )

        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledWith("https://mangadex.org/chapter/botblock-1", undefined)
        expect(resolveChapterFromHtmlMock).toHaveBeenCalled()
        expect(result).toBeDefined()
    })

    it("rethrows a plain non-bot-block error without calling the tab fallback", async () => {
        const source = { manifest: { id: "mangadex" }, match: vi.fn().mockReturnValue("chapter") }
        findSourceMock.mockReturnValue(source)
        resolveChapterUrlMock.mockRejectedValue(new Error("totally unrelated failure"))

        await expect(
            readerHandlers["reader:resolve"]!(
                { type: "reader:resolve", url: "https://mangadex.org/chapter/plain-error-1" },
                mkCtx()
            )
        ).rejects.toThrow("totally unrelated failure")

        expect(fetchChapterHtmlViaTabMock).not.toHaveBeenCalled()
    })
})

describe("reader:resolve persists the chapter", () => {
    it("writes the resolved chapter and backfills a missing coverUrl in one call, without publishing inline", async () => {
        // The live publish now comes from the dispatcher via MUTATION_SCOPES
        // (["chapters", "library"]) - the handler itself no longer publishes, so a
        // direct handler call must NOT touch the live bus. See mutation-scopes.test.ts
        // for the classification invariant that drives the dispatcher's publish.
        const source = { manifest: { id: "mangadex" }, match: vi.fn().mockReturnValue("chapter") }
        findSourceMock.mockReturnValue(source)
        // Library entry exists but has no cover yet - the backfill should fill it.
        await db.manga.put({ ...manga, id: "mangadex:manga:resolve-publish", coverUrl: undefined } as never)
        resolveChapterUrlMock.mockResolvedValue({
            manga: {
                manga: { ...manga, id: "mangadex:manga:resolve-publish", coverUrl: "https://cdn.example/c.jpg" },
                sourceId: "mangadex",
                sourceMangaId: "resolve-publish",
                url: "https://mangadex.org/title/resolve-publish"
            },
            chapter: chapter("mangadex:chapter:resolve-publish:1", 1, "https://mangadex.org/chapter/resolve-publish-1")
        })

        await readerHandlers["reader:resolve"]!(
            { type: "reader:resolve", url: "https://mangadex.org/chapter/resolve-publish-1" },
            mkCtx()
        )

        const storedChapter = await db.chapters.get("mangadex:chapter:resolve-publish:1")
        expect(storedChapter).toBeDefined()
        const storedManga = await db.manga.get("mangadex:manga:resolve-publish")
        expect(storedManga?.coverUrl).toBe("https://cdn.example/c.jpg")
        expect(publishLiveMock).not.toHaveBeenCalled()
    })
})

describe("reader:chapters (Webtoons-style getChapterListUrl sources)", () => {
    const SOURCE_ID = "webtoons"
    const SOURCE_MANGA_ID = "42"
    const WT_MANGA_ID = `${SOURCE_ID}:manga:${SOURCE_MANGA_ID}`
    const MANGA_URL = "https://www.webtoons.com/en/fantasy/slug/"
    const LIST_URL = `https://www.webtoons.com/en/fantasy/slug/list?title_no=${SOURCE_MANGA_ID}`

    function episodeLink(epNo: number): string {
        return `href="/en/fantasy/slug/ep-${epNo}/viewer?title_no=${SOURCE_MANGA_ID}&episode_no=${epNo}"`
    }

    beforeEach(() => {
        getSourceByIdMock.mockReturnValue({
            manifest: { id: SOURCE_ID },
            getChapterListUrl: () => LIST_URL
        })
    })

    it("on a cache-miss (title's first-ever open), awaits the tab-rendered list refresh instead of racing it", async () => {
        // Nothing cached yet - this is the race from the live-tested bug: the earlier
        // fire-and-forget scheduleChapterListRefresh() call would return an empty list
        // here, before the background tab-fetch had a chance to populate the cache.
        fetchChapterHtmlViaTabMock.mockResolvedValue(`<div>${episodeLink(3)}${episodeLink(2)}${episodeLink(1)}</div>`)

        const result = (await readerHandlers["reader:chapters"]!(
            {
                type: "reader:chapters",
                sourceId: SOURCE_ID,
                sourceMangaId: SOURCE_MANGA_ID,
                mangaUrl: MANGA_URL,
                mangaId: WT_MANGA_ID
            },
            mkCtx()
        )) as Array<{ url: string; sortKey: number; title: string }>

        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalled()
        expect(result.length).toBe(3)
        expect(result.map(c => c.sortKey).sort((a, b) => a - b)).toEqual([1, 2, 3])
    })

    it("returns already-cached chapters immediately without waiting on a refresh", async () => {
        await db.manga.put({ ...manga, id: WT_MANGA_ID, sourceId: SOURCE_ID })
        await db.chapters.bulkPut([
            {
                id: `${SOURCE_ID}:chapter:${SOURCE_MANGA_ID}:1`,
                mangaId: WT_MANGA_ID,
                sourceId: SOURCE_ID,
                title: "Episode 1",
                url: "https://www.webtoons.com/ep-1",
                sortKey: 1
            },
            {
                id: `${SOURCE_ID}:chapter:${SOURCE_MANGA_ID}:2`,
                mangaId: WT_MANGA_ID,
                sourceId: SOURCE_ID,
                title: "Episode 2",
                url: "https://www.webtoons.com/ep-2",
                sortKey: 2
            }
        ])
        // If the handler awaited a refresh here instead of returning cached data
        // immediately, this never-resolving mock would hang the test.
        fetchChapterHtmlViaTabMock.mockImplementation(() => new Promise(() => {}))

        const result = (await readerHandlers["reader:chapters"]!(
            {
                type: "reader:chapters",
                sourceId: SOURCE_ID,
                sourceMangaId: SOURCE_MANGA_ID,
                mangaUrl: MANGA_URL,
                mangaId: WT_MANGA_ID
            },
            mkCtx()
        )) as Array<{ url: string; sortKey: number; title: string }>

        expect(result.map(c => c.sortKey).sort((a, b) => a - b)).toEqual([1, 2])
    })
})

describe("reader:chapters (standard sources without getChapterListUrl)", () => {
    const SOURCE_ID = "mangadex"
    const SOURCE_MANGA_ID = "abc"
    const MANGA_URL = "https://mangadex.org/title/abc"

    beforeEach(() => {
        getSourceByIdMock.mockReturnValue({ manifest: { id: SOURCE_ID } })
    })

    it("caches a freshly-fetched chapter list and publishes to the live bus", async () => {
        // putChapters now only writes for a manga that exists (anti-orphan guard).
        await db.manga.put(manga)
        listChaptersBySourceMock.mockResolvedValue([
            chapter("c1", 1, "https://mangadex.org/chapter/1"),
            chapter("c2", 2, "https://mangadex.org/chapter/2"),
            chapter("c3", 3, "https://mangadex.org/chapter/3")
        ])

        const result = (await readerHandlers["reader:chapters"]!(
            {
                type: "reader:chapters",
                sourceId: SOURCE_ID,
                sourceMangaId: SOURCE_MANGA_ID,
                mangaUrl: MANGA_URL,
                mangaId: manga.id
            },
            mkCtx()
        )) as Array<{ url: string; sortKey: number; title: string }>

        expect(result.map(c => c.sortKey).sort((a, b) => a - b)).toEqual([1, 2, 3])
        expect(await db.chapters.where("mangaId").equals(manga.id).count()).toBe(3)
        expect(publishLiveMock).toHaveBeenCalledWith(["chapters"], [manga.id])
    })

    it("does not publish when falling back to the (possibly empty) cache", async () => {
        listChaptersBySourceMock.mockRejectedValue(new Error("network down"))

        await readerHandlers["reader:chapters"]!(
            {
                type: "reader:chapters",
                sourceId: SOURCE_ID,
                sourceMangaId: SOURCE_MANGA_ID,
                mangaUrl: MANGA_URL,
                mangaId: manga.id
            },
            mkCtx()
        )

        expect(publishLiveMock).not.toHaveBeenCalled()
    })
})

describe("reader:resolve offline fallback", () => {
    it("serves a downloaded copy when the network resolve fails and a download exists", async () => {
        await db.downloads.clear()
        await db.manga.put(manga)
        const url = "https://mangadex.org/chapter/ch1"
        await db.chapters.put(chapter("mangadex:chapter:1", 1, url))
        await db.downloads.put({
            chapterId: "mangadex:chapter:1",
            mangaId: manga.id,
            pageBlobs: [new Blob(["a"]), new Blob(["b"])],
            pageCount: 2,
            downloadedAt: 1
        })
        resolveChapterUrlMock.mockRejectedValue(new Error("network down"))

        const result = (await readerHandlers["reader:resolve"]!({ type: "reader:resolve", url } as never, mkCtx())) as {
            pages: unknown[]
            chapter: { id: string }
            manga: { manga: { id: string } }
        }
        expect(result.pages).toHaveLength(2)
        expect(result.chapter.id).toBe("mangadex:chapter:1")
        expect(result.manga.manga.id).toBe(manga.id)
    })

    it("rethrows the network error when no download exists", async () => {
        await db.downloads.clear()
        resolveChapterUrlMock.mockRejectedValue(new Error("network down"))
        await expect(
            readerHandlers["reader:resolve"]!(
                { type: "reader:resolve", url: "https://mangadex.org/chapter/none" } as never,
                mkCtx()
            )
        ).rejects.toThrow("network down")
    })
})
