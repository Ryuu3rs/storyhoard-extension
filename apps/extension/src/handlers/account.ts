import { normalizeTitle } from "@amr/normalize"
import { addSyncedManga, applySyncedMangaIfNewer, db, removeManga, type LibraryManga } from "../database"
import {
    AccountAuthError,
    apiAccountStatus,
    apiLinkCommunity,
    apiPull,
    apiPush,
    clearAccountProfile,
    clearTombstones,
    getAccountProfile,
    getTombstones,
    toSyncItem,
    updateAccountProfile,
    type AccountProfile,
    type AccountStatus,
    type SyncItem
} from "../account"
import { accountAlarmName, configureAccountAlarm } from "../background/alarms"
import type { HandlerMap } from "../background/handler-types"
import { getCommunityProfile } from "../community"
import { publishLive } from "../live"

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

// Apply one server-side item locally. The server copy wins only when it is newer than the
// local row (same last-writer rule the server applies to pushes), so a pull never clobbers
// an edit made here since the last sync. Returns true when the library changed.
const READING_DIRECTIONS = new Set(["ltr", "rtl", "vertical"])
const PAGE_FITS = new Set(["width", "height", "contain", "original", "actual"])
const READER_THEMES = new Set(["auto", "light", "dark"])

// The user-owned library metadata + per-title reader overrides carried by a synced item.
// Present values are applied; like the existing rating/status handling this doesn't push a
// clear across devices (an omitted/absent value is left as-is), so setting a note or tag on
// one device shows up on another, while unsetting stays local for now.
function syncedEditableFields(item: SyncItem): Partial<LibraryManga> {
    const patch: Record<string, unknown> = {}
    if (typeof item.notes === "string" && item.notes) patch["notes"] = item.notes
    if (Array.isArray(item.categories) && item.categories.length > 0) patch["categories"] = item.categories
    if (item.onHold === true) patch["onHold"] = true
    if (item.manualTracking === true) patch["manualTracking"] = true
    if (item.nsfw === true) patch["nsfw"] = true
    // Clamp to the same 30-100 range the UI enforces, so a corrupt/crafted server value can't
    // reach the reader as an out-of-range width.
    if (typeof item.pageWidthPct === "number" && item.pageWidthPct >= 30 && item.pageWidthPct <= 100)
        patch["pageWidthPct"] = item.pageWidthPct
    if (typeof item.readingDirection === "string" && READING_DIRECTIONS.has(item.readingDirection))
        patch["readingDirection"] = item.readingDirection
    if (typeof item.pageFit === "string" && PAGE_FITS.has(item.pageFit)) patch["pageFit"] = item.pageFit
    if (typeof item.noGapContinuous === "boolean") patch["noGapContinuous"] = item.noGapContinuous
    if (typeof item.continuousScroll === "boolean") patch["continuousScroll"] = item.continuousScroll
    if (typeof item.readerTheme === "string" && READER_THEMES.has(item.readerTheme))
        patch["readerTheme"] = item.readerTheme
    return patch as Partial<LibraryManga>
}

export async function applyRemoteItem(item: SyncItem): Promise<boolean> {
    const local = await db.manga.get(item.clientId)
    if (item.deleted) {
        if (!local || local.updatedAt > item.clientUpdatedAt) return false
        await removeManga(item.clientId)
        return true
    }
    const reading = pickReading(item.readingStatus)
    const rating = pickRating(item.rating)
    if (local) {
        if (local.updatedAt >= item.clientUpdatedAt) return false
        const patch: Partial<LibraryManga> = {
            title: item.title,
            normalizedTitle: item.normalizedTitle || normalizeTitle(item.title),
            ...(item.coverUrl ? { coverUrl: item.coverUrl } : {}),
            ...(item.genres ? { genres: item.genres } : {}),
            status: pickStatus(item.status),
            ...(reading ? { readingStatus: reading } : {}),
            ...(reading && typeof item.readingStatusUpdatedAt === "number"
                ? { readingStatusUpdatedAt: item.readingStatusUpdatedAt }
                : {}),
            ...(rating ? { rating } : {}),
            ...(item.anilistId ? { anilistId: item.anilistId } : {}),
            ...(typeof item.lastReadChapterNumber === "number"
                ? { lastReadChapterNumber: item.lastReadChapterNumber }
                : {}),
            ...(typeof item.latestChapterNumber === "number" ? { latestChapterNumber: item.latestChapterNumber } : {}),
            ...(typeof item.lastReadAt === "number" ? { lastReadAt: item.lastReadAt } : {}),
            ...(item.workId ? { workId: item.workId } : {}),
            ...syncedEditableFields(item)
        }
        // Atomic compare-and-write (see applySyncedMangaIfNewer): the outer check above is a fast
        // path, but a user edit can land between that read and the write during the long paged pull.
        return await applySyncedMangaIfNewer(item.clientId, patch, item.clientUpdatedAt)
    }
    if (!item.sourceId || !item.mangaUrl) return false
    await addSyncedManga({
        id: item.clientId,
        title: item.title,
        normalizedTitle: item.normalizedTitle || normalizeTitle(item.title),
        sourceId: item.sourceId,
        sourceUrl: item.mangaUrl,
        mangaUrl: item.mangaUrl,
        ...(item.sourceMangaId ? { sourceMangaId: item.sourceMangaId } : {}),
        ...(item.coverUrl ? { coverUrl: item.coverUrl } : {}),
        ...(item.genres ? { genres: item.genres } : {}),
        authors: [],
        status: pickStatus(item.status),
        ...(reading ? { readingStatus: reading } : {}),
        ...(reading && typeof item.readingStatusUpdatedAt === "number"
            ? { readingStatusUpdatedAt: item.readingStatusUpdatedAt }
            : {}),
        ...(rating ? { rating } : {}),
        ...(item.anilistId ? { anilistId: item.anilistId } : {}),
        ...(typeof item.lastReadChapterNumber === "number"
            ? { lastReadChapterNumber: item.lastReadChapterNumber }
            : {}),
        ...(typeof item.latestChapterNumber === "number" ? { latestChapterNumber: item.latestChapterNumber } : {}),
        ...(typeof item.lastReadAt === "number" ? { lastReadAt: item.lastReadAt } : {}),
        ...(item.workId ? { workId: item.workId } : {}),
        ...syncedEditableFields(item),
        addedAt: Date.now(),
        updatedAt: item.clientUpdatedAt
    })
    return true
}

