import { describe, expect, it } from "vitest"
import { parseCatalogTitle } from "./catalog-search"
import { parseDiscoverItem } from "./weeb-discover"

// Discover and catalog search share one rule: an adult flag that is not plainly false or absent is adult.
describe("catalog search adult flag", () => {
    it.each([1, "true", "1"])("isAdult %j is not shown as a non-adult title", flag => {
        expect(parseDiscoverItem({ title: "X", anilistId: 5, isAdult: flag })).toBeNull()
        expect(parseCatalogTitle({ title: "X", anilistId: 5, isAdult: flag })?.isAdult).toBe(true)
    })
})
