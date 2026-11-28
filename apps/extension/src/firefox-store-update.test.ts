import { describe, expect, it } from "vitest"
import { amoListingUrl, FIREFOX_UPDATE_GRACE_MS, firefoxUpdateWaiting, parseAmoAddon } from "./firefox-store-update"

const published = Date.parse("2026-11-26T15:23:32Z")
const amo = (version: unknown, reviewed: unknown, extra: Record<string, unknown> = {}) => ({
    ...extra,
    current_version: { version, reviewed, file: { created: "2026-11-01T09:00:00Z" } }
})

describe("parseAmoAddon", () => {
    it("reads the public version and when it was approved", () => {
        expect(parseAmoAddon(amo("0.33.2", "2026-11-26T15:23:32Z"))).toEqual({
            version: "0.33.2",
            publishedAt: published
        })
    })

    it("starts the clock when the version went public, not when its file was uploaded before a long review", () => {
        const parsed = parseAmoAddon(amo("0.34.0", "2026-11-26T15:23:32Z"))
        expect(parsed?.publishedAt).toBe(published)
        expect(
            firefoxUpdateWaiting({ available: true, latestVersion: "0.34.0", ...parsed! }, "0.33.2", published + 1000)
        ).toBe(false)
    })

    it("falls back to the add-on's last update when the version has no approval date", () => {
        expect(parseAmoAddon(amo("0.33.2", null, { last_updated: "2026-11-26T15:23:32Z" }))).toEqual({
            version: "0.33.2",
            publishedAt: published
        })
    })

    it("accepts a four-part version", () => {
        expect(parseAmoAddon(amo("0.34.0.1", "2026-11-26T15:23:32Z"))?.version).toBe("0.34.0.1")
    })

    it.each([
        ["no body", null],
        ["no current version", {}],
        ["a version that is not a version", amo("1.0<x>", "2026-11-26")],
        ["a numeric version", amo(2, "2026-11-26")],
        ["a version part over six digits", amo("0.34.1234567", "2026-11-26")],
        ["a version with five parts", amo("1.2.3.4.5", "2026-11-26")],
        ["only an upload date", amo("1.0.0", undefined)],
        ["a bad approval date", amo("1.0.0", "soon")]
    ])("gives null for %s", (_label, json) => {
        expect(parseAmoAddon(json)).toBeNull()
    })
})

describe("amoListingUrl", () => {
    it("links the Android listing on Android and the desktop one everywhere else", () => {
        expect(amoListingUrl("android")).toBe("https://addons.mozilla.org/android/addon/storyhoard/")
        expect(amoListingUrl("win")).toBe("https://addons.mozilla.org/firefox/addon/storyhoard/")
        expect(amoListingUrl(undefined)).toBe("https://addons.mozilla.org/firefox/addon/storyhoard/")
    })
})

describe("firefoxUpdateWaiting", () => {
    const update = { available: true, latestVersion: "0.34.0", publishedAt: published }

    it("waits a day and a half for Firefox's own update before nudging", () => {
        expect(firefoxUpdateWaiting(update, "0.32.2", published + FIREFOX_UPDATE_GRACE_MS - 1)).toBe(false)
        expect(firefoxUpdateWaiting(update, "0.32.2", published + FIREFOX_UPDATE_GRACE_MS)).toBe(true)
    })

    it("stops once the copy has caught up, even if the stored check is old", () => {
        const later = published + FIREFOX_UPDATE_GRACE_MS * 10
        expect(firefoxUpdateWaiting(update, "0.34.0", later)).toBe(false)
        expect(firefoxUpdateWaiting(update, "0.35.0", later)).toBe(false)
    })

    it("never nudges without a stored update", () => {
        const later = published + FIREFOX_UPDATE_GRACE_MS * 10
        expect(firefoxUpdateWaiting(null, "0.32.2", later)).toBe(false)
        expect(firefoxUpdateWaiting({ ...update, available: false }, "0.32.2", later)).toBe(false)
    })

    it("sees a four-part AMO version as newer than the three-part install", () => {
        const fourPart = { available: true, latestVersion: "0.34.0.1", publishedAt: published }
        expect(firefoxUpdateWaiting(fourPart, "0.34.0", published + FIREFOX_UPDATE_GRACE_MS * 2)).toBe(true)
    })
})
