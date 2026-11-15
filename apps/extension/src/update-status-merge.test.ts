import { describe, expect, it } from "vitest"
import { mergeSourceStatus, type MergeableStatus } from "./update-status-merge"

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
        const merged = mergeSourceStatus(previous, run, "s2")
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
        const merged = mergeSourceStatus(previous, run, "s1")
        expect(merged.errors?.map(row => (row as { mangaId: string }).mangaId)).toEqual(["b", "c", "z"])
        expect(merged.relinkTitles).toEqual([])
        expect(merged.needsRelink).toEqual({})
        expect(merged.failed).toBe(3)
    })

    it("uses the run as is when nothing was stored", () => {
        const run: MergeableStatus = { checked: 1, updated: 0, failed: 0, checkedAt: 9 }
        expect(mergeSourceStatus(undefined, run, "s1")).toBe(run)
    })
})
