import { describe, expect, it } from "vitest"
import { sanitizeTextList } from "./page-text"

// One name in two Unicode spellings is one name (other names on the title page, genre chips, quick-add altTitles).
describe("sanitizeTextList repeats", () => {
    it("treats precomposed and decomposed accents as one name", () => {
        expect(sanitizeTextList(["Pokémon", "Pokémon"], 5, 100)).toHaveLength(1)
    })

    it("drops an other name that is the title in another normal form", () => {
        expect(sanitizeTextList(["Pokémon Adventures"], 5, 100, ["Pokémon Adventures"])).toEqual([])
    })
})
