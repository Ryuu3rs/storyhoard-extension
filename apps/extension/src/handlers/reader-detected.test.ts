import "fake-indexeddb/auto"
import Dexie from "dexie"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { HandlerContext } from "../background/handler-types"

const publishLiveMock = vi.fn()
vi.mock("../live", () => ({ publishLive: (...args: unknown[]) => publishLiveMock(...args) }))
const notifyMock = vi.hoisted(() => vi.fn())
vi.mock("../notifications", () => ({ notifyNewChapters: notifyMock }))

const settings = vi.hoisted(() => ({ autoAdd: true, markReadOnVisit: true, language: "en" }))
vi.mock("../settings", () => ({ getSettings: async () => ({ ...settings }) }))
vi.mock("../background/tab-fetch", () => ({ fetchChapterHtmlViaTab: vi.fn() }))

const findSourceProbe = vi.hoisted(() => ({ run: undefined as (() => void) | undefined }))
vi.mock("../sources", async importOriginal => {
    const actual = await importOriginal<typeof import("../sources")>()
    return {
        ...actual,
        findSource: (...args: Parameters<typeof actual.findSource>) => {
            findSourceProbe.run?.()
            return actual.findSource(...args)
        }
    }
})

const scheduleMock = vi.fn()
vi.mock("../background/chapter-cache", async importOriginal => ({
    ...(await importOriginal<typeof import("../background/chapter-cache")>()),
    scheduleChapterListRefresh: (...args: unknown[]) => scheduleMock(...args)
}))

const executeScript = vi.fn()
vi.stubGlobal("browser", {
    action: {
        setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
        setBadgeText: vi.fn().mockResolvedValue(undefined)
    },
    scripting: { executeScript }
})
const fetchSpy = vi.fn(() => Promise.reject(new Error("a detected page must never cause a network request")))
vi.stubGlobal("fetch", fetchSpy)

const { db } = await import("../database")
const { readerHandlers } = await import("./reader")
const { chapterListForUrl } = await import("../arch-sources")
const { handlers } = await import("../background/dispatch")

const ctx: HandlerContext = { sender: {} as HandlerContext["sender"] }

const ORIGIN = "https://reader.example"
const PAGE = `${ORIGIN}/manga/demo-title/chapter-4`
const MANGA_ID = "detected:reader.example:manga:demo-title"

const OPAQUE_ORIGIN = "https://mangafire.example"
const OPAQUE_PAGE = `${OPAQUE_ORIGIN}/title/demo-title.abc/chapter/9475194`
const OPAQUE_MANGA_ID = "detected:mangafire.example:manga:demo-title.abc"

type Tracked = {
    supported: boolean
    tracked?: boolean
    retry?: boolean
    mangaId?: string
    created?: boolean
    chapterNumber?: number | null
}

const senderFor = (url: string) => ({ sender: { tab: { url } } }) as unknown as HandlerContext

const trackDetected = (
    url: string,
    extra: { label?: string; explicit?: boolean } = {},
    c: HandlerContext = senderFor(url)
) => readerHandlers["work:track-detected"]!({ type: "work:track-detected", url, ...extra }, c) as Promise<Tracked>

const link = (n: number, text = `Chapter ${n}`) => ({ url: `${ORIGIN}/manga/demo-title/chapter-${n}`, text })

async function record(page: string, items: Array<{ url: string; text: string }>, mangaId?: string) {
    return (await readerHandlers["work:record-chapter-list"]!(
        { type: "work:record-chapter-list", url: page, items, ...(mangaId ? { mangaId } : {}) },
        ctx
    )) as { recorded: number; advanced: boolean }
}

beforeEach(async () => {
    vi.clearAllMocks()
    settings.autoAdd = true
    settings.markReadOnVisit = true
    await Promise.all([
        db.manga.clear(),
        db.chapters.clear(),
        db.progress.clear(),
        db.historyEvents.clear(),
        db.sourceLinks.clear()
    ])
})

