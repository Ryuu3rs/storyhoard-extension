import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// injectChapterPrompt is serialized into the page, so it cannot be imported and run here. These
// guards read its source to keep two regressions out: restyle selectors broad enough to reach
// layout wrappers on a site's own markup, and saved view prefs being auto-restored on official
// sites (which would make one bad toggle a persistent break).
const source = readFileSync(fileURLToPath(new URL("./inject-chapter-prompt.ts", import.meta.url)), "utf8")

describe("injectChapterPrompt restyle scoping", () => {
    it("never targets every element whose class merely contains 'chapter' or 'page'", () => {
        expect(source).not.toMatch(/div\[class\*=/)
        expect(source).not.toMatch(/img\[class\*=/)
    })

    it("scopes the restyle layers to the marked page-image container", () => {
        for (const layer of ["DARK_CSS", "FIT_CSS", "SCROLL_CSS", "NO_GAP_CSS"]) {
            const start = source.indexOf(`const ${layer}`)
            expect(start).toBeGreaterThan(-1)
            expect(source.slice(start, start + 600)).toContain("[data-amr-reader]")
        }
    })

    it("only restores saved view prefs on user-added sites", () => {
        const start = source.indexOf("function loadPrefs")
        expect(start).toBeGreaterThan(-1)
        expect(source.slice(start, start + 200)).toContain("if (!userAdded) return")
    })
})

function bodyOf(name: string): string {
    const start = source.indexOf(`function ${name}(`)
    expect(start).toBeGreaterThan(-1)
    const next = source.indexOf("\n    function ", start + 10)
    return source.slice(start, next === -1 ? start + 4000 : next)
}

describe("injectChapterPrompt rendered chapter list", () => {
    it("only reads the DOM: the list scrape makes no request of its own", () => {
        const body = bodyOf("readRenderedChapterList")
        expect(body).not.toMatch(/\bfetch\(|XMLHttpRequest|sendMessage|\.src\s*=/)
    })

    it("is scoped to the profile selectors or the known list containers, and capped", () => {
        const body = bodyOf("readRenderedChapterList")
        expect(body).toContain("renderedSelectors?.container")
        expect(body).toContain("renderedSelectors?.item")
        expect(body).toContain("KNOWN_CONTAINERS")
        expect(body).toContain("LIST_ITEM_CAP")
        expect(source).toContain("const LIST_ITEM_CAP = 2000")
    })

    it("catches an invalid selector instead of throwing out of the panel", () => {
        const body = bodyOf("readRenderedChapterList")
        expect(body).toMatch(/try \{\s*return Array\.from\(root\.querySelectorAll\(selector\)\)/)
    })

    it("sends the list only on a user-added profile source (the background passes null for any other site)", () => {
        const body = bodyOf("reportRenderedList")
        expect(body).toContain("if (!userAdded || !renderedSelectors) return")
        expect(body).toContain("work:record-chapter-list")
    })

    it("hands the declared selectors on when it re-injects itself after an in-page navigation", () => {
        expect(source).toContain("injectChapterPrompt(location.href, officialSites, _support, renderedSelectors)")
    })
})

describe("injectChapterPrompt chapter label", () => {
    it("sends the page's own chapter label with every chapter:track", () => {
        expect(source).not.toMatch(/type: "chapter:track", url: chapterUrl \}/)
        expect(bodyOf("trackChapter")).toContain("label")
        expect(bodyOf("currentChapterLabel")).toContain("document.title")
    })
})

describe("injectChapterPrompt generic prev/next seed", () => {
    it("only seeds user-added sites, from same-origin links of the chapter's own path shape", () => {
        const body = bodyOf("seedGenericNavFromDom")
        expect(body).toContain("if (!userAdded")
        expect(body).toContain("u.origin !== here.origin")
        expect(body).toContain("segments.length !== hereSegments.length")
    })

    it("fills only a side that is still empty, so the database list and the site seeds win", () => {
        const body = bodyOf("seedGenericNavFromDom")
        expect(body).toContain("!prevUrl && PREV.test(label)")
        expect(body).toContain("!nextUrl && NEXT.test(label)")
    })
})
