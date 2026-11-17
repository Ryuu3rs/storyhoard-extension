import { normalizeTitle } from "@amr/normalize"
import { addImportedManga, db, updateManga, type LibraryManga } from "../database"
import { getSettings } from "../settings"
import { neverRead, hasKnownLatest, hasNewerChapters, seriesFinished } from "../reading-status"
import {
    getAniListConfig,
    setAniListConfig,
    getAniListStatus,
    getViewerName,
    getViewerProgress,
    saveViewerProgress,
    getViewerMangaList,
    getViewerListEntry,
    getMediaListEntryId,
    saveMediaStatus,
    deleteMediaListEntry,
    getKnownMembership,
    setKnownMembership,
    resolveStatusSync,
    aniListStatusToLocal,
    type SyncStatusKind
} from "../anilist"
import { resolveMetadata } from "../metadata"
import { configureAniListAlarm } from "../background/alarms"
import { publishLive } from "../live"
import type { HandlerMap } from "../background/handler-types"
import { SyncDataPermissionError, syncDataAllowed } from "../sync-data-permission"

let anilistSyncRunning = false
let anilistSyncAborted = false

// Signal a running sync to stop at the next title boundary (pending extension update).
export function abortAniListSync(): void {
    if (anilistSyncRunning) anilistSyncAborted = true
}

export type AniListSyncResult = {
    pushed: number
    added: number
    checked: number
    skipped: number
    statusPushed: number
    statusPulled: number
}

// The library reading-status a title should sync to AniList: explicit paused/dropped/
// planning overrides, else derived completed (finished + caught up) / reading. "unread"
// (never opened) is excluded - membership sync handles the PLANNING add for those. Mirrors
// effectiveReadingStatus but deliberately ignores the inactivity auto-pause, which is a
// local convenience the user never asked to push to AniList.
function localStatusKind(m: LibraryManga): SyncStatusKind | "unread" {
    if (m.readingStatus === "dropped") return "dropped"
    if (m.readingStatus === "paused") return "paused"
    const hasRead = !neverRead(m)
    if (hasRead && hasKnownLatest(m) && !hasNewerChapters(m) && seriesFinished(m)) return "completed"
    if (m.readingStatus === "planning" && !hasRead) return "planning"
    if (hasRead) return "reading"
    return "unread"
}

export type AniListImportResult = { imported: number; skipped: number; total: number }