describe("work:track-detected", () => {
    it("is wired into the dispatch table", () => {
        expect(handlers["work:track-detected"]).toBe(readerHandlers["work:track-detected"])
    })

    it("keeps a tracking-only record for a site with no registered source", async () => {
        const result = await trackDetected(PAGE)

        expect(result).toMatchObject({ supported: true, tracked: true, created: true, mangaId: MANGA_ID })
        expect(result.chapterNumber).toBe(4)
        const manga = await db.manga.get(MANGA_ID)
        expect(manga).toMatchObject({
            sourceId: "detected:reader.example",
            sourceMangaId: "demo-title",
            title: "Demo Title",
            lastReadChapterNumber: 4
        })
        expect(await db.chapters.where("mangaId").equals(MANGA_ID).count()).toBe(1)
        expect(publishLiveMock).toHaveBeenCalledWith(["library", "chapters"], [MANGA_ID])
    })

    it("never reaches the network and never schedules a background list refresh", async () => {
        await trackDetected(PAGE)
        await record(PAGE, [link(5), link(4)])
        await chapterListForUrl(PAGE)

        expect(fetchSpy).not.toHaveBeenCalled()
        expect(scheduleMock).not.toHaveBeenCalled()
    })

    it("honours auto-add: with it off nothing is created, but an existing title still advances", async () => {
        settings.autoAdd = false
        const declined = await trackDetected(PAGE)
        expect(declined).toMatchObject({ supported: true, tracked: false, retry: false })
        expect(await db.manga.count()).toBe(0)

        settings.autoAdd = true
        await trackDetected(`${ORIGIN}/manga/demo-title/chapter-3`)
        settings.autoAdd = false
        const advanced = await trackDetected(PAGE)
        expect(advanced).toMatchObject({ tracked: true, created: false })
        expect((await db.manga.get(MANGA_ID))?.lastReadChapterNumber).toBe(4)
    })

    it("an explicit Mark read adds the title even with auto-add off", async () => {
        settings.autoAdd = false
        const result = await trackDetected(PAGE, { explicit: true })
        expect(result).toMatchObject({ tracked: true, created: true })
        expect(await db.manga.get(MANGA_ID)).toBeDefined()
    })

    it("does not mark the chapter read on a plain visit when mark-read-on-visit is off", async () => {
        settings.markReadOnVisit = false
        await trackDetected(PAGE)
        const progress = await db.progress.toArray()
        expect(progress).toHaveLength(1)
        expect(progress[0]?.completed).toBe(false)
    })

    it("numbers an opaque-id chapter from the page label, and waits for one rather than record an id", async () => {
        const waiting = await trackDetected(OPAQUE_PAGE)
        expect(waiting).toMatchObject({ supported: true, tracked: false, retry: true })
        expect(await db.manga.count()).toBe(0)

        const result = await trackDetected(OPAQUE_PAGE, { label: "Ch. 86" })
        expect(result).toMatchObject({ tracked: true, mangaId: OPAQUE_MANGA_ID, chapterNumber: 86 })
        const rows = await db.chapters.where("mangaId").equals(OPAQUE_MANGA_ID).toArray()
        expect(rows.map(c => c.sortKey)).toEqual([86])
    })

    it("declines a page it may not observe, or one from another site", async () => {
        expect(await trackDetected("https://en.wikipedia.org/manga/demo-title/chapter-4")).toEqual({
            supported: false
        })
        expect(await trackDetected("https://mangadex.org/chapter/3f1a5c8e-7b2d-4c1a-9e3f-0a1b2c3d4e5f")).toEqual({
            supported: false
        })
        const foreign = { sender: { tab: { url: "https://evil.example/page" } } } as unknown as HandlerContext
        expect(await trackDetected(PAGE, {}, foreign)).toEqual({ supported: false })
        const own = { sender: { tab: { url: PAGE } } } as unknown as HandlerContext
        expect(await trackDetected(PAGE, {}, own)).toMatchObject({ supported: true, tracked: true })
    })
})

