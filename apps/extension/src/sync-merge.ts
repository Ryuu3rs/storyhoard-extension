import type { SyncItem } from "./account"

// Three-way sync: `shadow` is the row as the server last showed it. A field that differs from the shadow
// is a local edit, so it needs no tracking at each write, a pull never overwrites it, and an empty value
// that matches the shadow can safely be cleared by a pull. Pure, so the rules can be tested alone.

export type SyncValues = Partial<SyncItem>

// Fields a member or this device can change. Series facts the server may override stay in here as
// hints; display values are separate and read-only.
export const MERGED_FIELDS = [
    "title",
    "normalizedTitle",
    "anilistId",
    "sourceId",
    "sourceMangaId",
    "mangaUrl",
    "coverUrl",
    "genres",
    "status",
    "readingStatus",
    "rating",
    "lastReadChapterNumber",
    "latestChapterNumber",
    "lastReadAt",
    "notes",
    "categories",
    "onHold",
    "manualTracking",
    "nsfw",
    "pageWidthPct",
    "readingDirection",
    "pageFit",
    "noGapContinuous",
    "continuousScroll",
    "readerTheme"
] as const satisfies ReadonlyArray<keyof SyncItem>

export type MergedField = (typeof MERGED_FIELDS)[number]

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

// What this device changed since the server last showed the row.
export function dirtyFields(current: SyncValues, shadow: SyncValues): MergedField[] {
    return MERGED_FIELDS.filter(field => !same(current[field], shadow[field]))
}

// A single-row patch for those changes: absent keeps, null clears. Lowering a number needs its reset
// stamp, and a status change carries its own clock. The row clock must beat the server's or the whole
// row is refused, so it is never older than the shadow's.
export function buildPatch(current: SyncItem, shadow: SyncValues, now: number): SyncItem | null {
    const fields = dirtyFields(current, shadow)
    if (fields.length === 0) return null
    const patch: Record<string, unknown> = {
        clientId: current.clientId,
        patch: true,
        clientUpdatedAt: Math.max(now, (shadow.clientUpdatedAt ?? 0) + 1)
    }
    for (const field of fields) patch[field] = current[field] ?? null
    if (fields.includes("readingStatus")) patch["readingStatusUpdatedAt"] = current.readingStatusUpdatedAt ?? now
    if (fields.includes("lastReadChapterNumber") && isNewerStamp(current.progressResetAt, shadow.progressResetAt)) {
        patch["progressResetAt"] = current.progressResetAt
    }
    if (fields.includes("latestChapterNumber") && isNewerStamp(current.latestResetAt, shadow.latestResetAt)) {
        patch["latestResetAt"] = current.latestResetAt
    }
    return patch as unknown as SyncItem
}

const isNewerStamp = (mine: number | null | undefined, theirs: number | null | undefined): boolean =>
    typeof mine === "number" && mine > (theirs ?? 0)

export type PullMerge = {
    // Fields to write locally. null means clear.
    changes: SyncValues
    // Fields kept as local edits, which the next push sends.
    kept: MergedField[]
}

// Merges a pulled row into the local one. With no shadow (first sync on this version, or a row this
// device has never seen from the server), nothing can be called a local edit, so the newer row wins.
export function mergePulled(
    local: SyncValues,
    shadow: SyncValues | undefined,
    remote: SyncValues,
    localUpdatedAt: number
): PullMerge {
    const changes: Record<string, unknown> = {}
    const kept: MergedField[] = []
    const remoteIsNewer = (remote.clientUpdatedAt ?? 0) > localUpdatedAt

    for (const field of MERGED_FIELDS) {
        if (!(field in remote) || same(local[field], remote[field])) continue
        const isLocalEdit = shadow ? !same(local[field], shadow[field]) : !remoteIsNewer
        if (isLocalEdit) kept.push(field)
        else changes[field] = remote[field] ?? null
    }

    applyProgressRule(local, remote, changes, kept)
    applyLatestRule(local, remote, changes, kept)
    applyStatusRule(local, remote, changes, kept)
    return { changes: changes as SyncValues, kept }
}

function take(changes: Record<string, unknown>, kept: MergedField[], field: MergedField, value: unknown): void {
    changes[field] = value ?? null
    const at = kept.indexOf(field)
    if (at >= 0) kept.splice(at, 1)
}

function keep(changes: Record<string, unknown>, kept: MergedField[], field: MergedField): void {
    delete changes[field]
    if (!kept.includes(field)) kept.push(field)
}

// Progress only rises, unless the server's copy carries a reset newer than this device's. A local reset
// that is newer stays a local edit, so it reaches the server.
function applyProgressRule(
    local: SyncValues,
    remote: SyncValues,
    changes: Record<string, unknown>,
    kept: MergedField[]
): void {
    const field = "lastReadChapterNumber"
    const mine = local[field]
    const theirs = remote[field]
    if (isNewerStamp(remote.progressResetAt, local.progressResetAt)) {
        take(changes, kept, field, theirs)
        take(changes, kept, "lastReadAt", remote.lastReadAt)
        return
    }
    if (isNewerStamp(local.progressResetAt, remote.progressResetAt)) {
        keep(changes, kept, field)
        keep(changes, kept, "lastReadAt")
        return
    }
    if (typeof mine === "number" && (typeof theirs !== "number" || theirs < mine)) {
        keep(changes, kept, field)
    } else if (typeof theirs === "number" && (typeof mine !== "number" || theirs > mine)) {
        take(changes, kept, field, theirs)
    }
    const myTime = local.lastReadAt
    const theirTime = remote.lastReadAt
    if (typeof myTime === "number" && (typeof theirTime !== "number" || theirTime < myTime)) {
        keep(changes, kept, "lastReadAt")
    } else if (typeof theirTime === "number" && (typeof myTime !== "number" || theirTime > myTime)) {
        take(changes, kept, "lastReadAt", theirTime)
    }
}

// Same shape for the newest known chapter, with its own reset stamp for repairs and update checks.
function applyLatestRule(
    local: SyncValues,
    remote: SyncValues,
    changes: Record<string, unknown>,
    kept: MergedField[]
): void {
    const field = "latestChapterNumber"
    const mine = local[field]
    const theirs = remote[field]
    if (isNewerStamp(remote.latestResetAt, local.latestResetAt)) {
        take(changes, kept, field, theirs)
    } else if (isNewerStamp(local.latestResetAt, remote.latestResetAt)) {
        keep(changes, kept, field)
    } else if (typeof mine === "number" && (typeof theirs !== "number" || theirs < mine)) {
        keep(changes, kept, field)
    } else if (typeof theirs === "number" && (typeof mine !== "number" || theirs > mine)) {
        take(changes, kept, field, theirs)
    }
}

// Reading status has its own clock, so the newest change wins whichever way the row clocks fall.
function applyStatusRule(
    local: SyncValues,
    remote: SyncValues,
    changes: Record<string, unknown>,
    kept: MergedField[]
): void {
    const mine = local.readingStatusUpdatedAt ?? 0
    const theirs = remote.readingStatusUpdatedAt ?? 0
    if (mine === theirs) return
    if (theirs > mine) {
        if (!same(local.readingStatus, remote.readingStatus)) take(changes, kept, "readingStatus", remote.readingStatus)
    } else if (!same(local.readingStatus, remote.readingStatus)) {
        keep(changes, kept, "readingStatus")
    }
}
