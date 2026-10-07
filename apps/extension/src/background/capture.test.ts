import { afterEach, describe, expect, it, vi } from "vitest"
import { clearAddAvailableBadge, isSlugLikeTitle, setAddAvailableBadge } from "./capture"

describe("add-available badge", () => {
    afterEach(() => vi.unstubAllGlobals())

    it("sets a tab-scoped badge and clears only a badge it set", async () => {
        const action = {
            setBadgeText: vi.fn().mockResolvedValue(undefined),
            setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined)
        }
        vi.stubGlobal("browser", { action })

        await setAddAvailableBadge(5)
        expect(action.setBadgeText).toHaveBeenCalledWith({ tabId: 5, text: "+" })

        await clearAddAvailableBadge(5)
        expect(action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 5, text: "" })

        action.setBadgeText.mockClear()
        await clearAddAvailableBadge(5)
        await clearAddAvailableBadge(9)
        expect(action.setBadgeText).not.toHaveBeenCalled()
    })
})

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