describe("work:record-chapter-list on a detected page (no registered source)", () => {
    it("records the page's own list against the tracking-only title and fills the dropdown", async () => {
        await trackDetected(PAGE)

        const result = await record(PAGE, [link(5), link(4), link(3), link(2), link(1)], MANGA_ID)

        expect(result).toEqual({ recorded: 5, advanced: true })
        const dropdown = await chapterListForUrl(PAGE)
        expect(dropdown.map(entry => entry.sortKey)).toEqual([1, 2, 3, 4, 5])
        const siblings = (await readerHandlers["chapter:siblings"]!({ type: "chapter:siblings", url: PAGE }, ctx)) as {
            prevUrl: string | null
            nextUrl: string | null
            mangaId: string | null
        }
        expect(siblings).toMatchObject({ prevUrl: `${ORIGIN}/manga/demo-title/chapter-3`, mangaId: MANGA_ID })
        expect(siblings.nextUrl).toBe(`${ORIGIN}/manga/demo-title/chapter-5`)
    })

    it("finds the title without being told its id", async () => {
        await trackDetected(PAGE)
        expect((await record(PAGE, [link(5), link(3)])).recorded).toBe(2)
    })

    it("drops foreign-origin, other-series and non-chapter links", async () => {
        await trackDetected(PAGE)

        await record(PAGE, [
            link(5),
            { url: "https://evil.example/manga/demo-title/chapter-9", text: "Chapter 9" },
            { url: `${ORIGIN}/manga/other-title/chapter-8`, text: "Chapter 8" },
            { url: `${ORIGIN}/about`, text: "Chapter 7" },
            { url: "javascript:alert(1)", text: "Chapter 6" }
        ])

        const stored = await db.chapters.where("mangaId").equals(MANGA_ID).toArray()
        expect(stored.filter(c => c.id.includes(":chapter:")).map(c => c.sortKey)).toEqual([5])
    })

    it("does not create a title, or store anything, for an untracked series", async () => {
        const result = await record(PAGE, [link(5), link(4)])

        expect(result).toEqual({ recorded: 0, advanced: false })
        expect(await db.chapters.count()).toBe(0)
        expect(await db.manga.count()).toBe(0)
    })

    it("will not write onto a title of another source, whatever id it is handed", async () => {
        await db.manga.put({
            id: "mangadex:manga:abc",
            title: "Other",
            normalizedTitle: "other",
            authors: [],
            status: "ongoing",
            addedAt: 1,
            updatedAt: 1,
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/title/abc"
        })

        const result = await record(PAGE, [link(5)], "mangadex:manga:abc")

        expect(result).toEqual({ recorded: 0, advanced: false })
        expect(await db.chapters.where("mangaId").equals("mangadex:manga:abc").count()).toBe(0)
    })

    it("ignores a page it may not observe", async () => {
        const result = await record("https://en.wikipedia.org/manga/demo-title/chapter-4", [
            { url: "https://en.wikipedia.org/manga/demo-title/chapter-5", text: "Chapter 5" }
        ])
        expect(result).toEqual({ recorded: 0, advanced: false })
    })
})

describe("work:track-detected numbers the visit from the address the matcher recognised", () => {
    it.each([
        ["episode-12", 12],
        ["ep-3", 3],
        ["ch-12", 12],
        ["chapter.5", 5],
        ["issue-9", 9]
    ])("records %s as a numbered chapter, never an unnumbered shadow row", async (segment, expected) => {
        const page = `${ORIGIN}/series/demo-title/${segment}`
        const result = await trackDetected(page)

        expect(result).toMatchObject({ tracked: true, chapterNumber: expected })
        const rows = await db.chapters.where("mangaId").equals("detected:reader.example:manga:demo-title").toArray()
        expect(rows.map(row => row.sortKey)).toEqual([expected])
        expect(rows.every(row => Number.isFinite(row.sortKey))).toBe(true)
    })
})

