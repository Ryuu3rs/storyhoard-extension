import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { LibraryManga } from "./database"
import { rowSubtitle, timeAgo } from "./popup-row"

const NOW = Date.UTC(2026, 10, 24, 12)
const row = (over: Partial<LibraryManga>): LibraryManga =>
    ({
        id: "t:1",
        title: "Title",
        normalizedTitle: "title",
        authors: [],
        status: "ongoing",
        addedAt: 1,
        updatedAt: NOW - 5_000,
        sourceId: "reader-example",
        sourceUrl: "https://reader.example/t/1",
        ...over
    }) as LibraryManga

describe("popup row subtitle", () => {
    it("separates the chapter line from the time with a spaced dot", () => {
        expect(
            rowSubtitle(
                row({ lastReadChapterNumber: 3, latestChapterNumber: 10, latestChapterAt: NOW - 3 * 3_600_000 }),
                NOW
            )
        ).toBe("Ch 3 of 10 · 3h ago")
        expect(rowSubtitle(row({}), NOW)).toBe("Unread · just now")
    })

    it("shows the chapter line alone when there is no time", () => {
        expect(rowSubtitle(row({ lastReadChapterNumber: 2, updatedAt: 0 }), NOW)).toBe("Ch 2")
    })

    it("reads the time in plain units", () => {
        expect(timeAgo(undefined, NOW)).toBe("")
        expect(timeAgo(NOW - 90_000, NOW)).toBe("1m ago")
        expect(timeAgo(NOW - 3 * 86_400_000, NOW)).toBe("3d ago")
    })

    it("is what the popup renders, so no template whitespace can eat the separator's spaces", () => {
        const popup = readFileSync(fileURLToPath(new URL("../entrypoints/popup/App.svelte", import.meta.url)), "utf8")
        expect(popup).toContain("{rowSubtitle(m, now)}")
        expect(popup).not.toMatch(/\{#if ago\(/)
    })
})
