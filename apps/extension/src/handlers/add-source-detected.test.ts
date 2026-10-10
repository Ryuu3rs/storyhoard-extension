import "fake-indexeddb/auto"
import { sourceRegistry } from "@amr/sources"
import type { CaptureSignals, SiteProfile } from "@amr/source-engine"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { HandlerContext } from "../background/handler-types"
import { db } from "../database"

const captureTabSignalsMock = vi.fn()
vi.mock("../arch-sources", async importOriginal => ({
    ...(await importOriginal<typeof import("../arch-sources")>()),
    captureTabSignals: (...args: unknown[]) => captureTabSignalsMock(...args)
}))

const probeSourceMock = vi.fn()
vi.mock("@amr/source-engine", async importOriginal => ({
    ...(await importOriginal<typeof import("@amr/source-engine")>()),
    probeSource: (...args: unknown[]) => probeSourceMock(...args)
}))

vi.mock("../background/chapter-cache", async importOriginal => ({
    ...(await importOriginal<typeof import("../background/chapter-cache")>()),
    scheduleChapterListRefresh: vi.fn()
}))
vi.mock("../settings", () => ({
    getSettings: async () => ({ language: "en", autoAdd: true, markReadOnVisit: true })
}))
vi.mock("../live", () => ({ publishLive: vi.fn() }))
vi.mock("../notifications", () => ({ notifyNewChapters: vi.fn() }))
vi.mock("../background/tab-fetch", () => ({ fetchChapterHtmlViaTab: vi.fn() }))

const injectPanelForTabMock = vi.fn()
vi.mock("../background/panel-injection", () => ({
    injectPanelForTab: (...args: unknown[]) => injectPanelForTabMock(...args)
}))

const permissions = { contains: vi.fn(), request: vi.fn(), remove: vi.fn() }
const tabs = { get: vi.fn(), query: vi.fn() }
vi.stubGlobal("browser", {
    permissions,
    tabs,
    action: {
        setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
        setBadgeText: vi.fn().mockResolvedValue(undefined)
    }
})

const { addSourceHandlers } = await import("./add-source")
const { readerHandlers } = await import("./reader")
const { beginUserSourcesInit } = await import("../background/user-sources-ready")

const CHAPTER_URL = "https://reader.example/manga/demo-title/chapter-2"
const PROFILE_ID = "reader.example"
const DETECTED_ID = "detected:reader.example:manga:demo-title"
const FOLLOWED_ID = "reader.example:manga:demo-title"
const fromTab = { sender: { tab: { id: 7, url: CHAPTER_URL } } } as unknown as HandlerContext

const signals: CaptureSignals = {
    url: CHAPTER_URL,
    ogTitle: "Demo Title Chapter 2 | Example Reader",
    ogSiteName: "Example Reader",
    links: [
        { href: "/manga/demo-title/chapter-1", text: "Prev" },
        { href: "/manga/demo-title/chapter-3", text: "Next" }
    ],
    images: []
}

const link = (n: number) => ({ url: `https://reader.example/manga/demo-title/chapter-${n}`, text: `Chapter ${n}` })

async function trackDetectedVisit(): Promise<void> {
    await readerHandlers["work:track-detected"]!({ type: "work:track-detected", url: CHAPTER_URL }, fromTab)
    await readerHandlers["work:record-chapter-list"]!(
        { type: "work:record-chapter-list", url: CHAPTER_URL, items: [link(1), link(2), link(3)] },
        fromTab
    )
}

const follow = () =>
    addSourceHandlers["source:add-from-tab"]!({ type: "source:add-from-tab", url: CHAPTER_URL }, fromTab) as Promise<{
        ok: boolean
    }>

beforeEach(async () => {
    vi.clearAllMocks()
    beginUserSourcesInit(async () => undefined)
    injectPanelForTabMock.mockResolvedValue(true)
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
    permissions.request.mockResolvedValue(true)
    captureTabSignalsMock.mockResolvedValue(signals)
    probeSourceMock.mockImplementation(async (profile: SiteProfile) => ({
        ok: true,
        effectiveOrigin: profile.origin,
        originCorrected: false,
        profile,
        stages: [{ stage: "chapters", ok: true, detail: "2 chapter(s)" }]
    }))
})

