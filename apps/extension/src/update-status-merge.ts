// A check of one site replaces only that site's part of the stored library-wide status, so the fix-it page
// sees a site's problems clear (or stay) after "Turn on" or "Open and re-check" without the rest of the
// last full check being thrown away.

type Row = { sourceId?: string; [key: string]: unknown }

export type MergeableStatus = {
    checked: number
    updated: number
    failed: number
    checkedAt: number
    errors?: Row[]
    relinkTitles?: Row[]
    needsVerify?: Row[]
    failuresBySource?: Record<string, number>
    needsRelink?: Record<string, number>
    causesBySource?: Record<string, Record<string, number>>
    skippedSources?: Record<string, number>
    [key: string]: unknown
}

function replaceKey<T>(map: Record<string, T> | undefined, sourceId: string, next: Record<string, T> | undefined) {
    const out = { ...(map ?? {}) }
    delete out[sourceId]
    if (next?.[sourceId] !== undefined) out[sourceId] = next[sourceId]
    return out
}

function replaceRows<T extends Row>(rows: T[] | undefined, sourceId: string, next: T[] | undefined): T[] {
    return [
        ...(rows ?? []).filter(row => row.sourceId !== sourceId),
        ...(next ?? []).filter(row => row.sourceId === sourceId)
    ]
}

export function mergeSourceStatus<T extends MergeableStatus>(previous: T | undefined, run: T, sourceId: string): T {
    if (!previous) return run
    const failedBefore = previous.failuresBySource?.[sourceId] ?? 0
    const failedNow = run.failuresBySource?.[sourceId] ?? 0
    return {
        ...previous,
        checkedAt: run.checkedAt,
        updated: previous.updated + run.updated,
        failed: Math.max(0, previous.failed - failedBefore) + failedNow,
        errors: replaceRows(previous.errors, sourceId, run.errors),
        relinkTitles: replaceRows(previous.relinkTitles, sourceId, run.relinkTitles),
        needsVerify: replaceRows(previous.needsVerify, sourceId, run.needsVerify),
        failuresBySource: replaceKey(previous.failuresBySource, sourceId, run.failuresBySource),
        needsRelink: replaceKey(previous.needsRelink, sourceId, run.needsRelink),
        causesBySource: replaceKey(previous.causesBySource, sourceId, run.causesBySource),
        skippedSources: replaceKey(previous.skippedSources, sourceId, run.skippedSources)
    }
}