// Pulls the user's AniList manga list INTO the library. Each new title lands as a
// backup-style "needs a source" entry: a hostname-style (dot-containing) sourceId
// plus manualTracking, exactly the shape a broken backup import produces, so the
// SAME ImportReconcile relink flow (App.svelte's libraryNeedsAttention filter keys
// on `manualTracking && sourceId.includes(".")`) surfaces it for the user to attach a
// real mirror. Dedup + write are atomic in addImportedManga; one malformed entry
// never aborts the batch.
export async function runAniListImport(): Promise<AniListImportResult> {
    const config = await getAniListConfig()
    if (!config.token) throw new Error("Connect your AniList account first")
    const entries = await getViewerMangaList(config.token)
    const settings = await getSettings()
    const now = Date.now()
    const candidates: LibraryManga[] = []
    for (const entry of entries) {
        try {
            const title = entry.title.trim()
            if (!title || entry.anilistId <= 0) continue
            // Respect the import-status opt-outs: when the user turned off importing
            // paused/dropped/planning titles, skip those AniList entries entirely.
            if (entry.listStatus === "paused" && !settings.anilistImportPaused) continue
            if (entry.listStatus === "dropped" && !settings.anilistImportDropped) continue
            if (entry.listStatus === "planning" && !settings.anilistImportPlanning) continue
            // Skip light novels: AniList's type:MANGA bucket includes NOVEL / LIGHT_NOVEL,
            // which have no manga mirror to attach, so importing them only creates broken
            // "needs a source" entries that trigger fruitless searches (S9). ONE_SHOT stays.
            if (entry.format === "NOVEL" || entry.format === "LIGHT_NOVEL") continue
            // A COMPLETED AniList entry is imported as a finished, caught-up title (status
            // completed + latest = lastRead = the integer total) so it derives "completed"
            // (reading-status.ts) instead of landing in Reading - but ONLY when the SERIES is
            // actually finished per AniList publication status, never from the user's list
            // status alone. A still-ongoing series the user marked "completed" on their list
            // must not be stamped publication-finished (S7); it falls through to the normal
            // import. Also requires a real chapter total (no mirror search needed).
            // Narrows to a number in the completed branch below (satisfies
            // exactOptionalPropertyTypes: a plain boolean flag would not).
            const seriesIsFinished = entry.status === "completed" || entry.status === "cancelled"
            const completedTotal =
                entry.rawListStatus === "COMPLETED" && seriesIsFinished ? entry.totalChapters : undefined
            candidates.push({
                id: `anilist:manga:${entry.anilistId}`,
                title,
                normalizedTitle: normalizeTitle(title),
                authors: entry.authors ?? [],
                status: completedTotal !== undefined ? "completed" : entry.status,
                addedAt: now,
                updatedAt: now,
                anilistId: entry.anilistId,
                sourceId: "anilist.co",
                sourceUrl: `https://anilist.co/manga/${entry.anilistId}`,
                manualTracking: true,
                ...(entry.nsfw ? { nsfw: true } : {}),
                ...(entry.coverUrl ? { coverUrl: entry.coverUrl } : {}),
                ...(entry.genres.length > 0 ? { genres: entry.genres } : {}),
                ...(completedTotal !== undefined
                    ? {
                          latestChapterNumber: completedTotal,
                          latestChapterAt: now,
                          lastReadChapterNumber: completedTotal
                      }
                    : {
                          ...(entry.progress > 0 ? { lastReadChapterNumber: entry.progress } : {}),
                          ...(entry.listStatus ? { readingStatus: entry.listStatus } : {})
                      })
            })
        } catch (error) {
            console.warn("[AMR] AniList import: skipping a malformed entry", error)
        }
    }
    const { imported } = await addImportedManga(candidates)
    return { imported, skipped: entries.length - imported, total: entries.length }
}

// Deletes a title's AniList list entry when it's removed from the library. No-op
// unless membership sync is on and the title has a known AniList id. Fire-and-forget
// safe: swallows its own errors so a library removal never fails on an AniList hiccup.
export async function removeFromAniList(anilistId: number | undefined): Promise<void> {
    if (!anilistId || !(await syncDataAllowed())) return
    try {
        const config = await getAniListConfig()
        if (!config.token || !config.syncMembership) return
        const entryId = await getMediaListEntryId(config.token, anilistId)
        if (entryId !== undefined) await deleteMediaListEntry(config.token, entryId)
    } catch (error) {
        console.warn("[AMR] AniList remove failed", error)
    }
}

