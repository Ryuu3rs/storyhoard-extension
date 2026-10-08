import { describe, expect, it } from "vitest"
import {
    UNNUMBERED_SORT_KEY,
    assignListSortKeys,
    isNumberedChapter,
    latestNumberedChapter,
    parseChapterLabel,
    parseChapterNumber
} from "./chapter-numbering"

describe("parseChapterLabel", () => {
    it.each([
        ["Ch. 86", 86],
        ["Chapter 70", 70],
        ["chapter 70", 70],
        ["CH.86", 86],
        ["Ch.10.5", 10.5],
        ["Episode 12", 12],
        ["Ep. 3", 3],
        ["Issue 7", 7],
        ["#86", 86],
        ["No. 5", 5],
        ["Solo Leveling - Chapter 70", 70],
        ["Chapter 0", 0]
    ])("reads %j as chapter %d", (text, number) => {
        const label = parseChapterLabel(text)
        expect(label.kind).toBe("chapter")
        expect(label.number).toBe(number)
        expect(label.raw).toBe(text)
    })

    it("reads a volume label as kind volume, ahead of a chapter token", () => {
        expect(parseChapterLabel("Vol. 3")).toMatchObject({ kind: "volume", number: 3 })
        expect(parseChapterLabel("Volume 12.5")).toMatchObject({ kind: "volume", number: 12.5 })
        expect(parseChapterLabel("Vol.2 Ch.9")).toMatchObject({ kind: "volume", number: 2 })
    })

    it("reads season-episode as kind season with the episode as the number", () => {
        expect(parseChapterLabel("S2E5")).toMatchObject({ kind: "season", number: 5 })
        expect(parseChapterLabel("Season 1 x 12")).toMatchObject({ kind: "season", number: 12 })
        expect(parseChapterLabel("s3·4")).toMatchObject({ kind: "season", number: 4 })
    })

    it("falls back to a bare leading or trailing number", () => {
        expect(parseChapterLabel("86")).toMatchObject({ kind: "chapter", number: 86 })
        expect(parseChapterLabel("86 - The Return")).toMatchObject({ kind: "chapter", number: 86 })
        expect(parseChapterLabel("Solo Leveling 86")).toMatchObject({ kind: "chapter", number: 86 })
        expect(parseChapterLabel("12.5")).toMatchObject({ kind: "chapter", number: 12.5 })
    })

    it("treats a bare internal-id sized integer as unreliable with no number", () => {
        const label = parseChapterLabel("9475194")
        expect(label.kind).toBe("unreliable")
        expect(label.number).toBeUndefined()
        expect(parseChapterLabel("123456789012345")).toMatchObject({ kind: "unreliable" })
        expect(parseChapterLabel("100000").number).toBeUndefined()
        expect(parseChapterLabel("99999").number).toBe(99999)
    })

    it("returns no number for empty or numberless text, never 0", () => {
        for (const text of ["", "   ", "Extra", "Oneshot", "Prologue"]) {
            const label = parseChapterLabel(text)
            expect(label.number).toBeUndefined()
            expect(label.raw).toBe(text)
        }
    })

    it("does not read a number out of the middle of a word", () => {
        expect(parseChapterLabel("Step 5").number).toBe(5)
        expect(parseChapterLabel("Epic").number).toBeUndefined()
        expect(parseChapterLabel("R2D2 returns").number).toBeUndefined()
    })

    it("is unicode-aware", () => {
        expect(parseChapterLabel("CH. 86 - Épisode final")).toMatchObject({ number: 86 })
        expect(parseChapterLabel("Étape 4").number).toBe(4)
    })

    it("stays fast on a hostile very long input", () => {
        const started = Date.now()
        parseChapterLabel(`${"9".repeat(50_000)} ${"ch ".repeat(10_000)}`)
        expect(Date.now() - started).toBeLessThan(200)
    })
})

describe("UNNUMBERED_SORT_KEY", () => {
    it("is +Infinity so an unnumbered chapter sorts last, never before Chapter 1", () => {
        expect(UNNUMBERED_SORT_KEY).toBe(Number.POSITIVE_INFINITY)
    })
})

