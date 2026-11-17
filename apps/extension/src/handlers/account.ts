import { normalizeTitle } from "@amr/normalize"
import {
    addSyncedManga,
    applySyncedMangaIfNewer,
    clampTimestamp,
    createBackup,
    db,
    healFutureUpdatedAt,
    isHttpUrl,
    recordAnalyticsEvent,
    removeManga,
    sanitizeMangaRow,
    type LibraryManga
} from "../database"
import { libraryMangaSchema } from "../schema"
import { isPublicCoverUrl } from "../background/covers"
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
    getRefusedRows,
    getTombstoneMoves,
    getTombstones,
    setRefusedRows,
    toSyncItem,
    updateAccountProfile,
    type AccountProfile,
    type AccountStatus,
    type PushResult,
    type SyncItem
} from "../account"
import { accountAlarmName, configureAccountAlarm } from "../background/alarms"
import { diag } from "../diag-log"
import { fromExtensionPage, type HandlerMap } from "../background/handler-types"
import { getCommunityProfile } from "../community"
import { publishLive } from "../live"

const PUSH_BATCH = 400
const MAX_PULL_PAGES = 200
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

// removeManga also wipes the title's chapters, history and bookmarks, which the account does not hold,
// so they could not come back any other way. One backup per sync covers every delete in it. If the
// backup fails this throws, which ends the sync with the title still here.
let backedUpThisSync = false
async function backupBeforePulledDelete(): Promise<void> {
    if (backedUpThisSync) return
    await createBackup("pre-sync-delete")
    backedUpThisSync = true
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined)
const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const flag = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined)
const strings = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined
    const kept = v.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    return kept.length > 0 ? kept : undefined
}

// A pulled row is untrusted input: it is checked field by field like an imported file row, and a row
// without a usable id, title or timestamp is refused so one bad row cannot end the sync.
export function parseSyncItem(raw: unknown, now = Date.now()): SyncItem | undefined {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
    const r = raw as Record<string, unknown>
    const clientId = text(r["clientId"])
    const clientUpdatedAt = clampTimestamp(r["clientUpdatedAt"], now)
    if (!clientId || clientUpdatedAt === undefined) return undefined
    const title = text(r["title"])?.trim()
    if (r["deleted"] === true) {
        return { clientId, title: title ?? clientId, normalizedTitle: clientId, deleted: true, clientUpdatedAt }
    }
    if (!title) return undefined
    const mangaUrl = text(r["mangaUrl"])
    const anilistId = finite(r["anilistId"])
    const item: SyncItem = {
        clientId,
        title,
        normalizedTitle: text(r["normalizedTitle"])?.trim() || normalizeTitle(title),
        clientUpdatedAt,
        anilistId: anilistId !== undefined && Number.isInteger(anilistId) && anilistId > 0 ? anilistId : null,
        sourceId: text(r["sourceId"]) ?? null,
        sourceMangaId: text(r["sourceMangaId"]) ?? null,
        mangaUrl: mangaUrl && isHttpUrl(mangaUrl) ? mangaUrl : null,
        coverUrl: isPublicCoverUrl(r["coverUrl"]) ? r["coverUrl"] : null,
        genres: strings(r["genres"]) ?? null,
        status: text(r["status"]) ?? null,
        readingStatus: text(r["readingStatus"]) ?? null,
        readingStatusUpdatedAt: clampTimestamp(r["readingStatusUpdatedAt"], now) ?? null,
        rating: finite(r["rating"]) ?? null,
        lastReadChapterNumber: finite(r["lastReadChapterNumber"]) ?? null,
        latestChapterNumber: finite(r["latestChapterNumber"]) ?? null,
        lastReadAt: clampTimestamp(r["lastReadAt"], now) ?? null,
        notes: typeof r["notes"] === "string" ? r["notes"] : null,
        categories: strings(r["categories"]) ?? null,
        onHold: flag(r["onHold"]) ?? null,
        manualTracking: flag(r["manualTracking"]) ?? null,
        nsfw: flag(r["nsfw"]) ?? null,
        pageWidthPct: finite(r["pageWidthPct"]) ?? null,
        readingDirection: text(r["readingDirection"]) ?? null,
        pageFit: text(r["pageFit"]) ?? null,
        noGapContinuous: flag(r["noGapContinuous"]) ?? null,
        continuousScroll: flag(r["continuousScroll"]) ?? null,
        readerTheme: text(r["readerTheme"]) ?? null,
        workId: text(r["workId"]) ?? null
    }
    return item
}

export async function applyRemoteItem(raw: SyncItem): Promise<boolean> {
    const item = parseSyncItem(raw)
    if (!item) {
        diag.warn("account-sync", "skipped a malformed pulled row", {
            clientId: typeof raw?.clientId === "string" ? raw.clientId : null
        })
        return false
    }
    const local = await db.manga.get(item.clientId)
    if (item.deleted) {
        if (!local || local.updatedAt > item.clientUpdatedAt) return false
        await backupBeforePulledDelete()
        await removeManga(item.clientId)
        return true
    }
    const reading = pickReading(item.readingStatus)
    const rating = pickRating(item.rating)
    if (local) {
        if (local.updatedAt >= item.clientUpdatedAt) return false
        // A copy from before the user undid a source change counts the undone source's chapters.
        const sourceUndoneSince = (local.sourceRestoredAt ?? 0) > item.clientUpdatedAt
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
            ...(typeof item.latestChapterNumber === "number" && !sourceUndoneSince
                ? { latestChapterNumber: item.latestChapterNumber }
                : {}),
            ...(typeof item.lastReadAt === "number" ? { lastReadAt: item.lastReadAt } : {}),
            ...(item.workId ? { workId: item.workId } : {}),
            ...syncedEditableFields(item)
        }
        // Atomic compare-and-write (see applySyncedMangaIfNewer): the outer check above is a fast
        // path, but a user edit can land between that read and the write during the long paged pull.
        return await applySyncedMangaIfNewer(item.clientId, patch, item.clientUpdatedAt)
    }
    if (!item.sourceId || !item.mangaUrl) return false
    const record = sanitizeMangaRow({
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
    }) as LibraryManga
    if (!libraryMangaSchema.safeParse(record).success) {
        diag.warn("account-sync", "skipped a pulled row that fails the library schema", { clientId: item.clientId })
        return false
    }
    await addSyncedManga(record)
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

