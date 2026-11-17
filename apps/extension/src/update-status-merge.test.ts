import { describe, expect, it } from "vitest"
import { mergeSourceStatus, mergeTitleStatus, type MergeableStatus } from "./update-status-merge"

const ERROR_ROWS_CAP = 200

const previous: MergeableStatus = {
    checked: 10,
    updated: 2,
    failed: 3,
    checkedAt: 1,
    errors: [
        { mangaId: "a", sourceId: "s1" },
        { mangaId: "b", sourceId: "s2" },
        { mangaId: "c", sourceId: "s2" }
    ],
    relinkTitles: [{ mangaId: "d", sourceId: "s1" }],
    needsVerify: [{ origin: "https://s2.example", sourceId: "s2" }],
    failuresBySource: { s1: 1, s2: 2 },
    needsRelink: { s1: 1 },
    causesBySource: { s1: { "http-404": 1 }, s2: { network: 2 } }
}

describe("mergeSourceStatus", () => {
    it("swaps one site's rows and counts, keeping every other site's", () => {
        const run: MergeableStatus = {
            checked: 2,
            updated: 1,
            failed: 0,
            checkedAt: 9,
            errors: [],
            relinkTitles: [],
            needsVerify: [],
            failuresBySource: {},
            needsRelink: {},
            causesBySource: {}
        }
        const merged = mergeSourceStatus(previous, run, ["s2"])
        expect(merged.errors).toEqual([{ mangaId: "a", sourceId: "s1" }])
        expect(merged.needsVerify).toEqual([])
        expect(merged.relinkTitles).toEqual([{ mangaId: "d", sourceId: "s1" }])
        expect(merged.failuresBySource).toEqual({ s1: 1 })
        expect(merged.causesBySource).toEqual({ s1: { "http-404": 1 } })
        expect(merged.failed).toBe(1)
        expect(merged.updated).toBe(3)
        expect(merged.checkedAt).toBe(9)
    })

    it("adds the site's new problems from the run", () => {
        const run: MergeableStatus = {
            checked: 1,
            updated: 0,
            failed: 1,
            checkedAt: 9,
            errors: [{ mangaId: "z", sourceId: "s1" }],
            failuresBySource: { s1: 1 }
        }
        const merged = mergeSourceStatus(previous, run, ["s1"])
        expect(merged.errors?.map(row => (row as { mangaId: string }).mangaId)).toEqual(["b", "c", "z"])
        expect(merged.relinkTitles).toEqual([])
        expect(merged.needsRelink).toEqual({})
        expect(merged.failed).toBe(3)
    })

    it("uses the run as is when nothing was stored", () => {
        const run: MergeableStatus = { checked: 1, updated: 0, failed: 0, checkedAt: 9 }
        expect(mergeSourceStatus(undefined, run, ["s1"])).toBe(run)
    })

    it("swaps several sites at once from one run", () => {
        const run: MergeableStatus = { checked: 3, updated: 1, failed: 0, checkedAt: 9, errors: [] }
        const merged = mergeSourceStatus(previous, run, ["s1", "s2"])
        expect(merged.errors).toEqual([])
        expect(merged.relinkTitles).toEqual([])
        expect(merged.failed).toBe(0)
        expect(merged.updated).toBe(3)
    })
})

