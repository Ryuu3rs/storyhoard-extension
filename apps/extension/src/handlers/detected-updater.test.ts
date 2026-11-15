import "fake-indexeddb/auto"
import { sourceRegistry } from "@amr/sources"
import type { CaptureSignals } from "@amr/source-engine"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { HandlerContext } from "../background/handler-types"
import { db } from "../database"

// G1 with the real engine: a title seen on a site with no adapter, the user follows the site, and the real
// update check reads its chapters. Only the network, the tab capture and the panel injection are stubbed.

const captureTabSignalsMock = vi.fn()
vi.mock("../arch-sources", async importOriginal => ({
    ...(await importOriginal<typeof import("../arch-sources")>()),
    captureTabSignals: (...args: unknown[]) => captureTabSignalsMock(...args)
}))
vi.mock("../background/chapter-cache", async importOriginal => ({
    ...(await importOriginal<typeof import("../background/chapter-cache")>()),
    scheduleChapterListRefresh: vi.fn()
}))
vi.mock("../settings", () => ({
    getSettings: async () => ({ language: "en", autoAdd: true, markReadOnVisit: true })
}))
vi.mock("../live", () => ({ publishLive: vi.fn() }))
const notifyNewChaptersMock = vi.fn()
vi.mock("../notifications", () => ({ notifyNewChapters: (...args: unknown[]) => notifyNewChaptersMock(...args) }))
const fetchChapterHtmlViaTabMock = vi.fn()
vi.mock("../background/tab-fetch", () => ({
    fetchChapterHtmlViaTab: (...args: unknown[]) => fetchChapterHtmlViaTabMock(...args)
}))
vi.mock("../background/panel-injection", () => ({ injectPanelForTab: vi.fn(async () => true) }))

const storage = new Map<string, unknown>()
const permissions = {
    getAll: vi.fn(async () => ({ origins: [] as string[] })),
    contains: vi.fn(),
    request: vi.fn(),
    remove: vi.fn()
}
const tabs = { get: vi.fn(), query: vi.fn() }
vi.stubGlobal("browser", {
    permissions,
    tabs,
    action: {
        setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
        setBadgeText: vi.fn().mockResolvedValue(undefined)
    },
    storage: {
        local: {
            get: vi.fn(async (key: string) => (storage.has(key) ? { [key]: storage.get(key) } : {})),
            set: vi.fn(async (items: Record<string, unknown>) => {
                for (const [key, value] of Object.entries(items)) storage.set(key, value)
            }),
            remove: vi.fn(async (key: string) => void storage.delete(key))
        }
    }
})

const { addSourceHandlers } = await import("./add-source")
const { readerHandlers } = await import("./reader")
const { checkUpdates } = await import("./updates-sources")
const { beginUserSourcesInit } = await import("../background/user-sources-ready")
const { resyncStoredArchProfiles } = await import("../arch-sources")

const HOST = "reader.example"
const CHAPTER_URL = `https://${HOST}/manga/demo-title/chapter-2`
const SERIES_URL = `https://${HOST}/manga/demo-title`
const PROFILE_ID = HOST
const DETECTED_ID = `detected:${HOST}:manga:demo-title`
const FOLLOWED_ID = `${HOST}:manga:demo-title`
const fromTab = { sender: { tab: { id: 7, url: CHAPTER_URL } } } as unknown as HandlerContext

const signals: CaptureSignals = {
    url: CHAPTER_URL,
    ogTitle: "Demo Title Chapter 2 | Example Reader",
    ogSiteName: "Example Reader",
    links: [],
    images: []
}

function seriesPage(latest: number, extra = ""): string {
    const rows = Array.from({ length: latest }, (_, index) => {
        const n = latest - index
        return `<li><a href="/manga/demo-title/chapter-${n}">Chapter ${n}</a></li>`
    }).join("")
    return `<html><head><title>Demo Title</title></head><body><ul>${rows}</ul>${extra}</body></html>`
}

// What real pages carry beside a title's own rows. None of it is a chapter of this title.
const FOREIGN = [
    `<a href="/manga/other-title/chapter-900">Other 900</a>`,
    `<a href="/manga/demo-title-side-story/chapter-901">Side story 901</a>`,
    `<a href="https://elsewhere.example/manga/demo-title/chapter-902">Elsewhere 902</a>`,
    `<a href="/latest/chapter-903">Latest 903</a>`
].join("")

let titlePage: string | undefined
// Only ever moves forward: the response cache every source has outlives a test.
let now = Date.now()

async function visitChapter(): Promise<void> {
    await readerHandlers["work:track-detected"]!({ type: "work:track-detected", url: CHAPTER_URL }, fromTab)
    await readerHandlers["work:record-chapter-list"]!(
        {
            type: "work:record-chapter-list",
            url: CHAPTER_URL,
            items: [1, 2, 3].map(n => ({
                url: `https://${HOST}/manga/demo-title/chapter-${n}`,
                text: `Chapter ${n}`
            }))
        },
        fromTab
    )
}

