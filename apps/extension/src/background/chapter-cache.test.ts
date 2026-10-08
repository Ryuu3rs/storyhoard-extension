import "fake-indexeddb/auto"
import type { ChapterRecord } from "@amr/contracts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { db, type LibraryManga } from "../database"

const fetchChapterHtmlViaTabMock = vi.fn()
vi.mock("./tab-fetch", () => ({
    fetchChapterHtmlViaTab: (...args: unknown[]) => fetchChapterHtmlViaTabMock(...args)
}))

const publishLiveMock = vi.fn()
vi.mock("../live", () => ({
    publishLive: (...args: unknown[]) => publishLiveMock(...args)
}))

const tabOriginsMock = vi.fn<(sourceId: string) => string[] | undefined>(() => undefined)
const listChaptersBySourceMock = vi.fn()
const listChaptersFromSourceHtmlMock = vi.fn()
vi.mock("../sources", () => ({
    // findSource is only referenced in chapter-cache.ts's type positions
    // (ReturnType<typeof findSource>), never called - fakeSource() below builds
    // the values these tests pass in directly.
    findSource: vi.fn(),
    listChaptersBySource: (...args: unknown[]) => listChaptersBySourceMock(...args),
    listChaptersFromSourceHtml: (...args: unknown[]) => listChaptersFromSourceHtmlMock(...args),
    tabOriginsForSource: (sourceId: string) => tabOriginsMock(sourceId)
}))

const {
    mineAndCacheEpisodesFromHtml,
    listChaptersWithTabFallback,
    ensureChapterListRefreshed,
    scheduleChapterListRefresh,
    purgeStaleMangahubChapterRows,
    MANGAHUB_INTERNAL_ID_MIN,
    _resetRefreshCooldownForTests,
    _awaitRefreshesForTests
} = await import("./chapter-cache")

const SOURCE_ID = "webtoons"
const SOURCE_MANGA_ID = "99"
const MANGA_ID = `${SOURCE_ID}:manga:${SOURCE_MANGA_ID}`
const HOSTNAME = "www.webtoons.com"
const MANGA_URL = `https://${HOSTNAME}/en/fantasy/slug/`
const LIST_URL = `https://${HOSTNAME}/en/fantasy/slug/list?title_no=${SOURCE_MANGA_ID}`

const manga: LibraryManga = {
    id: MANGA_ID,
    title: "Test Series",
    normalizedTitle: "test series",
    authors: [],
    status: "ongoing",
    addedAt: 1,
    updatedAt: 1,
    sourceId: SOURCE_ID,
    sourceUrl: `https://${HOSTNAME}/en/fantasy/slug/`,
    sourceMangaId: SOURCE_MANGA_ID,
    mangaUrl: `https://${HOSTNAME}/en/fantasy/slug/`
}

function link(titleNo: string, epNo: number): string {
    return `href="/en/fantasy/slug/ep-${epNo}/viewer?title_no=${titleNo}&episode_no=${epNo}"`
}

beforeEach(async () => {
    await Promise.all([db.manga.clear(), db.chapters.clear()])
    publishLiveMock.mockReset()
    listChaptersBySourceMock.mockReset()
    listChaptersFromSourceHtmlMock.mockReset()
    fetchChapterHtmlViaTabMock.mockReset()
})

