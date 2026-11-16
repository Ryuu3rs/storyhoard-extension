// A check of some sites, or a scheduled run of the titles that were due, replaces only its own part of the
// stored library-wide status. The fix-it page then sees problems clear (or stay) for what was re-checked,
// without the rest of the last full check being thrown away.

type Row = { sourceId?: string; mangaId?: string; [key: string]: unknown }
type Counts = Record<string, number>

export type MergeableStatus = {
    checked: number
    updated: number
    failed: number
    checkedAt: number
    errors?: Row[]
    relinkTitles?: Row[]
    needsVerify?: Row[]
    failuresBySource?: Counts
    needsRelink?: Counts
    causesBySource?: Record<string, Counts>
    skippedSources?: Counts
    trackingOnly?: Counts
    emptyLists?: Counts
    shortLists?: Counts
    [key: string]: unknown
}

function replaceKeys<T>(
    map: Record<string, T> | undefined,
    sourceIds: ReadonlySet<string>,
    next: Record<string, T> | undefined
) {
    const out = { ...(map ?? {}) }
    for (const sourceId of sourceIds) {
        delete out[sourceId]
        if (next?.[sourceId] !== undefined) out[sourceId] = next[sourceId]
    }
    return out
}

const inSources = (row: Row, sourceIds: ReadonlySet<string>) =>
    row.sourceId !== undefined && sourceIds.has(row.sourceId)

function replaceRows<T extends Row>(rows: T[] | undefined, sourceIds: ReadonlySet<string>, next: T[] | undefined): T[] {
    return [
        ...(rows ?? []).filter(row => !inSources(row, sourceIds)),
        ...(next ?? []).filter(row => inSources(row, sourceIds))
    ]
}

// Per-site notices that carry no title, so a run can only refresh them for the sites it reached.
function replaceNotices<T extends MergeableStatus>(previous: T, run: T, sourceIds: ReadonlySet<string>) {
    return {
        needsVerify: replaceRows(previous.needsVerify, sourceIds, run.needsVerify),
        causesBySource: replaceKeys(previous.causesBySource, sourceIds, run.causesBySource),
        skippedSources: replaceKeys(previous.skippedSources, sourceIds, run.skippedSources),
        trackingOnly: replaceKeys(previous.trackingOnly, sourceIds, run.trackingOnly),
        emptyLists: replaceKeys(previous.emptyLists, sourceIds, run.emptyLists),
        shortLists: replaceKeys(previous.shortLists, sourceIds, run.shortLists)
    }
}

const sum = (counts: Counts | undefined, sourceIds: ReadonlySet<string>) =>
    [...sourceIds].reduce((total, sourceId) => total + (counts?.[sourceId] ?? 0), 0)

export function mergeSourceStatus<T extends MergeableStatus>(
    previous: T | undefined,
    run: T,
    sourceIds: readonly string[]
): T {
    if (!previous) return run
    const ids = new Set(sourceIds)
    return {
        ...previous,
        checkedAt: run.checkedAt,
        updated: previous.updated + run.updated,
        failed: Math.max(0, previous.failed - sum(previous.failuresBySource, ids)) + sum(run.failuresBySource, ids),
        errors: replaceRows(previous.errors, ids, run.errors),
        relinkTitles: replaceRows(previous.relinkTitles, ids, run.relinkTitles),
        failuresBySource: replaceKeys(previous.failuresBySource, ids, run.failuresBySource),
        needsRelink: replaceKeys(previous.needsRelink, ids, run.needsRelink),
        ...replaceNotices(previous, run, ids)
    }
}

function dropTitles<T extends Row>(rows: T[] | undefined, checked: ReadonlySet<string>) {
    const kept: T[] = []
    const droppedBySource = new Map<string, number>()
    for (const row of rows ?? []) {
        if (row.mangaId !== undefined && checked.has(row.mangaId)) {
            const sourceId = row.sourceId ?? ""
            droppedBySource.set(sourceId, (droppedBySource.get(sourceId) ?? 0) + 1)
        } else {
            kept.push(row)
        }
    }
    return { kept, droppedBySource }
}

function adjustCounts(counts: Counts | undefined, dropped: Map<string, number>, next: Counts | undefined): Counts {
    const out: Counts = { ...(counts ?? {}) }
    for (const [sourceId, n] of dropped) {
        const left = (out[sourceId] ?? 0) - n
        if (left > 0) out[sourceId] = left
        else delete out[sourceId]
    }
    for (const [sourceId, n] of Object.entries(next ?? {})) out[sourceId] = (out[sourceId] ?? 0) + n
    return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]))
}

// A scheduled run checks only the titles that were due. Their rows are replaced by what the run found;
// every other title's problems stay until a run checks it again. The run's own rows come first, so a
// caller capping the lists keeps the newest.
export function mergeTitleStatus<T extends MergeableStatus>(
    previous: T | undefined,
    run: T,
    checkedIds: ReadonlySet<string>,
    reachedSources: ReadonlySet<string>
): T {
    if (!previous) return run
    const errors = dropTitles(previous.errors, checkedIds)
    const relink = dropTitles(previous.relinkTitles, checkedIds)
    const droppedFailures = [...errors.droppedBySource.values()].reduce((total, n) => total + n, 0)
    return {
        ...previous,
        ...run,
        failed: Math.max(0, previous.failed - droppedFailures) + run.failed,
        errors: [...(run.errors ?? []), ...errors.kept],
        relinkTitles: [...(run.relinkTitles ?? []), ...relink.kept],
        failuresBySource: adjustCounts(previous.failuresBySource, errors.droppedBySource, run.failuresBySource),
        needsRelink: adjustCounts(previous.needsRelink, relink.droppedBySource, run.needsRelink),
        ...replaceNotices(previous, run, reachedSources)
    }
}
