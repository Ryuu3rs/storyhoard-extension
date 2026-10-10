import "fake-indexeddb/auto"
import { parseProfile, type SiteProfile } from "@amr/source-engine"
import { sourceRegistry } from "@amr/sources"
import { beforeEach, describe, expect, it, vi } from "vitest"

const officialSites = vi.hoisted(() => ({ list: [] as Array<{ domain: string; name: string; verified: boolean }> }))
vi.mock("../official-sources", async importOriginal => ({
    ...(await importOriginal<typeof import("../official-sources")>()),
    getCachedOfficialSites: async () => officialSites.list
}))
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
    officialSites.list = []
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

describe("injectPanelForTab panel mode", () => {
    const modeOf = () => (executeScript.mock.calls[0]![0] as { args: unknown[] }).args[4]

    it("a registered source on an ordinary site is followed", async () => {
        registerProfile(profile())
        await injectPanelForTab(7, PAGE)
        expect(modeOf()).toBe("followed")
    })

    it("a bundled source that is not an official partner is followed too", async () => {
        await injectPanelForTab(7, "https://mangadex.org/chapter/3f1a5c8e-7b2d-4c1a-9e3f-0a1b2c3d4e5f")
        expect(modeOf()).toBe("followed")
    })

    it("a site on the official partner list is official, keyed off the real host", async () => {
        officialSites.list = [{ domain: "reader.example", name: "Example Reader", verified: true }]
        registerProfile(profile())
        await injectPanelForTab(7, PAGE)
        expect(modeOf()).toBe("official")
    })
})

describe("injectPanelForTab detected mode", () => {
    const DETECTED_PAGE = "https://unfollowed.example/manga/demo-title/chapter-2"

    it("puts the observe-only panel on a reader page with no registered source", async () => {
        expect(await injectPanelForTab(7, DETECTED_PAGE, "detected")).toBe(true)

        const call = executeScript.mock.calls[0]![0] as { func: unknown; args: unknown[]; world?: string }
        expect(call.args[0]).toBe(DETECTED_PAGE)
        expect(call.args[3]).toEqual({})
        expect(call.args[4]).toBe("detected")
        expect(call.world).toBeUndefined()
    })

    it("injects the panel only: none of the main-world helpers a followed site gets", async () => {
        await injectPanelForTab(7, DETECTED_PAGE, "detected")

        expect(executeScript).toHaveBeenCalledTimes(1)
        expect(executeScript.mock.calls.some(([arg]) => (arg as { world?: string }).world === "MAIN")).toBe(false)
    })

    it("leaves a registered source to its followed panel", async () => {
        registerProfile(profile())
        expect(await injectPanelForTab(7, PAGE, "detected")).toBe(false)
        expect(executeScript).not.toHaveBeenCalled()
    })

    it("leaves an official partner to its overlay-only panel", async () => {
        officialSites.list = [{ domain: "unfollowed.example", name: "Partner", verified: true }]
        expect(await injectPanelForTab(7, DETECTED_PAGE, "detected")).toBe(false)
        expect(executeScript).not.toHaveBeenCalled()
    })

    it.each([
        "https://unfollowed.example/about",
        "https://en.wikipedia.org/manga/demo-title/chapter-2",
        "https://unfollowed.example/news/demo-title/chapter-2",
        "http://unfollowed.example/manga/demo-title/chapter-2"
    ])("refuses %s", async url => {
        expect(await injectPanelForTab(7, url, "detected")).toBe(false)
        expect(executeScript).not.toHaveBeenCalled()
    })

    it("never reads a detected page in the background: a followed mode is still what a registered source gets", async () => {
        registerProfile(profile())
        await injectPanelForTab(7, PAGE)
        expect((executeScript.mock.calls[0]![0] as { args: unknown[] }).args[4]).toBe("followed")
    })
})