describe("a chapter is one row whether it came from a visit or from the page's list", () => {
    async function assertOneRowPerNumber() {
        const rows = await db.chapters.where("mangaId").equals(MANGA_ID).toArray()
        const numbers = rows.map(row => row.sortKey).sort((a, b) => a - b)
        expect(numbers).toEqual([...new Set(numbers)])
        return rows
    }

    it("folds the visit row into the list row and keeps the read position pointing at it", async () => {
        await trackDetected(PAGE)
        expect((await db.chapters.where("mangaId").equals(MANGA_ID).toArray()).map(c => c.id)).toEqual([
            `${MANGA_ID}:ext:ch-4`
        ])

        await record(PAGE, [link(5), link(4), link(3)], MANGA_ID)

        const rows = await assertOneRowPerNumber()
        expect(rows.map(row => row.sortKey)).toEqual(expect.arrayContaining([3, 4, 5]))
        expect(rows).toHaveLength(3)
        expect(rows.some(row => row.id.includes(":ext:"))).toBe(false)
        const canonical = `detected:reader.example:chapter:demo-title:4`
        const progress = await db.progress.toArray()
        expect(progress.map(p => p.chapterId)).toEqual([canonical])
        expect(progress[0]).toMatchObject({ mangaId: MANGA_ID, completed: true })
        const manga = await db.manga.get(MANGA_ID)
        expect(manga?.lastReadChapterId).toBe(canonical)
        expect(await db.chapters.get(manga!.lastReadChapterId!)).toBeDefined()
        expect((await db.historyEvents.toArray()).every(event => event.chapterId === canonical)).toBe(true)
    })

    it("records a visit against the list row when the list was recorded first", async () => {
        await trackDetected(`${ORIGIN}/manga/demo-title/chapter-3`)
        await record(PAGE, [link(5), link(4), link(3)], MANGA_ID)

        await trackDetected(PAGE)

        const rows = await assertOneRowPerNumber()
        expect(rows).toHaveLength(3)
        const canonical = `detected:reader.example:chapter:demo-title:4`
        expect((await db.progress.get(canonical))?.completed).toBe(true)
        const manga = await db.manga.get(MANGA_ID)
        expect(manga).toMatchObject({ lastReadChapterNumber: 4, lastReadChapterId: canonical })
    })
})

describe("work:track-detected auto-mark versus an explicit click", () => {
    it("an auto-mark of an untracked title respects auto-add off, and an explicit click does not", async () => {
        settings.autoAdd = false
        const auto = await readerHandlers["work:track-detected"]!(
            { type: "work:track-detected", url: PAGE, markRead: true },
            senderFor(PAGE)
        )
        expect(auto).toMatchObject({ supported: true, tracked: false })
        expect(await db.manga.count()).toBe(0)

        const click = await trackDetected(PAGE, { explicit: true })
        expect(click).toMatchObject({ tracked: true, created: true })
    })

    it("an auto-mark still completes the chapter of a tracked title when mark-read-on-visit is off", async () => {
        settings.markReadOnVisit = false
        await trackDetected(`${ORIGIN}/manga/demo-title/chapter-3`)
        await readerHandlers["work:track-detected"]!(
            { type: "work:track-detected", url: PAGE, markRead: true },
            senderFor(PAGE)
        )

        const progress = await db.progress.toArray()
        expect(progress.find(p => p.chapterId.endsWith("ch-4"))?.completed).toBe(true)
        expect(progress.find(p => p.chapterId.endsWith("ch-3"))?.completed).toBe(false)
    })
})

describe("work:track-detected needs a verifiable sender origin", () => {
    it("declines a request that comes with no sender url, however well formed", async () => {
        expect(await trackDetected(PAGE, {}, ctx)).toEqual({ supported: false })
        expect(await trackDetected(PAGE, {}, { sender: { tab: {} } } as unknown as HandlerContext)).toEqual({
            supported: false
        })
        expect(await db.manga.count()).toBe(0)
    })

    it("accepts the sender's own page url when the tab carries none", async () => {
        const framed = { sender: { url: PAGE } } as unknown as HandlerContext
        expect(await trackDetected(PAGE, {}, framed)).toMatchObject({ supported: true, tracked: true })
    })
})

