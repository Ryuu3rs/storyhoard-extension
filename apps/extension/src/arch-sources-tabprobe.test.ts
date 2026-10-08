import "fake-indexeddb/auto"
import type { SiteProfile } from "@amr/source-engine"
import { beforeEach, describe, expect, it, vi } from "vitest"

const fetchChapterHtmlViaTabMock = vi.fn()
vi.mock("./background/tab-fetch", () => ({
    fetchChapterHtmlViaTab: (...args: unknown[]) => fetchChapterHtmlViaTabMock(...args)
}))
vi.mock("./background/chapter-cache", () => ({ scheduleChapterListRefresh: vi.fn() }))
vi.mock("./settings", () => ({ getSettings: async () => ({ language: "en" }) }))

const { buildTabProbeContext } = await import("./arch-sources")

const SERIES_URL = "https://reader.example/manga/demo-title"

const profile = {
    origin: "https://reader.example",
    origins: ["https://reader.example/*", "https://www.reader.example/*"]
} as unknown as SiteProfile

beforeEach(() => {
    fetchChapterHtmlViaTabMock.mockReset()
    fetchChapterHtmlViaTabMock.mockResolvedValue("<html>series</html>")
})

describe("buildTabProbeContext", () => {
    it("reads the series page through a tab", async () => {
        const context = buildTabProbeContext(profile, SERIES_URL)

        await expect(context.request.getText(new URL(SERIES_URL))).resolves.toBe("<html>series</html>")
        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledWith(SERIES_URL, profile.origins)
    })

    it("reuses the page for a second read of the same series url", async () => {
        const context = buildTabProbeContext(profile, SERIES_URL)

        await context.request.getText(new URL(SERIES_URL))
        await context.request.getText(new URL(SERIES_URL))

        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledTimes(1)
    })

    it("never opens a tab for any other page on the site", async () => {
        const context = buildTabProbeContext(profile, SERIES_URL)

        await expect(context.request.getText(new URL("https://reader.example/manga/other-title"))).rejects.toThrow()
        expect(fetchChapterHtmlViaTabMock).not.toHaveBeenCalled()
    })

    it("never opens a tab outside the profile's own origins", async () => {
        const context = buildTabProbeContext(profile, SERIES_URL)

        await expect(context.request.getText(new URL("https://evil.example/manga/demo-title"))).rejects.toThrow()
        await expect(context.request.getText(new URL("https://127.0.0.1/manga/demo-title"))).rejects.toThrow()
        expect(fetchChapterHtmlViaTabMock).not.toHaveBeenCalled()
    })

    it("never POSTs through a tab", async () => {
        const context = buildTabProbeContext(profile, SERIES_URL)

        await expect(context.request.postForm(new URL(SERIES_URL), { a: "b" })).rejects.toThrow()
        expect(fetchChapterHtmlViaTabMock).not.toHaveBeenCalled()
    })

    it("fails when the tab returns no page", async () => {
        fetchChapterHtmlViaTabMock.mockResolvedValue("")
        const context = buildTabProbeContext(profile, SERIES_URL)

        await expect(context.request.getText(new URL(SERIES_URL))).rejects.toThrow()
    })
})
