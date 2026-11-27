import { describe, it, expect } from "vitest"
import type { LibraryManga } from "./database"
import {
    neverRead,
    hasNewerChapters,
    hasKnownLatest,
    statusOf,
    readChapterLabel,
    effectiveReadingStatus,
    isOngoing,
    unreadChapterCount
} from "./reading-status"

function manga(fields: Partial<LibraryManga>): LibraryManga {
    return fields as LibraryManga
}

describe("unreadChapterCount", () => {
    it.each([
        [61.3, 61, 1],
        [62, 61.6, 1],
        [70, 61, 9],
        [61, 61, 0],
        [60, 61, 0]
    ])("latest %d read %d gives %d", (latest, read, count) => {
        expect(unreadChapterCount(manga({ latestChapterNumber: latest, lastReadChapterNumber: read }))).toBe(count)
    })

    it("counts a newer chapter known only by id as one", () => {
        expect(unreadChapterCount(manga({ latestChapterId: "b", lastReadChapterId: "a" }))).toBe(1)
    })
})

const NOW = 10_000 * 86_400_000 // a large, stable "now" in epoch ms

describe("reading-status", () => {
    it("treats a fully unread title as unread", () => {
        const m = manga({})
        expect(neverRead(m)).toBe(true)
        expect(statusOf(m)).toBe("unread")
        expect(readChapterLabel(m)).toBe("Unread")
    })

    it("labels a numbered read position", () => {
        const m = manga({ lastReadChapterId: "c12", lastReadChapterNumber: 12 })
        expect(readChapterLabel(m)).toBe("Ch 12")
        expect(readChapterLabel(m, "Read ch")).toBe("Read ch 12")
    })

    // A MangaDex oneshot: single chapter has sortKey Infinity, so only the *Id
    // fields are stored. The old number-only renderers wrongly printed "Unread".
    it("labels a read but unnumbered oneshot as Read, not Unread", () => {
        const m = manga({ lastReadChapterId: "one", latestChapterId: "one", status: "completed" })
        expect(neverRead(m)).toBe(false)
        expect(hasNewerChapters(m)).toBe(false)
        expect(statusOf(m)).toBe("completed")
        expect(readChapterLabel(m)).toBe("Read")
        expect(readChapterLabel(m, "Read ch")).toBe("Read")
    })

    it("marks a caught-up numbered title completed", () => {
        const m = manga({
            lastReadChapterId: "c15",
            lastReadChapterNumber: 15,
            latestChapterId: "c15",
            latestChapterNumber: 15,
            status: "completed"
        })
        expect(statusOf(m)).toBe("completed")
        expect(hasNewerChapters(m)).toBe(false)
    })

    // Caught up on an ONGOING series is "reading" (up to date), not completed - this is
    // what keeps a just-mark-read title in the default Ongoing view instead of vanishing.
    it("marks a caught-up ONGOING title reading, not completed", () => {
        const m = manga({
            lastReadChapterId: "c15",
            lastReadChapterNumber: 15,
            latestChapterId: "c15",
            latestChapterNumber: 15,
            status: "ongoing"
        })
        expect(statusOf(m)).toBe("reading")
        const eff = effectiveReadingStatus(m, { autoPauseDays: 0, now: NOW })
        expect(eff).toBe("reading")
        expect(isOngoing(eff)).toBe(true)
    })

    // A freshly mark-read externally-tracked title has status "unknown" until enrichment
    // runs - it must stay reading (visible in Ongoing), not derive as completed.
    it("marks a caught-up unknown-status title reading, not completed", () => {
        const m = manga({
            lastReadChapterId: "c1",
            lastReadChapterNumber: 1,
            latestChapterId: "c1",
            latestChapterNumber: 1,
            status: "unknown"
        })
        expect(statusOf(m)).toBe("reading")
    })

    it("marks a title with newer chapters reading", () => {
        const m = manga({
            lastReadChapterId: "c12",
            lastReadChapterNumber: 12,
            latestChapterId: "c15",
            latestChapterNumber: 15
        })
        expect(statusOf(m)).toBe("reading")
        expect(hasNewerChapters(m)).toBe(true)
    })

    // After an import/migration the ids legitimately differ while numbers match;
    // the number comparison must win so a caught-up title is not flagged unread.
    it("prefers the number comparison over differing ids", () => {
        const m = manga({
            lastReadChapterId: "old-source-c15",
            lastReadChapterNumber: 15,
            latestChapterId: "new-source-c15",
            latestChapterNumber: 15,
            status: "completed"
        })
        expect(hasNewerChapters(m)).toBe(false)
        expect(statusOf(m)).toBe("completed")
    })

    // A read title whose latest is unknown (e.g. an AniList import with no source
    // linked yet) is NOT caught up - it must not be reported completed.
    it("does not mark a read title with unknown latest completed", () => {
        const m = manga({ lastReadChapterNumber: 5 })
        expect(hasKnownLatest(m)).toBe(false)
        expect(statusOf(m)).toBe("reading")
    })

    it("treats a finite latestChapterNumber or non-empty latestChapterId as known latest", () => {
        expect(hasKnownLatest(manga({ latestChapterNumber: 3 }))).toBe(true)
        expect(hasKnownLatest(manga({ latestChapterId: "c3" }))).toBe(true)
        expect(hasKnownLatest(manga({ latestChapterId: "" }))).toBe(false)
        expect(hasKnownLatest(manga({}))).toBe(false)
    })
})

