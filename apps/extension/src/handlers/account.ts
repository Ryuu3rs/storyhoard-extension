import { normalizeTitle } from "@amr/normalize"
import {
    addSyncedManga,
    clearSyncShadows,
    createBackup,
    db,
    forgetSyncShadow,
    mergeSyncedManga,
    patchSyncedManga,
    recordAnalyticsEvent,
    removeManga,
    saveSyncShadow,
    type LibraryManga,
    type SyncShadow
} from "../database"
import {
    AccountAuthError,
    AccountSuspendedError,
    apiAccountStatus,
    apiWallet,
    apiLinkCommunity,
    apiPull,
    apiPush,
    clearAccountProfile,
    clearTombstones,
    forgetPendingForOtherAccount,
    getAccountProfile,
    getTombstoneMoves,
    getTombstones,
    toSyncItem,
    updateAccountProfile,
    type AccountProfile,
    type AccountStatus,
    type PushResult,
    type SyncItem
} from "../account"
import { accountAlarmName, configureAccountAlarm } from "../background/alarms"
import { diag } from "../diag-log"
import type { HandlerMap } from "../background/handler-types"
import { getCommunityProfile } from "../community"
import { publishLive } from "../live"
import { buildPatch, MERGED_FIELDS, mergePulled, type SyncValues } from "../sync-merge"

const PUSH_BATCH = 400
const STATUSES = new Set(["unknown", "ongoing", "completed", "hiatus", "cancelled"])
const READING = new Set(["paused", "dropped", "planning"])

type Status = LibraryManga["status"]

function pickStatus(v: string | null | undefined): Status {
    return STATUSES.has(v ?? "") ? (v as Status) : "unknown"
}

function pickReading(v: string | null | undefined): LibraryManga["readingStatus"] {
    return READING.has(v ?? "") ? (v as LibraryManga["readingStatus"]) : undefined
}

function pickRating(v: number | null | undefined): number | undefined {
    if (typeof v !== "number") return undefined
    const r = Math.round(v)
    return r >= 1 && r <= 5 ? r : undefined
}

const READING_DIRECTIONS = new Set(["ltr", "rtl", "vertical"])
const PAGE_FITS = new Set(["width", "height", "contain", "original", "actual"])
const READER_THEMES = new Set(["auto", "light", "dark"])

const orNull = <T>(value: T | undefined): T | null => value ?? null

// A pulled row reduced to values this extension can hold, so a value it would refuse is never mistaken
// for a local edit. Source fields are left out when empty, because a device that doesn't hold them must
// not blank them.
export function normalizeRemote(item: SyncItem): SyncValues {
    const width = item.pageWidthPct
    const values: SyncValues = {
        clientId: item.clientId,
        title: item.title,
        normalizedTitle: item.normalizedTitle || normalizeTitle(item.title),
        anilistId: item.anilistId ? item.anilistId : null,
        coverUrl: item.coverUrl || null,
        genres: item.genres?.length ? item.genres : null,
        status: pickStatus(item.status),
        readingStatus: orNull(pickReading(item.readingStatus)),
        readingStatusUpdatedAt: item.readingStatusUpdatedAt ?? null,
        progressResetAt: item.progressResetAt ?? null,
        latestResetAt: item.latestResetAt ?? null,
        rating: orNull(pickRating(item.rating)),
        lastReadChapterNumber: typeof item.lastReadChapterNumber === "number" ? item.lastReadChapterNumber : null,
        latestChapterNumber: typeof item.latestChapterNumber === "number" ? item.latestChapterNumber : null,
        lastReadAt: typeof item.lastReadAt === "number" ? item.lastReadAt : null,
        notes: item.notes || null,
        categories: item.categories?.length ? item.categories : null,
        onHold: typeof item.onHold === "boolean" ? item.onHold : null,
        manualTracking: typeof item.manualTracking === "boolean" ? item.manualTracking : null,
        nsfw: typeof item.nsfw === "boolean" ? item.nsfw : null,
        // Clamp to the same 30-100 range the UI enforces.
        pageWidthPct: typeof width === "number" && width >= 30 && width <= 100 ? width : null,
        readingDirection: READING_DIRECTIONS.has(item.readingDirection ?? "") ? item.readingDirection! : null,
        pageFit: PAGE_FITS.has(item.pageFit ?? "") ? item.pageFit! : null,
        noGapContinuous: typeof item.noGapContinuous === "boolean" ? item.noGapContinuous : null,
        continuousScroll: typeof item.continuousScroll === "boolean" ? item.continuousScroll : null,
        readerTheme: READER_THEMES.has(item.readerTheme ?? "") ? item.readerTheme! : null,
        clientUpdatedAt: item.clientUpdatedAt
    }
    if (item.sourceId) values.sourceId = item.sourceId
    if (item.sourceMangaId) values.sourceMangaId = item.sourceMangaId
    if (item.mangaUrl) values.mangaUrl = item.mangaUrl
    return values
}