// Validate a device token against the site, store it, and run a first sync. Shared by the
// account:link paste path and the H34 link-handoff receiver (both end with a valid token to
// persist and a sync to run), so the two can never drift in how a link is finalised.
export async function linkAccountWithToken(token: string): Promise<AccountProfile> {
    const status = await apiAccountStatus(token)
    await forgetPendingForOtherAccount(status.userId)
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

// Push local changes since the last push (plus parked removals), then pull server changes
// since the last pull. Rejected pushes carry the newer server copy, which is applied like a
// pull. A revoked token flips `invalid` and stops future runs until the user re-links.
export async function runAccountSync(): Promise<AccountProfile> {
    let profile = await getAccountProfile()
    if (!profile.token || profile.invalid || running) return profile
    running = true
    backedUpThisSync = false
    const token = profile.token
    try {
        const startedAt = Date.now()
        // A push clock ahead of this device's clock (left by a build that trusted remote timestamps)
        // would hold back every later edit, so it is reset and the whole library pushed again; the
        // server keeps whichever copy is newer.
        const lastPushAt = profile.lastPushAt > startedAt ? 0 : profile.lastPushAt
        if (await healFutureUpdatedAt(startedAt)) diag.warn("account-sync", "reset future timestamps on local rows")
        const library = await db.manga.toArray()
        const localIds = new Set(library.map(m => m.id))
        const previouslyRefused = new Set(await getRefusedRows())
        const rows = library.filter(m => m.updatedAt > lastPushAt || previouslyRefused.has(m.id))

        let libraryChanged = false
        let newestPushed = lastPushAt
        // V2 returns per-record results: `rejected` lost to a newer server copy, which is adopted like a
        // pull; `invalid` never reached the merge.
        const pushBatches = async (items: SyncItem[], onResult: (result: PushResult) => void) => {
            for (let i = 0; i < items.length; i += PUSH_BATCH) {
                const batch = items.slice(i, i + PUSH_BATCH)
                const result = await apiPush(token, batch)
                for (const r of Array.isArray(result.rejected) ? result.rejected : []) {
                    if (r?.server?.clientId !== r?.clientId || !batch.some(b => b.clientId === r.clientId)) continue
                    libraryChanged = (await applyRemoteItem(r.server)) || libraryChanged
                }
                if (result.invalid.length > 0) {
                    diag.warn("account-sync", "the server refused rows", { invalid: result.invalid })
                }
                onResult(result)
                for (const b of batch) {
                    if (!b.deleted && b.clientUpdatedAt > newestPushed) newestPushed = b.clientUpdatedAt
                }
            }
        }

        const refused = new Set<string>()
        await pushBatches(rows.map(toSyncItem), result => {
            for (const bad of result.invalid) if (bad.clientId) refused.add(bad.clientId)
        })
        await setRefusedRows([...refused])

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
        const settle = (clientId: string) => {
            const at = tombstones[clientId]
            if (at !== undefined) settled[clientId] = at
        }
        await pushBatches(outgoing, result => {
            result.accepted.forEach(settle)
            result.rejected.forEach(r => settle(r.clientId))
        })
        if (Object.keys(settled).length > 0) await clearTombstones(settled)

        // Keyset pull loop: page until the server says there is no more, carrying the opaque
        // cursor forward so a boundary write (two rows in the same millisecond) can't be skipped.
        // A server that keeps answering hasMore without moving the cursor, or more pages than one run
        // should take, ends the loop; the saved cursor lets the next run carry on.
        let cursor = profile.pullCursor
        let serverTime: number | undefined
        for (let pages = 1; ; pages++) {
            const page = await apiPull(token, cursor)
            const items: unknown[] = Array.isArray(page?.items) ? page.items : []
            for (const item of items) libraryChanged = (await applyRemoteItem(item as SyncItem)) || libraryChanged
            const next = typeof page?.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined
            const advanced = next !== undefined && next !== cursor
            if (next) cursor = next
            serverTime = clampTimestamp(page?.serverTime) ?? serverTime
            if (page?.hasMore !== true) break
            if (!advanced || pages >= MAX_PULL_PAGES) {
                diag.warn("account-sync", "stopped paging early", { advanced, pages })
                break
            }
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
        // A row stamped up to CLOCK_SKEW_MS ahead is pushed, but the push clock never passes the moment
        // this run read the library: an edit made after that has a later stamp and still goes out.
        profile = await updateAccountProfile({
            lastPushAt: Math.min(newestPushed, startedAt - 1),
            ...(cursor ? { pullCursor: cursor } : {}),
            lastSyncAt: Math.min(serverTime || Date.now(), Date.now()),
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
    // The device token is a long-lived credential, so only the extension's own pages get it. A content
    // script (the weeb.ltd bridge) only needs to know whether an account is linked.
    "account:status": async (_request, ctx) => {
        const profile = await getAccountProfile()
        if (fromExtensionPage(ctx)) return profile
        const { token, ...rest } = profile
        return { ...rest, linked: typeof token === "string" && token !== "" && !profile.invalid }
    },

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
