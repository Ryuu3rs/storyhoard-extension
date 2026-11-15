import type { CaptureSignals } from "@amr/source-engine"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
    captureTabSignals: vi.fn(),
    findUpgradeableSeed: vi.fn(),
    knownSourceFor: vi.fn(),
    findSource: vi.fn(),
    captureChapter: vi.fn(),
    clearAddAvailableBadge: vi.fn(),
    setAddAvailableBadge: vi.fn(),
    injectPanelForTab: vi.fn(),
    isInternalTab: vi.fn(),
    isInternalUrl: vi.fn(),
    userSourcesReady: vi.fn(),
    addSourceFromTab: vi.fn(),
    deriveSeedListOnVisit: vi.fn(),
    getSettings: vi.fn()
}))

vi.mock("../arch-sources", () => ({
    captureTabSignals: mocks.captureTabSignals,
    findUpgradeableSeed: mocks.findUpgradeableSeed
}))
vi.mock("../handlers/add-source", () => ({
    knownSourceFor: mocks.knownSourceFor,
    addSourceFromTab: mocks.addSourceFromTab,
    deriveSeedListOnVisit: mocks.deriveSeedListOnVisit
}))
vi.mock("../settings", () => ({ getSettings: mocks.getSettings }))
vi.mock("../sources", () => ({ findSource: mocks.findSource }))
vi.mock("./capture", () => ({
    captureChapter: mocks.captureChapter,
    clearAddAvailableBadge: mocks.clearAddAvailableBadge,
    setAddAvailableBadge: mocks.setAddAvailableBadge
}))
vi.mock("./panel-injection", () => ({ injectPanelForTab: mocks.injectPanelForTab }))
vi.mock("./tab-fetch", () => ({ isInternalTab: mocks.isInternalTab, isInternalUrl: mocks.isInternalUrl }))
vi.mock("./user-sources-ready", () => ({ userSourcesReady: mocks.userSourcesReady }))

const { handleTabUpdated, forgetTab } = await import("./tab-updated")

const permissions = { contains: vi.fn() }
const tabs = { get: vi.fn() }

const READER_URL = "https://reader.example/manga/demo-title/chapter-2"

function signalsFor(url: string, extra: Partial<CaptureSignals> = {}): CaptureSignals {
    return { url, links: [], images: [], ...extra }
}

beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal("browser", { permissions, tabs })
    forgetTab(1)
    mocks.userSourcesReady.mockResolvedValue(undefined)
    mocks.isInternalTab.mockReturnValue(false)
    mocks.isInternalUrl.mockReturnValue(false)
    mocks.knownSourceFor.mockReturnValue(undefined)
    mocks.findSource.mockReturnValue(undefined)
    mocks.findUpgradeableSeed.mockResolvedValue(undefined)
    mocks.captureChapter.mockResolvedValue({ supported: false })
    mocks.clearAddAvailableBadge.mockResolvedValue(undefined)
    mocks.setAddAvailableBadge.mockResolvedValue(undefined)
    mocks.injectPanelForTab.mockResolvedValue(true)
    mocks.addSourceFromTab.mockResolvedValue({ ok: true })
    mocks.deriveSeedListOnVisit.mockResolvedValue(undefined)
    mocks.getSettings.mockResolvedValue({ autoFollowDetected: false })
    permissions.contains.mockResolvedValue(false)
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

