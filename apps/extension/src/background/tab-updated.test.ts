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
    userSourcesReady: vi.fn()
}))

vi.mock("../arch-sources", () => ({
    captureTabSignals: mocks.captureTabSignals,
    findUpgradeableSeed: mocks.findUpgradeableSeed
}))
vi.mock("../handlers/add-source", () => ({ knownSourceFor: mocks.knownSourceFor }))
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
        permissions.contains.mockResolvedValue(true)
        mocks.captureTabSignals.mockResolvedValue(signalsFor(READER_URL, { largeImages: 0 }))
        await handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
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
        mocks.captureTabSignals.mockResolvedValue(signalsFor(READER_URL, { largeImages: 0 }))
        await handleTabUpdated(1, { status: "complete" }, { url: READER_URL })
        expect(mocks.injectPanelForTab).not.toHaveBeenCalled()
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