describe("mergeTitleStatus", () => {
    const scheduledRun = (extra: Partial<MergeableStatus> = {}): MergeableStatus => ({
        checked: 1,
        updated: 0,
        failed: 0,
        checkedAt: 9,
        scheduled: true,
        errors: [],
        relinkTitles: [],
        needsVerify: [],
        failuresBySource: {},
        needsRelink: {},
        causesBySource: {},
        ...extra
    })

    it("keeps the problems of titles the run did not check", () => {
        const merged = mergeTitleStatus(previous, scheduledRun(), new Set(["new"]), new Set(["s3"]))
        expect(merged.errors).toEqual(previous.errors)
        expect(merged.relinkTitles).toEqual(previous.relinkTitles)
        expect(merged.failuresBySource).toEqual({ s2: 2, s1: 1 })
        expect(merged.needsVerify).toEqual(previous.needsVerify)
        expect(merged.failed).toBe(3)
        expect(merged.checked).toBe(1)
        expect(merged.scheduled).toBe(true)
    })

    it("replaces the rows and counts of the titles it checked", () => {
        const run = scheduledRun({
            failed: 1,
            errors: [{ mangaId: "c", sourceId: "s2" }],
            failuresBySource: { s2: 1 },
            causesBySource: { s2: { "http-404": 1 } }
        })
        const merged = mergeTitleStatus(previous, run, new Set(["a", "b", "c", "d"]), new Set(["s1", "s2"]))
        expect(merged.errors).toEqual([{ mangaId: "c", sourceId: "s2" }])
        expect(merged.relinkTitles).toEqual([])
        expect(merged.failuresBySource).toEqual({ s2: 1 })
        expect(merged.needsRelink).toEqual({})
        expect(merged.failed).toBe(1)
        expect(merged.needsVerify).toEqual([])
        expect(merged.causesBySource).toEqual({ s2: { "http-404": 1 } })
    })

    it("puts the run's rows first so a capped list keeps the newest", () => {
        const run = scheduledRun({ failed: 1, errors: [{ mangaId: "z", sourceId: "s1" }], failuresBySource: { s1: 1 } })
        const merged = mergeTitleStatus(previous, run, new Set(["z"]), new Set(["s1"]))
        expect(merged.errors?.map(row => row.mangaId)).toEqual(["z", "a", "b", "c"])
        expect(merged.failuresBySource).toEqual({ s1: 2, s2: 2 })
        expect(merged.failed).toBe(4)
    })

    it("uses the run as is when nothing was stored", () => {
        const run = scheduledRun()
        expect(mergeTitleStatus(undefined, run, new Set(), new Set())).toBe(run)
    })

    it("does not count a re-failing title twice when its row fell past the 200-row cap", () => {
        // A full check stored before the id lists existed: 300 failing titles, 200 rows kept.
        const all = Array.from({ length: 300 }, (_, i) => ({ mangaId: `t${i}`, sourceId: "s1" }))
        const stored: MergeableStatus = {
            checked: 300,
            updated: 0,
            failed: 300,
            checkedAt: 1,
            errors: all.slice(0, ERROR_ROWS_CAP),
            failuresBySource: { s1: 300 }
        }
        const rechecked = all.slice(ERROR_ROWS_CAP)
        const run = scheduledRun({
            checked: 100,
            failed: 100,
            errors: rechecked,
            failedTitleIds: { s1: rechecked.map(row => row.mangaId) },
            failuresBySource: { s1: 100 }
        })
        const merged = mergeTitleStatus(stored, run, new Set(rechecked.map(r => r.mangaId)), new Set(["s1"]))
        expect(merged.failed).toBe(300)
        expect(merged.failuresBySource).toEqual({ s1: 300 })
    })

    it("keeps the counts steady over repeated runs that re-check titles whose rows were capped away", () => {
        const ids = Array.from({ length: 250 }, (_, i) => `t${i}`)
        const rows = ids.map(mangaId => ({ mangaId, sourceId: "s1" }))
        const runOf = (checked: string[]): MergeableStatus =>
            scheduledRun({
                checked: checked.length,
                failed: checked.length,
                errors: rows.filter(row => checked.includes(row.mangaId)).slice(0, ERROR_ROWS_CAP),
                relinkTitles: rows.filter(row => checked.includes(row.mangaId)).slice(0, ERROR_ROWS_CAP),
                failedTitleIds: { s1: checked },
                relinkTitleIds: { s2: checked },
                failuresBySource: { s1: checked.length },
                needsRelink: { s2: checked.length }
            })
        let status: MergeableStatus = runOf(ids)
        for (const batch of [ids.slice(200), ids.slice(0, 120), ids.slice(220), ids]) {
            const merged = mergeTitleStatus(status, runOf(batch), new Set(batch), new Set(["s1", "s2"]))
            status = {
                ...merged,
                errors: merged.errors!.slice(0, ERROR_ROWS_CAP),
                relinkTitles: merged.relinkTitles!.slice(0, ERROR_ROWS_CAP)
            }
            expect(status.failed).toBe(250)
            expect(status.failuresBySource).toEqual({ s1: 250 })
            expect(status.needsRelink).toEqual({ s2: 250 })
        }
    })

    it("takes a title out of its old site's count when a run finds it on another", () => {
        const stored = scheduledRun({ failed: 1, failedTitleIds: { s1: ["a"] }, failuresBySource: { s1: 1 } })
        const run = scheduledRun({ failed: 1, failedTitleIds: { s2: ["a"] }, failuresBySource: { s2: 1 } })
        const merged = mergeTitleStatus(stored, run, new Set(["a"]), new Set(["s2"]))
        expect(merged.failedTitleIds).toEqual({ s2: ["a"] })
        expect(merged.failuresBySource).toEqual({ s2: 1 })
        expect(merged.failed).toBe(1)
    })
})

describe("mergeSourceStatus title id lists", () => {
    it("swaps the re-checked site's ids and keeps the rest, so a later scheduled merge counts right", () => {
        const stored: MergeableStatus = {
            checked: 3,
            updated: 0,
            failed: 3,
            checkedAt: 1,
            failedTitleIds: { s1: ["a", "b"], s2: ["c"] },
            failuresBySource: { s1: 2, s2: 1 }
        }
        const run: MergeableStatus = {
            checked: 1,
            updated: 0,
            failed: 0,
            checkedAt: 2,
            failedTitleIds: {},
            failuresBySource: {}
        }
        const merged = mergeSourceStatus(stored, run, ["s2"])
        expect(merged.failedTitleIds).toEqual({ s1: ["a", "b"] })
        expect(merged.failed).toBe(2)
    })
})