describe("cold start: added sources are registered before any decision", () => {
    function deferredReady() {
        let release!: () => void
        mocks.userSourcesReady.mockReturnValue(
            new Promise<void>(resolve => {
                release = resolve
            })
        )
        return release
    }

    it("does not look up the source, capture or inject until registration has finished", async () => {
        const release = deferredReady()
        mocks.findSource.mockReturnValue({
            manifest: { name: "Added Site", supportUrl: null },
            match: () => "chapter"
        })

        const pending = handleTabUpdated(1, { url: READER_URL, status: "complete" }, { url: READER_URL })
        await Promise.resolve()
        await Promise.resolve()

        expect(mocks.findSource).not.toHaveBeenCalled()
        expect(mocks.captureChapter).not.toHaveBeenCalled()
        expect(mocks.injectPanelForTab).not.toHaveBeenCalled()
        expect(mocks.setAddAvailableBadge).not.toHaveBeenCalled()

        release()
        await pending

        expect(mocks.captureChapter).toHaveBeenCalledWith(READER_URL)
        expect(mocks.findSource).toHaveBeenCalled()
        expect(mocks.injectPanelForTab).toHaveBeenCalledWith(1, READER_URL)
        expect(mocks.setAddAvailableBadge).not.toHaveBeenCalled()
    })

    it("does not offer 'add' for an already-added site once registration is done", async () => {
        const release = deferredReady()
        mocks.findSource.mockReturnValue({ manifest: { name: "Added Site" }, match: () => "chapter" })
        mocks.knownSourceFor.mockReturnValue({ manifest: { id: "reader.example", name: "Added Site" } })

        const pending = handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        release()
        await pending

        expect(mocks.setAddAvailableBadge).not.toHaveBeenCalled()
        expect(mocks.injectPanelForTab).toHaveBeenCalledTimes(1)
    })
})

describe("the add hint only appears on pages that look like readers", () => {
    it.each([
        "https://en.wikipedia.org/wiki/Chapter_3",
        "https://example.test/podcast/my-show/episode-12",
        "https://example.test/tv/my-show/episode-3",
        "https://example.test/news/issue-12"
    ])("does not badge %s", async url => {
        await handleTabUpdated(1, { status: "complete" }, { url })
        expect(mocks.setAddAvailableBadge).not.toHaveBeenCalled()
    })

    it("badges a reader-shaped url on a site it has no access to yet", async () => {
        await handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        expect(mocks.captureTabSignals).not.toHaveBeenCalled()
        expect(mocks.setAddAvailableBadge).toHaveBeenCalledWith(1)
    })

    it("when access is held, badges only if the page itself looks like a reader", async () => {
        permissions.contains.mockResolvedValue(true)
        mocks.captureTabSignals.mockResolvedValue(signalsFor(READER_URL, { largeImages: 5 }))
        await handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        expect(mocks.setAddAvailableBadge).toHaveBeenCalledWith(1)
    })

    it("when access is held, a text-only page with a chapter-like url is not badged", async () => {
        vi.useFakeTimers()
        permissions.contains.mockResolvedValue(true)
        mocks.captureTabSignals.mockResolvedValue(signalsFor(READER_URL, { largeImages: 0 }))
        const pending = handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        await vi.advanceTimersByTimeAsync(6000)
        await pending
        expect(mocks.setAddAvailableBadge).not.toHaveBeenCalled()
    })

    it("ignores signals read from a different page than the one being offered", async () => {
        permissions.contains.mockResolvedValue(true)
        mocks.captureTabSignals.mockResolvedValue(
            signalsFor("https://reader.example/manga/other/chapter-9", { largeImages: 5 })
        )
        await handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        expect(mocks.setAddAvailableBadge).not.toHaveBeenCalled()
    })

    it("offers the hint again after the same page is reloaded", async () => {
        await handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        expect(mocks.setAddAvailableBadge).toHaveBeenCalledTimes(1)

        await handleTabUpdated(1, { status: "loading" }, { url: READER_URL })
        await handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        expect(mocks.setAddAvailableBadge).toHaveBeenCalledTimes(2)
    })

    it("offers an upgrade hint for a tracking-only stand-in", async () => {
        mocks.knownSourceFor.mockReturnValue({ manifest: { id: "reader.example", name: "Reader" } })
        mocks.findUpgradeableSeed.mockResolvedValue({ id: "reader.example" })
        await handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        expect(mocks.setAddAvailableBadge).toHaveBeenCalledWith(1)
    })
})