const follow = () =>
    addSourceHandlers["source:add-from-tab"]!({ type: "source:add-from-tab", url: CHAPTER_URL }, fromTab) as Promise<{
        ok: boolean
        reason?: string
        tier?: string
        updateMode?: string
    }>

// A check an hour after the last one, past the short-lived response cache every source has.
async function check() {
    now += 60 * 60 * 1000
    await checkUpdates()
    return storage.get("updateStatus") as {
        checked: number
        updated: number
        failed: number
        emptyLists: Record<string, number>
        shortLists: Record<string, number>
        trackingOnly: Record<string, number>
    }
}

async function chapterNumbers(): Promise<number[]> {
    return (await db.chapters.where("mangaId").equals(FOLLOWED_ID).toArray()).map(c => c.sortKey).sort((a, b) => a - b)
}

beforeEach(async () => {
    vi.clearAllMocks()
    storage.clear()
    now += 60 * 60 * 1000
    vi.spyOn(Date, "now").mockImplementation(() => now)
    beginUserSourcesInit(async () => undefined)
    sourceRegistry.unregister(PROFILE_ID)
    await Promise.all([
        db.archProfiles.clear(),
        db.manga.clear(),
        db.chapters.clear(),
        db.progress.clear(),
        db.historyEvents.clear(),
        db.sourceLinks.clear()
    ])
    tabs.get.mockResolvedValue({ id: 7, url: CHAPTER_URL })
    tabs.query.mockResolvedValue([{ id: 7, url: CHAPTER_URL }])
    permissions.contains.mockResolvedValue(true)
    permissions.request.mockResolvedValue(false)
    captureTabSignalsMock.mockResolvedValue(signals)
    fetchChapterHtmlViaTabMock.mockRejectedValue(new Error("no tab"))
    titlePage = seriesPage(5, FOREIGN)
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            const { pathname } = new URL(url)
            const served = titlePage !== undefined && pathname === new URL(SERIES_URL).pathname
            const response = served ? new Response(titlePage, { status: 200 }) : new Response("gone", { status: 404 })
            return Object.defineProperty(response, "url", { value: url })
        })
    )
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe("a site followed from a detected page gets an updater", () => {
    it("lists from the title page on the first check, carrying the detected title over", async () => {
        await visitChapter()
        expect(await db.manga.get(DETECTED_ID)).toMatchObject({ lastReadChapterNumber: 2 })

        const followed = await follow()
        expect(followed).toMatchObject({ ok: true, tier: "fetch", updateMode: "auto" })

        const status = await check()
        expect(status).toMatchObject({ checked: 1, failed: 0, emptyLists: {}, trackingOnly: {} })
        expect(await db.manga.count()).toBe(1)
        expect(await db.manga.get(DETECTED_ID)).toBeUndefined()
        expect(await db.manga.get(FOLLOWED_ID)).toMatchObject({
            sourceId: PROFILE_ID,
            lastReadChapterNumber: 2,
            latestChapterNumber: 5
        })
    })

    it("does not announce what already existed: the first list is a baseline", async () => {
        await visitChapter()
        await follow()
        const before = (await db.manga.get(FOLLOWED_ID))?.latestChapterAt

        const status = await check()

        expect(status.updated).toBe(0)
        expect(notifyNewChaptersMock).not.toHaveBeenCalledWith(["Demo Title"])
        expect(await db.manga.get(FOLLOWED_ID)).toMatchObject({ latestChapterNumber: 5, latestChapterAt: before })
    })

    it("reports exactly one new chapter when the page gains one, then none", async () => {
        await visitChapter()
        await follow()
        await check()

        titlePage = seriesPage(6, FOREIGN)
        const oneNew = await check()
        expect(oneNew).toMatchObject({ updated: 1, failed: 0 })
        expect(notifyNewChaptersMock).toHaveBeenCalledWith(["Demo Title"])
        expect(await chapterNumbers()).toEqual([1, 2, 3, 4, 5, 6])

        notifyNewChaptersMock.mockClear()
        const none = await check()
        expect(none).toMatchObject({ updated: 0, failed: 0 })
        expect(notifyNewChaptersMock).not.toHaveBeenCalledWith(["Demo Title"])
    })

    it("takes no chapters from other series, other hosts or other sections of the page", async () => {
        await visitChapter()
        await follow()
        await check()

        expect(await chapterNumbers()).toEqual([1, 2, 3, 4, 5])
        expect((await db.manga.get(FOLLOWED_ID))?.latestChapterNumber).toBe(5)
    })

    it("leaves one row per chapter, with the read position and progress on it", async () => {
        await visitChapter()
        await follow()
        await check()

        expect(await chapterNumbers()).toEqual([1, 2, 3, 4, 5])
        const title = await db.manga.get(FOLLOWED_ID)
        const readRow = await db.chapters.get(title!.lastReadChapterId!)
        expect(readRow?.sortKey).toBe(2)
        const progress = await db.progress.toArray()
        expect(progress).toHaveLength(1)
        expect(progress[0]).toMatchObject({ mangaId: FOLLOWED_ID, chapterId: readRow?.id, completed: true })
        expect((await db.historyEvents.toArray()).every(event => event.chapterId === readRow?.id)).toBe(true)
    })

    it("survives a worker restart: the followed site re-registers from storage and still lists", async () => {
        await visitChapter()
        await follow()
        sourceRegistry.unregister(PROFILE_ID)
        await resyncStoredArchProfiles()

        expect(await check()).toMatchObject({ checked: 1, failed: 0 })
        expect(await chapterNumbers()).toEqual([1, 2, 3, 4, 5])
    })

    it("re-following is refused and changes nothing", async () => {
        await visitChapter()
        await follow()
        await check()
        const before = await db.archProfiles.get(PROFILE_ID)

        const again = await follow()

        expect(again).toMatchObject({ ok: false, reason: "unsupported" })
        expect(await db.archProfiles.get(PROFILE_ID)).toEqual(before)
        expect(await db.manga.count()).toBe(1)
    })
})

