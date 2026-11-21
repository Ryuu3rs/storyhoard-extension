import { describe, expect, it } from "vitest"
import { normalizeTitle } from "@amr/normalize"
import { sanitizePageText } from "./page-text"

// Zero-width non-joiner and joiner are spelling in Persian, Bengali, Sinhala and Malayalam, not hidden text.
describe("sanitizePageText script joiners", () => {
    it.each([
        ["Persian, ZWNJ inside a word", "می‌خواهم"],
        ["Persian title", "کتاب‌های من"],
        ["Bengali, ZWNJ after a hasanta", "ক্‌ষ"],
        ["Sinhala, ZWJ forming rakaransaya (Sri)", "ශ්‍රී"],
        ["Malayalam chillu, ZWJ after virama", "ന്‍"]
    ])("keeps the word as written: %s", (_, word) => {
        expect(sanitizePageText(word)).toBe(word)
    })

    it("still drops a stray joiner and splits at a stray non-joiner", () => {
        expect(sanitizePageText("a‍b ‌x")).toBe("ab x")
        expect(sanitizePageText("a‌b")).toBe("a b")
        expect(sanitizePageText("می‌ من")).toBe("می من")
        expect(sanitizePageText("‌‍")).toBe("")
    })

    it("a Persian title from a page still matches the same title stored elsewhere", () => {
        const stored = "می‌خواهم"
        expect(normalizeTitle(sanitizePageText(stored))).toBe(normalizeTitle(stored))
    })
})