describe("mineAndCacheEpisodesFromHtml", () => {
    it("rejects episode links whose title_no does not match the mined manga (Recommended for you pollution guard)", async () => {
        await db.manga.put(manga)
        const html = `
            <div>
                ${link(SOURCE_MANGA_ID, 1)}
                ${link(SOURCE_MANGA_ID, 2)}
                ${link(SOURCE_MANGA_ID, 3)}
                <div class="recommend">
                    ${link("777", 5)}
                    ${link("888", 12)}
                </div>
            </div>
        `

        const stored = await mineAndCacheEpisodesFromHtml(MANGA_ID, SOURCE_ID, SOURCE_MANGA_ID, HOSTNAME, html)

        expect(stored.sort((a, b) => a - b)).toEqual([1, 2, 3])
        const chapters = await db.chapters.where("mangaId").equals(MANGA_ID).toArray()
        expect(chapters).toHaveLength(3)
        expect(chapters.every(c => c.id.startsWith(`${SOURCE_ID}:chapter:${SOURCE_MANGA_ID}:`))).toBe(true)
        expect(chapters.map(c => c.sortKey).sort((a, b) => a - b)).toEqual([1, 2, 3])
        expect(publishLiveMock).toHaveBeenCalledWith(["chapters"], [MANGA_ID])
    })

    it("does not publish a live event when a re-mine changes nothing (reader loop guard)", async () => {
        await db.manga.put(manga)
        const html = `
            <div>
                ${link(SOURCE_MANGA_ID, 1)}
                ${link(SOURCE_MANGA_ID, 2)}
                ${link(SOURCE_MANGA_ID, 3)}
            </div>
        `

        await mineAndCacheEpisodesFromHtml(MANGA_ID, SOURCE_ID, SOURCE_MANGA_ID, HOSTNAME, html)
        expect(publishLiveMock).toHaveBeenCalledTimes(1)

        // Second identical mine is a pure no-op upsert. A live event here would make the
        // reader's loadSiblings subscriber re-crawl and re-publish forever - the endless
        // background-tab reopen the Webtoons reader hit on Next.
        publishLiveMock.mockClear()
        const storedAgain = await mineAndCacheEpisodesFromHtml(MANGA_ID, SOURCE_ID, SOURCE_MANGA_ID, HOSTNAME, html)
        expect(storedAgain).toHaveLength(3)
        expect(publishLiveMock).not.toHaveBeenCalled()
    })

    it("self-heals by deleting stale chapter rows embedding a different sourceMangaId", async () => {
        await db.manga.put(manga)
        // Pre-seed a stale row simulating pre-fix pollution: stored under MANGA_ID but
        // whose id embeds a different sourceMangaId ("777").
        const staleChapter: ChapterRecord = {
            id: `${SOURCE_ID}:chapter:777:5`,
            mangaId: MANGA_ID,
            sourceId: SOURCE_ID,
            title: "Episode 5",
            url: `https://${HOSTNAME}/en/fantasy/slug/ep-5/viewer?title_no=777&episode_no=5`,
            sortKey: 5
        }
        await db.chapters.put(staleChapter)

        const cleanHtml = `
            <div>
                ${link(SOURCE_MANGA_ID, 1)}
                ${link(SOURCE_MANGA_ID, 2)}
                ${link(SOURCE_MANGA_ID, 3)}
            </div>
        `

        await mineAndCacheEpisodesFromHtml(MANGA_ID, SOURCE_ID, SOURCE_MANGA_ID, HOSTNAME, cleanHtml)

        expect(await db.chapters.get(staleChapter.id)).toBeUndefined()
        const chapters = await db.chapters.where("mangaId").equals(MANGA_ID).toArray()
        expect(chapters.every(c => c.id.startsWith(`${SOURCE_ID}:chapter:${SOURCE_MANGA_ID}:`))).toBe(true)
    })

    it("returns 0 and stores nothing when the HTML has 2 or fewer matching links (pagination-only guard)", async () => {
        await db.manga.put(manga)
        const html = `
            <div>
                ${link(SOURCE_MANGA_ID, 1)}
                ${link(SOURCE_MANGA_ID, 2)}
            </div>
        `

        const stored = await mineAndCacheEpisodesFromHtml(MANGA_ID, SOURCE_ID, SOURCE_MANGA_ID, HOSTNAME, html)

        expect(stored).toEqual([])
        const chapters = await db.chapters.where("mangaId").equals(MANGA_ID).toArray()
        expect(chapters).toHaveLength(0)
        expect(publishLiveMock).not.toHaveBeenCalled()
    })

    it("advances manga.latestChapterNumber/latestChapterId when a mined episode outranks the stored one", async () => {
        await db.manga.put({
            ...manga,
            latestChapterNumber: 1,
            latestChapterId: `${SOURCE_ID}:chapter:${SOURCE_MANGA_ID}:1`
        })
        const html = `
            <div>
                ${link(SOURCE_MANGA_ID, 1)}
                ${link(SOURCE_MANGA_ID, 2)}
                ${link(SOURCE_MANGA_ID, 3)}
            </div>
        `

        await mineAndCacheEpisodesFromHtml(MANGA_ID, SOURCE_ID, SOURCE_MANGA_ID, HOSTNAME, html)

        const updated = await db.manga.get(MANGA_ID)
        expect(updated?.latestChapterNumber).toBe(3)
        expect(updated?.latestChapterId).toBe(`${SOURCE_ID}:chapter:${SOURCE_MANGA_ID}:3`)
    })
})

