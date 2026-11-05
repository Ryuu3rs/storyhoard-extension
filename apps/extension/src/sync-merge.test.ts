import { describe, expect, it } from "vitest"
import type { SyncItem } from "./account"
import { buildPatch, dirtyFields, mergePulled } from "./sync-merge"

const base: SyncItem = {
    clientId: "a",
    title: "A",
    normalizedTitle: "a",
    rating: 3,
    notes: "note",
    lastReadChapterNumber: 10,
    latestChapterNumber: 20,
    lastReadAt: 1000,
    readingStatus: null,
    readingStatusUpdatedAt: null,
    clientUpdatedAt: 5000
}

describe("dirtyFields", () => {
    it("is empty when nothing changed, and treats missing and null as the same", () => {
        expect(dirtyFields({ ...base, nsfw: null }, base)).toEqual([])
    })

    it("names only what changed", () => {
        expect(dirtyFields({ ...base, rating: 5, notes: null }, base)).toEqual(["rating", "notes"])
    })
})

describe("buildPatch", () => {
    it("sends nothing when nothing changed", () => {
        expect(buildPatch(base, base, 9000)).toBeNull()
    })

    it("sends only the changed field, and null to clear", () => {
        expect(buildPatch({ ...base, notes: null }, base, 9000)).toEqual({
            clientId: "a",
            patch: true,
            clientUpdatedAt: 9000,
            notes: null
        })
    })

    it("never sends a clock older than the server's, even with a slow device clock", () => {
        expect(buildPatch({ ...base, rating: 4 }, base, 100)?.clientUpdatedAt).toBe(5001)
    })

    it("stamps a status change", () => {
        const patch = buildPatch({ ...base, readingStatus: "paused", readingStatusUpdatedAt: 7000 }, base, 9000)
        expect(patch).toMatchObject({ readingStatus: "paused", readingStatusUpdatedAt: 7000 })
    })

    it("carries a reset stamp only when the reset is new", () => {
        const lowered = { ...base, lastReadChapterNumber: 2, progressResetAt: 8000 }
        expect(buildPatch(lowered, base, 9000)).toMatchObject({ lastReadChapterNumber: 2, progressResetAt: 8000 })
        const again = { ...lowered, lastReadChapterNumber: 3 }
        expect(buildPatch(again, { ...base, progressResetAt: 8000 }, 9000)).not.toHaveProperty("progressResetAt")
    })

    it("carries the latest chapter's reset stamp", () => {
        const repaired = { ...base, latestChapterNumber: 5, latestResetAt: 8000 }
        expect(buildPatch(repaired, base, 9000)).toMatchObject({ latestChapterNumber: 5, latestResetAt: 8000 })
    })
})

describe("mergePulled", () => {
    const merge = (local: Partial<SyncItem>, shadow: Partial<SyncItem>, remote: Partial<SyncItem>) =>
        mergePulled({ ...base, ...local }, { ...base, ...shadow }, { ...base, ...remote }, 6000)

    it("takes what only the server changed, including a clear", () => {
        expect(merge({}, {}, { rating: 5, notes: null }).changes).toEqual({ rating: 5, notes: null })
    })

    it("keeps a local edit when the server changed something else", () => {
        const { changes, kept } = merge({ notes: "mine" }, {}, { rating: 5 })
        expect(changes).toEqual({ rating: 5 })
        expect(kept).toEqual(["notes"])
    })

    it("keeps a local clear instead of bringing the value back", () => {
        const { changes, kept } = merge({ rating: null }, {}, {})
        expect(changes).toEqual({})
        expect(kept).toEqual(["rating"])
    })

    it("does not blank an app's rating because this device never had one", () => {
        const { changes } = merge({ rating: null }, { rating: null }, { rating: 4 })
        expect(changes).toEqual({ rating: 4 })
    })

    it("never lowers progress without a reset", () => {
        const { changes, kept } = merge({ lastReadChapterNumber: 30 }, { lastReadChapterNumber: 10 }, {})
        expect(changes).not.toHaveProperty("lastReadChapterNumber")
        expect(kept).toContain("lastReadChapterNumber")
    })

    it("raises progress from the server even over a local edit", () => {
        const { changes } = merge({ lastReadChapterNumber: 12 }, {}, { lastReadChapterNumber: 15 })
        expect(changes.lastReadChapterNumber).toBe(15)
    })

    it("lowers progress when the server holds a newer reset, and clears the time with it", () => {
        const { changes } = merge(
            { lastReadChapterNumber: 30, lastReadAt: 2000 },
            {},
            { lastReadChapterNumber: null, lastReadAt: null, progressResetAt: 7000 }
        )
        expect(changes).toMatchObject({ lastReadChapterNumber: null, lastReadAt: null })
    })

    it("keeps a local reset that is newer than the server's progress", () => {
        const { changes, kept } = merge(
            { lastReadChapterNumber: 2, progressResetAt: 7000 },
            {},
            { lastReadChapterNumber: 15 }
        )
        expect(changes).not.toHaveProperty("lastReadChapterNumber")
        expect(kept).toContain("lastReadChapterNumber")
    })

    it("applies a repair that lowers the latest chapter", () => {
        const { changes } = merge(
            { latestChapterNumber: 999 },
            { latestChapterNumber: 999 },
            {
                latestChapterNumber: 20,
                latestResetAt: 7000
            }
        )
        expect(changes.latestChapterNumber).toBe(20)
    })

    it("lets the newest status win by its own clock, whichever row is newer", () => {
        const theirs = merge(
            { readingStatus: "paused", readingStatusUpdatedAt: 7000 },
            {},
            { readingStatus: "dropped", readingStatusUpdatedAt: 8000 }
        )
        expect(theirs.changes.readingStatus).toBe("dropped")
        const mine = merge(
            { readingStatus: "paused", readingStatusUpdatedAt: 8000 },
            {},
            { readingStatus: "dropped", readingStatusUpdatedAt: 7000 }
        )
        expect(mine.changes).not.toHaveProperty("readingStatus")
        expect(mine.kept).toContain("readingStatus")
    })

    it("with no shadow, lets the newer row win", () => {
        const older = mergePulled(
            { ...base, notes: "mine" },
            undefined,
            { ...base, notes: "theirs", clientUpdatedAt: 1 },
            6000
        )
        expect(older.changes).toEqual({})
        expect(older.kept).toEqual(["notes"])
        const newer = mergePulled(
            { ...base, notes: "mine" },
            undefined,
            { ...base, notes: "theirs", clientUpdatedAt: 9000 },
            6000
        )
        expect(newer.changes).toEqual({ notes: "theirs" })
    })
})
