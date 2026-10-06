import { describe, expect, it } from "vitest"
import { isSlugLikeTitle } from "./capture"

// Guards refreshExternalMangaMetadata against downgrading a humanized title (set by
// trackExternalChapter) to an adapter's raw-slug fallback (e.g. comix returns
// "solo-leveling-season-2" on a parse miss). Slug-shaped titles must be rejected.
describe("isSlugLikeTitle", () => {
    it("treats separator-joined, space-free strings as slug-like (a downgrade to reject)", () => {
        expect(isSlugLikeTitle("solo-leveling-season-2")).toBe(true)
        expect(isSlugLikeTitle("the_archmages_restaurant")).toBe(true)
    })

    it("accepts genuine display titles (spaced, or a single separator-free word)", () => {
        expect(isSlugLikeTitle("Solo Leveling")).toBe(false)
        expect(isSlugLikeTitle("One Piece")).toBe(false)
        expect(isSlugLikeTitle("Naruto")).toBe(false)
        // A hyphenated title that still has spaces is a real title, not a slug.
        expect(isSlugLikeTitle("Spy x Family - Extra")).toBe(false)
    })

    it("accepts a genuinely hyphenated single-token display title (has capitals)", () => {
        // These have no spaces but keep their capitals, so they are real titles, not lowercased slugs.
        expect(isSlugLikeTitle("Spider-Man")).toBe(false)
        expect(isSlugLikeTitle("Re-Zero")).toBe(false)
        expect(isSlugLikeTitle("Kaiju-No8")).toBe(false)
    })
})