// A fake source matching the subset of findSource()'s return value that
// listChaptersWithTabFallback/ensureChapterListRefreshed actually touch.
function fakeSource(getChapterListUrl: (sourceMangaId: string, mangaUrl: string) => string | null) {
    return { manifest: { id: SOURCE_ID }, getChapterListUrl } as unknown as Parameters<
        typeof ensureChapterListRefreshed
    >[0]
}

function pageHtml(epNos: number[], nextPage: number | null): string {
    const links = epNos.map(n => link(SOURCE_MANGA_ID, n)).join("\n")
    const nextLink = nextPage !== null ? `<a href="?title_no=${SOURCE_MANGA_ID}&page=${nextPage}">Next</a>` : ""
    return `<div>${links}${nextLink}</div>`
}

describe("listChaptersWithTabFallback pagination (Webtoons-style JS-rendered list pages)", () => {
    beforeEach(() => {
        fetchChapterHtmlViaTabMock.mockReset()
    })

    it("follows pagination across multiple pages and merges the full episode range", async () => {
        await db.manga.put(manga)
        fetchChapterHtmlViaTabMock
            .mockResolvedValueOnce(pageHtml([15, 14, 13, 12, 11], 2))
            .mockResolvedValueOnce(pageHtml([10, 9, 8, 7, 6], 3))
            .mockResolvedValueOnce(pageHtml([5, 4, 3, 2, 1], null))

        const source = fakeSource(() => LIST_URL)
        await listChaptersWithTabFallback(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)

        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledTimes(3)
        const chapters = await db.chapters.where("mangaId").equals(MANGA_ID).toArray()
        expect(chapters.map(c => c.sortKey).sort((a, b) => a - b)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1))
    })

    it("stops as soon as a page adds nothing new, without fetching further pages", async () => {
        await db.manga.put(manga)
        fetchChapterHtmlViaTabMock
            .mockResolvedValueOnce(pageHtml([5, 4, 3, 2, 1], 2))
            // Page 2 only has the 2-link pagination noise mineAndCacheEpisodesFromHtml
            // ignores - simulates running past the last real page.
            .mockResolvedValueOnce(pageHtml([1, 2], null))

        const source = fakeSource(() => LIST_URL)
        await listChaptersWithTabFallback(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)

        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledTimes(2)
        const chapters = await db.chapters.where("mangaId").equals(MANGA_ID).toArray()
        expect(chapters).toHaveLength(5)
    })

    it("stops after two pages when the site re-serves the same episodes while still advertising a next page (Webtoons &page clamp guard)", async () => {
        await db.manga.put(manga)
        // Every page echoes the identical newest episodes AND keeps advertising a next
        // page - Webtoons clamps &page=N past the last real page. Tracking per-page link
        // counts drove this to MAX_PAGES (~20 tab loads, ~8 min). Tracking episode
        // identity across the crawl stops it the moment a page adds nothing new.
        fetchChapterHtmlViaTabMock.mockImplementation((pageUrlStr: string) => {
            const requestedPage = Number(new URL(pageUrlStr).searchParams.get("page") ?? "1")
            return Promise.resolve(pageHtml([5, 4, 3, 2, 1], requestedPage + 1))
        })

        const source = fakeSource(() => LIST_URL)
        await listChaptersWithTabFallback(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)

        expect(fetchChapterHtmlViaTabMock.mock.calls.length).toBeLessThanOrEqual(2)
        const chapters = await db.chapters.where("mangaId").equals(MANGA_ID).toArray()
        expect(chapters.map(c => c.sortKey).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
    })

    it("stops once a page's own pagination control stops advertising a next page", async () => {
        await db.manga.put(manga)
        fetchChapterHtmlViaTabMock.mockResolvedValueOnce(pageHtml([3, 2, 1], null))

        const source = fakeSource(() => LIST_URL)
        await listChaptersWithTabFallback(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)

        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledTimes(1)
        const chapters = await db.chapters.where("mangaId").equals(MANGA_ID).toArray()
        expect(chapters).toHaveLength(3)
    })

    it("requests page N via a &page=N query param on every page after the first", async () => {
        await db.manga.put(manga)
        fetchChapterHtmlViaTabMock
            .mockResolvedValueOnce(pageHtml([10, 9, 8, 7, 6], 2))
            .mockResolvedValueOnce(pageHtml([5, 4, 3, 2, 1], null))

        const source = fakeSource(() => LIST_URL)
        await listChaptersWithTabFallback(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)

        expect(fetchChapterHtmlViaTabMock).toHaveBeenNthCalledWith(1, LIST_URL)
        expect(fetchChapterHtmlViaTabMock).toHaveBeenNthCalledWith(2, `${LIST_URL}&page=2`)
    })
})

