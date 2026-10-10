import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { HandlerContext } from "../background/handler-types"

const publishLiveMock = vi.fn()
vi.mock("../live", () => ({ publishLive: (...args: unknown[]) => publishLiveMock(...args) }))
vi.mock("../notifications", () => ({ notifyNewChapters: vi.fn() }))

const settings = vi.hoisted(() => ({ autoAdd: true, markReadOnVisit: true, language: "en" }))
vi.mock("../settings", () => ({ getSettings: async () => ({ ...settings }) }))
vi.mock("../background/tab-fetch", () => ({ fetchChapterHtmlViaTab: vi.fn() }))

const scheduleMock = vi.fn()
vi.mock("../background/chapter-cache", async importOriginal => ({
    ...(await importOriginal<typeof import("../background/chapter-cache")>()),
    scheduleChapterListRefresh: (...args: unknown[]) => scheduleMock(...args)
}))

vi.stubGlobal("browser", {
    action: {
        setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
        setBadgeText: vi.fn().mockResolvedValue(undefined)
    }
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

const trackDetected = (url: string, extra: { label?: string; explicit?: boolean } = {}, c: HandlerContext = ctx) =>
    readerHandlers["work:track-detected"]!({ type: "work:track-detected", url, ...extra }, c) as Promise<Tracked>

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
