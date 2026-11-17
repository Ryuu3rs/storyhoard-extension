import { describe, expect, it } from "vitest"
import {
    appendNewSources,
    buildLabelMap,
    labelFromMap,
    MAX_SOURCE_NAME_LENGTH,
    moveInOrder,
    orderedSourceIds,
    sanitizeSourceName,
    sourceLabel,
    UNLISTED_SOURCE_LABEL,
    type SourcePref
} from "./source-labels"

const pref = (sourceId: string, position: number, name?: string): SourcePref => ({
    sourceId,
    position,
    updatedAt: 1,
    ...(name !== undefined ? { name } : {})
})

describe("sourceLabel", () => {
    const prefs = [pref("b", 1), pref("a", 0), pref("c", 2, "My mirror")]

    it("numbers sources by the user's order, not by id", () => {
        expect(sourceLabel("a", prefs)).toBe("Source 1")
        expect(sourceLabel("b", prefs)).toBe("Source 2")
    })

    it("shows a name only when the user typed one", () => {
        expect(sourceLabel("c", prefs)).toBe("My mirror")
    })

    it("numbers by place, so a gap or a tie in positions still gives 1..N", () => {
        const gapped = [pref("x", 10), pref("y", 10), pref("z", 400)]
        expect(["x", "y", "z"].map(id => sourceLabel(id, gapped))).toEqual(["Source 1", "Source 2", "Source 3"])
    })

    it("never falls back to the raw id", () => {
        expect(sourceLabel("detected:some.host", prefs)).toBe(UNLISTED_SOURCE_LABEL)
        expect(labelFromMap(buildLabelMap(prefs), "mangadex")).toBe(UNLISTED_SOURCE_LABEL)
    })

    it("returns to the number when the name is cleared", () => {
        const cleared = prefs.map(p => (p.sourceId === "c" ? { sourceId: "c", position: 2, updatedAt: 2 } : p))
        expect(sourceLabel("c", cleared)).toBe("Source 3")
    })
})

describe("appendNewSources", () => {
    it("puts a new source after the existing ones and leaves them untouched", () => {
        const prefs = [pref("a", 0), pref("b", 1)]
        const added = appendNewSources(prefs, ["c", "a", "d"], 5)
        expect(added.map(p => [p.sourceId, p.position])).toEqual([
            ["c", 2],
            ["d", 3]
        ])
        const after = [...prefs, ...added]
        expect(["a", "b", "c", "d"].map(id => sourceLabel(id, after))).toEqual([
            "Source 1",
            "Source 2",
            "Source 3",
            "Source 4"
        ])
    })

    it("is stable: adding nothing new changes nothing", () => {
        expect(appendNewSources([pref("a", 0)], ["a"], 5)).toEqual([])
    })
})

describe("moveInOrder", () => {
    it("moves to a one-based place and clamps", () => {
        expect(moveInOrder(["a", "b", "c"], "c", 1)).toEqual(["c", "a", "b"])
        expect(moveInOrder(["a", "b", "c"], "a", 99)).toEqual(["b", "c", "a"])
        expect(moveInOrder(["a", "b", "c"], "b", 0)).toEqual(["b", "a", "c"])
        expect(moveInOrder(["a", "b"], "zzz", 1)).toEqual(["a", "b"])
    })
})

describe("sanitizeSourceName", () => {
    it("keeps plain text, collapses whitespace and caps the length", () => {
        expect(sanitizeSourceName("  My   mirror ")).toBe("My mirror")
        expect(sanitizeSourceName("x".repeat(200))).toHaveLength(40)
    })

    it("strips markup characters and control characters", () => {
        expect(sanitizeSourceName("<img src=x onerror=alert(1)>")).toBe("img src=x onerror=alert(1)")
        expect(sanitizeSourceName("a\u0000b\nc")).toBe("a b c")
    })

    it("treats empty or non-string input as no name", () => {
        expect(sanitizeSourceName("   ")).toBeUndefined()
        expect(sanitizeSourceName("<>")).toBeUndefined()
        expect(sanitizeSourceName(42)).toBeUndefined()
    })
})

describe("orderedSourceIds", () => {
    it("sorts by position then id", () => {
        expect(orderedSourceIds([pref("b", 1), pref("a", 1), pref("c", 0)])).toEqual(["c", "a", "b"])
    })
})

const hasLoneSurrogate = (value: string) =>
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)

describe("sanitizeSourceName with invisible and multi-unit characters", () => {
    it("never cuts an emoji in half at the length cap", () => {
        const typed = "a".repeat(MAX_SOURCE_NAME_LENGTH - 1) + "\u{1F525}"
        const name = sanitizeSourceName(typed)!
        expect(hasLoneSurrogate(name)).toBe(false)
        expect(() => encodeURIComponent(name)).not.toThrow()
    })

    it("treats a name made only of invisible characters as no name", () => {
        expect(sanitizeSourceName("​​")).toBeUndefined()
    })

    it("treats a name made only of zero-width joiners or blank letters as no name", () => {
        expect(sanitizeSourceName("‍")).toBeUndefined()
        expect(sanitizeSourceName("‍‍‍")).toBeUndefined()
        expect(sanitizeSourceName("⠀ ㅤ")).toBeUndefined()
    })

    it("does not leave a dangling zero-width joiner or half a flag at the length cap", () => {
        const family = "\u{1F468}‍\u{1F469}‍\u{1F467}"
        const cutFamily = sanitizeSourceName("a".repeat(MAX_SOURCE_NAME_LENGTH - 2) + family)!
        expect(cutFamily.endsWith("‍")).toBe(false)
        expect(cutFamily.endsWith(family)).toBe(true)
        const flag = "\u{1F1EF}\u{1F1F5}"
        const cutFlag = sanitizeSourceName("a".repeat(MAX_SOURCE_NAME_LENGTH - 1) + flag)!
        expect(cutFlag.endsWith(flag)).toBe(true)
        const overFlag = sanitizeSourceName("a".repeat(MAX_SOURCE_NAME_LENGTH) + flag)!
        expect(overFlag).toBe("a".repeat(MAX_SOURCE_NAME_LENGTH))
    })

    it("bounds the stored text when one character stacks many marks", () => {
        expect(sanitizeSourceName("x" + "a" + "́".repeat(500))).toBe("x")
    })

    it("drops bidi override characters that flip how the label reads", () => {
        expect(sanitizeSourceName("My ‮etis")).not.toContain("‮")
    })
})