// Sync values as stored on a library row: null clears the field, except the address, which also has a
// stored form the row needs for reading.
function toLocalPatch(changes: SyncValues): Record<string, unknown> {
    const patch: Record<string, unknown> = {}
    for (const [field, value] of Object.entries(changes)) patch[field] = value ?? undefined
    return patch
}

// The read-only values the server decides, and the clocks that travel with the fields. These never count
// as local edits, so they are applied whichever row is newer.
function serverValues(local: LibraryManga | undefined, item: SyncItem): Record<string, unknown> {
    const patch: Record<string, unknown> = {}
    if ("displayTitle" in item && (item.displayTitle ?? undefined) !== local?.displayTitle) {
        patch["displayTitle"] = item.displayTitle ?? undefined
    }
    if ("displayCoverUrl" in item && (item.displayCoverUrl ?? undefined) !== local?.displayCoverUrl) {
        patch["displayCoverUrl"] = item.displayCoverUrl ?? undefined
    }
    if (item.workId && item.workId !== local?.workId) patch["workId"] = item.workId
    for (const stamp of ["readingStatusUpdatedAt", "progressResetAt", "latestResetAt"] as const) {
        const theirs = item[stamp]
        if (typeof theirs === "number" && theirs > (local?.[stamp] ?? 0)) patch[stamp] = theirs
    }
    return patch
}

// removeManga also wipes the title's chapters, history and bookmarks, which the account does not hold,
// so they could not come back any other way. One backup per sync covers every delete in it. If the
// backup fails this throws, which ends the sync with the title still here.
let backedUpThisSync = false
async function backupBeforePulledDelete(): Promise<void> {
    if (backedUpThisSync) return
    await createBackup("pre-sync-delete")
    backedUpThisSync = true
}

async function applyRemoteDelete(clientId: string): Promise<void> {
    await backupBeforePulledDelete()
    await removeManga(clientId)
}

async function createFromRemote(item: SyncItem, values: SyncValues): Promise<boolean> {
    if (!values.sourceId || !values.mangaUrl) return false
    const row = {
        ...toLocalPatch(values),
        ...serverValues(undefined, item),
        id: item.clientId,
        sourceUrl: values.mangaUrl,
        authors: [],
        addedAt: Date.now(),
        updatedAt: item.clientUpdatedAt
    }
    delete (row as { clientId?: unknown }).clientId
    delete (row as { clientUpdatedAt?: unknown }).clientUpdatedAt
    await addSyncedManga(JSON.parse(JSON.stringify(row)) as LibraryManga)
    return true
}

// Applies one server row by the three-way rules in sync-merge. Local edits survive, a clear can travel,
// and a server-only change arrives even when its row clock did not move. Returns whether the library
// changed.
export async function applyRemoteItem(item: SyncItem): Promise<boolean> {
    if (item.deleted) {
        const local = await db.manga.get(item.clientId)
        await forgetSyncShadow(item.clientId)
        if (!local || local.updatedAt > item.clientUpdatedAt) return false
        await applyRemoteDelete(item.clientId)
        return true
    }
    const values = normalizeRemote(item)
    const present = await db.manga.get(item.clientId)
    if (!present) {
        // A removal still waiting to reach the server must not be undone by the row it is about to delete.
        const parked = (await getTombstones())[item.clientId]
        if (parked !== undefined && parked >= item.clientUpdatedAt) return false
        const created = await createFromRemote(item, values)
        if (created) await saveSyncShadow(values as SyncShadow)
        return created
    }
    const shadow = await db.syncShadow.get(item.clientId)
    return mergeSyncedManga(item.clientId, values as SyncShadow, local => {
        const { changes } = mergePulled(toSyncItem(local), shadow, values, local.updatedAt)
        const patch = { ...toLocalPatch(changes), ...serverValues(local, item) }
        if (Object.keys(changes).length > 0) patch["updatedAt"] = Math.max(local.updatedAt, item.clientUpdatedAt)
        return patch
    })
}

