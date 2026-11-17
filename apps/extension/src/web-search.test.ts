import { describe, expect, it, vi } from "vitest"
import { runWebSearch, webSearchAvailable, webSearchText } from "./web-search"

describe("webSearchText", () => {
    it("is the title's name plus its media type word, nothing else", () => {
        expect(webSearchText({ title: "Solo Leveling", mediaType: "manhwa" })).toBe("Solo Leveling manhwa")
        expect(webSearchText({ title: "Frieren", mediaType: null })).toBe("Frieren")
        expect(webSearchText({ title: "Some Webtoon", mediaType: "webtoon" })).toBe("Some Webtoon")
        expect(webSearchText({ title: "A Book", mediaType: "book" })).toBe("A Book")
        expect(webSearchText({ title: "  ​ ", mediaType: "manga" })).toBe("")
    })
})

describe("runWebSearch", () => {
    it("uses Chrome's search.query in a new tab", async () => {
        const query = vi.fn(async () => {})
        expect(await runWebSearch({ query }, "Frieren manga", "chrome")).toBe(true)
        expect(query).toHaveBeenCalledWith({ text: "Frieren manga", disposition: "NEW_TAB" })
    })

    it("uses Firefox's search.search with the default engine in a new tab", async () => {
        const search = vi.fn(async () => {})
        const query = vi.fn(async () => {})
        expect(await runWebSearch({ search, query }, "Frieren", "firefox")).toBe(true)
        expect(search).toHaveBeenCalledWith({ query: "Frieren", disposition: "NEW_TAB" })
        expect(query).not.toHaveBeenCalled()
    })

    it("does nothing without the API, without text, or when the browser refuses", async () => {
        expect(await runWebSearch(undefined, "Frieren", "chrome")).toBe(false)
        expect(await runWebSearch({ query: vi.fn() }, "", "chrome")).toBe(false)
        const failing = vi.fn(async () => {
            throw new Error("no")
        })
        expect(await runWebSearch({ query: failing }, "Frieren", "chrome")).toBe(false)
    })

    it("is hidden on Android, which has no search API", () => {
        expect(webSearchAvailable("android")).toBe(false)
        expect(webSearchAvailable("win")).toBe(true)
    })
})
