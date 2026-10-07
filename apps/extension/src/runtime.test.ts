import { describe, expect, it } from "vitest"
import { runtimeRequestSchema } from "./runtime"

describe("source:* (Add site) schema", () => {
    const url = "https://reader.example/manga/demo/chapter-1"

    it("accepts detect and add-from-tab with a url and an optional tab id", () => {
        for (const type of ["source:detect", "source:add-from-tab"]) {
            expect(runtimeRequestSchema.safeParse({ type, url }).success).toBe(true)
            expect(runtimeRequestSchema.safeParse({ type, url, tabId: 12 }).success).toBe(true)
        }
    })

    it("rejects a missing or malformed url and a bad tab id", () => {
        for (const type of ["source:detect", "source:add-from-tab"]) {
            expect(runtimeRequestSchema.safeParse({ type }).success).toBe(false)
            expect(runtimeRequestSchema.safeParse({ type, url: "not a url" }).success).toBe(false)
            expect(runtimeRequestSchema.safeParse({ type, url, tabId: -1 }).success).toBe(false)
            expect(runtimeRequestSchema.safeParse({ type, url, tabId: "7" }).success).toBe(false)
        }
    })

    it("accepts list, and remove with an id", () => {
        expect(runtimeRequestSchema.safeParse({ type: "source:list" }).success).toBe(true)
        expect(runtimeRequestSchema.safeParse({ type: "source:remove", id: "reader.example" }).success).toBe(true)
    })

    it("rejects remove without an id", () => {
        expect(runtimeRequestSchema.safeParse({ type: "source:remove" }).success).toBe(false)
        expect(runtimeRequestSchema.safeParse({ type: "source:remove", id: "" }).success).toBe(false)
    })

    it("no longer accepts the retired untyped arch:* messages", () => {
        for (const type of ["arch:importProfile", "arch:listProfiles", "arch:deleteProfile", "arch:captureTab"]) {
            expect(runtimeRequestSchema.safeParse({ type }).success).toBe(false)
        }
    })
})

describe("settings:update schema", () => {
    it("accepts the reading-preference fields", () => {
        const msg = {
            type: "settings:update",
            settings: {
                readingDirection: "rtl",
                pageFit: "contain",
                showPageNumber: false,
                preloadPages: 5
            }
        }
        expect(runtimeRequestSchema.safeParse(msg).success).toBe(true)
    })

    it("rejects an out-of-range preload count", () => {
        const msg = { type: "settings:update", settings: { preloadPages: 99 } }
        expect(runtimeRequestSchema.safeParse(msg).success).toBe(false)
    })

    it("rejects an unknown reading direction", () => {
        const msg = { type: "settings:update", settings: { readingDirection: "diagonal" } }
        expect(runtimeRequestSchema.safeParse(msg).success).toBe(false)
    })

    it("rejects an unknown page fit", () => {
        const msg = { type: "settings:update", settings: { pageFit: "stretch" } }
        expect(runtimeRequestSchema.safeParse(msg).success).toBe(false)
    })

    it("accepts openChapterIn and rejects unknown values", () => {
        expect(
            runtimeRequestSchema.safeParse({ type: "settings:update", settings: { openChapterIn: "browser" } }).success
        ).toBe(true)
        expect(
            runtimeRequestSchema.safeParse({ type: "settings:update", settings: { openChapterIn: "telepathy" } })
                .success
        ).toBe(false)
    })
})

describe("library:rate schema", () => {
    it("accepts a 1-5 rating and 0 to clear", () => {
        expect(runtimeRequestSchema.safeParse({ type: "library:rate", mangaId: "m1", rating: 4 }).success).toBe(true)
        expect(runtimeRequestSchema.safeParse({ type: "library:rate", mangaId: "m1", rating: 0 }).success).toBe(true)
    })

    it("rejects out-of-range and non-integer ratings", () => {
        expect(runtimeRequestSchema.safeParse({ type: "library:rate", mangaId: "m1", rating: 6 }).success).toBe(false)
        expect(runtimeRequestSchema.safeParse({ type: "library:rate", mangaId: "m1", rating: 2.5 }).success).toBe(false)
    })
})