describe("a list that cannot be read is reported, never read as nothing new", () => {
    it("reports a page that stops listing chapters, keeps the title and does not announce", async () => {
        await visitChapter()
        await follow()
        await check()

        titlePage = "<html><head><title>Maintenance</title></head><body>Back soon</body></html>"
        const status = await check()

        expect(status).toMatchObject({ updated: 0, emptyLists: { [PROFILE_ID]: 1 } })
        expect((await db.manga.get(FOLLOWED_ID))?.latestChapterNumber).toBe(5)
    })

    it("a title whose first list is empty stays waiting for its baseline, so the next list announces nothing", async () => {
        await visitChapter()
        await follow()

        titlePage = "<html><head><title>Maintenance</title></head><body>Back soon</body></html>"
        expect(await check()).toMatchObject({ updated: 0, emptyLists: { [PROFILE_ID]: 1 } })

        titlePage = seriesPage(9)
        expect((await check()).updated).toBe(0)
        expect((await db.manga.get(FOLLOWED_ID))?.latestChapterNumber).toBe(9)
    })

    it("reports a list that stops below a chapter already known, keeps it, and a later visit announces nothing", async () => {
        await visitChapter()
        await follow()
        await check()

        titlePage = seriesPage(2)
        const status = await check()
        expect(status).toMatchObject({ updated: 0, shortLists: { [PROFILE_ID]: 1 } })
        expect((await db.manga.get(FOLLOWED_ID))?.latestChapterNumber).toBe(5)

        notifyNewChaptersMock.mockClear()
        await readerHandlers["work:record-chapter-list"]!(
            {
                type: "work:record-chapter-list",
                url: CHAPTER_URL,
                items: [1, 2, 3, 4, 5].map(n => ({
                    url: `https://${HOST}/manga/demo-title/chapter-${n}`,
                    text: `Chapter ${n}`
                }))
            },
            fromTab
        )
        expect(notifyNewChaptersMock).not.toHaveBeenCalled()
    })

    it("follows on-visit when no list can be read, and says so in the check instead of counting it checked", async () => {
        await visitChapter()
        titlePage = "<html><head><title>Demo Title</title></head><body>No list here</body></html>"
        fetchChapterHtmlViaTabMock.mockResolvedValue(titlePage)

        const followed = await follow()
        expect(followed).toMatchObject({ ok: true, tier: "on-visit", updateMode: "on-visit" })

        const status = await check()
        expect(status).toMatchObject({ checked: 0, updated: 0, trackingOnly: { [PROFILE_ID]: 1 } })
        expect(await db.manga.get(FOLLOWED_ID)).toMatchObject({ lastReadChapterNumber: 2 })
    })
})

describe("following from the panel, which has no gesture to ask for the www twin with", () => {
    it("follows the address the user granted and re-registers after a restart", async () => {
        const held = new Set([`https://${HOST}/*`])
        permissions.contains.mockImplementation(async ({ origins }: { origins: string[] }) =>
            origins.every(origin => held.has(origin))
        )
        await visitChapter()

        expect((await follow()).ok).toBe(true)
        const stored = (await db.archProfiles.get(PROFILE_ID))?.profile as { domains: string[]; origins: string[] }
        expect(stored.domains).toEqual([HOST])
        expect(stored.origins).toEqual([`https://${HOST}/*`])

        sourceRegistry.unregister(PROFILE_ID)
        await resyncStoredArchProfiles()
        expect(sourceRegistry.get(PROFILE_ID)).toBeDefined()
    })

    it("still refuses when the page's own address is not granted either", async () => {
        await visitChapter()
        permissions.contains.mockResolvedValue(false)

        expect(await follow()).toMatchObject({ ok: false, reason: "permission" })
        expect(await db.archProfiles.count()).toBe(0)
        expect(await db.manga.get(DETECTED_ID)).toBeDefined()
    })
})
