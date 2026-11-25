// A check of some sites, or a scheduled run of the titles that were due, replaces only its own part of the
// stored library-wide status. The fix-it page then sees problems clear (or stay) for what was re-checked,
// without the rest of the last full check being thrown away.

type Row = { sourceId?: string; mangaId?: string; [key: string]: unknown }
type Counts = Record<string, number>
// Every title behind a count, by site. The rows are capped for display; these are not, so a merge knows
// which titles a count is made of and can take a re-checked title out of it exactly once.
export type TitleIds = Record<string, string[]>

export type MergeableStatus = {
    checked: number
    updated: number
    failed: number
    checkedAt: number
    errors?: Row[]
    relinkTitles?: Row[]
    needsVerify?: Row[]
    failedTitleIds?: TitleIds
    relinkTitleIds?: TitleIds
    failedUnlisted?: Counts
    relinkUnlisted?: Counts
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

// A status stored before the id lists existed only names the titles in its rows.
function titleIds(ids: TitleIds | undefined, rows: Row[] | undefined): TitleIds {
    if (ids) return ids
    const out: Record<string, Set<string>> = {}
    for (const row of rows ?? []) {
        if (!row.mangaId || row.sourceId === undefined) continue
        ;(out[row.sourceId] ??= new Set()).add(row.mangaId)
    }
    return Object.fromEntries(Object.entries(out).map(([sourceId, set]) => [sourceId, [...set]]))
}

// The part of each site's count that no id names. A status stored before the id lists existed names only the
// titles in its capped rows, so the rest of its counts lives here until a check of that site replaces it.
function unlistedCounts(
    ids: TitleIds | undefined,
    rows: Row[] | undefined,
    counts: Counts | undefined,
    stored: Counts | undefined
): Counts {
    if (ids) return stored ?? {}
    const named = titleIds(undefined, rows)
    const out: Counts = {}
    for (const [sourceId, count] of Object.entries(counts ?? {})) {
        const extra = count - (named[sourceId]?.length ?? 0)
        if (extra > 0) out[sourceId] = extra
    }
    return out
}

// A title a run names for the first time in a site that still has unnamed titles is most likely one of them,
// so it moves from the unnamed part to the named part instead of being counted twice.
function remainingUnlisted(unlisted: Counts, previous: TitleIds, merged: TitleIds): Counts {
    const known = new Set(Object.values(previous).flat())
    const out: Counts = {}
    for (const [sourceId, count] of Object.entries(unlisted)) {
        const named = (merged[sourceId] ?? []).filter(id => !known.has(id)).length
        if (count - named > 0) out[sourceId] = count - named
    }
    return out
}

function countIds(ids: TitleIds, unlisted: Counts = {}): Counts {
    const sourceIds = new Set([...Object.keys(ids), ...Object.keys(unlisted)])
    return Object.fromEntries(
        [...sourceIds]
            .map(sourceId => [sourceId, (ids[sourceId]?.length ?? 0) + (unlisted[sourceId] ?? 0)] as const)
            .filter(([, n]) => n > 0)
            .sort((a, b) => b[1] - a[1])
    )
}

const totalCounts = (counts: Counts) => Object.values(counts).reduce((total, n) => total + n, 0)

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
        failedTitleIds: replaceKeys(
            titleIds(previous.failedTitleIds, previous.errors),
            ids,
            titleIds(run.failedTitleIds, run.errors)
        ),
        relinkTitleIds: replaceKeys(
            titleIds(previous.relinkTitleIds, previous.relinkTitles),
            ids,
            titleIds(run.relinkTitleIds, run.relinkTitles)
        ),
        failedUnlisted: replaceKeys(
            unlistedCounts(
                previous.failedTitleIds,
                previous.errors,
                previous.failuresBySource,
                previous.failedUnlisted
            ),
            ids,
            run.failedUnlisted
        ),
        relinkUnlisted: replaceKeys(
            unlistedCounts(
                previous.relinkTitleIds,
                previous.relinkTitles,
                previous.needsRelink,
                previous.relinkUnlisted
            ),
            ids,
            run.relinkUnlisted
        ),
        failuresBySource: replaceKeys(previous.failuresBySource, ids, run.failuresBySource),
        needsRelink: replaceKeys(previous.needsRelink, ids, run.needsRelink),
        ...replaceNotices(previous, run, ids)
    }
}

