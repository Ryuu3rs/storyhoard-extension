import { fakeBrowser } from "wxt/testing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("browser", fakeBrowser)

const { fetchChapterHtmlViaTab, isInternalTab, isInternalUrl, isLazyPlaceholderSrc } = await import("./tab-fetch")

beforeEach(() => {
    fakeBrowser.reset()
    vi.spyOn(fakeBrowser.scripting, "executeScript").mockResolvedValue([{ result: "<html>done</html>" }] as never)
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe("isLazyPlaceholderSrc", () => {
    it("treats empty/whitespace and data: URIs as placeholders", () => {
        expect(isLazyPlaceholderSrc(null)).toBe(true)
        expect(isLazyPlaceholderSrc("   ")).toBe(true)
        expect(isLazyPlaceholderSrc("data:image/gif;base64,AAAA")).toBe(true)
    })

    it("treats a placeholder FILENAME as a placeholder", () => {
        expect(isLazyPlaceholderSrc("https://cdn.x.com/assets/loading.gif")).toBe(true)
        expect(isLazyPlaceholderSrc("https://cdn.x.com/1x1.png")).toBe(true)
        expect(isLazyPlaceholderSrc("https://cdn.x.com/spacer.png?v=2")).toBe(true)
        expect(isLazyPlaceholderSrc("https://cdn.x.com/blank.gif#x")).toBe(true)
    })

    it("does NOT flag a real page image whose PATH merely contains a token", () => {
        expect(isLazyPlaceholderSrc("https://cdn.mghcdn.com/loading-scans/one-piece/1.jpg")).toBe(false)
        expect(isLazyPlaceholderSrc("https://img.site.com/blanksky-manga/ch5/003.png")).toBe(false)
        expect(isLazyPlaceholderSrc("https://cdn.x.com/spacermaster/ch1/01.jpg")).toBe(false)
        expect(isLazyPlaceholderSrc("https://cdn.x.com/series/1x1000/pg2.jpg")).toBe(false)
        expect(isLazyPlaceholderSrc("https://cdn.mghcdn.com/manga/One-Piece/1092/1.jpg")).toBe(false)
    })
})

describe("fetchChapterHtmlViaTab internal-tab tracking", () => {
    it("registers the URL as internal before tabs.create resolves, closing the capture race window", async () => {
        // create is left pending so the tabId is still unknown - exactly the window in
        // which the tab's first onUpdated url event could fire and be mistaken for user
        // navigation. The URL must already read as internal here.
        let resolveCreate!: (tab: { id: number }) => void
        vi.spyOn(fakeBrowser.tabs, "create").mockReturnValue(
            new Promise<{ id: number }>(resolve => {
                resolveCreate = resolve
            }) as never
        )
        vi.spyOn(fakeBrowser.tabs, "get").mockResolvedValue({
            id: 7,
            status: "complete",
            url: "https://www.webtoons.com/en/fantasy/slug/ep-1/viewer?title_no=99&episode_no=1"
        } as never)
        const removeSpy = vi.spyOn(fakeBrowser.tabs, "remove").mockResolvedValue(undefined as never)

        const url = "https://www.webtoons.com/en/fantasy/slug/ep-1/viewer?title_no=99&episode_no=1"
        const pending = fetchChapterHtmlViaTab(url)

        expect(isInternalUrl(url)).toBe(true)

        resolveCreate({ id: 7 })
        await pending

        // Cleaned up on completion - neither the URL nor the tabId lingers as internal.
        expect(isInternalUrl(url)).toBe(false)
        expect(isInternalTab(7)).toBe(false)
        expect(removeSpy).toHaveBeenCalledWith(7)
    })

    it("marks the created tabId internal while the fetch is in flight", async () => {
        let resolveGet!: (tab: { id: number; status: string; url: string }) => void
        vi.spyOn(fakeBrowser.tabs, "create").mockResolvedValue({ id: 12 } as never)
        vi.spyOn(fakeBrowser.tabs, "get").mockReturnValue(
            new Promise<{ id: number; status: string; url: string }>(resolve => {
                resolveGet = resolve
            }) as never
        )
        vi.spyOn(fakeBrowser.tabs, "remove").mockResolvedValue(undefined as never)

        const pending = fetchChapterHtmlViaTab("https://ex.com/x")
        // Let create resolve and tabId register before the load completes.
        await Promise.resolve()
        await Promise.resolve()
        expect(isInternalTab(12)).toBe(true)

        resolveGet({ id: 12, status: "complete", url: "https://ex.com/x" })
        await pending
        expect(isInternalTab(12)).toBe(false)
    })
})

describe("waitForTabComplete proactive completion check", () => {
    it("resolves from the proactive tabs.get when the page is already complete and no onUpdated event ever fires", async () => {
        vi.spyOn(fakeBrowser.tabs, "create").mockResolvedValue({ id: 42 } as never)
        // The tab is already "complete" - the onUpdated listener would wait out the full
        // 25s timeout on its own, so only the proactive get can resolve this.
        vi.spyOn(fakeBrowser.tabs, "get").mockResolvedValue({
            id: 42,
            status: "complete",
            url: "https://ex.com/cached"
        } as never)
        vi.spyOn(fakeBrowser.tabs, "remove").mockResolvedValue(undefined as never)

        const html = await fetchChapterHtmlViaTab("https://ex.com/cached")

        expect(html).toBe("<html>done</html>")
    })
})

describe("fetchChapterHtmlViaTab final-URL check", () => {
    function tabAt(url: string | undefined) {
        vi.spyOn(fakeBrowser.tabs, "create").mockResolvedValue({ id: 5 } as never)
        vi.spyOn(fakeBrowser.tabs, "get").mockResolvedValue({
            id: 5,
            status: "complete",
            ...(url ? { url } : {})
        } as never)
        return vi.spyOn(fakeBrowser.tabs, "remove").mockResolvedValue(undefined as never)
    }

    it("throws and reads nothing when the tab was redirected to another origin", async () => {
        const removeSpy = tabAt("https://weeb.ltd/account")

        await expect(fetchChapterHtmlViaTab("https://reader.example/series/x")).rejects.toThrow(/redirected/)

        expect(fakeBrowser.scripting.executeScript).not.toHaveBeenCalled()
        expect(removeSpy).toHaveBeenCalledWith(5)
    })

    it("fails closed when the tab url is unreadable (a redirect to an origin without access)", async () => {
        tabAt(undefined)
        await expect(fetchChapterHtmlViaTab("https://reader.example/series/x")).rejects.toThrow(/redirected/)
        expect(fakeBrowser.scripting.executeScript).not.toHaveBeenCalled()
    })

    it("treats a plain-http landing on the same host as another origin", async () => {
        tabAt("http://reader.example/series/x")
        await expect(fetchChapterHtmlViaTab("https://reader.example/series/x")).rejects.toThrow(/redirected/)
    })

    it("reads a page that stayed on the origin or moved to its www twin, and pins the injected read to those origins", async () => {
        tabAt("https://www.reader.example/series/x?page=2")

        await expect(fetchChapterHtmlViaTab("https://reader.example/series/x")).resolves.toBe("<html>done</html>")

        const call = vi.mocked(fakeBrowser.scripting.executeScript).mock.calls[0]![0] as { args?: unknown[] }
        expect(call.args).toEqual([["https://reader.example", "https://www.reader.example"]])
    })
})