describe("panel:resolve-mode", () => {
    const resolve = (url: string) =>
        readerHandlers["panel:resolve-mode"]!({ type: "panel:resolve-mode", url }, ctx) as Promise<unknown>

    it("puts an unfollowed reader page in detected mode with the open selectors", async () => {
        expect(await resolve(PAGE)).toEqual({ mode: "detected", renderedSelectors: {} })
    })

    it("says nothing for a page that is not a reader page or may not be observed", async () => {
        expect(await resolve(`${ORIGIN}/about`)).toBeNull()
        expect(await resolve("https://en.wikipedia.org/manga/demo-title/chapter-4")).toBeNull()
    })

    // The panel asks from the page's tab after the page changed its own address. The address is the page's to
    // choose, so the tab must still read as a reader on that address before a detected panel goes back up.
    const fromTab = (url: string) =>
        readerHandlers["panel:resolve-mode"]!({ type: "panel:resolve-mode", url }, {
            sender: { tab: { id: 5, url }, url }
        } as unknown as HandlerContext) as Promise<unknown>
    const signalsOn = (url: string, largeImages: number) => [{ result: { url, links: [], images: [], largeImages } }]

    it("re-confirms from the tab's content that the new address is still a reader page", async () => {
        executeScript.mockResolvedValue(signalsOn(PAGE, 4))
        expect(await fromTab(PAGE)).toEqual({ mode: "detected", renderedSelectors: {} })
        expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 5 } }))
    })

    it("puts no detected panel back on a tab that shows another address or cannot be read", async () => {
        executeScript.mockResolvedValue(signalsOn(`${ORIGIN}/manga/other/chapter-1`, 4))
        expect(await fromTab(PAGE)).toBeNull()
        executeScript.mockRejectedValue(new Error("no access"))
        expect(await fromTab(PAGE)).toBeNull()
    })

    it("puts no detected panel back on an address whose page does not read as a reader, after one more look", async () => {
        executeScript.mockResolvedValue(signalsOn(PAGE, 0))
        expect(await fromTab(PAGE)).toBeNull()
        expect(executeScript).toHaveBeenCalledTimes(2)
    })
})