describe("listChaptersWithTabFallback standard (SW-fetch) path", () => {
    it("publishes chapters for the manga after a successful bulkPut", async () => {
        await db.manga.put(manga)
        const chapters: ChapterRecord[] = [1, 2, 3].map(n => ({
            id: `${SOURCE_ID}:chapter:${SOURCE_MANGA_ID}:${n}`,
            mangaId: MANGA_ID,
            sourceId: SOURCE_ID,
            title: `Episode ${n}`,
            url: `https://${HOSTNAME}/ep-${n}`,
            sortKey: n
        }))
        listChaptersBySourceMock.mockResolvedValue(chapters)

        const source = fakeSource(() => null)
        await listChaptersWithTabFallback(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)

        expect(publishLiveMock).toHaveBeenCalledWith(["chapters"], [MANGA_ID])
    })

    it("does not publish when the source returns no chapters", async () => {
        await db.manga.put(manga)
        listChaptersBySourceMock.mockResolvedValue([])

        const source = fakeSource(() => null)
        await listChaptersWithTabFallback(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)

        expect(publishLiveMock).not.toHaveBeenCalled()
    })

    it("tab-renders the manga page and re-parses when the SW list is empty and chapterListViaMangaPageTab is set (Comix)", async () => {
        // Comix behind Cloudflare: the SW-fetch list 403s -> []. With the flag set the
        // fallback tab-renders the manga page and re-runs listChapters against that HTML.
        await db.manga.put(manga)
        listChaptersBySourceMock.mockResolvedValue([])
        fetchChapterHtmlViaTabMock.mockResolvedValue("<html>rendered manga page</html>")
        const synthesised: ChapterRecord[] = [1, 2, 3].map(n => ({
            id: `${SOURCE_ID}:chapter:${SOURCE_MANGA_ID}:${n}`,
            mangaId: MANGA_ID,
            sourceId: SOURCE_ID,
            title: `Ch.${n}`,
            url: `https://${HOSTNAME}/title/slug/0-chapter-${n}`,
            sortKey: n
        }))
        listChaptersFromSourceHtmlMock.mockResolvedValue(synthesised)

        const source = {
            manifest: { id: SOURCE_ID },
            getChapterListUrl: () => null,
            chapterListViaMangaPageTab: true
        } as unknown as Parameters<typeof listChaptersWithTabFallback>[0]
        const cached = await listChaptersWithTabFallback(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)

        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledWith(MANGA_URL, undefined)
        expect(listChaptersFromSourceHtmlMock).toHaveBeenCalledOnce()
        expect(cached).toBe(3)
        const chapters = await db.chapters.where("mangaId").equals(MANGA_ID).toArray()
        expect(chapters.map(c => c.sortKey).sort((a, b) => a - b)).toEqual([1, 2, 3])
    })

    it("does not tab-render when chapterListViaMangaPageTab is unset (default sources)", async () => {
        await db.manga.put(manga)
        listChaptersBySourceMock.mockResolvedValue([])
        fetchChapterHtmlViaTabMock.mockResolvedValue("<html></html>")

        const source = fakeSource(() => null)
        await listChaptersWithTabFallback(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)

        expect(fetchChapterHtmlViaTabMock).not.toHaveBeenCalled()
        expect(listChaptersFromSourceHtmlMock).not.toHaveBeenCalled()
    })

    it("advances manga.latestChapterNumber/latestChapterId when a fetched chapter outranks the stored one", async () => {
        await db.manga.put({
            ...manga,
            latestChapterNumber: 1,
            latestChapterId: `${SOURCE_ID}:chapter:${SOURCE_MANGA_ID}:1`
        })
        const chapters: ChapterRecord[] = [1, 2, 3].map(n => ({
            id: `${SOURCE_ID}:chapter:${SOURCE_MANGA_ID}:${n}`,
            mangaId: MANGA_ID,
            sourceId: SOURCE_ID,
            title: `Episode ${n}`,
            url: `https://${HOSTNAME}/ep-${n}`,
            sortKey: n
        }))
        listChaptersBySourceMock.mockResolvedValue(chapters)

        const source = fakeSource(() => null)
        await listChaptersWithTabFallback(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)

        const updated = await db.manga.get(MANGA_ID)
        expect(updated?.latestChapterNumber).toBe(3)
        expect(updated?.latestChapterId).toBe(`${SOURCE_ID}:chapter:${SOURCE_MANGA_ID}:3`)
    })

    it("sets manga.latestChapterNumber to 0 for a fresh manga whose only fetched chapter is Chapter 0 (Prologue)", async () => {
        // No latestChapterNumber on the seeded manga - simulates a manga that has
        // never had its chapter list fetched before. A genuine sortKey-0 chapter
        // (e.g. "Chapter 0: Prologue") must still register as an advance over the
        // unset baseline, not get skipped because 0 > 0 is false.
        await db.manga.put(manga)
        const chapters: ChapterRecord[] = [
            {
                id: `${SOURCE_ID}:chapter:${SOURCE_MANGA_ID}:0`,
                mangaId: MANGA_ID,
                sourceId: SOURCE_ID,
                title: "Chapter 0: Prologue",
                url: `https://${HOSTNAME}/ep-0`,
                sortKey: 0
            }
        ]
        listChaptersBySourceMock.mockResolvedValue(chapters)

        const source = fakeSource(() => null)
        await listChaptersWithTabFallback(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)

        const updated = await db.manga.get(MANGA_ID)
        expect(updated?.latestChapterNumber).toBe(0)
        expect(updated?.latestChapterId).toBe(`${SOURCE_ID}:chapter:${SOURCE_MANGA_ID}:0`)
    })

    // Regression test for the UNNUMBERED_SORT_KEY (Infinity) leak class, site 1
    // (SEVERE, data loss): a plain `Math.max(...chapters.map(c => c.sortKey))` let a
    // single unnumbered chapter (sortKey: Infinity) beat every real chapter number and
    // get persisted as latestChapterNumber - which IndexedDB keeps, backup export
    // turns into null, and import validation then rejects outright, silently dropping
    // the title from a restored library.
    it("advances to the highest NUMBERED chapter, ignoring an unnumbered chapter that would win a plain Math.max", async () => {
        await db.manga.put({
            ...manga,
            latestChapterNumber: 1,
            latestChapterId: `${SOURCE_ID}:chapter:${SOURCE_MANGA_ID}:1`
        })
        const chapters: ChapterRecord[] = [
            {
                id: `${SOURCE_ID}:chapter:${SOURCE_MANGA_ID}:1`,
                mangaId: MANGA_ID,
                sourceId: SOURCE_ID,
                title: "Chapter 1",
                url: `https://${HOSTNAME}/ep-1`,
                sortKey: 1
            },
            {
                id: `${SOURCE_ID}:chapter:${SOURCE_MANGA_ID}:2`,
                mangaId: MANGA_ID,
                sourceId: SOURCE_ID,
                title: "Chapter 2",
                url: `https://${HOSTNAME}/ep-2`,
                sortKey: 2
            },
            {
                id: `${SOURCE_ID}:chapter:${SOURCE_MANGA_ID}:extra`,
                mangaId: MANGA_ID,
                sourceId: SOURCE_ID,
                title: "Extra",
                url: `https://${HOSTNAME}/ep-extra`,
                sortKey: Number.POSITIVE_INFINITY
            }
        ]
        listChaptersBySourceMock.mockResolvedValue(chapters)

        const source = fakeSource(() => null)
        await listChaptersWithTabFallback(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)

        const updated = await db.manga.get(MANGA_ID)
        expect(updated?.latestChapterNumber).toBe(2)
        expect(updated?.latestChapterId).toBe(`${SOURCE_ID}:chapter:${SOURCE_MANGA_ID}:2`)
    })

    it("skips the latest-chapter write entirely when every fetched chapter is unnumbered, rather than persisting Infinity or falling back to the first chapter", async () => {
        await db.manga.put({
            ...manga,
            latestChapterNumber: 5,
            latestChapterId: `${SOURCE_ID}:chapter:${SOURCE_MANGA_ID}:5`
        })
        const chapters: ChapterRecord[] = [
            {
                id: `${SOURCE_ID}:chapter:${SOURCE_MANGA_ID}:oneshot-a`,
                mangaId: MANGA_ID,
                sourceId: SOURCE_ID,
                title: "Extra A",
                url: `https://${HOSTNAME}/ep-a`,
                sortKey: Number.POSITIVE_INFINITY
            },
            {
                id: `${SOURCE_ID}:chapter:${SOURCE_MANGA_ID}:oneshot-b`,
                mangaId: MANGA_ID,
                sourceId: SOURCE_ID,
                title: "Extra B",
                url: `https://${HOSTNAME}/ep-b`,
                sortKey: Number.POSITIVE_INFINITY
            }
        ]
        listChaptersBySourceMock.mockResolvedValue(chapters)

        const source = fakeSource(() => null)
        await listChaptersWithTabFallback(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)

        const updated = await db.manga.get(MANGA_ID)
        expect(updated?.latestChapterNumber).toBe(5)
        expect(updated?.latestChapterId).toBe(`${SOURCE_ID}:chapter:${SOURCE_MANGA_ID}:5`)
    })

    it("purges stale MangaHub junk rows after a fresh bulkPut, but leaves other sources untouched", async () => {
        const MANGAHUB_MANGA_ID = "mangahub:manga:some-series"
        const mangahubManga: LibraryManga = {
            ...manga,
            id: MANGAHUB_MANGA_ID,
            sourceId: "mangahub",
            sourceMangaId: "some-series"
        }
        await db.manga.put(mangahubManga)
        // Pre-existing junk row from before the extractChapters fix - a poisoned
        // internal-id sortKey that the fresh fetch below no longer returns.
        await db.chapters.put({
            id: "mangahub:chapter:some-series:2650711",
            mangaId: MANGAHUB_MANGA_ID,
            sourceId: "mangahub",
            title: "Chapter 2650711",
            url: "https://mangahub.io/chapter/some-series/chapter-2650711",
            sortKey: 2650711
        })
        const freshChapters: ChapterRecord[] = [1, 2].map(n => ({
            id: `mangahub:chapter:some-series:${n}`,
            mangaId: MANGAHUB_MANGA_ID,
            sourceId: "mangahub",
            title: `Chapter ${n}`,
            url: `https://mangahub.io/chapter/some-series/chapter-${n}`,
            sortKey: n
        }))
        listChaptersBySourceMock.mockResolvedValue(freshChapters)

        const mangahubSource = { manifest: { id: "mangahub" }, getChapterListUrl: () => null } as unknown as Parameters<
            typeof ensureChapterListRefreshed
        >[0]
        await listChaptersWithTabFallback(
            mangahubSource,
            "some-series",
            "https://mangahub.io/manga/some-series",
            MANGAHUB_MANGA_ID
        )

        const remaining = await db.chapters.where("mangaId").equals(MANGAHUB_MANGA_ID).toArray()
        expect(remaining.map(c => c.sortKey).sort((a, b) => a - b)).toEqual([1, 2])
    })
})

