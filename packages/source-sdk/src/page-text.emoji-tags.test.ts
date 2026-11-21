import { describe, expect, it } from "vitest"
import { sanitizePageText } from "./page-text"

// A subdivision flag is one emoji; an ideographic variation selector picks the glyph of a Japanese name.
describe("sanitizePageText tag sequences and variation selectors", () => {
    const scotland = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}"

    it("keeps a subdivision flag whole", () => {
        expect(sanitizePageText(`Highland ${scotland} Tales`)).toBe(`Highland ${scotland} Tales`)
    })

    it("keeps an ideographic variation selector on a kanji", () => {
        expect(sanitizePageText("葛\u{E0100}飾")).toBe("葛\u{E0100}飾")
    })

    it("still drops tags outside a flag and a variation selector on a Latin letter", () => {
        expect(sanitizePageText("a\u{E0067}\u{E0062}\u{E007F}b")).toBe("a b")
        expect(sanitizePageText("\u{1F3F4}\u{E0067}\u{E0062} x")).toBe("\u{1F3F4} x")
        expect(sanitizePageText("a\u{E0100}b")).toBe("ab")
    })
})