// Pushes local read progress to the user's AniList list. For each library title with
// a numeric read position, resolves its AniList media id (cached from metadata
// enrichment, else looked up once and cached), reads the remote progress, and pushes
// the local floor only when it is higher - so a sync never lowers AniList. Rate-limited
// well under AniList's 90/min budget (two calls per title). Re-entrancy-latched and
// abort-aware like the other background loops.
export async function runAniListSync(): Promise<AniListSyncResult> {
    if (anilistSyncRunning || !(await syncDataAllowed())) {
        return { pushed: 0, added: 0, checked: 0, skipped: 0, statusPushed: 0, statusPulled: 0 }
    }
    anilistSyncRunning = true
    anilistSyncAborted = false
    let pushed = 0
    let added = 0
    let checked = 0
    let skipped = 0
    let statusPushed = 0
    let statusPulled = 0
    try {
        const config = await getAniListConfig()
        if (!config.token) throw new Error("No AniList token configured")
        const token = config.token
        const membership = config.syncMembership
        const wantStatusSync = Boolean(config.statusPush || config.statusPull)

        // Read titles always push progress. With membership sync on, unread titles that
        // already have a cached AniList id are added to the list (as PLANNING) too - we
        // don't resolve every library title here to keep the request budget bounded. With
        // status sync on, any title carrying an AniList id is in scope so its status can be
        // reconciled even if it has no read progress (e.g. a dropped-before-reading title).
        const mangas = await db.manga
            .filter(
                m =>
                    !m.onHold &&
                    (m.lastReadChapterNumber !== undefined ||
                        (membership && m.anilistId !== undefined) ||
                        (wantStatusSync && m.anilistId !== undefined))
            )
            .toArray()

        // Reconcile snapshot, captured BEFORE the push loop mutates the remote list.
        // - currentRemoteIds: the AniList list fetched ONCE, up front. Fetching before the
        //   push means a genuinely-removed title is seen as absent even though the push
        //   re-creates it. A throwing OR empty remote is indistinguishable from a soft
        //   failure, so reconcile is skipped entirely (stays undefined) - never drop
        //   anything on an empty/failed remote.
        // - genuineRemovals: ids the user HAD on their AniList list last sync
        //   (knownMembership) that are absent from currentRemoteIds now. This is the only
        //   eligible-to-drop set. It is deliberately NOT derived from local anilistIds:
        //   metadata enrichment stamps an anilistId on nearly every library title, so a
        //   local id proves nothing about whether the user ever tracked it on AniList.
        //   On the first sync knownMembership is empty, so nothing is dropped.
        let currentRemoteIds: Set<number> | undefined
        let genuineRemovals: Set<number> | undefined
        if (membership) {
            try {
                const remote = await getViewerMangaList(token)
                if (remote.length > 0) {
                    currentRemoteIds = new Set(remote.map(e => e.anilistId))
                    const known = new Set(await getKnownMembership())
                    genuineRemovals = new Set([...known].filter(id => !currentRemoteIds!.has(id)))
                }
            } catch (error) {
                console.warn("[AMR] AniList reconcile: remote fetch failed, skipping reconcile", error)
            }
        }

        // Ids that are on the user's AniList list after this run: everything the push
        // touched (created or confirmed) becomes the next knownMembership together with
        // currentRemoteIds. A genuine-removal title is never pushed, so it is excluded.
        const pushedIds = new Set<number>()

        for (const manga of mangas) {
            if (anilistSyncAborted) break

            let anilistId = manga.anilistId
            if (anilistId === undefined && manga.lastReadChapterNumber !== undefined) {
                const meta = await resolveMetadata({
                    title: manga.title,
                    sourceId: manga.sourceId,
                    ...(manga.sourceMangaId ? { sourceMangaId: manga.sourceMangaId } : {})
                })
                if (meta?.anilistId) {
                    anilistId = meta.anilistId
                    // Cache only the id. Do NOT stamp metadataUpdatedAt here: that field
                    // means "metadata enrichment (status/cover/genres) was attempted", and
                    // this sync fetched none of that - stamping it would make the enrichment
                    // pass skip the title for the full retry window.
                    await updateManga(manga.id, { anilistId } as Partial<LibraryManga>)
                }
            }
            if (anilistId === undefined) {
                skipped++
                continue
            }

            // Genuine removal: the user had this on their AniList list and has since
            // deleted it there. Mark it dropped locally and DO NOT push it - pushing would
            // re-create the very entry we just detected as removed (the oscillation bug).
            // Only read, not-on-hold, not-already-dropped titles are touched.
            if (
                genuineRemovals !== undefined &&
                genuineRemovals.has(anilistId) &&
                !manga.onHold &&
                !neverRead(manga) &&
                manga.readingStatus !== "dropped"
            ) {
                await updateManga(manga.id, { readingStatus: "dropped" } as Partial<LibraryManga>)
                continue
            }

            const local =
                manga.lastReadChapterNumber !== undefined ? Math.floor(manga.lastReadChapterNumber) : undefined

            try {
                if (!neverRead(manga)) {
                    // Read title: push progress. Branch on neverRead, NOT on local > 0 - a
                    // title read only to Ch 0 / 0.5 floors to 0 but is still read, so it
                    // must push progress (never fall through to the PLANNING add below).
                    const target = local ?? 0
                    const remote = await getViewerProgress(token, anilistId)
                    checked++
                    if (remote === undefined || target > remote) {
                        await saveViewerProgress(token, anilistId, target)
                        pushed++
                    }
                    pushedIds.add(anilistId)
                } else if (membership) {
                    // Unread library title: add as PLANNING only when not already on the
                    // list, so an existing CURRENT/COMPLETED status is never clobbered.
                    const entryId = await getMediaListEntryId(token, anilistId)
                    checked++
                    if (entryId === undefined) {
                        await saveMediaStatus(token, anilistId, "PLANNING")
                        added++
                    }
                    pushedIds.add(anilistId)
                } else {
                    skipped++
                    continue
                }
            } catch {
                // Transient (rate limit, network) - leave it for the next run.
                skipped++
            }
            // AniList allows ~90 requests/min; two calls per title -> ~1.3s spacing.
            await new Promise<void>(r => setTimeout(r, 1300))
        }

        // Second pass: bidirectional reading-status reconcile. Isolated from the progress/
        // membership loop above so that well-tested path is untouched, and only runs when
        // the user opted into pushing and/or pulling status. Per title: compare the local
        // status to the AniList entry's; with both directions on, the more recently changed
        // side wins (last-writer). A pulled COMPLETED completes the local title against the
        // AniList chapter total, mirroring the import rule (skipped when no total is known).
        if (wantStatusSync && !anilistSyncAborted) {
            const nowMs = Date.now()
            for (const manga of mangas) {
                if (anilistSyncAborted) break
                const anilistId = manga.anilistId
                if (anilistId === undefined) continue
                if (genuineRemovals !== undefined && genuineRemovals.has(anilistId)) continue
                const kind = localStatusKind(manga)
                if (kind === "unread") continue
                try {
                    const entry = await getViewerListEntry(token, anilistId)
                    // Explicit = the RESOLVED kind is a user choice (paused/dropped/planning),
                    // not the raw readingStatus field: a title marked "planning" that has since
                    // been read resolves to a DERIVED "reading", which must not be treated as
                    // explicit. An explicit status stamps readingStatusUpdatedAt; a derived one
                    // does not. Do NOT fall back to `updatedAt` for the tiebreak - unrelated
                    // writes (the genre/status backfill) churn it, which would let a legacy
                    // title wrongly win last-writer over a genuinely newer remote change.
                    const explicit = kind === "paused" || kind === "dropped" || kind === "planning"
                    const decision = resolveStatusSync({
                        local: {
                            kind,
                            ts: Math.min(manga.readingStatusUpdatedAt ?? manga.lastReadAt ?? 0, nowMs),
                            explicit
                        },
                        remote: {
                            ...(entry?.status ? { status: entry.status } : {}),
                            ts: entry?.updatedAt !== undefined ? Math.min(entry.updatedAt * 1000, nowMs) : 0
                        },
                        push: Boolean(config.statusPush),
                        pull: Boolean(config.statusPull)
                    })
                    if (decision.action === "push") {
                        await saveMediaStatus(token, anilistId, decision.status)
                        statusPushed++
                    } else if (decision.action === "pullLocal") {
                        const local = aniListStatusToLocal(decision.status)
                        if (local.completed) {
                            // Only complete when the SERIES is actually finished per AniList AND
                            // a real total is known - never stamp publication-finished from the
                            // user's list status alone (S7, same rule as import).
                            if (entry?.totalChapters !== undefined && entry.seriesFinished) {
                                // Never LOWER the local latest to AniList's total: a
                                // scanlation mirror is frequently ahead of AniList's chapter
                                // count, and overwriting would hide real chapters from the
                                // reader/badge. Never RAISE lastRead past what actually
                                // exists locally either (no phantom "read" chapters).
                                const total = entry.totalChapters
                                const nextLatest = Math.max(manga.latestChapterNumber ?? 0, total)
                                const nextLastRead = Math.min(
                                    nextLatest,
                                    Math.max(manga.lastReadChapterNumber ?? 0, total)
                                )
                                await db.table("manga").update(manga.id, {
                                    status: "completed",
                                    latestChapterNumber: nextLatest,
                                    latestChapterAt: nowMs,
                                    lastReadChapterNumber: nextLastRead,
                                    readingStatus: undefined,
                                    readingStatusUpdatedAt: nowMs,
                                    updatedAt: nowMs
                                })
                                statusPulled++
                            }
                        } else {
                            // A cleared override (null) needs the untyped update path -
                            // exactOptionalPropertyTypes rejects readingStatus: undefined in a
                            // typed Partial<LibraryManga>.
                            await db.table("manga").update(manga.id, {
                                readingStatus: local.readingStatus ?? undefined,
                                readingStatusUpdatedAt: nowMs,
                                updatedAt: nowMs
                            })
                            statusPulled++
                        }
                    }
                } catch {
                    // Transient - leave it for the next run.
                }
                await new Promise<void>(r => setTimeout(r, 1300))
            }
            if (statusPulled > 0) publishLive(["library"], [])
        }

        // Persist the membership known as of this completed sync: the current remote list
        // unioned with everything the push just added, so the next run can tell a real
        // removal from a title the user never tracked. Only when the remote fetch actually
        // succeeded (currentRemoteIds defined) and the run finished - an aborted or
        // soft-failed run must not overwrite the previous known set.
        if (membership && !anilistSyncAborted && currentRemoteIds !== undefined) {
            const nextKnown = new Set(currentRemoteIds)
            for (const id of pushedIds) nextKnown.add(id)
            await setKnownMembership([...nextKnown])
        }

        // Only record a completed sync when the loop actually finished. An aborted run
        // (pending extension update) processed only part of the library, so stamping
        // lastSyncAt would mislabel a partial push as a full sync.
        if (!anilistSyncAborted) await setAniListConfig({ lastSyncAt: Date.now() })
        return { pushed, added, checked, skipped, statusPushed, statusPulled }
    } finally {
        anilistSyncRunning = false
        anilistSyncAborted = false
    }
}

