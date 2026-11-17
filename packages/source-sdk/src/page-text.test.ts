import { describe, expect, it } from "vitest"
import { MAX_MARKS_PER_CHARACTER, MAX_PAGE_TITLE_LENGTH, sanitizePageText } from "./page-text"

const ch = (code: number) => String.fromCodePoint(code)

describe("sanitizePageText", () => {
    it("drops direction overrides, isolates, controls and zero-width characters", () => {
        const raw = `${ch(0x202e)}cod.exe${ch(0x202c)} a${ch(0x200b)}b ${ch(0x2066)}c${ch(0x2069)} d${ch(0)}e${ch(0xfeff)}`
        expect(sanitizePageText(raw)).toBe("cod.exe a b c d e")
    })

    it("folds line breaks and runs of whitespace into single spaces", () => {
        expect(sanitizePageText(`  Line one\r\n\tLine${ch(0x2028)}two  `)).toBe("Line one Line two")
    })

    it("keeps a joiner that builds one emoji and drops a stray one", () => {
        const family = `${ch(0x1f468)}${ch(0x200d)}${ch(0x1f469)}${ch(0x200d)}${ch(0x1f467)}`
        expect(sanitizePageText(`Home ${family}`)).toBe(`Home ${family}`)
        expect(sanitizePageText(`a${ch(0x200d)}b`)).toBe("ab")
    })

    it("caps the length by whole characters, never splitting an emoji or an accented letter", () => {
        const flag = `${ch(0x1f1ef)}${ch(0x1f1f5)}`
        const accented = `e${ch(0x301)}`
        const out = sanitizePageText(`${flag}${accented}`.repeat(200))
        const graphemes = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(out))
        expect(graphemes).toHaveLength(MAX_PAGE_TITLE_LENGTH)
        expect(out.endsWith(accented)).toBe(true)
        expect(sanitizePageText("x".repeat(50), 10)).toBe("x".repeat(10))
    })

    it("caps the stored length even when the page stacks combining marks onto one character", () => {
        const zalgo = "a" + ch(0x301).repeat(5000)
        expect(sanitizePageText(zalgo)).toBe("a" + ch(0x301).repeat(MAX_MARKS_PER_CHARACTER))
        const tower = ("b" + ch(0x302).repeat(500)).repeat(MAX_PAGE_TITLE_LENGTH)
        expect(sanitizePageText(tower).length).toBeLessThanOrEqual(MAX_PAGE_TITLE_LENGTH * 4)
    })

    it("keeps the few marks a real accented letter carries", () => {
        expect(sanitizePageText(`Vie${ch(0x323)}${ch(0x302)}t`)).toBe(`Vie${ch(0x323)}${ch(0x302)}t`)
    })

    it("caps the code units too when every character is a long emoji", () => {
        const family = `${ch(0x1f468)}${ch(0x200d)}${ch(0x1f469)}${ch(0x200d)}${ch(0x1f467)}`
        const out = sanitizePageText(family.repeat(MAX_PAGE_TITLE_LENGTH))
        expect(out.length).toBeLessThanOrEqual(MAX_PAGE_TITLE_LENGTH * 4)
        expect(out).toBe(family.repeat(MAX_PAGE_TITLE_LENGTH / 2))
    })

    it("does not keep a title made only of default-ignorable blanks (Hangul fillers, combining grapheme joiner)", () => {
        expect(sanitizePageText(`${ch(0x3164)}${ch(0xffa0)}${ch(0x115f)}${ch(0x34f)}${ch(0x3164)}`)).toBe("")
        expect(sanitizePageText(`${ch(0x2800)} ${ch(0x1160)}${ch(0xfe0f)}${ch(0x301)}`)).toBe("")
    })

    it("drops default-ignorable characters inside a title but keeps emoji sequences whole", () => {
        expect(sanitizePageText(`Sec${ch(0x34f)}ret${ch(0x3164)}Garden`)).toBe("Secret Garden")
        const heart = `${ch(0x2764)}${ch(0xfe0f)}`
        const keycap = `1${ch(0xfe0f)}${ch(0x20e3)}`
        expect(sanitizePageText(`I ${heart} ${keycap}`)).toBe(`I ${heart} ${keycap}`)
        expect(sanitizePageText(`a${ch(0xfe0f)}b`)).toBe("ab")
    })

    it("returns an empty string for anything that is not text", () => {
        expect(sanitizePageText(undefined)).toBe("")
        expect(sanitizePageText(42)).toBe("")
        expect(sanitizePageText(`${ch(0x202e)}${ch(10)}`)).toBe("")
    })
})