describe("single-page readers change address without a page load", () => {
    it("detects on the url event alone, after the page has had a moment to render", async () => {
        vi.useFakeTimers()
        tabs.get.mockResolvedValue({ url: READER_URL, status: "complete" })

        const pending = handleTabUpdated(1, { url: READER_URL }, { url: READER_URL })
        await vi.advanceTimersByTimeAsync(1500)
        await pending

        expect(mocks.clearAddAvailableBadge).toHaveBeenCalledWith(1)
        expect(mocks.setAddAvailableBadge).toHaveBeenCalledWith(1)
    })

    it("skips the hint when the tab has moved on again by the time it settles", async () => {
        vi.useFakeTimers()
        tabs.get.mockResolvedValue({ url: "https://reader.example/about", status: "complete" })

        const pending = handleTabUpdated(1, { url: READER_URL }, { url: READER_URL })
        await vi.advanceTimersByTimeAsync(1500)
        await pending

        expect(mocks.setAddAvailableBadge).not.toHaveBeenCalled()
    })

    it("leaves a full page load to its own 'complete' event", async () => {
        vi.useFakeTimers()
        tabs.get.mockResolvedValue({ url: READER_URL, status: "loading" })

        const pending = handleTabUpdated(1, { url: READER_URL }, { url: READER_URL })
        await vi.advanceTimersByTimeAsync(1500)
        await pending

        expect(mocks.setAddAvailableBadge).not.toHaveBeenCalled()
    })

    it("inspects a page once when the url event and the complete event both arrive", async () => {
        vi.useFakeTimers()
        tabs.get.mockResolvedValue({ url: READER_URL, status: "complete" })

        const first = handleTabUpdated(1, { url: READER_URL }, { url: READER_URL })
        await vi.advanceTimersByTimeAsync(1500)
        await first
        await handleTabUpdated(1, { status: "complete" }, { url: READER_URL })

        expect(mocks.setAddAvailableBadge).toHaveBeenCalledTimes(1)
    })
})