// The server took a row but not all of it. Those fields follow the server exactly, without marking the
// row as changed, so it doesn't push straight back. A number the server held back can be higher or lower
// than this device's, so no ratchet applies here.
async function applyServerFields(server: SyncItem, fields: readonly string[]): Promise<boolean> {
    const values = normalizeRemote(server)
    const taken: Record<string, unknown> = {}
    for (const field of fields) {
        if (field in values) taken[field] = values[field as keyof SyncValues]
    }
    await saveSyncShadow(values as SyncShadow)
    if (Object.keys(taken).length === 0) return false
    await patchSyncedManga(server.clientId, { ...toLocalPatch(taken), ...serverValues(undefined, server) })
    return true
}

// What the server now holds for a row just sent: its values, without the wire's own flags.
function withoutFlags(row: SyncItem): SyncValues {
    const { patch: _patch, deleted: _deleted, ...values } = row
    return values
}

function statusPatch(status: AccountStatus): Partial<AccountProfile> {
    return {
        userId: status.userId,
        itemCount: status.itemCount,
        ...(status.name ? { name: status.name } : {}),
        ...(status.image ? { image: status.image } : {})
    }
}

// Validate a device token against the site, store it, and run a first sync. Shared by the
// account:link paste path and the H34 link-handoff receiver (both end with a valid token to
// persist and a sync to run), so the two can never drift in how a link is finalised.
export async function linkAccountWithToken(token: string): Promise<AccountProfile> {
    const status = await apiAccountStatus(token)
    await forgetPendingForOtherAccount(status.userId)
    await clearSyncShadows()
    await updateAccountProfile({
        token,
        ...statusPatch(status),
        invalid: false,
        lastPushAt: 0,
        pullCursor: undefined
    })
    await configureAccountAlarm()
    return runAccountSync()
}

let running = false

