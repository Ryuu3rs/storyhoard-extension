import "fake-indexeddb/auto"
import { parseProfile, type SiteProfile } from "@amr/source-engine"
import { sourceRegistry } from "@amr/sources"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../official-sources", () => ({ getCachedOfficialSites: async () => [] }))
vi.mock("../settings", () => ({ getSettings: async () => ({ language: "en" }) }))
vi.mock("./chapter-cache", () => ({ scheduleChapterListRefresh: vi.fn() }))

const executeScript = vi.fn()
vi.stubGlobal("browser", { scripting: { executeScript } })

const { injectPanelForTab } = await import("./panel-injection")
const { registerProfile } = await import("../arch-sources")

const PAGE = "https://reader.example/manga/demo-title/chapter-2"

function profile(renderedSelectors?: { container?: string; item?: string }): SiteProfile {
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
        match: { manga: "^/manga/([^/]+)/?$", chapter: "^/manga/([^/]+)/chapter-([0-9.]+)/?$" },
        series: { titlePattern: "<title>(?<title>[^<]+)</title>" },
        list: {
            itemPattern: 'href="(?<chapterUrl>/manga/{slug}/chapter-(?<chapterNumber>[0-9.]+))"',
            ...(renderedSelectors ? { renderedSelectors } : {})
        }
    })
    if (!parsed.ok) throw new Error(parsed.error)
    return parsed.profile
}

beforeEach(() => {
    executeScript.mockReset()
    executeScript.mockResolvedValue([])
    sourceRegistry.unregister("reader.example")
})

describe("injectPanelForTab rendered-list selectors", () => {
    it("hands a profile source's declared selectors to the panel", async () => {
        registerProfile(profile({ container: "ul.chapters", item: "li > a" }))

        expect(await injectPanelForTab(7, PAGE)).toBe(true)

        const panelCall = executeScript.mock.calls[0]![0] as { args: unknown[] }
        expect(panelCall.args[3]).toEqual({ container: "ul.chapters", item: "li > a" })
    })

    it("turns the list read on, with no selectors, for a profile source that declares none", async () => {
        registerProfile(profile())

        await injectPanelForTab(7, PAGE)

        expect((executeScript.mock.calls[0]![0] as { args: unknown[] }).args[3]).toEqual({})
    })

    it("turns the list read off for a bundled source", async () => {
        await injectPanelForTab(7, "https://mangadex.org/chapter/3f1a5c8e-7b2d-4c1a-9e3f-0a1b2c3d4e5f")

        expect((executeScript.mock.calls[0]![0] as { args: unknown[] }).args[3]).toBeNull()
    })
})