describe("effectiveReadingStatus", () => {
    const opts = { autoPauseDays: 0, now: NOW }

    it("returns unread for a never-opened title with no override", () => {
        expect(effectiveReadingStatus(manga({}), opts)).toBe("unread")
    })

    it("returns reading for a started-but-behind title", () => {
        const m = manga({ lastReadChapterNumber: 12, latestChapterNumber: 15 })
        expect(effectiveReadingStatus(m, opts)).toBe("reading")
    })

    it("returns completed for a caught-up title", () => {
        const m = manga({
            lastReadChapterId: "c15",
            lastReadChapterNumber: 15,
            latestChapterId: "c15",
            latestChapterNumber: 15,
            status: "completed"
        })
        expect(effectiveReadingStatus(m, opts)).toBe("completed")
    })

    it("returns planning only for a not-yet-started planning title", () => {
        expect(effectiveReadingStatus(manga({ readingStatus: "planning" }), opts)).toBe("planning")
        // Once started, planning no longer applies - it reads as reading/completed.
        const started = manga({ readingStatus: "planning", lastReadChapterNumber: 3, latestChapterNumber: 8 })
        expect(effectiveReadingStatus(started, opts)).toBe("reading")
    })

    it("returns paused for an explicit paused override (still behind)", () => {
        const m = manga({ readingStatus: "paused", lastReadChapterNumber: 4, latestChapterNumber: 9 })
        expect(effectiveReadingStatus(m, opts)).toBe("on-hold")
    })

    it("returns on-hold for the onHold flag, unifying it with the old paused status", () => {
        const m = manga({ onHold: true, lastReadChapterNumber: 4, latestChapterNumber: 9 })
        expect(effectiveReadingStatus(m, opts)).toBe("on-hold")
    })

    it("returns dropped for an explicit dropped override (still behind)", () => {
        const m = manga({ readingStatus: "dropped", lastReadChapterNumber: 4, latestChapterNumber: 9 })
        expect(effectiveReadingStatus(m, opts)).toBe("dropped")
    })

    // LOCAL ACTIVITY WINS: a stored paused/dropped is overridden by real local completion.
    it("completed beats a stored dropped when caught up", () => {
        const m = manga({
            readingStatus: "dropped",
            lastReadChapterNumber: 20,
            latestChapterNumber: 20,
            lastReadChapterId: "c20",
            latestChapterId: "c20",
            status: "completed"
        })
        expect(effectiveReadingStatus(m, opts)).toBe("completed")
    })

    it("completed beats a stored paused when caught up", () => {
        const m = manga({
            readingStatus: "paused",
            lastReadChapterNumber: 20,
            latestChapterNumber: 20,
            lastReadChapterId: "c20",
            latestChapterId: "c20",
            status: "completed"
        })
        expect(effectiveReadingStatus(m, opts)).toBe("completed")
    })

    // A read title whose latest is unknown is not "caught up": completion must not
    // fire, so a stored dropped/paused is honoured and the bare case reads "reading".
    it("honours a stored dropped for a read title with unknown latest", () => {
        const m = manga({ readingStatus: "dropped", lastReadChapterNumber: 5 })
        expect(effectiveReadingStatus(m, opts)).toBe("dropped")
    })

    it("honours a stored paused for a read title with unknown latest", () => {
        const m = manga({ readingStatus: "paused", lastReadChapterNumber: 5 })
        expect(effectiveReadingStatus(m, opts)).toBe("on-hold")
    })

    it("reads a read title with unknown latest and no override as reading, not completed", () => {
        const m = manga({ lastReadChapterNumber: 5 })
        expect(effectiveReadingStatus(m, opts)).toBe("reading")
    })

    it("still marks a read title with known latest and caught up as completed", () => {
        const m = manga({
            lastReadChapterId: "c9",
            lastReadChapterNumber: 9,
            latestChapterId: "c9",
            latestChapterNumber: 9,
            status: "completed"
        })
        expect(effectiveReadingStatus(m, opts)).toBe("completed")
    })

    it("dropped takes precedence over paused when both a drop override and paused apply", () => {
        // readingStatus can only hold one value, but auto-pause could also trigger; a
        // dropped override still wins the paused branch below it.
        const m = manga({
            readingStatus: "dropped",
            lastReadChapterNumber: 4,
            latestChapterNumber: 9,
            lastReadAt: NOW - 100 * 86_400_000
        })
        expect(effectiveReadingStatus(m, { autoPauseDays: 30, now: NOW })).toBe("dropped")
    })

    describe("auto-pause window", () => {
        it("does not auto-pause when autoPauseDays is 0 (off), however stale", () => {
            const m = manga({
                lastReadChapterNumber: 4,
                latestChapterNumber: 9,
                lastReadAt: NOW - 999 * 86_400_000
            })
            expect(effectiveReadingStatus(m, { autoPauseDays: 0, now: NOW })).toBe("reading")
        })

        it("auto-pauses a title whose last read is older than the window", () => {
            const m = manga({
                lastReadChapterNumber: 4,
                latestChapterNumber: 9,
                lastReadAt: NOW - 31 * 86_400_000
            })
            expect(effectiveReadingStatus(m, { autoPauseDays: 30, now: NOW })).toBe("on-hold")
        })

        it("does not auto-pause a title read within the window", () => {
            const m = manga({
                lastReadChapterNumber: 4,
                latestChapterNumber: 9,
                lastReadAt: NOW - 10 * 86_400_000
            })
            expect(effectiveReadingStatus(m, { autoPauseDays: 30, now: NOW })).toBe("reading")
        })

        it("never auto-pauses a caught-up (completed) title", () => {
            const m = manga({
                lastReadChapterId: "c9",
                lastReadChapterNumber: 9,
                latestChapterId: "c9",
                latestChapterNumber: 9,
                status: "completed",
                lastReadAt: NOW - 999 * 86_400_000
            })
            expect(effectiveReadingStatus(m, { autoPauseDays: 30, now: NOW })).toBe("completed")
        })

        it("does not auto-pause when lastReadAt is absent", () => {
            const m = manga({ lastReadChapterNumber: 4, latestChapterNumber: 9 })
            expect(effectiveReadingStatus(m, { autoPauseDays: 30, now: NOW })).toBe("reading")
        })
    })
})

describe("isOngoing", () => {
    it("treats unread/reading/planning as ongoing", () => {
        expect(isOngoing("unread")).toBe(true)
        expect(isOngoing("reading")).toBe(true)
        expect(isOngoing("planning")).toBe(true)
    })

    it("treats paused/dropped/completed as not ongoing", () => {
        expect(isOngoing("on-hold")).toBe(false)
        expect(isOngoing("dropped")).toBe(false)
        expect(isOngoing("completed")).toBe(false)
    })
})