describe("purgeStaleMangahubChapterRows", () => {
    it("deletes only junk (sortKey >= MANGAHUB_INTERNAL_ID_MIN) MangaHub rows absent from the fresh id set", async () => {
        const MANGAHUB_MANGA_ID = "mangahub:manga:some-series"
        await db.chapters.bulkPut([
            {
                id: "mangahub:chapter:some-series:1",
                mangaId: MANGAHUB_MANGA_ID,
                sourceId: "mangahub",
                title: "Chapter 1",
                url: "https://mangahub.io/chapter/some-series/chapter-1",
                sortKey: 1
            },
            {
                id: "mangahub:chapter:some-series:2",
                mangaId: MANGAHUB_MANGA_ID,
                sourceId: "mangahub",
                title: "Chapter 2",
                url: "https://mangahub.io/chapter/some-series/chapter-2",
                sortKey: 2
            },
            {
                id: "mangahub:chapter:some-series:2650003",
                mangaId: MANGAHUB_MANGA_ID,
                sourceId: "mangahub",
                title: "Chapter 2650003",
                url: "https://mangahub.io/chapter/some-series/chapter-2650003",
                sortKey: MANGAHUB_INTERNAL_ID_MIN + 3
            },
            {
                id: "mangahub:chapter:some-series:2650004",
                mangaId: MANGAHUB_MANGA_ID,
                sourceId: "mangahub",
                title: "Chapter 2650004",
                url: "https://mangahub.io/chapter/some-series/chapter-2650004",
                sortKey: MANGAHUB_INTERNAL_ID_MIN + 4
            },
            // A different source's row on the same manga id, with a similarly-large
            // sortKey - must never be touched by a MangaHub-scoped purge.
            {
                id: "webtoons:chapter:some-series:2650005",
                mangaId: MANGAHUB_MANGA_ID,
                sourceId: "webtoons",
                title: "Episode 2650005",
                url: "https://www.webtoons.com/ep-2650005",
                sortKey: MANGAHUB_INTERNAL_ID_MIN + 5
            }
        ])

        const freshIds = new Set(["mangahub:chapter:some-series:1", "mangahub:chapter:some-series:2"])
        await purgeStaleMangahubChapterRows(MANGAHUB_MANGA_ID, freshIds)

        const remaining = await db.chapters.where("mangaId").equals(MANGAHUB_MANGA_ID).toArray()
        expect(remaining.map(c => c.id).sort()).toEqual(
            [
                "mangahub:chapter:some-series:1",
                "mangahub:chapter:some-series:2",
                "webtoons:chapter:some-series:2650005"
            ].sort()
        )
    })

    it("does nothing when there are no stale rows", async () => {
        const MANGAHUB_MANGA_ID = "mangahub:manga:clean-series"
        await db.chapters.put({
            id: "mangahub:chapter:clean-series:1",
            mangaId: MANGAHUB_MANGA_ID,
            sourceId: "mangahub",
            title: "Chapter 1",
            url: "https://mangahub.io/chapter/clean-series/chapter-1",
            sortKey: 1
        })

        await purgeStaleMangahubChapterRows(MANGAHUB_MANGA_ID, new Set(["mangahub:chapter:clean-series:1"]))

        const remaining = await db.chapters.where("mangaId").equals(MANGAHUB_MANGA_ID).toArray()
        expect(remaining).toHaveLength(1)
    })
})

