import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { isValidUrl, openExternal } from "./open-external"

vi.stubGlobal("browser", fakeBrowser)

const create = vi.spyOn(fakeBrowser.tabs, "create").mockResolvedValue({} as never)

beforeEach(() => create.mockClear())

describe("openExternal", () => {
    it("opens http(s) only", () => {
        expect(openExternal("https://site.example/manga/x", false)).toBe(true)
        expect(create).toHaveBeenCalledWith({ url: "https://site.example/manga/x", active: false })
        for (const url of ["javascript:/manga/x/%0Aalert(1)", "data:text/html,<h1>x", "file:///etc/passwd", "", null]) {
            create.mockClear()
            expect(openExternal(url)).toBe(false)
            expect(isValidUrl(url)).toBe(false)
            expect(create).not.toHaveBeenCalled()
        }
    })
})

describe("the app's Open buttons for search results", () => {
    const source = (file: string) =>
        readFileSync(fileURLToPath(new URL(`../entrypoints/app/${file}`, import.meta.url)), "utf8")

    for (const [file, fn] of [
        ["FindSource.svelte", "openCandidate"],
        ["ImportReconcile.svelte", "openResult"]
    ] as const) {
        it(`${file} ${fn} goes through the http(s) gate`, () => {
            const text = source(file)
            const start = text.indexOf(`function ${fn}(`)
            expect(start).toBeGreaterThan(-1)
            const body = text.slice(start, text.indexOf("\n    }", start))
            expect(body).toContain("openExternal(")
            expect(text).not.toContain("browser.tabs.create")
        })
    }
})
