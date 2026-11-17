import { describe, expect, it } from "vitest"
import { mergeSourceStatus, mergeTitleStatus, type MergeableStatus } from "./update-status-merge"

// A status written by an older build has no failedTitleIds / relinkTitleIds. Its rows are capped
// at 200 (ERROR_ROWS_CAP / RELINK_TITLES_CAP in handlers/updates-sources.ts) while its counts are not.
describe("a legacy stored status without title id lists", () => {
    const rows = (n: number, sourceId: string) =>
        Array.from({ length: n }, (_, i) => ({ mangaId: `${sourceId}:m${i}`, title: `T${i}`, sourceId }))

    const legacy = (): MergeableStatus => ({
        checked: 450,
        updated: 0,
        failed: 450,
        checkedAt: 1,
        errors: rows(200, "site-a"),
        failuresBySource: { "site-a": 450 },
        relinkTitles: rows(200, "site-b"),
        needsRelink: { "site-b": 300 }
    })

    const emptyRun = (): MergeableStatus => ({
        checked: 0,
        updated: 0,
        failed: 0,
        checkedAt: 2,
        errors: [],
        relinkTitles: [],
        failuresBySource: {},
        needsRelink: {},
        failedTitleIds: {},
        relinkTitleIds: {}
    })

    it("keeps the failure count when the run re-checked none of the failing titles", () => {
        const merged = mergeTitleStatus(legacy(), emptyRun(), new Set(), new Set())
        expect(merged.failed).toBe(450)
        expect(merged.failuresBySource).toEqual({ "site-a": 450 })
    })

    it("keeps the needs-relink count when the run re-checked none of those titles", () => {
        const merged = mergeTitleStatus(legacy(), emptyRun(), new Set(), new Set())
        expect(merged.needsRelink).toEqual({ "site-b": 300 })
    })

    it("keeps both counts across later scheduled runs", () => {
        let status = mergeTitleStatus(legacy(), emptyRun(), new Set(), new Set())
        status = mergeTitleStatus(status, emptyRun(), new Set(), new Set())
        expect(status.failed).toBe(450)
        expect(status.needsRelink).toEqual({ "site-b": 300 })
    })

    it("takes a re-checked named title out of the count exactly once", () => {
        const merged = mergeTitleStatus(legacy(), emptyRun(), new Set(["site-a:m0"]), new Set(["site-a"]))
        expect(merged.failed).toBe(449)
        expect(merged.failuresBySource).toEqual({ "site-a": 449 })
    })

    it("does not count a title twice when a run names one the rows had cut off", () => {
        const run: MergeableStatus = {
            ...emptyRun(),
            failed: 1,
            failuresBySource: { "site-a": 1 },
            failedTitleIds: { "site-a": ["site-a:m300"] }
        }
        const merged = mergeTitleStatus(legacy(), run, new Set(["site-a:m300"]), new Set(["site-a"]))
        expect(merged.failed).toBe(450)
    })

    it("a check of another site keeps the counts, and a later scheduled run still does", () => {
        const other: MergeableStatus = { ...emptyRun(), failuresBySource: {}, needsRelink: {} }
        const afterSite = mergeSourceStatus(legacy(), other, ["site-c"])
        expect(afterSite.failuresBySource).toEqual({ "site-a": 450 })
        const afterRun = mergeTitleStatus(afterSite, emptyRun(), new Set(), new Set())
        expect(afterRun.failed).toBe(450)
        expect(afterRun.needsRelink).toEqual({ "site-b": 300 })
    })

    it("a check of the site itself replaces the unnamed remainder", () => {
        const recheck: MergeableStatus = {
            ...emptyRun(),
            failed: 2,
            failuresBySource: { "site-a": 2 },
            failedTitleIds: { "site-a": ["site-a:m0", "site-a:m1"] }
        }
        const afterSite = mergeSourceStatus(legacy(), recheck, ["site-a"])
        const afterRun = mergeTitleStatus(afterSite, emptyRun(), new Set(), new Set())
        expect(afterRun.failuresBySource).toEqual({ "site-a": 2 })
    })
})