describe("an unrecognised reader page that host access already covers gets the observe-only panel", () => {
    beforeEach(() => {
        permissions.contains.mockResolvedValue(true)
        mocks.captureTabSignals.mockResolvedValue(signalsFor(READER_URL, { largeImages: 5 }))
    })

    it("injects it in detected mode once the page itself confirms it is a reader", async () => {
        await handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        expect(mocks.injectPanelForTab).toHaveBeenCalledTimes(1)
        expect(mocks.injectPanelForTab).toHaveBeenCalledWith(1, READER_URL, "detected")
        expect(mocks.setAddAvailableBadge).toHaveBeenCalledWith(1)
    })

    it("does nothing more than the hint when no host access is held", async () => {
        permissions.contains.mockResolvedValue(false)
        await handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        expect(mocks.captureTabSignals).not.toHaveBeenCalled()
        expect(mocks.injectPanelForTab).not.toHaveBeenCalled()
        expect(mocks.setAddAvailableBadge).toHaveBeenCalledWith(1)
    })

    it("does not inject on a text-only page whose address merely looks like a chapter", async () => {
        vi.useFakeTimers()
        mocks.captureTabSignals.mockResolvedValue(signalsFor(READER_URL, { largeImages: 0 }))
        const pending = handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        await vi.advanceTimersByTimeAsync(6000)
        await pending
        expect(mocks.injectPanelForTab).not.toHaveBeenCalled()
    })

    it("looks again when the page draws its images after the load, and stops after a few tries", async () => {
        vi.useFakeTimers()
        mocks.captureTabSignals
            .mockResolvedValueOnce(signalsFor(READER_URL))
            .mockResolvedValueOnce(signalsFor(READER_URL, { largeImages: 45 }))
        const pending = handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        await vi.advanceTimersByTimeAsync(1500)
        await pending
        expect(mocks.captureTabSignals).toHaveBeenCalledTimes(2)
        expect(mocks.injectPanelForTab).toHaveBeenCalledWith(1, READER_URL, "detected")

        vi.clearAllMocks()
        forgetTab(1)
        mocks.captureTabSignals.mockResolvedValue(signalsFor(READER_URL))
        const never = handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        await vi.advanceTimersByTimeAsync(20_000)
        await never
        expect(mocks.captureTabSignals).toHaveBeenCalledTimes(3)
        expect(mocks.injectPanelForTab).not.toHaveBeenCalled()
    })

    it("a reload during the recheck window gets its own checks", async () => {
        vi.useFakeTimers()
        let drawnAt = Infinity
        mocks.captureTabSignals.mockImplementation(async () =>
            signalsFor(READER_URL, { largeImages: Date.now() >= drawnAt ? 20 : 0 })
        )
        const first = handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        await vi.advanceTimersByTimeAsync(5000)
        await handleTabUpdated(1, { status: "loading" }, { url: READER_URL })
        const second = handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        drawnAt = Date.now() + 1500
        await vi.advanceTimersByTimeAsync(10_000)
        await Promise.all([first, second])
        expect(mocks.injectPanelForTab).toHaveBeenCalledWith(1, READER_URL, "detected")
    })

    it("treats ?ch=5 and ?ch=6 as different pages", async () => {
        mocks.captureTabSignals.mockResolvedValue(signalsFor("https://reader.example/read?ch=6", { largeImages: 20 }))
        await handleTabUpdated(1, { status: "complete" }, { url: "https://reader.example/read?ch=5" })
        expect(mocks.injectPanelForTab).not.toHaveBeenCalled()
    })

    it("a #fragment rewritten while reading is the same page, and is offered once", async () => {
        const page = READER_URL
        mocks.captureTabSignals.mockImplementation(async () => signalsFor(`${page}#p3`, { largeImages: 20 }))
        await handleTabUpdated(1, { status: "complete" }, { url: page })
        await handleTabUpdated(1, { status: "complete" }, { url: `${page}#p3` })
        expect(mocks.injectPanelForTab).toHaveBeenCalledTimes(1)
    })

    it("a failed badge does not cost the page its panel", async () => {
        mocks.setAddAvailableBadge.mockRejectedValueOnce(new Error("action unavailable"))
        await handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        expect(mocks.injectPanelForTab).toHaveBeenCalledWith(1, READER_URL, "detected")
    })

    it("judges the page, not the address: a chapter address with only an opaque id still gets the panel", async () => {
        const opaque = "https://reader.example/chapters/01M6T50R9QMMSZB8WQK0SEAM4W"
        mocks.captureTabSignals.mockResolvedValue(signalsFor(opaque, { largeImages: 20 }))
        await handleTabUpdated(1, { status: "complete" }, { url: opaque })
        expect(mocks.injectPanelForTab).toHaveBeenCalledWith(1, opaque, "detected")
    })

    it("never reads an opaque-id page without access", async () => {
        permissions.contains.mockResolvedValue(false)
        const opaque = "https://reader.example/chapters/01M6T50R9QMMSZB8WQK0SEAM4W"
        await handleTabUpdated(1, { status: "complete" }, { url: opaque })
        expect(mocks.captureTabSignals).not.toHaveBeenCalled()
        expect(mocks.setAddAvailableBadge).not.toHaveBeenCalled()
    })

    it("stops looking at a page once the tab has moved to another one, and checks the new one", async () => {
        vi.useFakeTimers()
        const next = "https://reader.example/manga/demo-title/chapter-3"
        mocks.captureTabSignals.mockImplementation(async () => signalsFor(current))
        let current = READER_URL
        const first = handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        await vi.advanceTimersByTimeAsync(100)
        current = next
        mocks.captureTabSignals.mockImplementation(async () => signalsFor(current, { largeImages: 10 }))
        const second = handleTabUpdated(1, { status: "complete" }, { url: next })
        await vi.advanceTimersByTimeAsync(6000)
        await Promise.all([first, second])
        expect(mocks.injectPanelForTab).toHaveBeenCalledTimes(1)
        expect(mocks.injectPanelForTab).toHaveBeenCalledWith(1, next, "detected")
    })

    it("does not inject for signals read from a different page", async () => {
        mocks.captureTabSignals.mockResolvedValue(
            signalsFor("https://reader.example/manga/other/chapter-9", { largeImages: 5 })
        )
        await handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        expect(mocks.injectPanelForTab).not.toHaveBeenCalled()
    })

    it("does not inject on a site the extension already knows (it has its own panel)", async () => {
        mocks.knownSourceFor.mockReturnValue({ manifest: { id: "reader.example", name: "Reader" } })
        mocks.findUpgradeableSeed.mockResolvedValue({ id: "reader.example" })
        await handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        expect(mocks.injectPanelForTab).not.toHaveBeenCalled()
    })

    it("injects once when the url event and the complete event both arrive", async () => {
        vi.useFakeTimers()
        tabs.get.mockResolvedValue({ url: READER_URL, status: "complete" })
        const first = handleTabUpdated(1, { url: READER_URL }, { url: READER_URL })
        await vi.advanceTimersByTimeAsync(1500)
        await first
        await handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        expect(mocks.injectPanelForTab).toHaveBeenCalledTimes(1)
    })

    it("a registered chapter page is still handled by the followed path, not the detected one", async () => {
        mocks.findSource.mockReturnValue({ manifest: { name: "Added Site" }, match: () => "chapter" })
        await handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        expect(mocks.injectPanelForTab).toHaveBeenCalledWith(1, READER_URL)
    })
})

