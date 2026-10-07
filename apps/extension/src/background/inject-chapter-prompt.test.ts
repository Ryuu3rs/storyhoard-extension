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
