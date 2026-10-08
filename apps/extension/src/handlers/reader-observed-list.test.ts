import "fake-indexeddb/auto"
import { draftProfileFromChapterPage, parseProfile, type SiteProfile } from "@amr/source-engine"
import { sourceRegistry } from "@amr/sources"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { HandlerContext } from "../background/handler-types"
import type { LibraryManga } from "../database"

const publishLiveMock = vi.fn()
vi.mock("../live", () => ({ publishLive: (...args: unknown[]) => publishLiveMock(...args) }))

const notifyNewChaptersMock = vi.fn()
vi.mock("../notifications", () => ({
    notifyNewChapters: (...args: unknown[]) => notifyNewChaptersMock(...args)
}))

vi.mock("../settings", () => ({ getSettings: async () => ({ language: "en" }) }))
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

const { db } = await import("../database")
const { readerHandlers } = await import("./reader")
const { registerProfile, chapterListForUrl } = await import("../arch-sources")
const { MAX_OBSERVED_ITEMS } = await import("../observed-chapter-list")

const ctx: HandlerContext = { sender: {} as HandlerContext["sender"] }

const URL_ORIGIN = "https://reader.example"
const URL_PAGE = `${URL_ORIGIN}/manga/demo-title/chapter-4`
const URL_MANGA_ID = "reader.example:manga:demo-title"

const TEXT_ORIGIN = "https://mangafire.example"
const TEXT_PAGE = `${TEXT_ORIGIN}/title/demo-title.abc/chapter/9475194`
const TEXT_MANGA_ID = "mangafire.example:manga:demo-title.abc"

function drafted(signals: Parameters<typeof draftProfileFromChapterPage>[0]): SiteProfile {
    const parsed = parseProfile(draftProfileFromChapterPage(signals)?.profile)
    if (!parsed.ok) throw new Error("fixture profile must parse")
    return parsed.profile
}

function urlNumberedProfile(): SiteProfile {
    return drafted({
        url: URL_PAGE,
        ogTitle: "Demo Title Chapter 4 | Example Reader",
        ogSiteName: "Example Reader",
        links: [
            { href: "/manga/demo-title/chapter-3", text: "Prev" },
            { href: "/manga/demo-title/chapter-5", text: "Next" }
        ],
        images: []
    })
}

function textNumberedProfile(): SiteProfile {
    return drafted({
        url: TEXT_PAGE,
        ogSiteName: "MangaFire Example",
        docTitle: "Demo Title - Chapter 4 - MangaFire Example",
        links: [
            { href: "/title/demo-title.abc/chapter/9475192", text: "Ch. 2" },
            { href: "/title/demo-title.abc/chapter/9475193", text: "Ch. 3" },
            { href: "/title/demo-title.abc/chapter/9475194", text: "Ch. 4" }
        ],
        images: []
    })
}

function trackedManga(id: string, sourceId: string, sourceMangaId: string, extra: Partial<LibraryManga> = {}) {
    const manga: LibraryManga = {
        id,
        title: "Demo Title",
        normalizedTitle: "demo title",
        authors: [],
        status: "ongoing",
        addedAt: 1,
        updatedAt: 1,
        sourceId,
        sourceUrl: `https://${sourceId}/x`,
        sourceMangaId,
        mangaUrl: `https://${sourceId}/manga/${sourceMangaId}`,
        ...extra
    }
    return manga
}

const link = (n: number, text = `Chapter ${n}`) => ({ url: `${URL_ORIGIN}/manga/demo-title/chapter-${n}`, text })

async function record(page: string, items: Array<{ url: string; text: string }>, mangaId?: string) {
    return (await readerHandlers["work:record-chapter-list"]!(
        { type: "work:record-chapter-list", url: page, items, ...(mangaId ? { mangaId } : {}) },
        ctx
    )) as { recorded: number; advanced: boolean }
}

beforeEach(async () => {
    vi.clearAllMocks()
    sourceRegistry.unregister("reader.example")
    sourceRegistry.unregister("mangafire.example")
    await Promise.all([
        db.manga.clear(),
        db.chapters.clear(),
        db.progress.clear(),
        db.historyEvents.clear(),
        db.sourceLinks.clear()
    ])
    expect(registerProfile(urlNumberedProfile())).toBe(true)
    expect(registerProfile(textNumberedProfile())).toBe(true)
})