describe("parseChapterNumber", () => {
    it("returns undefined (never 0) for unparseable input", () => {
        expect(parseChapterNumber("Extra")).toBeUndefined()
        expect(parseChapterNumber("Oneshot")).toBeUndefined()
        expect(parseChapterNumber("")).toBeUndefined()
        expect(parseChapterNumber(null)).toBeUndefined()
        expect(parseChapterNumber(undefined)).toBeUndefined()
        expect(parseChapterNumber("abc")).toBeUndefined()
    })

    it("returns 0 only for a literal 0 (a genuine Chapter 0)", () => {
        expect(parseChapterNumber("0")).toBe(0)
        expect(parseChapterNumber("0.0")).toBe(0)
    })

    it("parses integers and decimals", () => {
        expect(parseChapterNumber("1")).toBe(1)
        expect(parseChapterNumber("12")).toBe(12)
        expect(parseChapterNumber("1.5")).toBe(1.5)
    })

    it("parses a leading number out of trailing junk (parseFloat semantics)", () => {
        expect(parseChapterNumber("3 extra")).toBe(3)
    })
})

describe("assignListSortKeys", () => {
    const num = (x: number | undefined) => x

    it("maps a parseable oldest-first ascending list to its numbers", () => {
        const items = [1, 2, 3]
        expect(assignListSortKeys(items, num, "oldest-first")).toEqual([1, 2, 3])
    })

    it("maps a parseable newest-first descending list back to its numbers in document order", () => {
        const items = [3, 2, 1]
        expect(assignListSortKeys(items, num, "newest-first")).toEqual([3, 2, 1])
    })

    it("interpolates a single unnumbered entry between its neighbours (oldest-first)", () => {
        // document order: 1, 2, <extra>, 3
        const items: (number | undefined)[] = [1, 2, undefined, 3]
        const keys = assignListSortKeys(items, num, "oldest-first")
        expect(keys[0]).toBe(1)
        expect(keys[1]).toBe(2)
        expect(keys[2]).toBeGreaterThan(2)
        expect(keys[2]).toBeLessThan(3)
        expect(keys[3]).toBe(3)
    })

    it("interpolates in a newest-first document, keeping the entry between its real neighbours", () => {
        // document order (newest first): 3, <extra>, 2, 1
        const items: (number | undefined)[] = [3, undefined, 2, 1]
        const keys = assignListSortKeys(items, num, "newest-first")
        expect(keys[0]).toBe(3)
        expect(keys[3]).toBe(1)
        expect(keys[2]).toBe(2)
        // the extra sits (chronologically) between Chapter 2 and Chapter 3
        expect(keys[1]).toBeGreaterThan(2)
        expect(keys[1]).toBeLessThan(3)
    })

    it("keeps multiple unnumbered entries in a run ordered and distinct", () => {
        // document order (oldest-first): 3, <a>, <b>, 4
        const items: (number | undefined)[] = [3, undefined, undefined, 4]
        const keys = assignListSortKeys(items, num, "oldest-first")
        expect(keys[0]).toBe(3)
        expect(keys[3]).toBe(4)
        expect(keys[1]).toBeCloseTo(3.001)
        expect(keys[2]).toBeCloseTo(3.002)
        expect(keys[1]).toBeLessThan(keys[2]!)
        expect(keys[2]).toBeLessThan(4)
    })

    it("handles an all-unparseable list without any 0 collapse", () => {
        const items: (number | undefined)[] = [undefined, undefined, undefined]
        const keys = assignListSortKeys(items, num, "oldest-first")
        // no real chapter seen yet, so they walk 0.001, 0.002, 0.003 - strictly
        // increasing and never a bare 0.
        expect(keys).toEqual([0.001, 0.002, 0.003])
        expect(keys.every(k => k > 0)).toBe(true)
    })

    it("sorts a leading unnumbered entry BELOW a first real Chapter 0 (negative epsilon)", () => {
        // oldest-first: <Prologue>, 0, 1. The prologue precedes the first real chapter, which
        // is 0 - it must sort below 0, not at 0.001 (which would put it above Chapter 0).
        const items: (number | undefined)[] = [undefined, 0, 1]
        const keys = assignListSortKeys(items, num, "oldest-first")
        expect(keys[0]!).toBeLessThan(0)
        expect(keys[1]).toBe(0)
        expect(keys[2]).toBe(1)
    })

    it("keeps a leading unnumbered entry below a first real chapter >= 1", () => {
        const items: (number | undefined)[] = [undefined, 1, 2]
        const keys = assignListSortKeys(items, num, "oldest-first")
        expect(keys[0]!).toBeLessThan(1)
        expect(keys[1]).toBe(1)
        expect(keys[2]).toBe(2)
    })

    it("treats a non-finite getNumber result (NaN/Infinity) as unnumbered, never a sortKey", () => {
        for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
            const items: (number | undefined)[] = [1, bad as unknown as number, 3]
            const keys = assignListSortKeys(items, x => x, "oldest-first")
            expect(keys.every(k => Number.isFinite(k))).toBe(true)
            expect(keys[0]).toBe(1)
            // the poisoned entry interpolates off Chapter 1, and Chapter 3 stays real.
            expect(keys[1]!).toBeGreaterThan(1)
            expect(keys[1]!).toBeLessThan(3)
            expect(keys[2]).toBe(3)
        }
    })

    it("handles a single numbered item", () => {
        expect(assignListSortKeys([7], num, "oldest-first")).toEqual([7])
    })

    it("handles a single unnumbered item", () => {
        expect(assignListSortKeys([undefined], num, "oldest-first")).toEqual([0.001])
    })

    it("interpolates each of several unnumbered runs at their own real position", () => {
        // oldest-first: 1, 2, 3, <extraA>, <extraB>, 4, <extraC>, 5
        const items: (number | undefined)[] = [1, 2, 3, undefined, undefined, 4, undefined, 5]
        const keys = assignListSortKeys(items, num, "oldest-first")
        expect(keys[3]).toBeGreaterThan(3)
        expect(keys[3]).toBeLessThan(4)
        expect(keys[4]).toBeGreaterThan(keys[3]!)
        expect(keys[4]).toBeLessThan(4)
        expect(keys[6]).toBeGreaterThan(4)
        expect(keys[6]).toBeLessThan(5)
        expect(keys.map(Math.floor)).toEqual([1, 2, 3, 3, 3, 4, 4, 5])
    })
})

