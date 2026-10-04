import { describe, expect, it } from "vitest"
import { titleKey, workKeyOf } from "./work-identity"

describe("titleKey", () => {
    it("folds case, whitespace and punctuation", () => {
        expect(titleKey("Re:Zero")).toBe(titleKey("Re Zero"))
        expect(titleKey("  One   Piece  ")).toBe(titleKey("one piece"))
    })

    it("keeps non-Latin letters and normalizes accents", () => {
        expect(titleKey("Café")).toBe(titleKey("Café")) // composed vs decomposed
        expect(titleKey("ワンピース")).not.toBe("")
    })

    it("yields empty string for a missing or symbol-only title", () => {
        expect(titleKey(undefined)).toBe("")
        expect(titleKey("!!!")).toBe("")
    })

    it("does not collapse distinct titles (exact-equality only)", () => {
        expect(titleKey("Naruto")).not.toBe(titleKey("Naruto Shippuden"))
    })
})

describe("workKeyOf", () => {
    it("prefers workId over everything", () => {
        expect(workKeyOf({ workId: "W1", anilistId: 5, title: "X" })).toBe("work:W1")
    })

    it("falls back to anilistId then titleKey", () => {
        expect(workKeyOf({ anilistId: 42, title: "X" })).toBe("anilist:42")
        expect(workKeyOf({ title: "Re:Zero" })).toBe(`title:${titleKey("Re:Zero")}`)
    })

    it("uses fallbackId when there is no anchor and no usable title", () => {
        expect(workKeyOf({ title: "!!!" }, "mangadex:manga:abc")).toBe("id:mangadex:manga:abc")
        expect(workKeyOf({}, "x")).toBe("id:x")
    })

    it("returns empty string when nothing anchors it and no fallback is given", () => {
        expect(workKeyOf({})).toBe("")
    })
})
