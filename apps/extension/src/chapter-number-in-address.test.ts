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
        expect(chapterNumberInPath("/manga/x/chapter-12-5")).toBe(12.5)
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

    it("does not read a hex or uuid chapter id after a bare /chapter/ segment as a chapter number", () => {
        expect(chapterNumberInPath("/series/some-title/chapter/5e8a1b2c9d0f")).toBeUndefined()
        expect(chapterNumberInPath("/series/some-title/chapter/0b6a8d55-1111-2222-3333-444444444444")).toBeUndefined()
        expect(chapterNumberInPath("/chapter/12345678-abcd-ef01-2345-6789abcdef01")).toBeUndefined()
        expect(chapterNumberInPath("/chapter/29-sai-dokushin/chapter/5e8a1b2c9d0f")).toBeUndefined()
        expect(chapterNumberInPath("/series/some-title/chapter/12-the-return")).toBe(12)
    })

    it.each([
        ["https://reader.example/manga/foo/chapter/12.html", 12],
        ["https://reader.example/manga/foo/chapter/12.5.html", 12.5],
        ["https://reader.example/manga/foo/Chapter/12.htm", 12],
        ["https://reader.example/manga/foo/chapter/12.php", 12],
        ["/manga/foo/chapter/12.", 12],
        ["/manga/foo/chapter/12!", 12],
        ["/manga/foo/chapter/12(1)", 12],
        ["/manga/foo/chapter/12~raw", 12],
        ["/manga/foo/chapter/12,5", 12],
        ["/manga/foo/chapter/12%20end", 12]
    ])("reads %s after a bare /chapter/ segment as chapter %d", (address, expected) => {
        expect(chapterNumberInPath(address)).toBe(expected)
    })

    it("tries an earlier segment when the one after a bare /chapter/ is not a number", () => {
        expect(chapterNumberInPath("/manga/x/chapter-7/chapter/read")).toBe(7)
        expect(chapterNumberInPath("/series/some-title/chapter/abc12")).toBeUndefined()
    })

    it("returns undefined when the path names no chapter", () => {
        expect(chapterNumberInPath("/manga/x")).toBeUndefined()
        expect(chapterNumberInPath("/chapter/")).toBeUndefined()
    })
})
