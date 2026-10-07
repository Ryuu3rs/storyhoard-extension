import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
    mangaGet: vi.fn(),
    saveResolvedChapter: vi.fn(),
    saveProgress: vi.fn(),
    updateManga: vi.fn(),
    cacheCover: vi.fn(),
    trackExternalChapter: vi.fn(),
    recordAnalyticsEvent: vi.fn(),
    findSource: vi.fn(),
    resolveChapterUrl: vi.fn(),
    resolveMangaMetadata: vi.fn(),
    isProfileSource: vi.fn(),
    fetchCoverBlob: vi.fn()
}))

vi.mock("../database", () => ({
    db: { manga: { get: mocks.mangaGet } },
    saveResolvedChapter: mocks.saveResolvedChapter,
    saveProgress: mocks.saveProgress,
    updateManga: mocks.updateManga,
    cacheCover: mocks.cacheCover,
    trackExternalChapter: mocks.trackExternalChapter,
    recordAnalyticsEvent: mocks.recordAnalyticsEvent
}))
vi.mock("../sources", () => ({
    findSource: mocks.findSource,
    resolveChapterUrl: mocks.resolveChapterUrl,
    resolveMangaMetadata: mocks.resolveMangaMetadata
}))
vi.mock("../arch-sources", () => ({ isProfileSource: mocks.isProfileSource }))
vi.mock("../settings", () => ({ getSettings: async () => ({ autoAdd: true, markReadOnVisit: true }) }))
vi.mock("./chapter-cache", () => ({ scheduleChapterListRefresh: vi.fn() }))
vi.mock("./covers", () => ({ fetchCoverBlob: mocks.fetchCoverBlob }))
vi.mock("../live", () => ({ publishLive: vi.fn() }))

const { captureChapter } = await import("./capture")

const CHAPTER_URL = "https://reader.example/manga/demo-title/chapter-2"
const SOURCE_ID = "reader.example"
const MANGA_ID = `${SOURCE_ID}:manga:demo-title`

function resolvedChapter() {
    return {
        manga: {
            sourceId: SOURCE_ID,
            sourceMangaId: "demo-title",
            url: "https://reader.example/manga/demo-title",
            manga: { id: MANGA_ID, title: "demo title", normalizedTitle: "demo title" }
        },
        chapter: { id: `${SOURCE_ID}:chapter:demo-title:2`, sourceId: SOURCE_ID, url: CHAPTER_URL, sortKey: 2 },
        pages: []
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal("browser", {
        action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
        alarms: { create: vi.fn() }
    })
    mocks.findSource.mockReturnValue({ manifest: { id: SOURCE_ID }, match: () => "chapter" })
    mocks.resolveChapterUrl.mockResolvedValue(resolvedChapter())
    mocks.isProfileSource.mockReturnValue(true)
    mocks.mangaGet.mockResolvedValue(undefined)
    mocks.resolveMangaMetadata.mockResolvedValue({ title: "Demo Title", coverUrl: "https://reader.example/cover.jpg" })
    mocks.fetchCoverBlob.mockResolvedValue(undefined)
})

describe("capturing a chapter on a profile (added) source", () => {
    it("fills the real title and cover from the series page for a newly created row", async () => {
        await captureChapter(CHAPTER_URL)

        await vi.waitFor(() => expect(mocks.updateManga).toHaveBeenCalled())
        expect(mocks.resolveMangaMetadata).toHaveBeenCalledWith({
            sourceId: SOURCE_ID,
            sourceMangaId: "demo-title",
            mangaUrl: "https://reader.example/manga/demo-title"
        })
        expect(mocks.updateManga).toHaveBeenCalledWith(
            MANGA_ID,
            expect.objectContaining({ title: "Demo Title", coverUrl: "https://reader.example/cover.jpg" })
        )
    })

    it("never fetches series metadata for a bundled source", async () => {
        mocks.isProfileSource.mockReturnValue(false)

        await captureChapter(CHAPTER_URL)

        expect(mocks.resolveMangaMetadata).not.toHaveBeenCalled()
        expect(mocks.mangaGet).not.toHaveBeenCalled()
    })

    it("keeps a real stored title and cover on a re-capture instead of overwriting them with the slug", async () => {
        mocks.mangaGet.mockResolvedValue({
            id: MANGA_ID,
            title: "Demo Title Reborn",
            normalizedTitle: "demo title reborn",
            coverUrl: "https://reader.example/cover.jpg"
        })

        await captureChapter(CHAPTER_URL)

        const saved = mocks.saveResolvedChapter.mock.calls[0]![0] as {
            manga: { title: string; coverUrl?: string }
        }
        expect(saved.manga.title).toBe("Demo Title Reborn")
        expect(saved.manga.coverUrl).toBe("https://reader.example/cover.jpg")
        expect(mocks.resolveMangaMetadata).not.toHaveBeenCalled()
    })

    it("retries the metadata fill on a re-capture while the stored title is still the slug placeholder", async () => {
        mocks.resolveMangaMetadata.mockResolvedValue({ title: "The Demo Title" })
        mocks.mangaGet.mockResolvedValue({ id: MANGA_ID, title: "demo title", normalizedTitle: "demo title" })

        await captureChapter(CHAPTER_URL)

        await vi.waitFor(() => expect(mocks.updateManga).toHaveBeenCalled())
        expect(mocks.updateManga).toHaveBeenCalledWith(MANGA_ID, expect.objectContaining({ title: "The Demo Title" }))
    })
})