describe("sync schema (G5)", () => {
    it("accepts sync:config patches and action messages", () => {
        expect(
            runtimeRequestSchema.safeParse({ type: "sync:config", config: { token: "ghp_x", autoSync: true } }).success
        ).toBe(true)
        expect(runtimeRequestSchema.safeParse({ type: "sync:push" }).success).toBe(true)
        expect(runtimeRequestSchema.safeParse({ type: "sync:pull" }).success).toBe(true)
        expect(runtimeRequestSchema.safeParse({ type: "sync:status" }).success).toBe(true)
    })

    it("rejects a non-boolean autoSync", () => {
        expect(runtimeRequestSchema.safeParse({ type: "sync:config", config: { autoSync: "yes" } }).success).toBe(false)
    })
})

describe("library:reading-prefs schema", () => {
    it("accepts valid direction and fit overrides", () => {
        expect(
            runtimeRequestSchema.safeParse({
                type: "library:reading-prefs",
                mangaId: "m1",
                readingDirection: "rtl",
                pageFit: "width"
            }).success
        ).toBe(true)
    })

    it("accepts null to clear overrides", () => {
        expect(
            runtimeRequestSchema.safeParse({
                type: "library:reading-prefs",
                mangaId: "m1",
                readingDirection: null,
                pageFit: null
            }).success
        ).toBe(true)
    })

    it("rejects invalid direction", () => {
        expect(
            runtimeRequestSchema.safeParse({
                type: "library:reading-prefs",
                mangaId: "m1",
                readingDirection: "diagonal"
            }).success
        ).toBe(false)
    })

    it("accepts a boolean noGapContinuous override and null to clear it", () => {
        expect(
            runtimeRequestSchema.safeParse({
                type: "library:reading-prefs",
                mangaId: "m1",
                noGapContinuous: true
            }).success
        ).toBe(true)
        expect(
            runtimeRequestSchema.safeParse({
                type: "library:reading-prefs",
                mangaId: "m1",
                noGapContinuous: null
            }).success
        ).toBe(true)
    })

    it("rejects a non-boolean noGapContinuous", () => {
        expect(
            runtimeRequestSchema.safeParse({
                type: "library:reading-prefs",
                mangaId: "m1",
                noGapContinuous: "yes"
            }).success
        ).toBe(false)
    })

    it("accepts continuousScroll + readerTheme overrides and null to clear them", () => {
        expect(
            runtimeRequestSchema.safeParse({
                type: "library:reading-prefs",
                mangaId: "m1",
                continuousScroll: true,
                readerTheme: "dark"
            }).success
        ).toBe(true)
        expect(
            runtimeRequestSchema.safeParse({
                type: "library:reading-prefs",
                mangaId: "m1",
                continuousScroll: null,
                readerTheme: null
            }).success
        ).toBe(true)
    })

    it("rejects an invalid readerTheme", () => {
        expect(
            runtimeRequestSchema.safeParse({
                type: "library:reading-prefs",
                mangaId: "m1",
                readerTheme: "sepia"
            }).success
        ).toBe(false)
    })
})

describe("manual tracking schema (G2)", () => {
    it("accepts library:manual toggles", () => {
        expect(runtimeRequestSchema.safeParse({ type: "library:manual", mangaId: "m1", manual: true }).success).toBe(
            true
        )
    })

    it("accepts library:hold toggles", () => {
        expect(runtimeRequestSchema.safeParse({ type: "library:hold", mangaId: "m1", onHold: true }).success).toBe(true)
    })

    it("accepts library:numbers with values or null to clear", () => {
        expect(
            runtimeRequestSchema.safeParse({ type: "library:numbers", mangaId: "m1", latestChapterNumber: 161 }).success
        ).toBe(true)
        expect(
            runtimeRequestSchema.safeParse({ type: "library:numbers", mangaId: "m1", lastReadChapterNumber: null })
                .success
        ).toBe(true)
    })

    it("rejects negative chapter numbers", () => {
        expect(
            runtimeRequestSchema.safeParse({ type: "library:numbers", mangaId: "m1", latestChapterNumber: -3 }).success
        ).toBe(false)
    })

    it("accepts library:categories arrays", () => {
        expect(
            runtimeRequestSchema.safeParse({ type: "library:categories", mangaId: "m1", categories: ["a", "b"] })
                .success
        ).toBe(true)
        expect(
            runtimeRequestSchema.safeParse({ type: "library:categories", mangaId: "m1", categories: [] }).success
        ).toBe(true)
    })
})
