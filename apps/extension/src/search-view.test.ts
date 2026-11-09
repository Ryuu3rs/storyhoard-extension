import { describe, expect, it } from "vitest"
import type { CatalogTitle } from "./catalog-search"
import { libraryEntryFor, matchNames, resultIsTitle, siteSearchUrl, titleFacts, topReadingHosts } from "./search-view"

const solo: CatalogTitle = {
    workId: null,
    anilistId: 105398,
    title: "Solo Leveling",
    altTitles: ["Na Honjaman Level Up", "Only I Level Up", "Re"],
    cover: null,
    mediaType: "manhwa",
    status: "finished",
    year: 2018,
    genres: [],
    isAdult: false,
    readers: 0
}

describe("search popover helpers", () => {
    it("lists type, year and status", () => {
        expect(titleFacts(solo)).toEqual(["Manhwa", "2018", "Completed"])
        expect(titleFacts({ ...solo, mediaType: null, year: null, status: null })).toEqual([])
    })

    it("keeps every name but drops ones too short to match on", () => {
        expect(matchNames(solo)).toEqual(["solo leveling", "na honjaman level up", "only i level up"])
    })

    it("matches a site hit by any name, but not a spin-off that only contains the name", () => {
        const names = matchNames(solo)
        expect(resultIsTitle("Solo Leveling", names)).toBe(true)
        expect(resultIsTitle("Na Honjaman Level-Up", names)).toBe(true)
        expect(resultIsTitle("Solo Leveling: Ragnarok", names)).toBe(false)
        expect(resultIsTitle("The Solo Leveling", names)).toBe(true)
        expect(resultIsTitle("Solo Leveling (Novel)", names)).toBe(false)
        expect(resultIsTitle("Leveling", names)).toBe(false)
    })

    it("treats sequels and spin-offs as other works", () => {
        const ghoul = matchNames({ ...solo, title: "Tokyo Ghoul", altTitles: [] })
        expect(resultIsTitle("Tokyo Ghoul:re", ghoul)).toBe(false)
        expect(resultIsTitle("Tokyo Ghoul (Official)", ghoul)).toBe(true)
        const overgeared = matchNames({ ...solo, title: "Overgeared", altTitles: [] })
        expect(resultIsTitle("Overgeared 2", overgeared)).toBe(false)
        expect(resultIsTitle("Overgeared Manhwa", overgeared)).toBe(true)
    })

    it("matches across dropped apostrophes and accents", () => {
        const orv = matchNames({ ...solo, title: "Omniscient Reader’s Viewpoint", altTitles: [] })
        expect(resultIsTitle("Omniscient Readers Viewpoint", orv)).toBe(true)
        const pokemon = matchNames({ ...solo, title: "Pokémon Adventures", altTitles: [] })
        expect(resultIsTitle("Pokemon Adventures", pokemon)).toBe(true)
    })

    it("keeps two-character CJK names but not two-letter Latin ones", () => {
        const shingeki = { ...solo, anilistId: null, title: "진격", altTitles: ["進撃", "Re"] }
        expect(matchNames(shingeki)).toEqual(["진격", "進撃"])
        expect(libraryEntryFor(shingeki, [{ title: "진격" }])).toBeDefined()
    })

    it("builds a site search link even for a title cut mid-emoji", () => {
        expect(() => siteSearchUrl("a.example", `${"a".repeat(3)}\uD83D`)).not.toThrow()
        expect(siteSearchUrl("a.example", "Fun 😀")).toBe(`https://a.example/?s=${encodeURIComponent("Fun 😀")}`)
    })

    it("finds the library entry by AniList id or by name", () => {
        const library = [
            { title: "Something Else", anilistId: 105398 },
            { title: "Only I Level Up", anilistId: undefined }
        ]
        expect(libraryEntryFor(solo, library)).toBe(library[0])
        expect(libraryEntryFor({ ...solo, anilistId: null }, library)).toBe(library[1])
        expect(libraryEntryFor({ ...solo, anilistId: null, altTitles: [] }, library)).toBeUndefined()
    })

    it("ranks the sites the user reads on by how many titles each holds", () => {
        expect(
            topReadingHosts([
                "https://www.a.example/manga/1",
                "https://b.example/x",
                "https://a.example/manga/2",
                undefined,
                "not a url",
                "javascript:alert(1)"
            ])
        ).toEqual(["a.example", "b.example"])
    })

    it("builds a site's own search link", () => {
        expect(siteSearchUrl("a.example", "Solo Leveling & co")).toBe("https://a.example/?s=Solo%20Leveling%20%26%20co")
    })
})
