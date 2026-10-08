import "fake-indexeddb/auto"
import type { SourceAdapter, SourceChapter } from "@amr/source-sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LibraryManga } from "../database"

const fetchChapterHtmlViaTabMock = vi.fn()
vi.mock("./tab-fetch", () => ({
    fetchChapterHtmlViaTab: (...args: unknown[]) => fetchChapterHtmlViaTabMock(...args)
}))
vi.mock("../live", () => ({ publishLive: vi.fn() }))

const listChaptersFromSourceHtmlMock = vi.fn()
const tabOriginsMock = vi.fn<(sourceId: string) => string[] | undefined>(() => undefined)
vi.mock("../sources", () => ({
    findSource: vi.fn(),
    listChaptersBySource: vi.fn(),
    listChaptersFromSourceHtml: (...args: unknown[]) => listChaptersFromSourceHtmlMock(...args),
    tabOriginsForSource: (sourceId: string) => tabOriginsMock(sourceId)
}))

type CacheModule = typeof import("./chapter-cache")
let cache: CacheModule

const storage = new Map<string, unknown>()
const SOURCE_ID = "reader.example"
const MANGA_URL = "https://reader.example/manga/demo-title"

const source = {
    manifest: { id: SOURCE_ID },
    chapterListViaMangaPageTab: true,
    chapterListRenderUrl: (_id: string, mangaUrl: string) => `${mangaUrl}/chapters`
} as unknown as SourceAdapter

function manga(slug: string): LibraryManga {
    return {
        id: `${SOURCE_ID}:manga:${slug}`,
        title: slug,
        normalizedTitle: slug,
        authors: [],
        status: "ongoing",
        addedAt: 1,
        updatedAt: 1,
        sourceId: SOURCE_ID,
        sourceUrl: `https://reader.example/manga/${slug}`
    }
}

function chapter(n: number): SourceChapter {
    return {
        id: `${SOURCE_ID}:chapter:demo-title:${n}`,
        mangaId: `${SOURCE_ID}:manga:demo-title`,
        sourceId: SOURCE_ID,
        sourceChapterId: String(n),
        title: `Ch.${n}`,
        url: `https://reader.example/manga/demo-title/chapter-${n}`,
        sortKey: n,
        language: "en"
    }
}

let now = 1_000_000_000_000

beforeEach(async () => {
    storage.clear()
    now = 1_000_000_000_000
    vi.spyOn(Date, "now").mockImplementation(() => now)
    vi.stubGlobal("browser", {
        storage: {
            local: {
                get: async (key: string) => (storage.has(key) ? { [key]: storage.get(key) } : {}),
                set: async (items: Record<string, unknown>) => {
                    for (const [k, v] of Object.entries(items)) storage.set(k, v)
                }
            }
        }
    })
    fetchChapterHtmlViaTabMock.mockReset()
    fetchChapterHtmlViaTabMock.mockResolvedValue("<html>rendered</html>")
    listChaptersFromSourceHtmlMock.mockReset()
    listChaptersFromSourceHtmlMock.mockResolvedValue([chapter(1), chapter(2)])
    tabOriginsMock.mockReset()
    tabOriginsMock.mockReturnValue(["https://reader.example/*"])
    vi.resetModules()
    cache = await import("./chapter-cache")
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe("listChaptersViaRenderedTab", () => {
    it("renders the source's list page in a tab held to its own origins and parses the rendered html", async () => {
        const chapters = await cache.listChaptersViaRenderedTab(manga("demo-title"), source, "demo-title", MANGA_URL)

        expect(chapters).toHaveLength(2)
        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledWith(`${MANGA_URL}/chapters`, ["https://reader.example/*"])
        expect(listChaptersFromSourceHtmlMock).toHaveBeenCalledWith(
            expect.objectContaining({ id: `${SOURCE_ID}:manga:demo-title` }),
            SOURCE_ID,
            "demo-title",
            MANGA_URL,
            "<html>rendered</html>"
        )
    })

    it("does not render the same title again inside the cooldown, and does once it has elapsed", async () => {
        await cache.listChaptersViaRenderedTab(manga("demo-title"), source, "demo-title", MANGA_URL)
        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledTimes(1)

        now += cache.TAB_LIST_COOLDOWN_MS - 1
        expect(await cache.listChaptersViaRenderedTab(manga("demo-title"), source, "demo-title", MANGA_URL)).toBe(
            undefined
        )
        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledTimes(1)

        now += 2
        await cache.listChaptersViaRenderedTab(manga("demo-title"), source, "demo-title", MANGA_URL)
        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledTimes(2)
    })

    it("gates each title on its own", async () => {
        await cache.listChaptersViaRenderedTab(manga("one"), source, "one", MANGA_URL)
        await cache.listChaptersViaRenderedTab(manga("two"), source, "two", MANGA_URL)
        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledTimes(2)
    })

    it("keeps the cooldown across a service-worker restart", async () => {
        await cache.listChaptersViaRenderedTab(manga("demo-title"), source, "demo-title", MANGA_URL)

        vi.resetModules()
        cache = await import("./chapter-cache")

        expect(await cache.listChaptersViaRenderedTab(manga("demo-title"), source, "demo-title", MANGA_URL)).toBe(
            undefined
        )
        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledTimes(1)
    })

    it("retries sooner, but not at once, after a render that listed nothing", async () => {
        fetchChapterHtmlViaTabMock.mockRejectedValue(new Error("Tab load timed out"))
        const failed = await cache.listChaptersViaRenderedTab(manga("demo-title"), source, "demo-title", MANGA_URL)
        expect(failed).toEqual([])

        now += cache.TAB_LIST_RETRY_MS - 1
        expect(await cache.listChaptersViaRenderedTab(manga("demo-title"), source, "demo-title", MANGA_URL)).toBe(
            undefined
        )

        now += 2
        fetchChapterHtmlViaTabMock.mockResolvedValue("<html>rendered</html>")
        const retried = await cache.listChaptersViaRenderedTab(manga("demo-title"), source, "demo-title", MANGA_URL)
        expect(retried).toHaveLength(2)
    })

    it("never has more than the cap of tab renders open at once", async () => {
        let open = 0
        let peak = 0
        const releases: Array<() => void> = []
        fetchChapterHtmlViaTabMock.mockImplementation(async () => {
            open++
            peak = Math.max(peak, open)
            await new Promise<void>(resolve => releases.push(resolve))
            open--
            return "<html>rendered</html>"
        })

        const runs = ["a", "b", "c", "d", "e"].map(slug =>
            cache.listChaptersViaRenderedTab(manga(slug), source, slug, MANGA_URL)
        )
        for (let i = 0; i < 20 && releases.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
        expect(peak).toBe(cache.MAX_CONCURRENT_TAB_RENDERS)

        for (let drained = 0; drained < 5; drained++) {
            for (let i = 0; i < 50 && releases.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
            releases.shift()?.()
        }
        await Promise.all(runs)
        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledTimes(5)
        expect(peak).toBe(cache.MAX_CONCURRENT_TAB_RENDERS)
    })
})
