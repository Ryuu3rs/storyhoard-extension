import { describe, expect, it } from "vitest"
import { parseCatalogTitle } from "./catalog-search"
import { runtimeRequestSchema } from "./runtime"
import { planToReadRequest } from "./weeb-discover"

// Like Discover, catalog search accepts only a positive safe-integer AniList id.
describe("catalog search AniList id", () => {
    it.each([0, -3, 1e21])("drops AniList id %s from a weeb.ltd search answer", id => {
        expect(parseCatalogTitle({ title: "X", anilistId: id })?.anilistId).toBeNull()
    })

    it("Add to library on such a title never sends a request the message schema rejects", () => {
        const title = parseCatalogTitle({ title: "X", anilistId: -3 })!
        const request = planToReadRequest(title)
        if (request) expect(runtimeRequestSchema.safeParse(request).success).toBe(true)
    })
})