describe("a hostile page on a detected site", () => {
    // Bidi overrides and isolates, C0 controls (a newline) and zero-width characters: the text-spoofing set.
    const SPOOF = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/
    const EVIL = "https://evil-reader.example"
    const recordOn = (page: string, items: Array<{ url: string; text: string }>) =>
        readerHandlers["work:record-chapter-list"]!(
            { type: "work:record-chapter-list", url: page, items },
            senderFor(page)
        ) as Promise<{ recorded: number; advanced: boolean }>

    it("cannot write direction overrides or line breaks into a library title", async () => {
        const text = `${String.fromCharCode(0x202e)}elif.exe${String.fromCharCode(0x202c)} Your account is locked${String.fromCharCode(10)}Re-verify now`
        const result = await trackDetected(`${EVIL}/manga/${encodeURIComponent(text)}/chapter-1`)
        expect(result.tracked).toBe(true)
        const row = await db.manga.get(result.mangaId!)
        expect(SPOOF.test(row!.title)).toBe(false)
        expect(row!.title).toBe("Elif.Exe Your Account Is Locked Re Verify Now")
    })

    it("cannot write an unbounded title, and an address past the length cap is not observed at all", async () => {
        const capped = await trackDetected(`${EVIL}/manga/${"x".repeat(1_500)}/chapter-1`)
        expect(capped.tracked).toBe(true)
        expect([...(await db.manga.get(capped.mangaId!))!.title]).toHaveLength(200)

        expect(await trackDetected(`${EVIL}/manga/${"y".repeat(50_000)}/chapter-1`)).toEqual({ supported: false })
        expect(await db.manga.count()).toBe(1)
    })

    it("cannot make the extension announce a new chapter with text the page chose", async () => {
        const slug = encodeURIComponent("Security alert\nYour library will be deleted - visit evil-reader.example")
        const series = `${EVIL}/manga/${slug}`
        await trackDetected(`${series}/chapter-1`)
        await recordOn(`${series}/chapter-1`, [
            { url: `${series}/chapter-1`, text: "Chapter 1" },
            { url: `${series}/chapter-2`, text: "Chapter 2" }
        ])
        await recordOn(`${series}/chapter-1`, [{ url: `${series}/chapter-3`, text: "Chapter 3" }])

        expect(notifyMock).toHaveBeenCalled()
        const announced = notifyMock.mock.calls.flatMap(call => call[0] as string[])
        expect(announced.some(title => SPOOF.test(title))).toBe(false)
    })

    it("numbers a link by its address, not by the number its visible text claims", async () => {
        const series = `${EVIL}/manga/demo`
        await trackDetected(`${series}/chapter-1`)
        await recordOn(`${series}/chapter-1`, [{ url: `${series}/chapter-2`, text: "Chapter 2" }])
        await recordOn(`${series}/chapter-1`, [{ url: `${series}/chapter-2`, text: "Chapter 99999" }])

        const row = await db.manga.get("detected:evil-reader.example:manga:demo")
        expect(row!.latestChapterNumber).toBe(2)
    })

    it("cannot move the latest chapter far ahead with one stray link, while a real run of chapters still can", async () => {
        const series = `${EVIL}/manga/demo`
        await trackDetected(`${series}/chapter-1`)
        await recordOn(
            `${series}/chapter-1`,
            [1, 2, 3].map(n => ({ url: `${series}/chapter-${n}`, text: `Ch ${n}` }))
        )
        await recordOn(`${series}/chapter-1`, [{ url: `${series}/chapter-9000`, text: "Chapter 9000" }])
        expect((await db.manga.get("detected:evil-reader.example:manga:demo"))!.latestChapterNumber).toBe(3)
        expect(await db.chapters.where("url").equals(`${series}/chapter-9000`).count()).toBe(0)

        const run = [200, 201, 202, 203].map(n => ({ url: `${series}/chapter-${n}`, text: `Ch ${n}` }))
        await recordOn(`${series}/chapter-1`, run)
        expect((await db.manga.get("detected:evil-reader.example:manga:demo"))!.latestChapterNumber).toBe(203)
    })

    it("cannot grow one title's chapter table by relabelling the same links", async () => {
        const series = `${EVIL}/manga/demo`
        await trackDetected(`${series}/chapter-1`)
        for (let batch = 0; batch < 3; batch++) {
            const items = Array.from({ length: 2000 }, (_, i) => ({
                url: `${series}/chapter-1`,
                text: `Chapter ${batch * 2000 + i}.5`
            }))
            await recordOn(`${series}/chapter-1`, items)
        }
        const rows = await db.chapters.where("mangaId").equals("detected:evil-reader.example:manga:demo").toArray()
        expect(rows.length).toBeLessThanOrEqual(2)
        expect(new Set(rows.map(row => row.url)).size).toBe(rows.length)
    })

    it("cannot mint an unbounded number of titles by walking its own address, but a click still adds", async () => {
        const { MAX_AUTO_ADDED_PER_SITE_PER_HOUR } = await import("./reader")
        for (let i = 0; i < 60; i++) await trackDetected(`${EVIL}/manga/spam-title-${i}/chapter-1`)
        const count = () => db.manga.where("sourceId").equals("detected:evil-reader.example").count()
        expect(await count()).toBe(MAX_AUTO_ADDED_PER_SITE_PER_HOUR)

        const click = await trackDetected(`${EVIL}/manga/wanted/chapter-1`, { explicit: true })
        expect(click).toMatchObject({ tracked: true, created: true })
        expect(await count()).toBe(MAX_AUTO_ADDED_PER_SITE_PER_HOUR + 1)

        // Another site has its own allowance.
        expect(await trackDetected(PAGE)).toMatchObject({ tracked: true, created: true })
    })

    it("caps auto-added titles per site per day too", async () => {
        const { MAX_AUTO_ADDED_PER_SITE_PER_DAY } = await import("./reader")
        const now = Date.now()
        await db.manga.bulkPut(
            Array.from({ length: MAX_AUTO_ADDED_PER_SITE_PER_DAY }, (_, i) => ({
                id: `detected:evil-reader.example:manga:earlier-${i}`,
                title: `Earlier ${i}`,
                normalizedTitle: `earlier ${i}`,
                sourceId: "detected:evil-reader.example",
                sourceUrl: `${EVIL}/manga/earlier-${i}/chapter-1`,
                authors: [],
                status: "unknown",
                addedAt: now - 3 * 60 * 60 * 1000,
                updatedAt: now
            })) as never
        )
        expect(await trackDetected(`${EVIL}/manga/one-more/chapter-1`)).toMatchObject({ tracked: false })
    })
})