describe("work:record-chapter-list", () => {
    it("drops foreign-origin, other-series and non-chapter links, and keeps the title's own chapters", async () => {
        await db.manga.put(trackedManga(URL_MANGA_ID, "reader.example", "demo-title", { latestChapterNumber: 3 }))

        const result = await record(URL_PAGE, [
            link(5),
            link(4),
            link(3),
            { url: "https://evil.example/manga/demo-title/chapter-9", text: "Chapter 9" },
            { url: `${URL_ORIGIN}/manga/other-title/chapter-8`, text: "Chapter 8" },
            { url: `${URL_ORIGIN}/about`, text: "Chapter 7" },
            { url: "javascript:alert(1)", text: "Chapter 6" },
            { url: "not a url", text: "Chapter 2" }
        ])

        const stored = await db.chapters.where("mangaId").equals(URL_MANGA_ID).toArray()
        expect(stored.map(c => c.sortKey).sort((a, b) => a - b)).toEqual([3, 4, 5])
        expect(stored.every(c => c.url.startsWith(`${URL_ORIGIN}/manga/demo-title/`))).toBe(true)
        expect(result).toEqual({ recorded: 3, advanced: true })
    })

    it("fills the chapter dropdown of a source whose list could never be fetched", async () => {
        await db.manga.put(trackedManga(URL_MANGA_ID, "reader.example", "demo-title"))
        await record(URL_PAGE, [link(5), link(4), link(3), link(2), link(1)])

        const dropdown = await chapterListForUrl(`${URL_ORIGIN}/manga/demo-title/chapter-4`)

        expect(dropdown.map(entry => entry.sortKey)).toEqual([1, 2, 3, 4, 5])
    })

    it("advances the latest chapter and notifies when a title with an earlier latest gains a chapter", async () => {
        await db.manga.put(trackedManga(URL_MANGA_ID, "reader.example", "demo-title", { latestChapterNumber: 3 }))

        const result = await record(URL_PAGE, [link(5), link(4), link(3)])

        expect(result.advanced).toBe(true)
        const updated = await db.manga.get(URL_MANGA_ID)
        expect(updated?.latestChapterNumber).toBe(5)
        expect(updated?.latestChapterId).toBe("reader.example:chapter:demo-title:5")
        expect(updated?.latestChapterAt).toBeDefined()
        expect(notifyNewChaptersMock).toHaveBeenCalledWith(["Demo Title"])
        expect(publishLiveMock).toHaveBeenCalledWith(["chapters", "library"], [URL_MANGA_ID])
    })

    it("takes the first list as a baseline without announcing it as new chapters", async () => {
        await db.manga.put(trackedManga(URL_MANGA_ID, "reader.example", "demo-title"))

        const result = await record(URL_PAGE, [link(5), link(4), link(3)])

        expect(result.advanced).toBe(true)
        expect((await db.manga.get(URL_MANGA_ID))?.latestChapterNumber).toBe(5)
        expect(notifyNewChaptersMock).not.toHaveBeenCalled()
    })

    it("never lowers the latest chapter from a partial list, and stays quiet when nothing changed", async () => {
        await db.manga.put(trackedManga(URL_MANGA_ID, "reader.example", "demo-title", { latestChapterNumber: 9 }))
        await record(URL_PAGE, [link(5), link(4)])
        expect((await db.manga.get(URL_MANGA_ID))?.latestChapterNumber).toBe(9)

        publishLiveMock.mockClear()
        const again = await record(URL_PAGE, [link(5), link(4)])
        expect(again).toEqual({ recorded: 0, advanced: false })
        expect(publishLiveMock).not.toHaveBeenCalled()
        expect(notifyNewChaptersMock).not.toHaveBeenCalled()
    })

    it("does not create a title, or store anything, for an untracked series", async () => {
        const result = await record(URL_PAGE, [link(5), link(4)])

        expect(result).toEqual({ recorded: 0, advanced: false })
        expect(await db.chapters.count()).toBe(0)
        expect(await db.manga.count()).toBe(0)
    })

    it("ignores a page that belongs to a bundled source", async () => {
        const result = await record("https://mangadex.org/chapter/3f1a5c8e-7b2d-4c1a-9e3f-0a1b2c3d4e5f", [
            { url: "https://mangadex.org/chapter/aaaa", text: "Chapter 1" }
        ])
        expect(result).toEqual({ recorded: 0, advanced: false })
        expect(await db.chapters.count()).toBe(0)
    })

    it("will not write onto a title of another source, whatever mangaId it is handed", async () => {
        await db.manga.put(trackedManga("mangadex:manga:abc", "mangadex", "abc"))

        const result = await record(URL_PAGE, [link(5)], "mangadex:manga:abc")

        expect(result).toEqual({ recorded: 0, advanced: false })
        expect(await db.chapters.where("mangaId").equals("mangadex:manga:abc").count()).toBe(0)
    })

    it("reads each chapter number from the link text for a site whose URL holds only an id", async () => {
        await db.manga.put(trackedManga(TEXT_MANGA_ID, "mangafire.example", "demo-title.abc"))

        const result = await record(TEXT_PAGE, [
            { url: `${TEXT_ORIGIN}/title/demo-title.abc/chapter/9475196`, text: "Ch. 86" },
            { url: `${TEXT_ORIGIN}/title/demo-title.abc/chapter/9475195`, text: "Chapter 85: The Gate" },
            { url: `${TEXT_ORIGIN}/title/demo-title.abc/chapter/9475001`, text: "Read first" },
            { url: `${TEXT_ORIGIN}/title/other.xyz/chapter/9400099`, text: "Ch. 3" }
        ])

        expect(result.recorded).toBe(2)
        const stored = await db.chapters.where("mangaId").equals(TEXT_MANGA_ID).toArray()
        expect(stored.map(c => c.sortKey).sort((a, b) => a - b)).toEqual([85, 86])
    })

    it("bounds a hostile list to the item cap", async () => {
        await db.manga.put(trackedManga(URL_MANGA_ID, "reader.example", "demo-title"))
        const items = Array.from({ length: MAX_OBSERVED_ITEMS + 500 }, (_, i) => link(i + 1))

        const result = await record(URL_PAGE, items)

        expect(result.recorded).toBe(MAX_OBSERVED_ITEMS)
        expect(await db.chapters.count()).toBe(MAX_OBSERVED_ITEMS)
    })

    it("drops an unreasonable chapter number", async () => {
        await db.manga.put(trackedManga(URL_MANGA_ID, "reader.example", "demo-title"))

        await record(URL_PAGE, [
            link(5),
            { url: `${URL_ORIGIN}/manga/demo-title/chapter-999999`, text: "Chapter 999999" }
        ])

        const stored = await db.chapters.where("mangaId").equals(URL_MANGA_ID).toArray()
        expect(stored.map(c => c.sortKey)).toEqual([5])
    })
})

