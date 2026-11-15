import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../sources", () => ({
    listChaptersBySource: vi.fn(),
    chaptersForLanguage: <T extends { language?: string }>(chapters: T[], language: string) => {
        const matched = chapters.filter(c => !c.language || c.language === language)
        return matched.length > 0 ? matched : chapters
    }
}))
vi.mock("../settings", () => ({ getSettings: vi.fn(async () => ({ language: "en" })) }))

const { listChaptersBySource } = await import("../sources")
const { resolveSourcesHandlers } = await import("./resolve-sources")

const ctx = {} as never

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