// Pulls server changes since the last pull, then pushes whatever differs from what the server showed,
// then parked removals. A revoked token flips `invalid` and stops future runs until the user re-links.
export async function runAccountSync(): Promise<AccountProfile> {
    let profile = await getAccountProfile()
    if (!profile.token || profile.invalid || running) return profile
    running = true
    backedUpThisSync = false
    const token = profile.token
    try {
        let libraryChanged = false

        // A device on the old rules has no copy of what the server showed it, so it starts over once.
        if (!profile.shadowReady) {
            await clearSyncShadows()
            profile = await updateAccountProfile({ pullCursor: undefined, shadowReady: true })
        }

        // Pull first, so what is pushed next is measured against what the server holds now.
        let cursor = profile.pullCursor
        let serverTime = profile.lastSyncAt
        for (;;) {
            const page = await apiPull(token, cursor)
            for (const item of page.items) libraryChanged = (await applyRemoteItem(item)) || libraryChanged
            if (page.nextCursor) cursor = page.nextCursor
            serverTime = page.serverTime
            if (!page.hasMore) break
        }

        const refused = new Set<string>()
        // What the server took is recorded batch by batch, so a failure partway costs only the rest.
        const pushBatches = async (items: SyncItem[], onResult: (result: PushResult) => Promise<void>) => {
            for (let i = 0; i < items.length; i += PUSH_BATCH) {
                const result = await apiPush(token, items.slice(i, i + PUSH_BATCH))
                for (const bad of result.invalid) if (bad.clientId) refused.add(bad.clientId)
                if (result.invalid.length > 0) {
                    diag.warn("account-sync", "the server refused rows", { invalid: result.invalid })
                }
                await onResult(result)
            }
        }

        const pushRows = async (rows: SyncItem[]) => {
            const sent = new Map(rows.map(row => [row.clientId, row]))
            const reAdds: SyncItem[] = []
            await pushBatches(rows, async result => {
                for (const clientId of result.accepted) {
                    const row = sent.get(clientId)
                    if (!row) continue
                    const shadow = await db.syncShadow.get(clientId)
                    await saveSyncShadow({ ...shadow, ...withoutFlags(row) } as SyncShadow)
                }
                for (const held of result.adjusted ?? []) {
                    libraryChanged = (await applyServerFields(held.server, held.fields)) || libraryChanged
                }
                for (const r of result.rejected) {
                    const row = sent.get(r.clientId)
                    if (r.reason === "deleted") {
                        const local = await db.manga.get(r.clientId)
                        if (!local || !row) continue
                        if (local.addedAt > r.server.clientUpdatedAt) {
                            reAdds.push({ ...toSyncItem(local), deleted: false })
                        } else {
                            await forgetSyncShadow(r.clientId)
                            await applyRemoteDelete(r.clientId)
                            libraryChanged = true
                        }
                    } else if (r.reason === "held" && row) {
                        const fields = MERGED_FIELDS.filter(field => field in row)
                        libraryChanged = (await applyServerFields(r.server, fields)) || libraryChanged
                    } else {
                        libraryChanged = (await applyRemoteItem(r.server)) || libraryChanged
                    }
                }
            })
            return reAdds
        }

        const library = await db.manga.toArray()
        const localIds = new Set(library.map(m => m.id))
        const shadows = new Map((await db.syncShadow.toArray()).map(shadow => [shadow.clientId, shadow]))
        const now = Date.now()
        const rows: SyncItem[] = []
        for (const manga of library) {
            const current = toSyncItem(manga)
            const shadow = shadows.get(manga.id)
            const row = shadow ? buildPatch(current, shadow, now) : current
            if (row) rows.push(row)
        }
        const reAdds = await pushRows(rows)
        if (reAdds.length > 0) await pushRows(reAdds)

        // Rows first, so a moved title's old row stays on the account until its new row is safely there.
        // A parked removal for a title that is back in the library is out of date, so it is dropped.
        const tombstones = await getTombstones()
        const moves = await getTombstoneMoves()
        const settled: Record<string, number> = {}
        const outgoing: SyncItem[] = []
        for (const [clientId, at] of Object.entries(tombstones)) {
            if (localIds.has(clientId)) settled[clientId] = at
            else if (!refused.has(moves[clientId] ?? "")) {
                outgoing.push({
                    clientId,
                    title: clientId,
                    normalizedTitle: clientId,
                    deleted: true,
                    clientUpdatedAt: at
                })
            }
        }
        const settle = async (clientId: string) => {
            const at = tombstones[clientId]
            if (at !== undefined) settled[clientId] = at
            await forgetSyncShadow(clientId)
        }
        await pushBatches(outgoing, async result => {
            for (const clientId of result.accepted) await settle(clientId)
            for (const r of result.rejected) {
                await settle(r.clientId)
                libraryChanged = (await applyRemoteItem(r.server)) || libraryChanged
            }
        })
        if (Object.keys(settled).length > 0) await clearTombstones(settled)

        const status = await apiAccountStatus(token).catch(() => null)
        const community = await getCommunityProfile()
        const shouldLink = community.enabled && community.userId && community.userId !== profile.communityLinkedId
        const linked = shouldLink ? await apiLinkCommunity(token, community.userId).catch(() => null) : null
        // If the account was re-linked while this run was in flight (account:link resets lastPushAt
        // to 0 / clears pullCursor for a full re-sync), the token now differs. Writing this run's
        // terminal lastPushAt/pullCursor would clobber that reset and corrupt the new account's
        // first sync, so bail without the terminal profile write.
        const latest = await getAccountProfile()
        if (latest.token !== token) {
            if (libraryChanged) publishLive(["library", "chapters"])
            return latest
        }
        profile = await updateAccountProfile({
            lastPushAt: Date.now(),
            ...(cursor ? { pullCursor: cursor } : {}),
            lastSyncAt: serverTime || Date.now(),
            syncProblem: undefined,
            ...(status ? statusPatch(status) : {}),
            ...(linked?.ok ? { communityLinkedId: community.userId } : {})
        })
        if (libraryChanged) publishLive(["library", "chapters"])
        return profile
    } catch (error) {
        if (error instanceof AccountAuthError) {
            await browser.alarms.clear(accountAlarmName)
            return updateAccountProfile({ invalid: true })
        }
        console.warn("[AMR] Account sync failed", error)
        const latest = await getAccountProfile()
        if (latest.token !== token) return latest
        return updateAccountProfile({ syncProblem: error instanceof AccountSuspendedError ? "suspended" : "failed" })
    } finally {
        running = false
    }
}

export const accountHandlers: HandlerMap = {
    "account:status": async () => getAccountProfile(),

    // Validate the pasted token against the site, store it, then run a first sync so the
    // library appears on the account straight away.
    "account:link": async request => {
        const result = await linkAccountWithToken(request.token.trim())
        // Count the conversion only when the link is usable: a first sync that hit a revoked token
        // leaves the profile invalid without throwing, which is not a successful link.
        if (!result.invalid) void recordAnalyticsEvent({ event: "account_linked", ts: Date.now() })
        return result
    },

    "account:unlink": async () => {
        await browser.alarms.clear(accountAlarmName)
        return clearAccountProfile()
    },

    "account:sync": async () => runAccountSync(),

    // Scales balance for the footer indicator. Not linked -> a zero sentinel, no network call.
    // A failed fetch (offline, revoked token) also reports zero rather than throwing at the panel.
    "account:wallet": async () => {
        const profile = await getAccountProfile()
        if (!profile.token) return { linked: false, balance: 0 }
        const wallet = await apiWallet(profile.token).catch(() => null)
        return { linked: true, balance: wallet?.balance ?? 0 }
    }
}