describe("chapter:track with the label the page shows", () => {
    const track = (url: string, label?: string) =>
        readerHandlers["chapter:track"]!({ type: "chapter:track", url, ...(label ? { label } : {}) }, ctx) as Promise<{
            supported: boolean
            chapterNumber?: number | null
            mangaId?: string
        }>

    it("records the number read from the label for a text-numbered source", async () => {
        const result = await track(TEXT_PAGE, "Ch. 86")

        expect(result).toMatchObject({ supported: true, chapterNumber: 86, mangaId: TEXT_MANGA_ID })
        const rows = await db.chapters.where("mangaId").equals(TEXT_MANGA_ID).toArray()
        expect(rows.map(c => c.sortKey)).toEqual([86])
        expect((await db.manga.get(TEXT_MANGA_ID))?.lastReadChapterNumber).toBe(86)
    })

    it("leaves a text-numbered chapter unnumbered, never id-numbered, when the page gives no label", async () => {
        const result = await track(TEXT_PAGE)
        expect(result.chapterNumber).toBeNull()
    })

    it("does not let a label override the number a url-numbered source already carries", async () => {
        const result = await track(URL_PAGE, "Chapter 99")
        expect(result).toMatchObject({ supported: true, chapterNumber: 4 })
    })
})

describe("an on-visit source", () => {
    it("fills its dropdown from the observed list but is never refreshed in the background", async () => {
        sourceRegistry.unregister("reader.example")
        expect(registerProfile({ ...urlNumberedProfile(), listSource: "on-visit" })).toBe(true)
        await db.manga.put(trackedManga(URL_MANGA_ID, "reader.example", "demo-title"))
        await record(URL_PAGE, [link(5), link(4), link(3)])

        const dropdown = await chapterListForUrl(URL_PAGE)

        expect(dropdown.map(entry => entry.sortKey)).toEqual([3, 4, 5])
        expect(scheduleMock).not.toHaveBeenCalled()
    })

    it("whereas a fetch-listed profile source still schedules its background refresh", async () => {
        await db.manga.put(trackedManga(URL_MANGA_ID, "reader.example", "demo-title"))
        await record(URL_PAGE, [link(5), link(4), link(3)])

        await chapterListForUrl(URL_PAGE)

        expect(scheduleMock).toHaveBeenCalledTimes(1)
    })
})