// The previous titles minus the ones the run checked, plus what the run found. A title is in at most one
// site's list, so a count never holds it twice however many runs re-check it.
function mergeTitleIds(previous: TitleIds, checked: ReadonlySet<string>, run: TitleIds): TitleIds {
    const out: Record<string, Set<string>> = {}
    const placed = new Set<string>()
    const add = (sourceId: string, id: string) => {
        if (placed.has(id)) return
        placed.add(id)
        ;(out[sourceId] ??= new Set()).add(id)
    }
    for (const [sourceId, list] of Object.entries(run)) for (const id of list) add(sourceId, id)
    for (const [sourceId, list] of Object.entries(previous)) {
        for (const id of list) if (!checked.has(id)) add(sourceId, id)
    }
    return Object.fromEntries(Object.entries(out).map(([sourceId, set]) => [sourceId, [...set]]))
}

const dropChecked = <T extends Row>(rows: T[] | undefined, checked: ReadonlySet<string>) =>
    (rows ?? []).filter(row => row.mangaId === undefined || !checked.has(row.mangaId))

// Which titles wait for their site is known locally, before any check has run (right after the update that
// stopped bundling the user's sites, say). The titles found are the status's site-off titles from now on, and a
// title listed as site-off before that is not any more is taken out. Everything else is left as it was. With no
// status yet, one is started that no check has filled in (checkedAt 0).
export function mergeSiteOffTitles(previous: MergeableStatus | undefined, run: Row[]): MergeableStatus {
    const base = previous ?? { checked: 0, updated: 0, failed: 0, checkedAt: 0 }
    const touched = new Set(
        [...run, ...(base.relinkTitles ?? []).filter(row => row.reason === "site-off")].flatMap(row =>
            row.mangaId ? [row.mangaId] : []
        )
    )
    const previousRelink = titleIds(base.relinkTitleIds, base.relinkTitles)
    const relinkTitleIds = mergeTitleIds(previousRelink, touched, titleIds(undefined, run))
    const relinkUnlisted = remainingUnlisted(
        unlistedCounts(base.relinkTitleIds, base.relinkTitles, base.needsRelink, base.relinkUnlisted),
        previousRelink,
        relinkTitleIds
    )
    return {
        ...base,
        relinkTitles: [...run, ...dropChecked(base.relinkTitles, touched)],
        relinkTitleIds,
        relinkUnlisted,
        needsRelink: countIds(relinkTitleIds, relinkUnlisted)
    }
}

// A scheduled run checks only the titles that were due. Their rows are replaced by what the run found;
// every other title's problems stay until a run checks it again. The run's own rows come first, so a
// caller capping the lists keeps the newest. Counts come from the id lists plus any unnamed remainder a legacy
// status carried, never from the capped rows alone.
export function mergeTitleStatus<T extends MergeableStatus>(
    previous: T | undefined,
    run: T,
    checkedIds: ReadonlySet<string>,
    reachedSources: ReadonlySet<string>
): T {
    if (!previous) return run
    const previousFailed = titleIds(previous.failedTitleIds, previous.errors)
    const previousRelink = titleIds(previous.relinkTitleIds, previous.relinkTitles)
    const failedTitleIds = mergeTitleIds(previousFailed, checkedIds, titleIds(run.failedTitleIds, run.errors))
    const relinkTitleIds = mergeTitleIds(previousRelink, checkedIds, titleIds(run.relinkTitleIds, run.relinkTitles))
    const failedUnlisted = remainingUnlisted(
        unlistedCounts(previous.failedTitleIds, previous.errors, previous.failuresBySource, previous.failedUnlisted),
        previousFailed,
        failedTitleIds
    )
    const relinkUnlisted = remainingUnlisted(
        unlistedCounts(previous.relinkTitleIds, previous.relinkTitles, previous.needsRelink, previous.relinkUnlisted),
        previousRelink,
        relinkTitleIds
    )
    const failuresBySource = countIds(failedTitleIds, failedUnlisted)
    return {
        ...previous,
        ...run,
        failed: totalCounts(failuresBySource),
        errors: [...(run.errors ?? []), ...dropChecked(previous.errors, checkedIds)],
        relinkTitles: [...(run.relinkTitles ?? []), ...dropChecked(previous.relinkTitles, checkedIds)],
        failedTitleIds,
        relinkTitleIds,
        failedUnlisted,
        relinkUnlisted,
        failuresBySource,
        needsRelink: countIds(relinkTitleIds, relinkUnlisted),
        ...replaceNotices(previous, run, reachedSources)
    }
}
