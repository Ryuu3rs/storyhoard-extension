import { describe, expect, it } from "vitest"
import type { LibraryManga } from "./database"
import {
    HostQueue,
    isBackedOff,
    pruneBackoff,
    recordHostBlock,
    recordHostSuccess,
    runBudget,
    selectDueTitles,
    updateIntervalFromStored,
    type HostBackoff
} from "./update-schedule"

const MIN = 60_000
const NOW = 1_000_000_000_000

function title(id: string, extra: Partial<LibraryManga> = {}, started = true): LibraryManga {
    return { id, title: id, ...(started ? { lastReadChapterNumber: 1 } : {}), ...extra } as LibraryManga
}

describe("updateIntervalFromStored", () => {
    it("maps the old hour choices to minutes", () => {
        expect(updateIntervalFromStored({ updateIntervalHours: 0 })).toBe(0)
        expect(updateIntervalFromStored({ updateIntervalHours: 6 })).toBe(360)
        expect(updateIntervalFromStored({ updateIntervalHours: 12 })).toBe(720)
        expect(updateIntervalFromStored({ updateIntervalHours: 24 })).toBe(1440)
    })

    it("keeps a valid minutes value and defaults an unknown one", () => {
        expect(updateIntervalFromStored({ updateIntervalMinutes: 5 })).toBe(5)
        expect(updateIntervalFromStored({ updateIntervalMinutes: 7 })).toBe(720)
        expect(updateIntervalFromStored({})).toBe(720)
    })
})

describe("selectDueTitles", () => {
    it("treats a never-checked title as due and puts it first, then the oldest-checked", () => {
        const titles = [title("recent"), title("old"), title("never")]
        const due = selectDueTitles(titles, { recent: NOW - 6 * MIN, old: NOW - 60 * MIN }, 5, 0, NOW)
        expect(due.map(t => t.id)).toEqual(["never", "old", "recent"])
    })

    it("leaves out a title checked more recently than the interval", () => {
        const due = selectDueTitles([title("a"), title("b")], { a: NOW - 2 * MIN, b: NOW - 5 * MIN }, 5, 0, NOW)
        expect(due.map(t => t.id)).toEqual(["b"])
    })

    it("holds paused, planning and dropped titles to a 6 h floor on a fast schedule", () => {
        const titles = [
            title("reading"),
            title("paused", { readingStatus: "paused" }),
            title("planning", { readingStatus: "planning" }, false),
            title("dropped", { readingStatus: "dropped" })
        ]
        const checked = Object.fromEntries(titles.map(t => [t.id, NOW - 10 * MIN]))
        expect(selectDueTitles(titles, checked, 5, 0, NOW).map(t => t.id)).toEqual(["reading"])
        const later = Object.fromEntries(titles.map(t => [t.id, NOW - 361 * MIN]))
        expect(selectDueTitles(titles, later, 5, 0, NOW)).toHaveLength(4)
    })

    it("uses the chosen interval for a paused title when it is longer than 6 h", () => {
        const titles = [title("paused", { readingStatus: "paused" })]
        expect(selectDueTitles(titles, { paused: NOW - 700 * MIN }, 1440, 0, NOW)).toHaveLength(0)
        expect(selectDueTitles(titles, { paused: NOW - 1441 * MIN }, 1440, 0, NOW)).toHaveLength(1)
    })

    it("treats an auto-paused title as slow", () => {
        const stale = title("stale", { lastReadAt: NOW - 40 * 86_400_000 })
        expect(selectDueTitles([stale], { stale: NOW - 10 * MIN }, 5, 30, NOW)).toHaveLength(0)
        expect(selectDueTitles([stale], { stale: NOW - 10 * MIN }, 5, 0, NOW)).toHaveLength(1)
    })
})

describe("runBudget", () => {
    it("ends a 5 minute schedule run in about 2.5 minutes", () => {
        const budget = runBudget(5)
        expect(budget.wallMs).toBe(150_000)
        expect(budget.maxTitles).toBe(150)
    })

    it("keeps a floor for very short and a ceiling for long schedules", () => {
        expect(runBudget(1).wallMs).toBe(90_000)
        expect(runBudget(1440).wallMs).toBe(14 * MIN)
    })

    it("always leaves the next run room to start", () => {
        for (const minutes of [5, 10, 15, 30, 60, 180, 360, 720, 1440]) {
            expect(runBudget(minutes).wallMs).toBeLessThan(minutes * MIN)
        }
    })
})

type Entry = { id: string; host: string }

describe("HostQueue", () => {
    const items: Entry[] = [
        { id: "a1", host: "a.test" },
        { id: "a2", host: "a.test" },
        { id: "a3", host: "a.test" },
        { id: "b1", host: "b.test" }
    ]
    const pull = (queue: HostQueue<Entry>, at: number) => queue.next(at) as { item: Entry; host: string }

    it("interleaves hosts instead of draining one", () => {
        const queue = new HostQueue(items, item => item.host, 2000)
        const first = pull(queue, 0)
        queue.markRequested(first.host, 0)
        const second = pull(queue, 10)
        expect([first.item.id, second.item.id]).toEqual(["a1", "b1"])
    })

    it("never asks the same host again inside the gap, and says how long to wait", () => {
        const queue = new HostQueue(items, item => item.host, 2000)
        for (const at of [0, 10]) queue.markRequested(pull(queue, at).host, at)
        expect(queue.next(500)).toEqual({ waitMs: 1500 })
        expect(pull(queue, 2000).item.id).toBe("a2")
    })

    it("keeps oldest-first order among ready hosts", () => {
        const queue = new HostQueue(
            [
                { id: "b-old", host: "b.test" },
                { id: "a-new", host: "a.test" }
            ],
            item => item.host
        )
        expect(pull(queue, 0).item.id).toBe("b-old")
    })

    it("drops a skipped host's remaining titles and reports how many", () => {
        const queue = new HostQueue(items, item => item.host)
        expect(queue.skipHost("a.test")).toBe(3)
        expect(queue.size).toBe(1)
        expect(pull(queue, 0).item.id).toBe("b1")
        expect(queue.next(0)).toBeUndefined()
    })
})

describe("host backoff", () => {
    it("blocks a host for 30 minutes, then longer on each repeat", () => {
        const backoff: HostBackoff = {}
        recordHostBlock(backoff, "a.test", NOW)
        expect(isBackedOff(backoff, "a.test", NOW + 29 * MIN)).toBe(true)
        expect(isBackedOff(backoff, "a.test", NOW + 31 * MIN)).toBe(false)
        recordHostBlock(backoff, "a.test", NOW + 31 * MIN)
        expect(backoff["a.test"]?.until).toBe(NOW + 31 * MIN + 60 * MIN)
    })

    it("caps the wait at 6 hours", () => {
        const backoff: HostBackoff = {}
        for (let i = 0; i < 12; i++) recordHostBlock(backoff, "a.test", NOW)
        expect(backoff["a.test"]?.until).toBe(NOW + 360 * MIN)
    })

    it("resets on success", () => {
        const backoff: HostBackoff = {}
        recordHostBlock(backoff, "a.test", NOW)
        recordHostSuccess(backoff, "a.test")
        expect(isBackedOff(backoff, "a.test", NOW)).toBe(false)
        expect(backoff["a.test"]).toBeUndefined()
    })

    it("prunes a first-time entry once it has expired", () => {
        const backoff: HostBackoff = {}
        recordHostBlock(backoff, "a.test", NOW)
        expect(pruneBackoff(backoff, NOW + 31 * MIN)).toEqual({})
    })
})