describe("work:track-detected holds the promotion lock for its write", () => {
    it("carries the new row with a move that starts right before the write, never leaving a detected row", async () => {
        const { promoteDetectedManga } = await import("../database")
        let moving: Promise<number> | undefined
        let checks = 0
        findSourceProbe.run = () => {
            checks += 1
            if (checks === 2) {
                moving = Dexie.ignoreTransaction(() =>
                    promoteDetectedManga("detected:reader.example", "reader.example")
                )
            }
        }

        const result = await trackDetected(PAGE)
        findSourceProbe.run = undefined
        await moving

        expect(moving).toBeDefined()
        expect(result).toMatchObject({ supported: true, tracked: true, created: true })
        expect(await db.manga.where("sourceId").equals("detected:reader.example").count()).toBe(0)
        const followed = await db.manga.get("reader.example:manga:demo-title")
        expect(followed).toMatchObject({ title: "Demo Title", sourceId: "reader.example", lastReadChapterNumber: 4 })
        expect((await db.progress.toArray()).map(p => p.mangaId)).toEqual(["reader.example:manga:demo-title"])
    })
})

describe("folding progress keeps the furthest page", () => {
    const canonical = "detected:reader.example:chapter:demo-title:4"
    const progressRow = (chapterId: string, pageIndex: number, updatedAt: number, completed: boolean) => ({
        mangaId: MANGA_ID,
        chapterId,
        pageIndex,
        pageCount: 20,
        completed,
        updatedAt
    })

    it("keeps the greater page when the list row's progress is newer but shorter", async () => {
        await trackDetected(PAGE)
        await db.progress.put(progressRow(`${MANGA_ID}:ext:ch-4`, 14, 100, true))
        await db.progress.put(progressRow(canonical, 3, 200, true))

        await record(PAGE, [link(5), link(4), link(3)], MANGA_ID)

        expect(await db.progress.get(`${MANGA_ID}:ext:ch-4`)).toBeUndefined()
        expect(await db.progress.get(canonical)).toMatchObject({ pageIndex: 14, completed: true, updatedAt: 200 })
    })

    it("keeps the greater page when the visit row is the newer one, and never loses completion", async () => {
        await trackDetected(PAGE)
        await db.progress.put(progressRow(`${MANGA_ID}:ext:ch-4`, 2, 300, false))
        await db.progress.put(progressRow(canonical, 9, 100, true))

        await record(PAGE, [link(5), link(4), link(3)], MANGA_ID)

        expect(await db.progress.get(canonical)).toMatchObject({ pageIndex: 9, completed: true })
    })

    it("keeps the furthest page when a visit is recorded against the list row", async () => {
        await trackDetected(`${ORIGIN}/manga/demo-title/chapter-3`)
        await record(PAGE, [link(5), link(4), link(3)], MANGA_ID)
        await db.progress.put(progressRow(canonical, 11, 100, false))

        await trackDetected(PAGE)

        expect(await db.progress.get(canonical)).toMatchObject({ pageIndex: 11, completed: true })
    })
})