describe("ensureChapterListRefreshed", () => {
    beforeEach(() => {
        fetchChapterHtmlViaTabMock.mockReset()
        // Each test simulates a fresh first-open: ensureChapterListRefreshed now skips
        // a crawl when one ran within the cooldown, so a timestamp left by a prior test
        // would otherwise gate the crawl this test expects to run.
        _resetRefreshCooldownForTests()
    })

    it("joins an in-flight refresh instead of starting a second one for the same manga", async () => {
        await db.manga.put(manga)
        let resolveFirst!: (html: string) => void
        fetchChapterHtmlViaTabMock.mockImplementationOnce(
            () =>
                new Promise<string>(resolve => {
                    resolveFirst = resolve
                })
        )

        const source = fakeSource(() => LIST_URL)
        const first = ensureChapterListRefreshed(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)
        const second = ensureChapterListRefreshed(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)

        resolveFirst(pageHtml([3, 2, 1], null))
        await Promise.all([first, second])

        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledTimes(1)
        const chapters = await db.chapters.where("mangaId").equals(MANGA_ID).toArray()
        expect(chapters).toHaveLength(3)
    })

    it("resolves once the cache reflects the mined episodes (awaitable, unlike scheduleChapterListRefresh)", async () => {
        await db.manga.put(manga)
        fetchChapterHtmlViaTabMock.mockResolvedValueOnce(pageHtml([3, 2, 1], null))

        const source = fakeSource(() => LIST_URL)
        await ensureChapterListRefreshed(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)

        const chapters = await db.chapters.where("mangaId").equals(MANGA_ID).toArray()
        expect(chapters).toHaveLength(3)
    })

    it("skips a second crawl within the cooldown window (reader tab-storm guard)", async () => {
        await db.manga.put(manga)
        fetchChapterHtmlViaTabMock.mockResolvedValue(pageHtml([3, 2, 1], null))

        const source = fakeSource(() => LIST_URL)
        await ensureChapterListRefreshed(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)
        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledTimes(1)

        // A second call moments later - as the reader's ["chapters"] subscriber would
        // drive on every live event - must NOT reopen the tab crawl.
        await ensureChapterListRefreshed(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)
        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledTimes(1)

        // ...until the cooldown is cleared (a genuinely new opportunity to refresh).
        _resetRefreshCooldownForTests()
        await ensureChapterListRefreshed(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)
        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledTimes(2)
    })

    it("a successful crawl holds the full cooldown even if the cache is emptied afterwards", async () => {
        // Uses the crawl's returned count, not a post-hoc db.chapters count() that would
        // race a concurrent delete (library remove/merge/relink) and wrongly shorten the
        // cooldown - reopening the tab storm on the next trigger.
        let now = Date.now()
        const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
        _resetRefreshCooldownForTests()
        await db.manga.put(manga)
        fetchChapterHtmlViaTabMock.mockResolvedValue(pageHtml([3, 2, 1], null))
        const source = fakeSource(() => LIST_URL)

        await ensureChapterListRefreshed(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)
        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledTimes(1)

        // Something unrelated wipes the cache right after the successful crawl.
        await db.chapters.where("mangaId").equals(MANGA_ID).delete()

        // Past the 60s short-retry window but well inside the 10-minute full cooldown.
        now += 61_000
        await ensureChapterListRefreshed(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)
        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledTimes(1)
        nowSpy.mockRestore()
    })

    it("a crawl that caches nothing retries after the short window", async () => {
        let now = Date.now()
        const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
        _resetRefreshCooldownForTests()
        await db.manga.put(manga)
        fetchChapterHtmlViaTabMock.mockResolvedValue(pageHtml([], null)) // mines nothing
        const source = fakeSource(() => LIST_URL)

        await ensureChapterListRefreshed(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)
        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledTimes(1)

        now += 61_000
        await ensureChapterListRefreshed(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)
        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledTimes(2)
        nowSpy.mockRestore()
    })

    it("never rejects, even when the underlying fetch throws", async () => {
        fetchChapterHtmlViaTabMock.mockRejectedValueOnce(new Error("tab load timed out"))
        const source = fakeSource(() => LIST_URL)

        await expect(ensureChapterListRefreshed(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)).resolves.toBeUndefined()
    })
})

