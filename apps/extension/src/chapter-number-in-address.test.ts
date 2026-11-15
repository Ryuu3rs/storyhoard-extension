import { describe, expect, it } from "vitest"
import { chapterNumberInPath } from "./chapter-number-in-address"

describe("chapterNumberInPath", () => {
    it("reads the chapter keyword after a series name that starts with a number", () => {
        expect(chapterNumberInPath("/chapter/29-sai-dokushin-wa-isekai/chapter-44.2")).toBe(44.2)
        expect(chapterNumberInPath("/chapter/86-eighty-six/chapter-12")).toBe(12)
    })

    it("keeps the shapes it already read", () => {
        expect(chapterNumberInPath("/comics/some-title/chapter/129")).toBe(129)
        expect(chapterNumberInPath("/manga/x/chapter-7")).toBe(7)
        expect(chapterNumberInPath("/read/x/chapter_3.5/")).toBe(3.5)
        expect(chapterNumberInPath("/manga/x/chapter-12-5")).toBe(12)
    })

    it("falls back to a number followed by a word when nothing cleaner exists", () => {
        expect(chapterNumberInPath("/manga/x/chapter-1-the-beginning")).toBe(1)
    })

    it("returns undefined when the path names no chapter", () => {
        expect(chapterNumberInPath("/manga/x")).toBeUndefined()
        expect(chapterNumberInPath("/chapter/")).toBeUndefined()
    })
})
