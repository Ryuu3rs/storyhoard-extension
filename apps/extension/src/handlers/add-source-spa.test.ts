import "fake-indexeddb/auto"
import { draftProfileFromChapterPage, parseProfile, type SiteProfile } from "@amr/source-engine"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const fetchChapterHtmlViaTabMock = vi.fn()
vi.mock("../background/tab-fetch", () => ({
    fetchChapterHtmlViaTab: (...args: unknown[]) => fetchChapterHtmlViaTabMock(...args)
}))
vi.mock("../background/chapter-cache", () => ({ scheduleChapterListRefresh: vi.fn() }))
vi.mock("../settings", () => ({ getSettings: async () => ({ language: "en" }) }))
vi.mock("../background/panel-injection", () => ({ injectPanelForTab: vi.fn() }))

const { probeListTier } = await import("./add-source")

const SERIES_URL = "https://reader.example/manga/demo-title"

const SHELL = `<html><head><meta property="og:title" content="Demo Title - Example Reader"></head><body><div id="app"></div><script src="/app.js"></script></body></html>`
const RENDERED = `<html><head><meta property="og:title" content="Demo Title - Example Reader"></head><body><ul class="chapters">
<li><a href="/manga/demo-title/chapter-3">Chapter 3</a></li>
<li><a href="/manga/demo-title/chapter-2">Chapter 2</a></li>
<li><a href="/manga/demo-title/chapter-1">Chapter 1</a></li>
</ul></body></html>`

function draftedProfile(): SiteProfile {
    const draft = draftProfileFromChapterPage({
        url: `${SERIES_URL}/chapter-2`,
        ogTitle: "Demo Title Chapter 2 | Example Reader",
        ogSiteName: "Example Reader",
        links: [
            { href: "/manga/demo-title/chapter-1", text: "Prev" },
            { href: "/manga/demo-title/chapter-3", text: "Next" }
        ],
        images: []
    })
    const parsed = parseProfile(draft?.profile)
    if (!parsed.ok) throw new Error("fixture profile must parse")
    return parsed.profile
}

// A minimal fetch response: status, the final url (the bounded client verifies it) and the body.
function stubFetch(handler: (url: string) => { status?: number; body: string }): void {
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            const { status = 200, body } = handler(url)
            return { ok: status >= 200 && status < 300, status, url, text: async () => body }
        })
    )
}

beforeEach(() => {
    fetchChapterHtmlViaTabMock.mockReset()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe("probeListTier against a script-built chapter list", () => {
    it("reads a server-rendered list with the plain fetch", async () => {
        stubFetch(() => ({ body: RENDERED }))

        const decision = await probeListTier(draftedProfile(), SERIES_URL)

        expect(decision).toMatchObject({ ok: true, tier: "fetch" })
        expect(fetchChapterHtmlViaTabMock).not.toHaveBeenCalled()
    })

    it("resolves a single-page app (empty shell on fetch, chapters once rendered) to the tab tier, probing green", async () => {
        stubFetch(() => ({ body: SHELL }))
        fetchChapterHtmlViaTabMock.mockResolvedValue(RENDERED)

        const decision = await probeListTier(draftedProfile(), SERIES_URL)

        expect(decision).toMatchObject({ ok: true, tier: "tab" })
        if (!decision.ok) throw new Error("expected a decision")
        expect(decision.report.ok).toBe(true)
        expect(decision.report.stages.find(stage => stage.stage === "chapters")).toMatchObject({
            ok: true,
            detail: "3 chapter(s)"
        })
        expect(fetchChapterHtmlViaTabMock).toHaveBeenCalledWith(SERIES_URL, expect.any(Array))
    })

    it("falls to on-visit when neither the fetch nor the rendered tab shows a list", async () => {
        stubFetch(() => ({ body: SHELL }))
        fetchChapterHtmlViaTabMock.mockResolvedValue(SHELL)

        const decision = await probeListTier(draftedProfile(), SERIES_URL)

        expect(decision).toMatchObject({ ok: true, tier: "on-visit" })
    })

    it("fails when the title page cannot be opened by either route", async () => {
        stubFetch(() => ({ status: 403, body: "blocked" }))
        fetchChapterHtmlViaTabMock.mockRejectedValue(new Error("Tab load timed out"))

        const decision = await probeListTier(draftedProfile(), SERIES_URL)

        expect(decision.ok).toBe(false)
    })
})
