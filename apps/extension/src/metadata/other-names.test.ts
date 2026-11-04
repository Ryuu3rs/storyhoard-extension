import { describe, expect, it } from "vitest"
import { otherNamesFrom } from "./anilist"

const demonSlayer = {
    id: 1,
    title: { english: "Demon Slayer: Kimetsu no Yaiba", romaji: "Kimetsu no Yaiba", native: "鬼滅の刃" },
    synonyms: ["Blade of Demon Destruction"]
}
const lookAlike = { id: 2, title: { romaji: "Taima no Haha" }, synonyms: ["Demon Slayer Mother"] }

describe("otherNamesFrom", () => {
    it("gives the other names, leaving out the one searched", () => {
        expect(otherNamesFrom([demonSlayer], "Kimetsu no Yaiba")).toEqual([
            "Demon Slayer: Kimetsu no Yaiba",
            "Blade of Demon Destruction"
        ])
    })

    it("finds a title from its Japanese name", () => {
        expect(otherNamesFrom([demonSlayer], "鬼滅の刃")).toContain("Kimetsu no Yaiba")
    })

    it("accepts a whole part of a name", () => {
        expect(otherNamesFrom([demonSlayer], "demon slayer")).toContain("Kimetsu no Yaiba")
    })

    it("skips a top hit that only shares the words, for the result that really is the title", () => {
        const names = otherNamesFrom([lookAlike, demonSlayer], "Demon Slayer")
        expect(names).toContain("Kimetsu no Yaiba")
        expect(names).not.toContain("Taima no Haha")
    })

    it("gives a shared part to the most read series, not a spin-off", () => {
        const spinOff = { id: 3, popularity: 10, title: { english: "Demon Slayer: Kimetsu Academy" }, synonyms: [] }
        const names = otherNamesFrom([spinOff, { ...demonSlayer, popularity: 900 }], "Demon Slayer")
        expect(names).toContain("Kimetsu no Yaiba")
    })

    it("offers nothing when no result really is that title", () => {
        expect(otherNamesFrom([lookAlike], "Demon Slayer")).toEqual([])
        expect(otherNamesFrom([demonSlayer], "Solo Leveling")).toEqual([])
        expect(otherNamesFrom([], "Solo Leveling")).toEqual([])
    })
})