describe("scheduleChapterListRefresh cooldown", () => {
    // fake-indexeddb's internal scheduling relies on real timers, so the cooldown
    // clock is controlled by mocking Date.now directly instead of vi.useFakeTimers().
    let nowSpy: ReturnType<typeof vi.spyOn>
    let currentNow = 0

    // Lets the fire-and-forget refresh (including its async IndexedDB writes) fully
    // settle before the next assertion. Awaits the ACTUAL in-flight refresh promise
    // rather than guessing a macrotask-tick count - a fixed tick count flaked under
    // full-suite load when fake-indexeddb's transaction completion needed more ticks
    // than assumed, leaving the first refresh in-flight so the next schedule deduped.
    // A trailing tick lets any queued-then-started refresh register before re-awaiting.
    const flush = async () => {
        await _awaitRefreshesForTests()
        await new Promise(resolve => setTimeout(resolve, 0))
        await _awaitRefreshesForTests()
    }

    beforeEach(() => {
        fetchChapterHtmlViaTabMock.mockReset()
        fetchChapterHtmlViaTabMock.mockResolvedValue(pageHtml([3, 2, 1], null))
        _resetRefreshCooldownForTests()
        currentNow = Date.now()
        nowSpy = vi.spyOn(Date, "now").mockImplementation(() => currentNow)
    })

    afterEach(async () => {
        // Let any refresh left in-flight by the test finish before the next test
        // reuses the same manga key - otherwise it would be seen as still in-flight
        // (inFlightRefreshes is module-scoped, unlike the cooldown map).
        await flush()
        nowSpy.mockRestore()
    })

    it("dedupes back-to-back schedule calls for the same manga into a single refresh", async () => {
        await db.manga.put(manga)
        const source = fakeSource(() => LIST_URL)

        scheduleChapterListRefresh(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)
        scheduleChapterListRefresh(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)
        await flush()

        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledTimes(1)
    })

    it("allows a second refresh once the cooldown window has elapsed", async () => {
        await db.manga.put(manga)
        const source = fakeSource(() => LIST_URL)

        scheduleChapterListRefresh(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)
        await flush()
        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledTimes(1)

        currentNow += 10 * 60 * 1000 + 1

        scheduleChapterListRefresh(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)
        await flush()
        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledTimes(2)
    })

    it("allows a second refresh immediately after _resetRefreshCooldownForTests", async () => {
        await db.manga.put(manga)
        const source = fakeSource(() => LIST_URL)

        scheduleChapterListRefresh(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)
        await flush()
        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledTimes(1)

        _resetRefreshCooldownForTests()

        scheduleChapterListRefresh(source, SOURCE_MANGA_ID, MANGA_URL, MANGA_ID)
        await flush()
        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledTimes(2)
    })
})
