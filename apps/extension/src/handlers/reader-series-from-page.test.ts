import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createAdapterFromProfile, parseProfile } from "@amr/source-engine"
import type { LibraryManga } from "../database"

// A site whose chapter address is a bare id ("/chapters/<id>"): only the chapter page names the series,
// by linking back to it. The host is made up.
const HOST = "https://idonly.example"
const SOURCE_ID = "idonly"
const SERIES_ID = "01HZX4N8Q2W6E9R3T7Y5U1I0PA"
const CHAPTER_ID = "01HZX4N8Q2W6E9R3T7Y5U1I0PC"
const chapterUrl = `${HOST}/chapters/${CHAPTER_ID}`

const parsed = parseProfile({
    profileFormat: 2,
    id: SOURCE_ID,
    name: "Id Only",
    engine: "generic",
    numberingKind: "chapter",
    origin: HOST,
    domains: ["idonly.example"],
    languages: ["en"],
    capabilities: ["manga"],
    requestRateLimit: { requests: 3, intervalMs: 1000 },
    origins: [`${HOST}/*`],
    match: {
        manga: "^/series/([0-9A-Z]{26})(?:/[^/]*)?/?$",
        chapter: "^/chapters/[0-9A-Z]{26}(?:/.*)?$"
    },
    series: { urlTemplate: "/series/{slug}", titlePattern: '<meta property="og:title" content="(?<title>[^"]+)"' }
})
if (!parsed.ok) throw new Error("test profile rejected")
const adapter = createAdapterFromProfile(parsed.profile)

const chapterPage = `<html><head><meta property="og:title" content="Chapter 42 | Demo Title" /></head>
<body><a href="/series/${SERIES_ID}/Demo-Title">Demo Title</a></body></html>`

const settings = vi.hoisted(() => ({ language: "en", autoAdd: false, markReadOnVisit: true }))

vi.mock("../sources", () => ({
    findSource: (url: URL) => (adapter.match(url) === "none" ? undefined : adapter),
    getSourceById: vi.fn(),
    resolveChapterUrl: async (url: string) =>
        adapter.resolveChapter(
            { url: new URL(url) },
            {
                request: { getText: async () => chapterPage } as never,
                now: () => Date.now(),
                logger: { debug: () => undefined, warn: () => undefined }
            }
        ),
    resolveChapterFromHtml: vi.fn(),
    listChaptersBySource: vi.fn(),
    resolveMangaMetadata: vi.fn(),
    chaptersForLanguage: <T>(chapters: T[]) => chapters,
    tabOriginsForSource: () => undefined
}))
vi.mock("../settings", () => ({ getSettings: async () => settings }))
vi.mock("../live", () => ({ publishLive: vi.fn() }))
vi.stubGlobal("browser", {
    runtime: { getURL: () => "chrome-extension://ext/" },
    action: { setBadgeBackgroundColor: vi.fn(), setBadgeText: vi.fn() }
})

const { db } = await import("../database")
const { readerHandlers } = await import("./reader")
const { captureChapter } = await import("../background/capture")
vi.spyOn(await import("../background/chapter-cache"), "scheduleChapterListRefresh").mockImplementation(() => {})

const mangaId = `${SOURCE_ID}:manga:${SERIES_ID}`
const tracked: LibraryManga = {
    id: mangaId,
    title: "Demo Title",
    normalizedTitle: "demo title",
    authors: [],
    status: "ongoing",
    addedAt: 1,
    updatedAt: 1,
    sourceId: SOURCE_ID,
    sourceMangaId: SERIES_ID,
    mangaUrl: `${HOST}/series/${SERIES_ID}`,
    sourceUrl: `${HOST}/series/${SERIES_ID}`,
    latestChapterNumber: 41,
    lastReadChapterNumber: 41
}

const pageCtx = { sender: { url: chapterUrl, tab: { id: 1, url: chapterUrl }, origin: HOST } } as never

beforeEach(async () => {
    settings.autoAdd = false
    await db.delete()
    await db.open()
    await db.manga.put(tracked)
})

describe("Mark read on a chapter whose address names no series", () => {
    it("records the chapter on the tracked title the page links back to", async () => {
        const result = await readerHandlers["chapter:track"]!({ type: "chapter:track", url: chapterUrl }, pageCtx)

        expect(result).toMatchObject({ supported: true, tracked: true, mangaId })
        expect(await db.manga.count()).toBe(1)
        expect((await db.manga.get(mangaId))?.lastReadChapterNumber).toBe(42)
    })

    it("then gives the panel that title for the chapter", async () => {
        await readerHandlers["chapter:track"]!({ type: "chapter:track", url: chapterUrl }, pageCtx)

        const siblings = await readerHandlers["chapter:siblings"]!(
            { type: "chapter:siblings", url: chapterUrl },
            pageCtx
        )
        expect(siblings).toMatchObject({ mangaId, mangaTitle: "Demo Title" })
    })
})

describe("Opening a chapter whose address names no series, with auto-add off", () => {
    it("moves the tracked title's read position, without adding a title", async () => {
        await captureChapter(chapterUrl)

        expect(await db.manga.count()).toBe(1)
        expect((await db.manga.get(mangaId))?.lastReadChapterNumber).toBe(42)
    })
})
