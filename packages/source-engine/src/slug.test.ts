import { describe, expect, it } from "vitest"
import { seriesNameFromSlug, stripSlugHash } from "./slug"

describe("stripSlugHash", () => {
    it("drops a trailing per-series hash", () => {
        expect(stripSlugHash("lantern-keeper-7de80a82")).toBe("lantern-keeper")
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
        expect(stripSlugHash("7de80a82")).toBe("7de80a82")
        expect(stripSlugHash("019c2921-c7b9-7d4e-a1b2-3c4d5e6f7a8b")).toBe("019c2921-c7b9-7d4e-a1b2-3c4d5e6f7a8b")
        expect(stripSlugHash("123456-7de80a82")).toBe("123456-7de80a82")
        expect(stripSlugHash("-7de80a82")).toBe("-7de80a82")
    })

    it("only looks at the last segment", () => {
        expect(stripSlugHash("lantern-7de80a82-keeper")).toBe("lantern-7de80a82-keeper")
    })
})

describe("seriesNameFromSlug", () => {
    it("title-cases the slug without its hash", () => {
        expect(seriesNameFromSlug("lantern-keeper-7de80a82")).toBe("Lantern Keeper")
        expect(seriesNameFromSlug("the_quiet_forge")).toBe("The Quiet Forge")
        expect(seriesNameFromSlug("kaiju-unit-no-8")).toBe("Kaiju Unit No 8")
        expect(seriesNameFromSlug("sky-ranger-x10")).toBe("Sky Ranger X10")
    })

    it("decodes a percent-encoded slug and leaves scripts without case alone", () => {
        expect(seriesNameFromSlug("%E3%81%82-tale")).toBe("あ Tale")
    })
})