describe("isNumberedChapter", () => {
    it("is true for finite numbers, including 0 (a genuine Chapter 0)", () => {
        expect(isNumberedChapter(0)).toBe(true)
        expect(isNumberedChapter(1)).toBe(true)
        expect(isNumberedChapter(1.5)).toBe(true)
    })

    it("is false for the UNNUMBERED_SORT_KEY sentinel and any other non-finite value", () => {
        expect(isNumberedChapter(UNNUMBERED_SORT_KEY)).toBe(false)
        expect(isNumberedChapter(Number.POSITIVE_INFINITY)).toBe(false)
        expect(isNumberedChapter(Number.NEGATIVE_INFINITY)).toBe(false)
        expect(isNumberedChapter(Number.NaN)).toBe(false)
    })

    it("is false for null/undefined", () => {
        expect(isNumberedChapter(null)).toBe(false)
        expect(isNumberedChapter(undefined)).toBe(false)
    })
})

describe("latestNumberedChapter", () => {
    it("returns the chapter with the highest finite sortKey", () => {
        const chapters = [{ sortKey: 1 }, { sortKey: 3 }, { sortKey: 2 }]
        expect(latestNumberedChapter(chapters)).toEqual({ sortKey: 3 })
    })

    it("ignores an unnumbered (Infinity) chapter even when it would otherwise win", () => {
        const chapters = [{ sortKey: 1 }, { sortKey: 2 }, { sortKey: UNNUMBERED_SORT_KEY }]
        expect(latestNumberedChapter(chapters)).toEqual({ sortKey: 2 })
    })

    it("returns undefined when nothing is numbered - not the first chapter or the unnumbered one", () => {
        const chapters = [{ sortKey: UNNUMBERED_SORT_KEY }, { sortKey: UNNUMBERED_SORT_KEY }]
        expect(latestNumberedChapter(chapters)).toBeUndefined()
    })

    it("returns undefined for an empty list", () => {
        expect(latestNumberedChapter([])).toBeUndefined()
    })

    it("returns a genuine Chapter 0 rather than treating it as falsy/absent", () => {
        const chapters = [{ sortKey: UNNUMBERED_SORT_KEY }, { sortKey: 0 }]
        expect(latestNumberedChapter(chapters)).toEqual({ sortKey: 0 })
    })
})
