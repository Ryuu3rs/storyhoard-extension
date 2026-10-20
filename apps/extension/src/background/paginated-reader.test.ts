import { describe, expect, it } from "vitest"
import { dm5ContinuousScrollMain } from "./paginated-reader"

// This runs injected into the page (MAIN world), so it is asserted on by its source text, like the
// other injected helpers. The behaviour that matters for the "flips to the end then blank" report is
// that the strip is shown and the page hidden BEFORE the capture walk, and pages fill in progressively.
const src = dm5ContinuousScrollMain.toString()

describe("dm5 continuous-scroll flattener", () => {
    it("builds one slot per page before the walk", () => {
        expect(src).toContain("slots.push")
        expect(src.indexOf("slots.push")).toBeLessThan(src.indexOf("imagepage = p"))
    })

    it("reveals the strip and hides the single page before the capture walk, not after", () => {
        const reveal = src.indexOf("appendChild(strip)")
        const walk = src.indexOf("imagepage = p")
        expect(reveal).toBeGreaterThan(-1)
        expect(walk).toBeGreaterThan(-1)
        expect(reveal).toBeLessThan(walk)
    })

    it("fills each page's slot as the walk resolves it", () => {
        expect(src).toMatch(/slots\[p - 1\]/)
        expect(src).toContain("imagepage = p")
    })

    it("undoes everything if the toggle is turned off mid-walk", () => {
        expect(src).toContain("restore()")
    })

    it("hides the DM5 novice-guide overlay (dark mask + yd-* steps) that covers the reader", () => {
        expect(src).toContain(".yd-mask")
        expect(src).toMatch(/display\s*:\s*none\s*!important/)
    })
})