describe("a visit to a registered chapter page can give a recognition-only site its list", () => {
    it("asks for the list once the page has finished loading and the panel is on", async () => {
        mocks.findSource.mockReturnValue({ manifest: { name: "Added Site" }, match: () => "chapter" })
        await handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        expect(mocks.injectPanelForTab).toHaveBeenCalledWith(1, READER_URL)
        expect(mocks.deriveSeedListOnVisit).toHaveBeenCalledWith(1, READER_URL)
    })

    it("does not ask on a page no source recognises as a chapter", async () => {
        await handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        expect(mocks.deriveSeedListOnVisit).not.toHaveBeenCalled()
    })

    it("a failure there does not break navigation handling", async () => {
        mocks.findSource.mockReturnValue({ manifest: { name: "Added Site" }, match: () => "chapter" })
        mocks.deriveSeedListOnVisit.mockRejectedValue(new Error("boom"))
        await expect(handleTabUpdated(1, { status: "complete" }, { url: READER_URL })).resolves.toBeUndefined()
    })
})

describe("auto-follow of recognised sites is opt-in", () => {
    beforeEach(() => {
        permissions.contains.mockResolvedValue(true)
        mocks.captureTabSignals.mockResolvedValue(signalsFor(READER_URL, { largeImages: 5 }))
    })

    it("offers the panel only, and follows nothing, by default", async () => {
        await handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        expect(mocks.injectPanelForTab).toHaveBeenCalledWith(1, READER_URL, "detected")
        expect(mocks.addSourceFromTab).not.toHaveBeenCalled()
    })

    it("follows the site on its own once the user has turned the setting on", async () => {
        mocks.getSettings.mockResolvedValue({ autoFollowDetected: true })
        await handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        expect(mocks.addSourceFromTab).toHaveBeenCalledWith({ url: READER_URL, tabId: 1 })
    })

    it("does not follow, on page content alone, a page whose address does not look like a chapter", async () => {
        mocks.getSettings.mockResolvedValue({ autoFollowDetected: true })
        const gallery = "https://hostile.example/gallery"
        mocks.captureTabSignals.mockResolvedValue(signalsFor(gallery, { largeImages: 20 }))
        await handleTabUpdated(1, { status: "complete" }, { url: gallery })
        expect(mocks.injectPanelForTab).toHaveBeenCalledWith(1, gallery, "detected")
        expect(mocks.addSourceFromTab).not.toHaveBeenCalled()
    })

    it("never follows a page the panel was not put on", async () => {
        mocks.getSettings.mockResolvedValue({ autoFollowDetected: true })
        mocks.injectPanelForTab.mockResolvedValue(false)
        await handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        expect(mocks.addSourceFromTab).not.toHaveBeenCalled()
    })

    it("never follows a site it has no access to", async () => {
        mocks.getSettings.mockResolvedValue({ autoFollowDetected: true })
        permissions.contains.mockResolvedValue(false)
        await handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        expect(mocks.addSourceFromTab).not.toHaveBeenCalled()
    })

    it("a failed follow does not break navigation handling", async () => {
        mocks.getSettings.mockResolvedValue({ autoFollowDetected: true })
        mocks.addSourceFromTab.mockRejectedValue(new Error("boom"))
        await expect(handleTabUpdated(1, { status: "complete" }, { url: READER_URL })).resolves.toBeUndefined()
    })
})