function statusPatch(status: AccountStatus): Partial<AccountProfile> {
    return {
        userId: status.userId,
        itemCount: status.itemCount,
        ...(status.name ? { name: status.name } : {}),
        ...(status.image ? { image: status.image } : {})
    }
}

let running = false

// Push local changes since the last push (plus parked removals), then pull server changes
// since the last pull. Rejected pushes carry the newer server copy, which is applied like a
// pull. A revoked token flips `invalid` and stops future runs until the user re-links.
export async function runAccountSync(): Promise<AccountProfile> {
    let profile = await getAccountProfile()
    if (!profile.token || profile.invalid || running) return profile
    running = true
    const token = profile.token
    try {
        const changed = (await db.manga.toArray()).filter(m => m.updatedAt > profile.lastPushAt)
        const tombstones = await getTombstones()
        const items: SyncItem[] = [
            ...changed.map(toSyncItem),
            ...Object.entries(tombstones).map(([clientId, at]) => ({
                clientId,
                title: clientId,
                normalizedTitle: clientId,
                deleted: true,
                clientUpdatedAt: at
            }))
        ]

        let libraryChanged = false
        let newestPushed = profile.lastPushAt
        for (let i = 0; i < items.length; i += PUSH_BATCH) {
            const batch = items.slice(i, i + PUSH_BATCH)
            // V2 returns per-record results: rejected rows carry the newer server copy (adopt it
            // like a pull); invalid rows never merged (log so a persistently bad row is visible).
            const result = await apiPush(token, batch)
            for (const r of result.rejected) libraryChanged = (await applyRemoteItem(r.server)) || libraryChanged
            if (result.invalid.length > 0) console.warn("[AMR] Account sync rejected invalid items", result.invalid)
            for (const b of batch) if (!b.deleted && b.clientUpdatedAt > newestPushed) newestPushed = b.clientUpdatedAt
        }
        if (Object.keys(tombstones).length > 0) await clearTombstones(tombstones)

        // Keyset pull loop: page until the server says there is no more, carrying the opaque
        // cursor forward so a boundary write (two rows in the same millisecond) can't be skipped.
        let cursor = profile.pullCursor
        let serverTime = profile.lastSyncAt
        for (;;) {
            const page = await apiPull(token, cursor)
            for (const item of page.items) libraryChanged = (await applyRemoteItem(item)) || libraryChanged
            if (page.nextCursor) cursor = page.nextCursor
            serverTime = page.serverTime
            if (!page.hasMore) break
        }

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
            lastPushAt: newestPushed,
            ...(cursor ? { pullCursor: cursor } : {}),
            lastSyncAt: serverTime || Date.now(),
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
        return profile
    } finally {
        running = false
    }
}

export const accountHandlers: HandlerMap = {
    "account:status": async () => getAccountProfile(),

    // Validate the pasted token against the site, store it, then run a first sync so the
    // library appears on the account straight away.
    "account:link": async request => {
        const token = request.token.trim()
        const status = await apiAccountStatus(token)
        await updateAccountProfile({
            token,
            ...statusPatch(status),
            invalid: false,
            lastPushAt: 0,
            pullCursor: undefined
        })
        await configureAccountAlarm()
        return runAccountSync()
    },

    "account:unlink": async () => {
        await browser.alarms.clear(accountAlarmName)
        await browser.storage.local.remove(["accountTombstones"])
        return clearAccountProfile()
    },

    "account:sync": async () => runAccountSync()
}
