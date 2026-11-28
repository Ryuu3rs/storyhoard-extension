import { describe, expect, it } from "vitest"
import { seriesNameFromSlug, stripSlugHash } from "./slug"

describe("stripSlugHash", () => {
    it("drops a trailing per-series hash", () => {
        expect(stripSlugHash("lantern-keeper-3f9c2b71")).toBe("lantern-keeper")
        expect(stripSlugHash("lantern-keeper-a1b2c3")).toBe("lantern-keeper")
        expect(stripSlugHash("lantern-keeper-7DE80A82")).toBe("lantern-keeper")
        expect(stripSlugHash("the-quiet-forge-0123456789abcdef0123456789abcdef")).toBe("the-quiet-forge")
    })

    it("keeps real trailing tokens", () => {
        for (const slug of [
            "kaiju-unit-no-8",
            "lantern-keeper-2",
            "lantern-keeper-season-2",
            "sky-ranger-x10",
            "lantern-keeper-2049",
            "lantern-keeper-20240115",
            "lantern-keeper-facade",
            "lantern-keeper-decade",
            "lantern-keeper-1a2b3",
            "lantern-keeper-ab12cz"
        ]) {
            expect(stripSlugHash(slug)).toBe(slug)
        }
    })

    it("keeps a slug that is an opaque id from end to end", () => {
        expect(stripSlugHash("3f9c2b71")).toBe("3f9c2b71")
        expect(stripSlugHash("019c2921-c7b9-7d4e-a1b2-3c4d5e6f7a8b")).toBe("019c2921-c7b9-7d4e-a1b2-3c4d5e6f7a8b")
        expect(stripSlugHash("123456-3f9c2b71")).toBe("123456-3f9c2b71")
        expect(stripSlugHash("-3f9c2b71")).toBe("-3f9c2b71")
    })

    it("keeps an id whose only words are generic ones every series on the site shares", () => {
        expect(stripSlugHash("manga-aa951409")).toBe("manga-aa951409")
        expect(stripSlugHash("manga-aa951409")).not.toBe(stripSlugHash("manga-bb120934"))
        expect(stripSlugHash("series-1a2b3c4d")).not.toBe(stripSlugHash("series-9f8e7d6c"))
        expect(stripSlugHash("the-manga-1a2b3c4d")).toBe("the-manga-1a2b3c4d")
        expect(seriesNameFromSlug("manga-aa951409")).not.toBe(seriesNameFromSlug("manga-bb120934"))
    })

    it("still drops the hash when a series word is in front of a generic one", () => {
        expect(stripSlugHash("night-walker-manga-1a2b3c4d")).toBe("night-walker-manga")
        expect(stripSlugHash("the-night-walker-1a2b3c4d")).toBe("the-night-walker")
    })

    it("only looks at the last segment", () => {
        expect(stripSlugHash("lantern-3f9c2b71-keeper")).toBe("lantern-3f9c2b71-keeper")
    })
})

describe("seriesNameFromSlug", () => {
    it("title-cases the slug without its hash", () => {
        expect(seriesNameFromSlug("lantern-keeper-3f9c2b71")).toBe("Lantern Keeper")
        expect(seriesNameFromSlug("the_quiet_forge")).toBe("The Quiet Forge")
        expect(seriesNameFromSlug("kaiju-unit-no-8")).toBe("Kaiju Unit No 8")
        expect(seriesNameFromSlug("sky-ranger-x10")).toBe("Sky Ranger X10")
    })

    it("decodes a percent-encoded slug and leaves scripts without case alone", () => {
        expect(seriesNameFromSlug("%E3%81%82-tale")).toBe("あ Tale")
    })
})
