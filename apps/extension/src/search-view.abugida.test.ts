import { describe, expect, it } from "vitest"
import { parseCatalogTitle } from "./catalog-search"
import { libraryEntryFor, matchNames, resultIsTitle } from "./search-view"
import { withoutOwned, type WeebDiscoverRail } from "./weeb-discover"

// In Indic, Thai and Burmese the marks are the vowels, not accents, so they stay in a name key.
describe("name keys keep the vowels of abugida scripts", () => {
    const kaala = { title: "काला" } // "Kaala", a different work
    const kal = parseCatalogTitle({ title: "कल", anilistId: 777 })!

    it("a library title is not owned-matched to a different Hindi title", () => {
        expect(libraryEntryFor(kal, [kaala])).toBeUndefined()
    })

    it("Discover does not hide a title the user does not own", () => {
        const rail: WeebDiscoverRail = {
            rail: "trending",
            label: "Trending",
            note: null,
            genre: null,
            items: [
                {
                    anilistId: 777,
                    workId: null,
                    title: "कल",
                    altTitles: [],
                    cover: null,
                    mediaType: null,
                    genres: [],
                    metric: ""
                }
            ]
        }
        expect(withoutOwned([rail], [kaala])).toHaveLength(1)
    })

    it("keeps the voicing mark of kana but still folds accents on Latin and Cyrillic letters", () => {
        const names = (title: string) => matchNames(parseCatalogTitle({ title, workId: "w-name" })!)
        expect(resultIsTitle("がき", names("かき"))).toBe(false)
        expect(resultIsTitle("がき", names("がき"))).toBe(true)
        expect(resultIsTitle("Pokemon", names("Pokémon"))).toBe(true)
        expect(resultIsTitle("ёлка", names("елка"))).toBe(true)
    })

    it("a site's hit for another Thai word is not this title", () => {
        const rak = parseCatalogTitle({ title: "รัก", workId: "w-rak" })! // "love"
        expect(resultIsTitle("รก", matchNames(rak))).toBe(false)
    })
})