export const anilistHandlers: HandlerMap = {
    "anilist:status": async () => {
        return await getAniListStatus()
    },
    "anilist:config": async request => {
        const patch = Object.fromEntries(Object.entries(request.config).filter(([, v]) => v !== undefined))
        // Validate a newly-pasted token. Reject only on a genuine AUTH error (4xx) so a
        // bad paste fails fast; on a transient error (5xx / network - AniList down) save
        // the token anyway rather than rejecting a good token during an outage.
        let viewerName: string | undefined
        if (typeof patch.token === "string" && patch.token.length > 0) {
            try {
                viewerName = await getViewerName(patch.token)
            } catch (cause) {
                const status = Number(/AniList API (\d+)/.exec(cause instanceof Error ? cause.message : "")?.[1])
                if (status >= 400 && status < 500) {
                    throw new Error("That AniList token was rejected. Check it and try again.")
                }
                // transient - fall through and save the (presumably valid) token unverified
            }
        }
        const next = await setAniListConfig(patch)
        await configureAniListAlarm()
        return {
            hasToken: Boolean(next.token),
            autoSync: next.autoSync,
            syncMembership: next.syncMembership,
            statusPush: next.statusPush ?? false,
            statusPull: next.statusPull ?? false,
            ...(viewerName ? { viewerName } : {}),
            ...(next.lastSyncAt ? { lastSyncAt: next.lastSyncAt } : {})
        }
    },
    "anilist:sync": async () => {
        const config = await getAniListConfig()
        if (!config.token) throw new Error("Connect your AniList account first")
        if (!(await syncDataAllowed())) throw new SyncDataPermissionError()
        // Fire-and-forget: the full push can run for minutes across a large library,
        // longer than an MV3 message channel survives. The worker keeps running it;
        // the UI refreshes lastSyncAt via anilist:status on the library live event.
        void runAniListSync()
            .then(() => publishLive(["library"]))
            .catch(error => console.warn("[AMR] AniList sync failed", error))
        return { started: true }
    },
    "anilist:import": async () => {
        // Awaits the full import and returns counts; the dispatcher publishes the
        // ["library"] live event from MUTATION_SCOPES once this resolves.
        return await runAniListImport()
    }
}
