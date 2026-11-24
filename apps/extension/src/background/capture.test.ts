import { afterEach, describe, expect, it, vi } from "vitest"
import { clearAddAvailableBadge, isPlaceholderTitle, isSlugLikeTitle, setAddAvailableBadge } from "./capture"

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
        expect(action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 5, text: null })

        action.setBadgeText.mockClear()
        await clearAddAvailableBadge(5)
        await clearAddAvailableBadge(9)
        expect(action.setBadgeText).not.toHaveBeenCalled()
    })
})

describe("add-available badge after a worker restart", () => {
    afterEach(() => vi.unstubAllGlobals())

    it("clears a " + " the browser still shows even though this worker forgot setting it", async () => {
        const action = {
            setBadgeText: vi.fn().mockResolvedValue(undefined),
            getBadgeText: vi.fn().mockResolvedValue("+")
        }
        vi.stubGlobal("browser", { action })

        await clearAddAvailableBadge(41)

        expect(action.getBadgeText).toHaveBeenCalledWith({ tabId: 41 })
        expect(action.setBadgeText).toHaveBeenCalledWith({ tabId: 41, text: null })
    })

    it("leaves the global ADD flash and an empty badge alone", async () => {
        const action = {
            setBadgeText: vi.fn(),
            getBadgeText: vi.fn().mockResolvedValueOnce("ADD").mockResolvedValueOnce("")
        }
        vi.stubGlobal("browser", { action })

        await clearAddAvailableBadge(42)
        await clearAddAvailableBadge(43)

        expect(action.setBadgeText).not.toHaveBeenCalled()
    })
})

describe("isPlaceholderTitle", () => {
    it("recognises the raw slug and its humanized forms", () => {
        expect(isPlaceholderTitle("demo-title", "demo-title")).toBe(true)
        expect(isPlaceholderTitle("demo title", "demo-title")).toBe(true)
        expect(isPlaceholderTitle("Demo Title", "demo-title")).toBe(true)
    })

    it("does not treat a real series title as a placeholder", () => {
        expect(isPlaceholderTitle("The Demo Title", "demo-title")).toBe(false)
        expect(isPlaceholderTitle("Spider-Man", "spider-man")).toBe(true)
        expect(isPlaceholderTitle("Spider-Man", "asm-1963")).toBe(false)
    })

    it("recognises a placeholder made from a slug that ends in a per-series hash, with or without it", () => {
        expect(isPlaceholderTitle("lantern keeper 3f9c2b71", "lantern-keeper-3f9c2b71")).toBe(true)
        expect(isPlaceholderTitle("Lantern Keeper 3f9c2b71", "lantern-keeper-3f9c2b71")).toBe(true)
        expect(isPlaceholderTitle("Lantern Keeper", "lantern-keeper-3f9c2b71")).toBe(true)
        expect(isPlaceholderTitle("The Lantern Keeper's Oath", "lantern-keeper-3f9c2b71")).toBe(false)
    })

    it("does not drop a real last word or punctuation when comparing", () => {
        expect(isPlaceholderTitle("Kaiju Unit", "kaiju-unit-no-8")).toBe(false)
        expect(isPlaceholderTitle("Lantern Keeper", "lantern-keeper-season-2")).toBe(false)
        expect(isPlaceholderTitle("Kaiju Unit No. 8", "kaiju-unit-no-8")).toBe(false)
        expect(isPlaceholderTitle("The Hero's Return", "the-hero-s-return")).toBe(false)
        expect(isPlaceholderTitle("019c2921", "019c2921-c7b9-7d4e-a1b2-3c4d5e6f7a8b")).toBe(false)
    })

    it("recognises the old Webtoons placeholder named after the title number", () => {
        expect(isPlaceholderTitle("Title No:5656", "5656")).toBe(true)
        expect(isPlaceholderTitle("Title No:5656", "95")).toBe(false)
        expect(isPlaceholderTitle("The Top Dungeon Farmer", "5656")).toBe(false)
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
