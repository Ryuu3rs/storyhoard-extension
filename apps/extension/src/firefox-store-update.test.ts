import { describe, expect, it } from "vitest"
import { amoListingUrl, FIREFOX_UPDATE_GRACE_MS, firefoxUpdateWaiting, parseAmoAddon } from "./firefox-store-update"

const published = Date.parse("2026-11-26T15:23:32Z")

describe("parseAmoAddon", () => {
    it("reads the public version and when its file was published", () => {
        expect(
            parseAmoAddon({ current_version: { version: "0.33.2", file: { created: "2026-11-26T15:23:32Z" } } })
        ).toEqual({ version: "0.33.2", publishedAt: published })
    })

    it.each([
        ["no body", null],
        ["no current version", {}],
        [
            "a version that is not a version",
            { current_version: { version: "1.0<x>", file: { created: "2026-11-26" } } }
        ],
        ["a numeric version", { current_version: { version: 2, file: { created: "2026-11-26" } } }],
        ["no file date", { current_version: { version: "1.0.0", file: {} } }],
        ["a bad file date", { current_version: { version: "1.0.0", file: { created: "soon" } } }]
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
})
