import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const PAGE = "https://reader.example/manga/title"

type Listener = (tabId: number, info: { status?: string }, tab?: { url?: string }) => void

function stubBrowser(initialTab: { status: string; url: string }) {
    const listeners = new Set<Listener>()
    const tab = { id: 7, ...initialTab }
    const executeScript = vi.fn(async () => [{ result: "<html>page</html>" }])
    vi.stubGlobal("browser", {
        tabs: {
            create: vi.fn(async () => ({ id: 7 })),
            get: vi.fn(async () => ({ ...tab })),
            remove: vi.fn(async () => {}),
            onUpdated: {
                addListener: (listener: Listener) => listeners.add(listener),
                removeListener: (listener: Listener) => listeners.delete(listener)
            }
        },
        scripting: { executeScript }
    })
    return {
        executeScript,
        navigate(status: string, url: string) {
            tab.status = status
            tab.url = url
            for (const listener of [...listeners]) listener(7, { status }, { url })
        }
    }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

const { fetchChapterHtmlViaTab } = await import("./tab-fetch")

describe("waiting for a background tab to load", () => {
    beforeEach(() => vi.clearAllMocks())
    afterEach(() => vi.unstubAllGlobals())

    it("does not read a new tab still on about:blank that already says complete", async () => {
        const fake = stubBrowser({ status: "complete", url: "about:blank" })
        const read = fetchChapterHtmlViaTab(PAGE, ["https://reader.example/*"])
        await flush()
        await flush()
        expect(fake.executeScript).not.toHaveBeenCalled()

        fake.navigate("complete", "about:blank")
        await flush()
        expect(fake.executeScript).not.toHaveBeenCalled()

        fake.navigate("loading", PAGE)
        fake.navigate("complete", PAGE)
        await expect(read).resolves.toBe("<html>page</html>")
        expect(fake.executeScript).toHaveBeenCalledTimes(1)
    })

    it("reads straight away when the page finished before the listener attached", async () => {
        const fake = stubBrowser({ status: "complete", url: PAGE })
        await expect(fetchChapterHtmlViaTab(PAGE, ["https://reader.example/*"])).resolves.toBe("<html>page</html>")
        expect(fake.executeScript).toHaveBeenCalledTimes(1)
    })

    it("still refuses a page that really moved to another site", async () => {
        const fake = stubBrowser({ status: "loading", url: PAGE })
        const read = fetchChapterHtmlViaTab(PAGE, ["https://reader.example/*"])
        await flush()
        fake.navigate("complete", "https://other.example/")
        await expect(read).rejects.toThrow(/redirected away/)
        expect(fake.executeScript).not.toHaveBeenCalled()
    })
})