describe("Track this site promotes a detected site to followed", () => {
    it("takes the tab from the message sender when the panel's click names none", async () => {
        await trackDetectedVisit()
        const result = await follow()
        expect(result.ok).toBe(true)
        expect(tabs.get).toHaveBeenCalledWith(7)
    })

    it("re-files the tracked title, its chapters, progress and links under the followed source", async () => {
        await trackDetectedVisit()
        const before = await db.manga.get(DETECTED_ID)
        expect(before).toMatchObject({ sourceId: "detected:reader.example", lastReadChapterNumber: 2 })
        expect(await db.chapters.where("mangaId").equals(DETECTED_ID).count()).toBeGreaterThan(0)

        expect((await follow()).ok).toBe(true)

        expect(await db.manga.get(DETECTED_ID)).toBeUndefined()
        const after = await db.manga.get(FOLLOWED_ID)
        expect(after).toMatchObject({
            sourceId: PROFILE_ID,
            sourceMangaId: "demo-title",
            title: "Demo Title",
            lastReadChapterNumber: 2
        })
        expect(await db.manga.count()).toBe(1)
        expect(await db.chapters.where("mangaId").equals(DETECTED_ID).count()).toBe(0)
        const chapters = await db.chapters.where("mangaId").equals(FOLLOWED_ID).toArray()
        expect(chapters.length).toBeGreaterThan(0)
        expect(chapters.every(c => c.sourceId === PROFILE_ID)).toBe(true)
        expect((await db.progress.toArray()).every(p => p.mangaId === FOLLOWED_ID)).toBe(true)
        expect((await db.historyEvents.toArray()).every(h => h.mangaId === FOLLOWED_ID)).toBe(true)
        expect(await db.sourceLinks.get(DETECTED_ID)).toBeUndefined()
        expect(await db.sourceLinks.get(FOLLOWED_ID)).toMatchObject({
            sourceId: PROFILE_ID,
            sourceMangaId: "demo-title"
        })
    })

    it("registers the profile and brings up the followed panel, which replaces the detected one", async () => {
        await trackDetectedVisit()
        await follow()

        expect(sourceRegistry.get(PROFILE_ID)).toBeDefined()
        expect(injectPanelForTabMock).toHaveBeenCalledWith(7, CHAPTER_URL)
        const stored = await db.archProfiles.get(PROFILE_ID)
        expect(stored).toBeDefined()
    })

    it("hands the page to the registered source from then on: no second copy of the title", async () => {
        await trackDetectedVisit()
        await follow()

        const declined = await readerHandlers["work:track-detected"]!(
            { type: "work:track-detected", url: CHAPTER_URL },
            fromTab
        )
        expect(declined).toEqual({ supported: false })

        const tracked = (await readerHandlers["chapter:track"]!(
            { type: "chapter:track", url: "https://reader.example/manga/demo-title/chapter-3" },
            fromTab
        )) as { supported: boolean; mangaId?: string; created?: boolean }
        expect(tracked).toMatchObject({ supported: true, mangaId: FOLLOWED_ID, created: false })
        expect(await db.manga.count()).toBe(1)
        expect((await db.manga.get(FOLLOWED_ID))?.lastReadChapterNumber).toBe(3)
    })

    it("leaves the detected title alone when the follow fails", async () => {
        await trackDetectedVisit()
        permissions.contains.mockResolvedValue(false)
        permissions.request.mockResolvedValue(false)

        const result = await follow()

        expect(result.ok).toBe(false)
        expect(await db.manga.get(DETECTED_ID)).toBeDefined()
        expect(await db.manga.get(FOLLOWED_ID)).toBeUndefined()
        expect(sourceRegistry.get(PROFILE_ID)).toBeUndefined()
        expect(injectPanelForTabMock).not.toHaveBeenCalled()
    })

    it("persists nothing about the site until Track is clicked", async () => {
        await trackDetectedVisit()

        expect(await db.archProfiles.count()).toBe(0)
        expect(sourceRegistry.get(PROFILE_ID)).toBeUndefined()
        expect(permissions.request).not.toHaveBeenCalled()
        expect(probeSourceMock).not.toHaveBeenCalled()
    })

    it("merges into a title the followed source already has instead of overwriting it", async () => {
        await trackDetectedVisit()
        await db.manga.put({
            id: FOLLOWED_ID,
            title: "Demo Title",
            normalizedTitle: "demo title",
            authors: [],
            status: "ongoing",
            addedAt: 1,
            updatedAt: 1,
            sourceId: PROFILE_ID,
            sourceUrl: "https://reader.example/manga/demo-title",
            sourceMangaId: "demo-title",
            lastReadChapterNumber: 9
        })

        expect((await follow()).ok).toBe(true)

        expect(await db.manga.get(DETECTED_ID)).toBeUndefined()
        expect(await db.manga.count()).toBe(1)
        expect((await db.manga.get(FOLLOWED_ID))?.lastReadChapterNumber).toBe(9)
    })
})
