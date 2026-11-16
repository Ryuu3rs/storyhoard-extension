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

    it("reads the chapter, not the series number, when the chapter slug carries its own title", () => {
        expect(chapterNumberInPath("/chapter/2-5-dimensional-seduction/chapter-12-beach-episode")).toBe(12)
        expect(chapterNumberInPath("/chapter/1-2-prince/chapter-30-finale")).toBe(30)
    })

    it("ignores a chapter keyword in the query string", () => {
        expect(chapterNumberInPath("/manga/x/chapter-12?from=chapter-11")).toBe(12)
        expect(chapterNumberInPath("/manga/x?ref=chapter-11")).toBeUndefined()
    })

    it("does not read a chapter keyword that is part of a longer word", () => {
        expect(chapterNumberInPath("/manga/subchapter-3")).toBeUndefined()
    })

    it("returns undefined when the path names no chapter", () => {
        expect(chapterNumberInPath("/manga/x")).toBeUndefined()
        expect(chapterNumberInPath("/chapter/")).toBeUndefined()
    })
})
