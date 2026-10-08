import "fake-indexeddb/auto"
import { parseProfile, type SiteProfile } from "@amr/source-engine"
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

describe("buildTabProbeContext with a separate chapter-list page", () => {
    function listProfile(): SiteProfile {
        const parsed = parseProfile({
            profileFormat: 2,
            id: "reader.example",
            name: "Example Reader",
            engine: "generic",
            origin: "https://reader.example",
            domains: ["reader.example"],
            languages: ["en"],
            capabilities: ["chapters", "manga"],
            requestRateLimit: { requests: 3, intervalMs: 1000 },
            origins: ["https://reader.example/*"],
            match: { manga: "^/manga/([^/]+)/?$" },
            series: { urlTemplate: "/manga/{slug}", titlePattern: "<title>(?<title>[^<]+)</title>" },
            list: {
                urlTemplate: "/manga/{slug}/chapters",
                itemPattern: 'href="(?<chapterUrl>/manga/{slug}/chapter-(?<chapterNumber>[0-9.]+))"'
            }
        })
        if (!parsed.ok) throw new Error(parsed.error)
        return parsed.profile
    }

    it("reads the profile's own list page as well as the series page", async () => {
        const context = buildTabProbeContext(listProfile(), SERIES_URL)
        const listUrl = "https://reader.example/manga/demo-title/chapters"

        await expect(context.request.getText(new URL(listUrl))).resolves.toBe("<html>series</html>")
        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledWith(listUrl, expect.any(Array))
    })

    it("still refuses every other page on the site", async () => {
        const context = buildTabProbeContext(listProfile(), SERIES_URL)

        await expect(
            context.request.getText(new URL("https://reader.example/manga/other-title/chapters"))
        ).rejects.toThrow()
        await expect(context.request.getText(new URL("https://reader.example/account"))).rejects.toThrow()
        expect(fetchChapterHtmlViaTabMock).not.toHaveBeenCalled()
    })
})
