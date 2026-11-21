import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../sources", () => ({
    listChaptersBySource: vi.fn(),
    chaptersForLanguage: <T extends { language?: string }>(chapters: T[], language: string) => {
        const matched = chapters.filter(c => !c.language || c.language === language)
        return matched.length > 0 ? matched : chapters
    }
}))
vi.mock("../settings", () => ({ getSettings: vi.fn(async () => ({ language: "en" })) }))
vi.mock("../background/analytics-flush", () => ({ usageStatsAllowed: vi.fn(async () => true) }))

const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ results: [] }))
vi.stubGlobal("fetch", fetchMock)

const { listChaptersBySource } = await import("../sources")
const { usageStatsAllowed } = await import("../background/analytics-flush")
const { resolveSourcesHandlers } = await import("./resolve-sources")

const ctx = {} as never

describe("catalog:search", () => {
    beforeEach(() => fetchMock.mockClear())

    const searchUrl = async () => {
        await resolveSourcesHandlers["catalog:search"]!({ type: "catalog:search", term: "solo" } as never, ctx)
        return new URL(String(fetchMock.mock.calls[0]![0]))
    }

    it("lets weeb.ltd count the search while usage stats are on", async () => {
        vi.mocked(usageStatsAllowed).mockResolvedValueOnce(true)
        expect((await searchUrl()).searchParams.has("stats")).toBe(false)
    })

    it("sends stats=0 while usage stats are off, or when their state cannot be read", async () => {
        vi.mocked(usageStatsAllowed).mockResolvedValueOnce(false)
        expect((await searchUrl()).searchParams.get("stats")).toBe("0")
        fetchMock.mockClear()
        vi.mocked(usageStatsAllowed).mockRejectedValueOnce(new Error("storage"))
        expect((await searchUrl()).searchParams.get("stats")).toBe("0")
    })
})

describe("catalog:site-chapters", () => {
    beforeEach(() => vi.mocked(listChaptersBySource).mockReset())

    it("summarises a site's chapter list in the reader's language without storing anything", async () => {
        vi.mocked(listChaptersBySource).mockResolvedValue([
            { sortKey: 1, language: "en", publishedAt: 100 },
            { sortKey: 2, language: "en", publishedAt: 200 },
            { sortKey: 3, language: "es", publishedAt: 300 }
        ] as never)

        const summary = await resolveSourcesHandlers["catalog:site-chapters"]!(
            {
                type: "catalog:site-chapters",
                sourceId: "site",
                sourceMangaId: "title",
                url: "https://site.example/manga/title"
            } as never,
            ctx
        )

        expect(listChaptersBySource).toHaveBeenCalledWith("site", "title", "https://site.example/manga/title")
        expect(summary).toEqual({ count: 2, latest: 2, latestAt: 200 })
    })
})
