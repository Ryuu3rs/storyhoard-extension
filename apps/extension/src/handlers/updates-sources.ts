import type { SourceLinkRecord } from "@amr/contracts"
import { sourceRegistry } from "@amr/sources"
import {
    isNumberedChapter,
    latestNumberedChapter,
    matchesSourceDomain,
    SourceChallengeError,
    SourceRequestError
} from "@amr/source-sdk"
import { normalizeTitle } from "@amr/normalize"
import {
    applyUpdateCheckResult,
    cacheCover,
    chaptersForUpdateCheck,
    clampIdSizedChapterNumbers,
    db,
    repairMangahubChapters,
    restoreSourceLink,
    updateManga,
    type LibraryManga
} from "../database"
import {
    chaptersForLanguage,
    checkSourcePermission,
    getMangaChapters,
    listChaptersForSource,
    listMangaChapters,
    resolveCoverFor,
    resolveGenresFor,
    searchManga
} from "../sources"
import { fetchCoverBlob, isPublicCoverUrl } from "../background/covers"
import { proxiedCoverUrl } from "../cover-crossorigin"
import { resolveMetadata } from "../metadata"
import { diag } from "../diag-log"
import { getSettings } from "../settings"
import { recordChallengedSites } from "../site-session"
import { updateCheckCause, type RelinkReason } from "../update-check-cause"
import { mergeSiteOffTitles, mergeSourceStatus, mergeTitleStatus, type MergeableStatus } from "../update-status-merge"
import { isNewerVersion } from "../update-check"
import { AMO_ADDON_API_URL, amoListingUrl, parseAmoAddon, type FirefoxStoreUpdate } from "../firefox-store-update"
import {
    HostQueue,
    hostOf,
    isBackedOff,
    pruneBackoff,
    recordHostBlock,
    recordHostSuccess,
    runBudget,
    selectDueTitles,
    type HostBackoff,
    type LastChecked,
    type RunBudget
} from "../update-schedule"
import { EXTENSION_UPDATE_INTERVAL_HOURS, GITHUB_RELEASES_URL, scheduleUpdateContinuation } from "../background/alarms"
import { isProfileSource, isTabListSource, isTrackingOnlySource, lacksSiteAccess } from "../arch-sources"
import { isDetectedSourceId } from "../detected-site"
import { isBotBlocked } from "../background/capture"
import { followMovedSeries, isSeriesGone } from "../background/moved-series"
import {
    MANGAHUB_INTERNAL_ID_MIN,
    listChaptersViaRenderedTab,
    purgeStaleMangahubChapterRows
} from "../background/chapter-cache"
import { delay, type HandlerMap } from "../background/handler-types"
import { userSourcesReady } from "../background/user-sources-ready"
import { UNLISTED_SOURCE_LABEL } from "../source-labels"
import { listSourceLabels } from "../source-prefs"
import { publishLive } from "../live"
import { notifyNewChapters } from "../notifications"
import { selfUpdateAllowed } from "../self-update"

// Failed titles kept in the stored status, enough for the fix-it page to list each one.
const ERROR_ROWS_CAP = 200
// Titles to relink kept in the stored status. A whole retired site behind a library must not make it unbounded.
const RELINK_TITLES_CAP = 200

let updateCheckRunning = false
let updateCheckAborted = false
let genreBackfillRunning = false
let genreBackfillAborted = false

// Persistent "an extension update is waiting to be applied" latch. Set from
// background.ts's onUpdateAvailable and read by the long background loops below.
// abortLongRunningTasks() only stops a task that is CURRENTLY running; if the update
// arrives while the worker is idle, the next alarm-driven checkUpdates/backfill would
// otherwise start a fresh multi-minute loop and keep the worker busy, re-deferring the
// update indefinitely. This latch makes both loops early-return so the worker idles and
// the browser applies the pending update. Persisted (storage.local, not a module
// boolean) so it survives a service-worker restart between onUpdateAvailable and the
// update landing; cleared on the next onStartup/onInstalled once the new version runs.
const UPDATE_PENDING_KEY = "extensionUpdatePending"

export async function markUpdatePending(): Promise<void> {
    await browser.storage.local.set({ [UPDATE_PENDING_KEY]: true })
}

export async function clearUpdatePending(): Promise<void> {
    await browser.storage.local.remove(UPDATE_PENDING_KEY)
}

async function isUpdatePending(): Promise<boolean> {
    return Boolean((await browser.storage.local.get(UPDATE_PENDING_KEY))[UPDATE_PENDING_KEY])
}

// How long to wait before the metadata pass re-tries a title it already checked, so a
// permanent no-match (or a source with no genres) isn't re-queried every startup.
const META_RETRY_MS = 7 * 24 * 60 * 60 * 1000

// Signal any running long, rate-limited background loop to stop at its next
// between-items boundary. Used when an extension update is waiting to be applied: a
// multi-minute loop keeps the service worker busy, which defers the update (the case
// that wedged installs). Both the update check AND the genre backfill are per-item
// loops with a ~350ms delay each, so both must yield. Aborting lets the worker go idle
// so the browser applies the pending update on its own - we intentionally do NOT force
// runtime.reload() (see the onUpdateAvailable listener in background.ts for why).
export function abortLongRunningTasks(): void {
    if (updateCheckRunning) updateCheckAborted = true
    if (genreBackfillRunning) genreBackfillAborted = true
}

// A crashed check (service worker killed mid-loop - browser closed, SW
// terminated/evicted) leaves updateProgress.running: true in storage forever:
// nothing but a fresh check's writeProgress() call ever flips it back, and the
// in-memory updateCheckRunning guard resets to false on every SW restart, so it
// can't tell a genuinely running check apart from a dead one. Treat a stored
// running: true older than this as dead rather than trusting it forever. Sized
// generously above what even a very large library could plausibly take: each
// title pauses 400ms for rate-limiting plus its own network round trip, so a
// library of many hundreds of titles can legitimately run several minutes -
// 15 minutes is comfortably past that while still recovering a stuck state quickly
// rather than leaving it wedged indefinitely.
const STALE_PROGRESS_TIMEOUT_MS = 15 * 60 * 1000

type UpdateProgress = {
    running: boolean
    done: number
    total: number
    currentTitle?: string
    sourceId?: string
    startedAt: number
}

// Proactively clear a stale "running" progress record left by a check whose
// service worker was killed mid-loop (browser closed, SW evicted, or - the case
// that bricked installs - an extension update landing while a check ran). Called
// from the background's onStartup/onInstalled: the in-memory updateCheckRunning
// guard is definitionally false in a freshly-started worker, so any persisted
// running: true at that point belongs to a dead check and nothing else will ever
// flip it back. Without this the check UI showed "running" forever until the next
// user-triggered check happened to hit the reactive stale-recovery in the
// updates:check handler. Leaves done/total/startedAt intact for display.
export async function clearStaleUpdateProgress(): Promise<void> {
    const stored = (await browser.storage.local.get("updateProgress"))["updateProgress"] as UpdateProgress | undefined
    // Re-check the in-memory guard AFTER the async get: onStartup fires this unawaited
    // while an overdue alarm can start a real check in the same fresh worker moments
    // later. If that check is now running, its progress record is live - clearing it
    // would flip the UI to "not running" mid-check until the next per-title write. The
    // guard is same-worker-accurate, so this reliably distinguishes a dead record from
    // a freshly-started one.
    if (!stored?.running || updateCheckRunning) return
    // Re-read immediately before writing: a full check can start AND finish between the
    // first get() above and here (an overdue alarm firing checkUpdates in the same fresh
    // worker), writing its own fresh progress. Writing {...stored} would then resurrect
    // the dead run's done/total over the real one. Only clear if the record is still the
    // exact stale one we read - same startedAt, still running.
    const current = (await browser.storage.local.get("updateProgress"))["updateProgress"] as UpdateProgress | undefined
    if (current?.running && current.startedAt === stored.startedAt && !updateCheckRunning) {
        await browser.storage.local.set({
            updateProgress: { ...current, running: false } satisfies UpdateProgress
        })
    }
}

// The chapters of a tab-list source's title, read from its page rendered in a background tab. Undefined
// when that title was rendered recently and nothing was done.
async function listRenderedChapters(item: LibraryManga, link: SourceLinkRecord) {
    const source = sourceRegistry.get(link.sourceId)
    if (!source) return undefined
    let sourceMangaId = link.sourceMangaId
    if (!sourceMangaId) {
        try {
            sourceMangaId = source.parseMangaUrl?.(new URL(link.url))?.sourceMangaId ?? undefined
        } catch {
            sourceMangaId = undefined
        }
    }
    if (!sourceMangaId) return []
    return listChaptersViaRenderedTab(item, source, sourceMangaId, link.url)
}

// A site that briefly lists one chapter short (10, then 9, then 10 again) re-points the title at the
// lower chapter, which is how a merge-inflated number heals, so the stored latest really does drop.
// Without a memory of the higher number, chapter 10 then reads as new a second time and is announced
// again. The number the title stood at before such a drop is kept here per title, and a chapter at or
// below it is not counted as new. It lapses after a week, so a drop that was a real correction does
// not hide genuinely new chapters for long.
const CHAPTER_HIGH_WATER_KEY = "chapterHighWater"
const CHAPTER_HIGH_WATER_TTL_MS = 7 * 24 * 60 * 60 * 1000

type ChapterHighWater = { marks: Record<string, { n: number; at: number }> }

async function readChapterHighWater(): Promise<ChapterHighWater> {
    const marks: ChapterHighWater["marks"] = {}
    try {
        const stored = (await browser.storage.local.get(CHAPTER_HIGH_WATER_KEY))[CHAPTER_HIGH_WATER_KEY]
        if (stored !== null && typeof stored === "object") {
            const now = Date.now()
            for (const [mangaId, mark] of Object.entries(stored as ChapterHighWater["marks"])) {
                if (Number.isFinite(mark?.n) && now - mark.at < CHAPTER_HIGH_WATER_TTL_MS) marks[mangaId] = mark
            }
        }
    } catch {
        // without the marks a short list can only cause one repeated announcement
    }
    return { marks }
}

async function noteChapterHighWater(
    highWater: ChapterHighWater,
    item: LibraryManga,
    latest: { sortKey: number } | undefined
): Promise<void> {
    if (!latest || !Number.isFinite(latest.sortKey)) return
    const previous = item.latestChapterNumber
    const mark = highWater.marks[item.id]
    let changed = false
    if (previous !== undefined && latest.sortKey < previous) {
        if (!mark || mark.n < previous) {
            highWater.marks[item.id] = { n: previous, at: Date.now() }
            changed = true
        }
    } else if (mark && latest.sortKey >= mark.n) {
        delete highWater.marks[item.id]
        changed = true
    }
    if (!changed) return
    await browser.storage.local.set({ [CHAPTER_HIGH_WATER_KEY]: highWater.marks }).catch(() => {})
}

const LAST_CHECKED_KEY = "updateLastChecked"
const HOST_BACKOFF_KEY = "updateHostBackoff"
const SCHEDULE_FLUSH_EVERY = 20

async function readSchedule(): Promise<{ lastChecked: LastChecked; backoff: HostBackoff }> {
    const stored = await browser.storage.local.get([LAST_CHECKED_KEY, HOST_BACKOFF_KEY])
    const lastChecked = stored[LAST_CHECKED_KEY]
    const backoff = stored[HOST_BACKOFF_KEY]
    return {
        lastChecked: lastChecked !== null && typeof lastChecked === "object" ? { ...(lastChecked as LastChecked) } : {},
        backoff: backoff !== null && typeof backoff === "object" ? { ...(backoff as HostBackoff) } : {}
    }
}

async function writeSchedule(lastChecked: LastChecked, backoff: HostBackoff): Promise<void> {
    await browser.storage.local.set({
        [LAST_CHECKED_KEY]: lastChecked,
        [HOST_BACKOFF_KEY]: pruneBackoff(backoff, Date.now())
    })
}

// The host a title's request goes to, or a private key for a title that never touches the network
// (no link, retired source, tracking-only) so the per-site spacing does not hold those back.
function queueHost(item: LibraryManga, link: SourceLinkRecord | undefined): string {
    if (!link || !sourceRegistry.get(link.sourceId) || isTrackingOnlySource(link.sourceId)) return `local:${item.id}`
    return hostOf(link.url) ?? `source:${link.sourceId}`
}

// A detected title is a local record of a page the user's own tab showed: there is no source behind it to
// ask, so it is never checked in the background.
const isCheckable = (item: LibraryManga) => !item.manualTracking && !item.onHold && !isDetectedSourceId(item.sourceId)

// A site with no adapter behind it, or a seeded one the user has not turned back on, is not read. Its
// titles wait for the site to be reconnected. Asked once per site per caller.
function siteOffCheck(): (sourceId: string) => Promise<boolean> {
    const answers = new Map<string, boolean>()
    return async sourceId => {
        let off = answers.get(sourceId)
        if (off === undefined) {
            off = !sourceRegistry.get(sourceId) || (await lacksSiteAccess(sourceId))
            answers.set(sourceId, off)
        }
        return off
    }
}

// The stored status with its site-off titles worked out from the library, without a request, so the app shows
// which sites to turn back on the first time it opens after an update instead of after the next check.
export async function statusWithSiteOffTitles(): Promise<MergeableStatus | null> {
    await userSourcesReady()
    const read = async () =>
        (await browser.storage.local.get("updateStatus"))["updateStatus"] as MergeableStatus | undefined
    if (updateCheckRunning) return (await read()) ?? null
    const siteIsOff = siteOffCheck()
    const manga = (await db.manga.toArray()).filter(isCheckable)
    const links = await db.sourceLinks.bulkGet(manga.map(item => item.id))
    const rows: Array<{ mangaId: string; title: string; sourceId: string; reason: RelinkReason }> = []
    for (const [i, item] of manga.entries()) {
        const link = links[i] ?? (await restoreSourceLink(item.id))
        if (link && (await siteIsOff(link.sourceId))) {
            rows.push({ mangaId: item.id, title: item.title, sourceId: link.sourceId, reason: "site-off" })
        }
    }
    const previous = await read()
    if (updateCheckRunning || (!previous && rows.length === 0)) return previous ?? null
    const merged = mergeSiteOffTitles(previous, rows)
    const next = { ...merged, relinkTitles: (merged.relinkTitles ?? []).slice(0, RELINK_TITLES_CAP) }
    if (JSON.stringify(next) !== JSON.stringify(previous)) await browser.storage.local.set({ updateStatus: next })
    return next
}

// Manual "Check now" and the per-site re-checks: every eligible title, on the given sites or all of them.
export function checkUpdates(sourceIds?: readonly string[]) {
    return runUpdateCheck(sourceIds && sourceIds.length > 0 ? [...new Set(sourceIds)] : undefined, false)
}

// The alarm: only titles that are due on the user's schedule, within a budget that ends before the next run.
export function checkScheduledUpdates() {
    return runUpdateCheck(undefined, true)
}

async function runUpdateCheck(sourceIds: string[] | undefined, scheduled: boolean) {
    const sourceId = sourceIds?.length === 1 ? sourceIds[0] : undefined
    // Claimed before the first await: two alarms firing together, or an alarm and "Check now", would
    // otherwise both pass the test and run the whole loop twice.
    if (updateCheckRunning) return
    updateCheckRunning = true
    updateCheckAborted = false
    const startedAt = Date.now()
    // Hoisted out of the try so the catch below can still write an accurate terminal
    // progress record after an unexpected mid-loop throw (Bug 8).
    let done = 0
    let total = 0
    let lastChecked: LastChecked = {}
    let hostBackoff: HostBackoff = {}
    let scheduleLoaded = false
    let eligibleCount = 0
    let budget: RunBudget | undefined
    let capped = false
    let budgetStopped = false
    const scheduledLinks = new Map<string, SourceLinkRecord>()
    const localIds = new Set<string>()
    const siteIsOff = siteOffCheck()
    // What this run actually looked at, so a scheduled run only replaces those titles' part of the status.
    const checkedIds = new Set<string>()
    const reachedSources = new Set<string>()
    try {
        // An alarm can cold-start the worker; bucket library rows only once added sources are registered.
        await userSourcesReady()
        // An extension update is waiting to be applied - idle so the browser can apply it
        // instead of starting a multi-minute loop that keeps the worker busy (Bug 22).
        if (await isUpdatePending()) return
        let manga: LibraryManga[]
        let language: string
        try {
            const settings = await getSettings()
            if (scheduled && settings.updateIntervalMinutes === 0) return
            let all = await db.manga.toArray()
            // A count holding a site's chapter id is healed here too, so "Check now" fixes it without waiting
            // for the one-time sweep, which only runs when the library page opens.
            const poisoned = all.filter(
                item =>
                    (item.latestChapterNumber ?? 0) >= MANGAHUB_INTERNAL_ID_MIN ||
                    (item.lastReadChapterNumber ?? 0) >= MANGAHUB_INTERNAL_ID_MIN
            )
            if (poisoned.length > 0) {
                for (const item of poisoned) await clampIdSizedChapterNumbers(item.id).catch(() => false)
                publishLive(
                    ["chapters", "library"],
                    poisoned.map(item => item.id)
                )
                all = await db.manga.toArray()
            }
            const scope = sourceIds ? new Set(sourceIds) : undefined
            const scoped = scope ? all.filter(item => scope.has(item.sourceId)) : all
            manga = scoped.filter(isCheckable)
            language = settings.language
            eligibleCount = manga.length
            const schedule = await readSchedule()
            lastChecked = schedule.lastChecked
            hostBackoff = schedule.backoff
            scheduleLoaded = true
            const libraryIds = new Set(all.map(item => item.id))
            for (const id of Object.keys(lastChecked)) if (!libraryIds.has(id)) delete lastChecked[id]
            if (scheduled) {
                const now = Date.now()
                budget = runBudget(settings.updateIntervalMinutes)
                const due = selectDueTitles(
                    manga,
                    lastChecked,
                    settings.updateIntervalMinutes,
                    settings.autoPauseDays,
                    now
                )
                const links = await db.sourceLinks.bulkGet(due.map(item => item.id))
                for (const link of links) if (link) scheduledLinks.set(link.mangaId, link)
                // A title synced before its link was written gets the link back here, before it is sorted,
                // so the request it will make counts against the budget and waits its turn on its real host.
                for (const item of due) {
                    if (scheduledLinks.has(item.id)) continue
                    const restored = await restoreSourceLink(item.id)
                    if (restored) scheduledLinks.set(item.id, restored)
                }
                // The budget is network time. A title that is settled without a request (no link, a retired
                // or tracking-only source, a site the user has not turned on) is always taken and costs none
                // of it; counting those let a large turned-off site fill every run and starve the rest.
                const settledLocally: LibraryManga[] = []
                const reachable: LibraryManga[] = []
                for (const item of due) {
                    const link = scheduledLinks.get(item.id)
                    const host = queueHost(item, link)
                    if (host.startsWith("local:") || (link && (await siteIsOff(link.sourceId)))) {
                        settledLocally.push(item)
                        localIds.add(item.id)
                    } else if (!isBackedOff(hostBackoff, host, now)) {
                        reachable.push(item)
                    }
                }
                capped = reachable.length > budget.maxTitles
                manga = [...settledLocally, ...reachable.slice(0, budget.maxTitles)]
                if (manga.length === 0) {
                    await writeSchedule(lastChecked, hostBackoff).catch(() => {})
                    return
                }
            }
        } catch (error) {
            // Loading settings/the library itself failed before the loop could even
            // start - record a failure state instead of leaving an unhandled rejection
            // (which the old request/response contract would also have surfaced badly)
            // and a progress indicator stuck showing "running" forever.
            const message = error instanceof Error ? error.message : "Update check failed to start"
            console.error("[AMR] Update check failed to start", error)
            const failure: Record<string, unknown> = {
                updateProgress: { running: false, done: 0, total: 0, startedAt } satisfies UpdateProgress
            }
            if (!sourceIds) {
                failure["updateStatus"] = {
                    checked: 0,
                    updated: 0,
                    failed: 0,
                    checkedAt: Date.now(),
                    errors: [{ mangaId: "", title: "Update check", message }]
                }
            }
            await browser.storage.local.set(failure)
            return
        }

        let checked = 0
        let updated = 0
        let failed = 0
        total = manga.length
        const errors: Array<{ mangaId: string; title: string; message: string; sourceId: string; cause: string }> = []
        // Titles that gained a new chapter this run, for the end-of-run notification.
        const updatedTitles: string[] = []
        // Per-sourceId count of titles skipped this run because the source's own
        // listChapters call threw a bot-block-shaped error (e.g. a Cloudflare 403) -
        // see the per-title catch block below. Kept separate from `failed` since this
        // routine background loop has no tab-fallback to recover with, so a persistent
        // per-title "failed to update" row here is noisy and unactionable; one
        // aggregate notice per source is added to `errors` after the loop instead.
        const botBlockedCounts = new Map<string, number>()
        // Per-sourceId count of titles that hard-failed this run, so the exported
        // failure log can show which adapters carry the failures instead of only a
        // 20-row sample. Distinct from botBlockedCounts (a skip, not a failure).
        const failuresBySource = new Map<string, number>()
        // Per-sourceId count of titles that can't be checked because the source has no
        // registered adapter (retired/removed, e.g. manganato), has no source link at all,
        // or its link can't be parsed to a series. These aren't transient failures - they
        // need the user to relink to a live mirror - so they get their own actionable bucket
        // instead of hard-failing every check forever with a generic error (or, for a missing
        // link, being silently skipped and counted nowhere).
        const needsRelinkCounts = new Map<string, number>()
        // The actual titles that need relinking, so the activity summary and the exported log can
        // name them (and link each into its relink flow) instead of showing only a per-source count.
        // Bounded: a library with a whole retired source behind it should not produce an unbounded list.
        const relinkTitles: Array<{ mangaId: string; title: string; sourceId: string; reason: RelinkReason }> = []
        // Uncapped, unlike the rows: a scheduled run's merge takes each re-checked title out of the counts.
        const relinkTitleIds = new Map<string, string[]>()
        const failedTitleIds = new Map<string, string[]>()
        const noteTitle = (ids: Map<string, string[]>, sourceId: string, mangaId: string) => {
            const list = ids.get(sourceId)
            if (list) list.push(mangaId)
            else ids.set(sourceId, [mangaId])
        }
        const bumpRelink = (sourceId: string, candidate: { id: string; title: string }, reason: RelinkReason) => {
            needsRelinkCounts.set(sourceId, (needsRelinkCounts.get(sourceId) ?? 0) + 1)
            noteTitle(relinkTitleIds, sourceId, candidate.id)
            if (relinkTitles.length < RELINK_TITLES_CAP) {
                relinkTitles.push({ mangaId: candidate.id, title: candidate.title, sourceId, reason })
            }
        }
        // Per-sourceId count of titles on a profile source that has no chapter list at all
        // (recognition-only). They stay tracked, but new chapters can never be detected for them, so
        // they get their own notice instead of counting as "checked, nothing new".
        const trackingOnlyCounts = new Map<string, number>()
        // Per-sourceId count of titles on a profile source whose chapter list came back EMPTY. That is a
        // profile that stopped matching its site (a redesign, a changed address pattern, a challenge page),
        // or one that never matched this title, not "no new chapters", so it is surfaced, not swallowed.
        const emptyListCounts = new Map<string, number>()
        // Per-sourceId count of titles on a profile source whose list stops below a chapter the title
        // already has (a list that only shows its first page, say). New chapters past that point cannot be
        // seen from it, so it is surfaced too, and the title keeps the latest chapter it knew.
        const shortListCounts = new Map<string, number>()
        // Titles stopped by a bot challenge, keyed by the origin that challenged. The user can do
        // something about these: the link is taken from the first affected title, so the prompt can open
        // the right site without ever naming it.
        const needsVerify = new Map<
            string,
            { origin: string; sourceId: string; count: number; openUrl: string; sampleTitle: string }
        >()
        const bumpVerify = (error: SourceChallengeError, candidate: LibraryManga, url: string) => {
            const row = needsVerify.get(error.origin)
            if (row) {
                row.count += 1
                return
            }
            needsVerify.set(error.origin, {
                origin: error.origin,
                sourceId: candidate.sourceId,
                count: 1,
                openUrl: /^https?:\/\//i.test(url) ? url : error.origin,
                sampleTitle: candidate.title
            })
        }
        // A site that challenged once will challenge the rest of this run too. Its other titles are counted
        // without asking again, so a large library does not hit a site that is already refusing it.
        const challengedSources = new Map<string, SourceChallengeError>()
        // The same for a source refusing with 403/502/503: one refusal stands for the rest of the run.
        const botBlockedSources = new Map<string, unknown>()
        const highWater = await readChapterHighWater()
        // sourceId -> cause -> titles, covering every title that did not get a usable chapter list, so
        // the exported log answers "what failed and why" past the 20 sampled error rows.
        const causes = new Map<string, Map<string, number>>()
        const bumpCause = (sourceId: string, cause: string) => {
            const counts = causes.get(sourceId) ?? new Map<string, number>()
            counts.set(cause, (counts.get(cause) ?? 0) + 1)
            causes.set(sourceId, counts)
        }

        const writeProgress = async (currentTitle?: string) => {
            const progress: UpdateProgress = {
                running: true,
                done,
                total,
                ...(currentTitle ? { currentTitle } : {}),
                ...(sourceId ? { sourceId } : {}),
                startedAt
            }
            await browser.storage.local.set({ updateProgress: progress })
        }

        await writeProgress()

        const queue = scheduled
            ? new HostQueue(manga, titleItem =>
                  localIds.has(titleItem.id)
                      ? `local:${titleItem.id}`
                      : queueHost(titleItem, scheduledLinks.get(titleItem.id))
              )
            : undefined
        const manualOrder = [...manga]
        let sinceFlush = 0
        for (;;) {
            let listed: LibraryManga
            let queuedHost: string | undefined
            if (queue && budget) {
                if (Date.now() - startedAt >= budget.wallMs) {
                    budgetStopped = true
                    break
                }
                const pulled = queue.next(Date.now())
                if (!pulled) break
                if ("waitMs" in pulled) {
                    if (Date.now() + pulled.waitMs - startedAt >= budget.wallMs) {
                        budgetStopped = true
                        break
                    }
                    await delay(pulled.waitMs)
                    continue
                }
                listed = pulled.item
                queuedHost = pulled.host
            } else {
                const nextTitle = manualOrder.shift()
                if (!nextTitle) break
                listed = nextTitle
            }
            let item = listed
            // Between-titles abort point: an extension update is waiting and needs the
            // worker idle. Stop cleanly here (never mid-transaction) and let the finally
            // below mark progress not-running so the UI doesn't show a wedged check.
            if (updateCheckAborted) break
            checkedIds.add(item.id)
            reachedSources.add(item.sourceId)
            let link =
                scheduledLinks.get(item.id) ?? (await db.sourceLinks.get(item.id)) ?? (await restoreSourceLink(item.id))
            if (link) reachedSources.add(link.sourceId)
            if (!link) {
                // No source link at all - the title can't be checked. Surface it as a relink
                // candidate rather than silently incrementing done and moving on (which left
                // these titles updating nowhere and appearing in no count).
                bumpRelink(item.sourceId, item, "no-link")
                diag.warn("update-check", `no source link for ${item.sourceId}`, { mangaId: item.id })
                lastChecked[item.id] = Date.now()
                done += 1
                continue
            }
            // A retired adapter would hard-fail every check, so it is bucketed as needs-relink without a fetch.
            // One prompt from the fix-it page grants a switched-off site, then its titles check again. Stamped
            // like the other titles settled without a request, so they wait their turn instead of staying due.
            if (await siteIsOff(link.sourceId)) {
                bumpRelink(link.sourceId, item, "site-off")
                lastChecked[item.id] = Date.now()
                done += 1
                continue
            }
            if (isTrackingOnlySource(link.sourceId)) {
                trackingOnlyCounts.set(link.sourceId, (trackingOnlyCounts.get(link.sourceId) ?? 0) + 1)
                lastChecked[item.id] = Date.now()
                done += 1
                continue
            }
            const challenged = challengedSources.get(link.sourceId)
            if (challenged) {
                bumpVerify(challenged, item, link.url)
                bumpCause(item.sourceId, updateCheckCause(challenged))
                done += 1
                continue
            }
            if (botBlockedSources.has(link.sourceId)) {
                botBlockedCounts.set(item.sourceId, (botBlockedCounts.get(item.sourceId) ?? 0) + 1)
                bumpCause(item.sourceId, updateCheckCause(botBlockedSources.get(link.sourceId)))
                done += 1
                continue
            }
            {
                await writeProgress(item.title)
                const host = queuedHost ?? hostOf(link.url)
                let stampChecked = true
                const noteBlocked = () => {
                    stampChecked = false
                    if (!host) return
                    recordHostBlock(hostBackoff, host, Date.now())
                    total -= queue?.skipHost(host) ?? 0
                }
                // Set by the request client even when an adapter catches the error and returns nothing.
                let seenChallenge: SourceChallengeError | undefined
                try {
                    const listedLink = link
                    let chapters = await listMangaChapters(item, listedLink, language, {
                        onChallenge: error => {
                            seenChallenge = error
                        }
                    }).catch(async error => {
                        // A tab may clear a challenge the plain fetch cannot, so the tab tier below gets its turn.
                        if (error instanceof SourceChallengeError && isTabListSource(listedLink.sourceId)) return []
                        if (isSeriesGone(error)) {
                            const moved = await followMovedSeries(listed, listedLink, language).catch(() => undefined)
                            if (moved) {
                                item = moved.item
                                link = moved.link
                                checkedIds.add(item.id)
                                return moved.chapters
                            }
                        }
                        throw error
                    })
                    // A list the site builds in the browser comes back empty from a plain fetch. Such a
                    // source is read by rendering its page in a background tab, which is expensive, so
                    // it runs at most once per cooldown window per title (undefined: skipped this run).
                    if (chapters.length === 0 && isTabListSource(link.sourceId)) {
                        const rendered = await listRenderedChapters(item, link)
                        if (rendered === undefined) {
                            checkedIds.delete(item.id)
                            done += 1
                            continue
                        }
                        chapters = rendered
                    }
                    if (chapters.length === 0 && seenChallenge) throw seenChallenge
                    const profileListed = isProfileSource(link.sourceId)
                    if (chapters.length === 0 && profileListed) {
                        emptyListCounts.set(item.sourceId, (emptyListCounts.get(item.sourceId) ?? 0) + 1)
                        bumpCause(item.sourceId, "empty")
                        diag.warn("update-check", `empty chapter list from ${item.sourceId}`, { mangaId: item.id })
                        done += 1
                        continue
                    }
                    // Detect updates within the user's preferred language only. A multi-language
                    // source that tags each chapter's language (e.g. MangaDex) but returns all of
                    // them would otherwise let a chapter in another language advance the badge and
                    // fire a "new chapter" notification. chaptersForLanguage keeps untagged
                    // chapters and falls back to the full list when nothing matches (the same rule
                    // the reader's prev/next uses in library.ts), so a single-language source is
                    // unaffected. The full `chapters` list is still persisted below, so switching
                    // the preferred language later re-exposes the other languages.
                    const localized = await chaptersForUpdateCheck(item.id, chapters, language)
                    // Prefer the highest NUMBERED chapter - an unguarded reduce over every
                    // sortKey lets a single unnumbered chapter (Infinity) win the "latest"
                    // contest and become latestChapterId/sourceUrl, pointing the manga at a
                    // chapter with no real number. Only fall back to picking among whatever
                    // was fetched (the old reduce) when NOTHING fetched is numbered - that
                    // keeps applyUpdateCheckResult's documented "non-finite means advanced"
                    // id-change self-heal working for a manga with no numbered chapters at all.
                    const latest =
                        latestNumberedChapter(localized) ??
                        localized.reduce(
                            (current, chapter) => (chapter.sortKey > (current?.sortKey ?? -1) ? chapter : current),
                            localized[0]
                        )
                    // Always re-point on an id change - this is the self-heal path merges
                    // and relinks rely on (a carried/dangling latestChapterId gets
                    // replaced by the source's real latest row, and a merge-inflated
                    // latestChapterNumber drops back to the source's true count - see
                    // mergeMangaRecords's cross-source policy). But only COUNT it as an
                    // update and publish a live event when the chapter number actually
                    // advanced: an id change with a same-or-lower number is a re-slug or
                    // a post-merge correction, not a new chapter, and reporting it
                    // inflated the "N updated" status and pushed phantom entries onto
                    // the Updates page. Chapters without a finite sortKey can't be
                    // compared, so they keep the old id-change-means-updated behavior.
                    const mark = profileListed ? undefined : highWater.marks[item.id]
                    const { advanced, stoppedShort, superseded } = await applyUpdateCheckResult({
                        mangaId: item.id,
                        listedFrom: link,
                        chapters,
                        latest,
                        previousLatestChapterId: item.latestChapterId,
                        previousLatestChapterNumber:
                            mark && mark.n > (item.latestChapterNumber ?? -1) ? mark.n : item.latestChapterNumber,
                        ...(profileListed ? { profileListed } : {}),
                        ...(link.sourceId === "mangahub"
                            ? { purgeStaleMangahub: (ids: Set<string>) => purgeStaleMangahubChapterRows(item.id, ids) }
                            : {})
                    })
                    if (superseded) {
                        // The title moved to another source while its old one was being read. Nothing from
                        // the old list was kept, so the title is due again and will be read from the new one.
                        stampChecked = false
                        checkedIds.delete(item.id)
                        done += 1
                        continue
                    }
                    if (!profileListed) await noteChapterHighWater(highWater, item, latest)
                    if (stoppedShort) {
                        shortListCounts.set(item.sourceId, (shortListCounts.get(item.sourceId) ?? 0) + 1)
                        diag.warn("update-check", `chapter list stops short for ${item.sourceId}`, {
                            mangaId: item.id
                        })
                    }
                    if (advanced) {
                        updated += 1
                        updatedTitles.push(item.title)
                        publishLive(["chapters", "library"], [item.id])
                        diag.info("update-check", `new chapter: ${item.title}`, {
                            sourceId: item.sourceId,
                            prev: item.latestChapterNumber ?? null,
                            latest: latest?.sortKey ?? null
                        })
                    }
                    checked += 1
                    if (host) recordHostSuccess(hostBackoff, host)
                } catch (error) {
                    const challenge = error instanceof SourceChallengeError ? error : seenChallenge
                    if (error instanceof SourceRequestError && error.status === 429) noteBlocked()
                    if (challenge) {
                        noteBlocked()
                        // Not a failure either, and unlike the plain block below the user can act on it.
                        bumpVerify(challenge, item, link.url)
                        bumpCause(item.sourceId, updateCheckCause(challenge))
                        challengedSources.set(link.sourceId, challenge)
                    } else if (isBotBlocked(error)) {
                        noteBlocked()
                        botBlockedSources.set(link.sourceId, error)
                        botBlockedCounts.set(item.sourceId, (botBlockedCounts.get(item.sourceId) ?? 0) + 1)
                        bumpCause(item.sourceId, updateCheckCause(error))
                        console.debug("[AMR] Update check skipped (bot-blocked)", {
                            mangaId: item.id,
                            sourceId: item.sourceId
                        })
                        // Fall through WITHOUT failed+=1, WITHOUT errors.push, WITHOUT the
                        // console.warn below - this is a known, currently-unactionable-via-
                        // this-path condition (no tab-fallback in this routine background
                        // loop), not a real per-title failure.
                    } else if (error instanceof Error && error.message === "The source link cannot be refreshed") {
                        // The adapter exists but can't parse this link into a series (e.g. an
                        // externally-tracked title minted from an unparseable chapter URL). That
                        // won't fix itself on retry, so it's a relink candidate, not a hard
                        // failure that regenerates every check.
                        bumpRelink(item.sourceId, item, "bad-link")
                    } else {
                        failed += 1
                        // Count a hard failure toward `checked` too, so `checked` means
                        // "titles attempted" (successes + failures), not "titles that
                        // succeeded". Before this, a throw skipped the success-path
                        // increment and checked+failed didn't add up to the real total
                        // (checked 331 | failed 450 looked like broken math). Bot-block
                        // skips stay out of both counts - they're a skip, not an attempt.
                        checked += 1
                        failuresBySource.set(item.sourceId, (failuresBySource.get(item.sourceId) ?? 0) + 1)
                        noteTitle(failedTitleIds, item.sourceId, item.id)
                        const cause = updateCheckCause(error)
                        bumpCause(item.sourceId, cause)
                        const message = error instanceof Error ? error.message : "Update failed"
                        errors.push({ mangaId: item.id, title: item.title, message, sourceId: item.sourceId, cause })
                        diag.warn("update-check", `failed for ${item.sourceId}`, { mangaId: item.id, message })
                    }
                } finally {
                    // Pause between every iteration (success or failure) so sites don't
                    // rate-limit when the library has many titles from the same source.
                    if (stampChecked && !updateCheckAborted) lastChecked[item.id] = Date.now()
                    if (host) queue?.markRequested(host, Date.now())
                    if (++sinceFlush >= SCHEDULE_FLUSH_EVERY) {
                        sinceFlush = 0
                        await writeSchedule(lastChecked, hostBackoff).catch(() => {})
                    }
                    await delay(400)
                }
            }
            done += 1
        }

        await writeSchedule(lastChecked, hostBackoff).catch(() => {})
        if (scheduled && !updateCheckAborted && (capped || (budgetStopped && (queue?.size ?? 0) > 0))) {
            await scheduleUpdateContinuation().catch(() => {})
        }

        // Written before the status, so the session choice a prompt offers is usable the moment it shows.
        const verifyRows = [...needsVerify.values()].sort((a, b) => b.count - a.count)
        await recordChallengedSites(verifyRows)

        // Keep only the most recent handful of errors so the status stays small.
        const status = {
            checked,
            updated,
            failed,
            checkedAt: Date.now(),
            ...(scheduled ? { scheduled: true, eligible: eligibleCount } : {}),
            errors: errors.slice(0, ERROR_ROWS_CAP),
            // Bot-block skips are NOT failures (failed stays 0) - a whole source refusing
            // automated checks while its chapters still load in the reader. Kept in their
            // own field, sorted worst-first, so the UI can render them as an expected
            // "skipped" notice instead of burying them in the failure list where they read
            // as something broken that should clear.
            skippedSources: Object.fromEntries([...botBlockedCounts].sort((a, b) => b[1] - a[1])),
            // Sites that showed a bot challenge. Each row carries a link for the prompt's button and
            // never reaches any text the user or a support chat sees.
            needsVerify: verifyRows,
            causesBySource: Object.fromEntries(
                [...causes].map(([source, counts]) => [source, Object.fromEntries(counts)])
            ),
            // Sorted worst-first, serialised as a plain object (storage.local can't hold a
            // Map) so the failure log can render a "failures by source" tally over all 450,
            // not just the 20 sampled rows above.
            failuresBySource: Object.fromEntries([...failuresBySource].sort((a, b) => b[1] - a[1])),
            // Titles that need relinking (retired/removed adapter, no source link, or an
            // unparseable link) - shown as an actionable "relink these" bucket, not a failure.
            needsRelink: Object.fromEntries([...needsRelinkCounts].sort((a, b) => b[1] - a[1])),
            // The specific titles behind the needs-relink counts, so the UI can list them and link
            // each into its relink flow, and the exported log can name them (title only, no host).
            relinkTitles,
            failedTitleIds: Object.fromEntries(failedTitleIds),
            relinkTitleIds: Object.fromEntries(relinkTitleIds),
            // Profile sources that cannot list chapters at all: tracked, but new chapters are never
            // auto-detected. Shown as a notice, never counted as "checked".
            trackingOnly: Object.fromEntries([...trackingOnlyCounts].sort((a, b) => b[1] - a[1])),
            // Profile sources that returned no chapters for a title: the profile has probably stopped
            // matching its site.
            emptyLists: Object.fromEntries([...emptyListCounts].sort((a, b) => b[1] - a[1])),
            // Profile sources whose list stops below a chapter the title already has.
            shortLists: Object.fromEntries([...shortListCounts].sort((a, b) => b[1] - a[1]))
        }
        const finalWrite: Record<string, unknown> = {
            updateProgress: { running: false, done, total, startedAt } satisfies UpdateProgress
        }
        // Only a full, all-sources check represents the library-wide status the Updates
        // page displays - a single-source "refresh this source" run would otherwise
        // clobber that global status with counts computed from just one source's manga.
        // An aborted check (extension update pending) also must not publish its partial
        // counts as a completed library-wide status: 3/500 titles checked would show on
        // the Updates page as a fresh, finished check. Leave the previous status intact.
        if (!updateCheckAborted) {
            if (!sourceIds && !scheduled) finalWrite["updateStatus"] = status
            else {
                const stored = await browser.storage.local.get("updateStatus")
                const previous = stored["updateStatus"] as typeof status | undefined
                if (sourceIds) {
                    // A check of some sites only refreshes their part of the last full check, never stands in for it.
                    if (previous) finalWrite["updateStatus"] = mergeSourceStatus(previous, status, sourceIds)
                } else {
                    const merged = mergeTitleStatus(previous, status, checkedIds, reachedSources)
                    finalWrite["updateStatus"] = {
                        ...merged,
                        errors: merged.errors.slice(0, ERROR_ROWS_CAP),
                        relinkTitles: merged.relinkTitles.slice(0, RELINK_TITLES_CAP)
                    }
                }
            }
        }
        await browser.storage.local.set(finalWrite)
        // Record the run in the diagnostic log so an export actually shows update-check
        // activity (previously only per-title FAILURES were logged, so a clean run left the
        // log unchanged between checks). Bounded detail: the advanced titles + per-source
        // block/failure tallies, not every checked title.
        diag.info(
            "update-check",
            `run ${sourceIds?.join(",") ?? (scheduled ? "scheduled" : "all")}: checked ${checked}, updated ${updated}, failed ${failed}`,
            {
                aborted: updateCheckAborted,
                updatedTitles: updatedTitles.slice(0, 50),
                botBlocked: Object.fromEntries(botBlockedCounts),
                needsVerify: verifyRows.map(row => ({ sourceId: row.sourceId, count: row.count })),
                causes: Object.fromEntries([...causes].map(([source, counts]) => [source, Object.fromEntries(counts)])),
                failuresBySource: Object.fromEntries(failuresBySource),
                needsRelink: Object.fromEntries(needsRelinkCounts),
                trackingOnly: Object.fromEntries(trackingOnlyCounts),
                emptyLists: Object.fromEntries(emptyListCounts),
                shortLists: Object.fromEntries(shortListCounts)
            }
        )
        // Notify only on a full, non-aborted check (same gate as the library-wide status)
        // so a single-source refresh doesn't fire, and only when something actually
        // advanced. Best-effort - never blocks or throws into the caller.
        if (!sourceIds && !updateCheckAborted) void notifyNewChapters(updatedTitles)
        return status
    } catch (error) {
        // A throw escaped the per-title try/catch - e.g. db.sourceLinks.get(item.id) or
        // writeProgress() rejecting on a transient IndexedDB failure, both of which sit
        // outside the per-title try. Without this, the persisted updateProgress stays
        // { running: true } forever (only a fresh check's writeProgress flips it back),
        // blocking every future updates:check with alreadyRunning until the 15-minute
        // stale timeout. Persist a terminal not-running record on this exit path too, and
        // swallow the error so an alarm-driven `void checkUpdates()` is not an unhandled
        // rejection (Bug 8).
        console.error("[AMR] Update check aborted by an unexpected error", error)
        if (scheduleLoaded) await writeSchedule(lastChecked, hostBackoff).catch(() => {})
        await browser.storage.local
            .set({ updateProgress: { running: false, done, total, startedAt } satisfies UpdateProgress })
            .catch(() => {})
        return
    } finally {
        updateCheckRunning = false
        updateCheckAborted = false
    }
}

// Bumped to v2: the original sweep only healed a poisoned latestChapterNumber. v2 also
// heals a poisoned lastReadChapterNumber (set by the pre-fix trackExternalChapter from a
// MangaHub internal-id URL), so it must re-run once for users the v1 sweep already marked done.
// Bumped to v3 so the sweep re-runs once with the new purely-local clamp, which heals
// existing poisoned titles even when MangaHub's Cloudflare gate blocks the fetch.
// Bumped for 0.33.x: a user-added source numbered visits from the internal id in the address, so titles of
// any source id can hold the poison. Bumped again for 0.34.0: the heal now keeps the read chapter's history
// and position instead of jumping to the newest chapter.
const MANGAHUB_CHAPTER_REPAIR_FLAG = "chapterIdRepairDone5"

// One-time repair sweep for libraries poisoned by the pre-fix extractChapters bug
// (MangaHub's id-slug "alternate version" chapter anchors getting ingested as real
// chapters, inflating latestChapterNumber into the hundreds-of-thousands/millions range
// - see INTERNAL_ID_MIN in the mangahub adapter, now in the site lab). latestChapterNumber only
// self-heals through a normal checkUpdates pass, but checkUpdates explicitly skips
// manualTracking/onHold titles and never runs at all if the user has disabled automatic
// update checking - some poisoned titles would otherwise never self-heal. This
// intentionally does NOT apply those exclusions: a poisoned badge on a manually-tracked
// or on-hold title needs the same one-time correction as everything else. Runs once per
// install, guarded by a persisted (not session-scoped) storage flag so it survives a
// service-worker restart. Best-effort: a failure on one title doesn't stop the sweep or
// block the completion flag from being set.
export async function repairMangahubChapterNumbers(): Promise<void> {
    const stored = await browser.storage.local.get(MANGAHUB_CHAPTER_REPAIR_FLAG)
    if (stored[MANGAHUB_CHAPTER_REPAIR_FLAG]) return

    // The initial query is pulled into its own try, separate from the completion
    // flag's finally below: a transient failure here (before any title was even
    // examined) must not permanently mark the one-shot sweep "done" with no retry
    // path - only a genuine run of the per-title loop (even one where every title
    // individually fails) earns that flag.
    let poisoned: LibraryManga[]
    try {
        poisoned = await db.manga
            .filter(
                m =>
                    (m.latestChapterNumber ?? 0) >= MANGAHUB_INTERNAL_ID_MIN ||
                    (m.lastReadChapterNumber ?? 0) >= MANGAHUB_INTERNAL_ID_MIN
            )
            .toArray()
    } catch (error) {
        console.error("[AMR] MangaHub chapter repair sweep failed to run", error)
        return
    }

    try {
        for (const manga of poisoned) {
            try {
                // Local heal FIRST (no network): delete the internal-id rows and recompute the
                // badge from the remaining real chapters, so a Cloudflare-blocked fetch still
                // fixes the Updates number instead of leaving the poison and burning the flag.
                // The network fetch below then restores the true upstream latest when it works.
                if (await clampIdSizedChapterNumbers(manga.id)) {
                    publishLive(["chapters", "library"], [manga.id])
                }

                if (manga.sourceId !== "mangahub") continue
                const link = await db.sourceLinks.get(manga.id)
                const sourceMangaId = link?.sourceMangaId ?? manga.sourceMangaId
                const mangaUrl = link?.url ?? manga.mangaUrl
                if (!sourceMangaId || !mangaUrl) continue

                const chapters = await listChaptersForSource(manga, "mangahub", sourceMangaId, mangaUrl)
                if (chapters.length === 0) continue

                // Same unnumbered-chapter guard as checkUpdates above: pick the highest
                // NUMBERED chapter first, only falling back to the unfiltered reduce when
                // nothing fetched is numbered.
                const latest =
                    latestNumberedChapter(chapters) ??
                    chapters.reduce(
                        (current, chapter) => (chapter.sortKey > (current?.sortKey ?? -1) ? chapter : current),
                        chapters[0]
                    )

                // Guard against writing back to a manga a concurrent remove/merge
                // deleted while the chapter-list fetch above was in flight - the
                // existence check is the first statement inside the transaction so
                // both the writes AND the publishLive call below are gated on it.
                const stillExists = await repairMangahubChapters({
                    mangaId: manga.id,
                    chapters,
                    latest,
                    purgeStaleMangahub: (ids: Set<string>) => purgeStaleMangahubChapterRows(manga.id, ids)
                })
                if (stillExists) publishLive(["chapters", "library"], [manga.id])
            } catch (error) {
                console.warn("[AMR] MangaHub chapter repair failed for one title", { mangaId: manga.id, error })
            }
        }
    } finally {
        await browser.storage.local.set({ [MANGAHUB_CHAPTER_REPAIR_FLAG]: true })
    }
}

// The app asks for this on every load, so a failed check (GitHub rate limit, offline) has to hold off
// too, or every refresh hits api.github.com again. Kept apart from extensionUpdate so a failure never
// clears a banner an earlier check found.
const EXTENSION_UPDATE_FAILED_KEY = "extensionUpdateFailedAt"
const EXTENSION_UPDATE_RETRY_MS = 60 * 60 * 1000

// Firefox: AMO updates every install, but holds back an update that needs approval. Ask AMO which
// version is public so the app can point a copy that stays behind at the listing, where Firefox
// shows the approval prompt. AMO's API allows cross-origin reads, so no host permission is needed.
async function checkFirefoxStoreUpdate(recordFailure: () => Promise<void>): Promise<void> {
    const response = await fetch(AMO_ADDON_API_URL, { headers: { Accept: "application/json" }, credentials: "omit" })
    if (!response.ok) {
        await recordFailure()
        return
    }
    const latest = parseAmoAddon(await response.json())
    if (!latest) {
        await recordFailure()
        return
    }
    let os: string | undefined
    try {
        os = (await browser.runtime.getPlatformInfo())?.os
    } catch {
        os = undefined
    }
    const update: FirefoxStoreUpdate & { checkedAt: number } = {
        store: "amo",
        available: isNewerVersion(latest.version, browser.runtime.getManifest().version),
        latestVersion: latest.version,
        publishedAt: latest.publishedAt,
        releaseUrl: amoListingUrl(os),
        checkedAt: Date.now()
    }
    await browser.storage.local.set({ extensionUpdate: update })
    await browser.storage.local.remove(EXTENSION_UPDATE_FAILED_KEY)
}

export async function checkExtensionUpdate(force = false): Promise<void> {
    const firefox = import.meta.env.BROWSER === "firefox"
    if (!firefox && !selfUpdateAllowed()) {
        await browser.storage.local.remove(["extensionUpdate", EXTENSION_UPDATE_FAILED_KEY])
        return
    }
    const kept = await browser.storage.local.get(["extensionUpdate", EXTENSION_UPDATE_FAILED_KEY])
    const stored = kept["extensionUpdate"] as { checkedAt: number } | undefined
    const failedAt = kept[EXTENSION_UPDATE_FAILED_KEY]
    if (!force && stored && Date.now() - stored.checkedAt < EXTENSION_UPDATE_INTERVAL_HOURS * 3_600_000) return
    if (!force && typeof failedAt === "number" && Date.now() - failedAt < EXTENSION_UPDATE_RETRY_MS) return
    // Clear stale result before fetch so the UI never shows an outdated banner
    // while the fresh check is in-flight.
    if (force) await browser.storage.local.remove("extensionUpdate")
    const recordFailure = () => browser.storage.local.set({ [EXTENSION_UPDATE_FAILED_KEY]: Date.now() }).catch(() => {})
    try {
        if (firefox) {
            await checkFirefoxStoreUpdate(recordFailure)
            return
        }
        const response = await fetch(GITHUB_RELEASES_URL, {
            headers: { Accept: "application/vnd.github.v3+json" },
            credentials: "omit"
        })
        if (!response.ok) {
            await recordFailure()
            return
        }
        const json = (await response.json()) as {
            tag_name?: string
            html_url?: string
            assets?: { name?: string; browser_download_url?: string }[]
        }
        const latestVersion = (json.tag_name ?? "").replace(/^v/, "")
        const releaseUrl = typeof json.html_url === "string" && /^https?:\/\//i.test(json.html_url) ? json.html_url : ""
        if (!latestVersion) return
        const currentVersion = browser.runtime.getManifest().version
        // A sideloaded Chromium copy is a load-unpacked of the `-chrome.zip` attached at release time.
        // An update counts as available only when that zip is there.
        const asset = (json.assets ?? []).find(a => typeof a.name === "string" && a.name.endsWith("-chrome.zip"))
        const available = isNewerVersion(latestVersion, currentVersion) && Boolean(asset)
        await browser.storage.local.set({
            extensionUpdate: {
                available,
                latestVersion,
                releaseUrl,
                downloadUrl: asset?.browser_download_url ?? "",
                downloadName: asset?.name ?? "",
                checkedAt: Date.now()
            }
        })
        await browser.storage.local.remove(EXTENSION_UPDATE_FAILED_KEY)
    } catch {
        await recordFailure()
    }
}

// The stored URL comes from a GitHub API answer; only a release asset on GitHub's own download hosts
// is handed to the downloads API.
const RELEASE_DOWNLOAD_HOSTS = new Set(["github.com", "objects.githubusercontent.com"])

function isReleaseDownloadUrl(value: string): boolean {
    try {
        const url = new URL(value)
        return url.protocol === "https:" && RELEASE_DOWNLOAD_HOSTS.has(url.hostname) && !url.username
    } catch {
        return false
    }
}

// downloads.download treats a filename with separators as a path under Downloads, so keep only the
// last segment.
function downloadFileName(name: string | undefined, url: string): string {
    const base = (value: string | undefined) => (value ?? "").split(/[/\\]/).pop()?.replace(/^\.+/, "").trim() ?? ""
    return base(name) || base(new URL(url).pathname) || "storyhoard.zip"
}

export async function backfillMangaGenres(): Promise<void> {
    if (genreBackfillRunning) return
    // Same pending-update latch as checkUpdates: idle so the browser can apply a waiting
    // extension update rather than starting a long rate-limited loop (Bug 22).
    if (await isUpdatePending()) return
    genreBackfillRunning = true
    genreBackfillAborted = false
    try {
        // Process titles missing genres, a cover, OR a publication status. The
        // source-based genre/cover resolvers expect a series page (need mangaUrl or
        // sourceMangaId) and self-guard below; the metadata provider needs only the
        // title, so a title with no series URL is still eligible for status/cover from
        // the catalog. A missing cover is common on titles first added from an on-site
        // chapter whose one-shot cover fetch failed (e.g. dynasty-scans); status is
        // "unknown" for every mirror except MangaDex/Kagane - both healed here in one
        // rate-limited pass. metadataUpdatedAt gates the re-try window so a permanent
        // no-match isn't queried every startup.
        const now = Date.now()
        const toFetch = await db.manga
            .filter(m => {
                // Also re-check "ongoing" titles: a series that finished upstream after being
                // added keeps its stale "ongoing" status forever otherwise, so it can never
                // reach Completed even when caught up (the 0.19 "everything went unread"
                // regression). The 7-day window keeps this from hammering the catalog.
                const missing =
                    !m.genres ||
                    m.genres.length === 0 ||
                    !m.coverUrl ||
                    m.status === "unknown" ||
                    m.status === "ongoing"
                if (!missing) return false
                return m.metadataUpdatedAt === undefined || now - m.metadataUpdatedAt >= META_RETRY_MS
            })
            .toArray()
        if (toFetch.length === 0) return
        for (const manga of toFetch) {
            // Yield to a pending extension update - same between-items abort as checkUpdates.
            if (genreBackfillAborted) break
            const source = {
                sourceId: manga.sourceId,
                ...(manga.sourceMangaId ? { sourceMangaId: manga.sourceMangaId } : {}),
                ...(manga.mangaUrl ? { mangaUrl: manga.mangaUrl } : {})
            }
            if (!manga.genres || manga.genres.length === 0) {
                try {
                    const genres = await resolveGenresFor(source)
                    if (genres.length > 0) {
                        await updateManga(manga.id, { genres } as Partial<LibraryManga>)
                    }
                } catch {
                    // Skip - source may not support genres or fetch failed transiently
                }
            }
            // Re-check the abort between the two network branches: a pending extension
            // update flipped mid-genre-fetch must not still cost this title a full cover
            // fetch + 350ms delay before the loop-top break yields.
            if (genreBackfillAborted) break
            if (!manga.coverUrl) {
                try {
                    const coverUrl = await resolveCoverFor(source)
                    if (isPublicCoverUrl(coverUrl)) {
                        await updateManga(manga.id, { coverUrl } as Partial<LibraryManga>)
                        try {
                            const blob = await fetchCoverBlob(proxiedCoverUrl(coverUrl))
                            if (blob) await cacheCover(manga.id, blob)
                        } catch {
                            // Non-fatal - the remote coverUrl still renders via hotlink
                        }
                    }
                } catch {
                    // Skip - source may not support covers or fetch failed transiently
                }
            }
            // Metadata catalog: fill the publication status (and any genres/cover the
            // mirror still didn't provide) from the provider chain (AniList). This is the
            // robust fix for the ~18 adapters that never expose a status - one title
            // lookup instead of scraping each site. Re-read the record so a cover/genres
            // just written above isn't re-fetched. metadataUpdatedAt is stamped either
            // way so a no-match falls into the retry window rather than re-querying.
            if (genreBackfillAborted) break
            const fresh = await db.manga.get(manga.id)
            if (
                fresh &&
                (fresh.status === "unknown" || fresh.status === "ongoing" || !fresh.genres?.length || !fresh.coverUrl)
            ) {
                const patch: Partial<LibraryManga> = { metadataUpdatedAt: Date.now() }
                try {
                    const meta = await resolveMetadata({
                        title: fresh.title,
                        sourceId: fresh.sourceId,
                        ...(fresh.sourceMangaId ? { sourceMangaId: fresh.sourceMangaId } : {})
                    })
                    if (meta) {
                        // resolveMetadata is a FUZZY AniList search that always returns a
                        // best guess for any string, with no title verification. Before it
                        // can flip a title to finished or (re)bind its anilistId - both of
                        // which mis-file the title or push the user's progress to the wrong
                        // AniList entry - require the matched title to be consistent with ours.
                        const titleMatchesMeta =
                            typeof meta.title === "string" &&
                            (() => {
                                const a = normalizeTitle(fresh.title)
                                const b = normalizeTitle(meta.title as string)
                                if (!a || !b) return false
                                return a === b || a.startsWith(b) || b.startsWith(a)
                            })()

                        // Fill an unknown status, OR upgrade an "ongoing" title to the catalog's
                        // finished/cancelled/hiatus status so a series that ended upstream can
                        // reach Completed. Never downgrade a known status back to ongoing (a
                        // fuzzy title match must not un-finish a title), never write unknown, and
                        // never flip a title to FINISHED off a title-inconsistent match.
                        if (meta.status && meta.status !== "unknown") {
                            const upgradesToFinished = meta.status !== "ongoing"
                            const allowed =
                                fresh.status === "unknown"
                                    ? !upgradesToFinished || titleMatchesMeta
                                    : fresh.status === "ongoing" && upgradesToFinished && titleMatchesMeta
                            if (allowed) patch.status = meta.status
                        }
                        if ((!fresh.genres || fresh.genres.length === 0) && meta.genres?.length) {
                            patch.genres = meta.genres
                        }
                        // Only bind anilistId from a title-consistent match, and never clobber
                        // an id we already have with a fresh fuzzy guess.
                        if (meta.anilistId && titleMatchesMeta && fresh.anilistId === undefined) {
                            patch.anilistId = meta.anilistId
                        }
                        if (!fresh.coverUrl && isPublicCoverUrl(meta.coverUrl)) patch.coverUrl = meta.coverUrl
                    }
                } catch {
                    // Provider unavailable - keep the stamped metadataUpdatedAt so the
                    // title retries after the window instead of every run.
                }
                await updateManga(manga.id, patch)
                if (patch.coverUrl) {
                    try {
                        const blob = await fetchCoverBlob(proxiedCoverUrl(patch.coverUrl))
                        if (blob) await cacheCover(manga.id, blob)
                    } catch {
                        // Non-fatal - the remote coverUrl still renders via hotlink
                    }
                }
            }
            // Respect the source rate limit (3 req/s) between requests.
            await new Promise<void>(r => setTimeout(r, 350))
        }
        publishLive(["library"])
    } finally {
        genreBackfillRunning = false
        genreBackfillAborted = false
    }
}

// Chapters with a sortKey newer than the manga's last-read position, falling back
// to the last 3 chapters (by sortKey) when nothing is newer - e.g. a freshly added
// title with no read progress yet still gets a short preview list.
async function newChaptersFor(mangaId: string) {
    const manga = await db.manga.get(mangaId)
    if (!manga) return []
    // Same preferred-language gate as the update check: don't list a chapter in another
    // language as "new". chaptersForLanguage keeps untagged chapters and falls back to the
    // full list when nothing matches, so single-language sources are unaffected.
    const { language } = await getSettings()
    const all = chaptersForLanguage(await db.chapters.where("mangaId").equals(mangaId).sortBy("sortKey"), language)
    const sinceKey = manga.lastReadChapterNumber ?? -1
    // isNumberedChapter first - Infinity > sinceKey is always true, so an unguarded
    // filter reports every unnumbered chapter as "new" on every single check, forever.
    const fresh = all.filter(c => isNumberedChapter(c.sortKey) && c.sortKey > sinceKey)
    return (fresh.length > 0 ? fresh : all.slice(-3)).map(c => ({
        id: c.id,
        title: c.title,
        sortKey: c.sortKey,
        url: c.url
    }))
}

export const updatesSourcesHandlers: HandlerMap = {
    "updates:check": async request => {
        // Fire-and-forget: a full library check can take several minutes (rate-limited
        // network calls per title), far longer than an MV3 message channel/service-worker
        // lifetime reliably survives. Awaiting checkUpdates() here caused "message channel
        // closed before a response was received" once the channel died mid-loop. Callers
        // now track progress via the updateProgress/updateStatus storage keys instead.
        if (updateCheckRunning) {
            return { started: false, alreadyRunning: true }
        }
        // updateCheckRunning only tracks this service-worker instance's lifetime, so a
        // check that crashed a previous instance mid-loop leaves no in-memory trace of
        // itself - only the persisted updateProgress record. Consult it before starting
        // a new check: a recent running: true means a check is plausibly still active
        // (report alreadyRunning as before), while a stale one means the previous run's
        // service worker died without ever getting to clear it - self-heal so the next
        // triggered check (this one) isn't blocked by a state nothing will ever clear.
        const storedProgress = (await browser.storage.local.get("updateProgress"))["updateProgress"] as
            | UpdateProgress
            | undefined
        if (storedProgress?.running) {
            if (Date.now() - storedProgress.startedAt < STALE_PROGRESS_TIMEOUT_MS) {
                return { started: false, alreadyRunning: true }
            }
            console.warn("[AMR] Clearing stale updateProgress from a crashed check", storedProgress)
            await browser.storage.local.set({
                updateProgress: { ...storedProgress, running: false } satisfies UpdateProgress
            })
        }
        // Another run may have claimed the guard while the progress record was read.
        if (updateCheckRunning) return { started: false, alreadyRunning: true }
        const sourceIds = request.sourceIds ?? (request.sourceId ? [request.sourceId] : undefined)
        void checkUpdates(sourceIds).catch(error => {
            console.error("[AMR] Update check crashed unexpectedly", error)
        })
        return { started: true }
    },
    "updates:get": async () => await statusWithSiteOffTitles(),
    "updates:new-chapters": async request => {
        return await newChaptersFor(request.mangaId)
    },
    "extension-update:check": async request => {
        await checkExtensionUpdate(request.force ?? false)
        const stored = await browser.storage.local.get("extensionUpdate")
        return (
            (stored["extensionUpdate"] as
                | {
                      available: boolean
                      latestVersion: string
                      releaseUrl: string
                      downloadUrl?: string
                      downloadName?: string
                  }
                | undefined) ?? null
        )
    },
    "extension-update:download": async () => {
        // Download the release zip (resolved during the update check) into the user's Downloads
        // folder. This is the closest MV3 gets to a self-update: an extension cannot install a
        // package into itself, so the final "load unpacked" step stays manual. The app asks for
        // the optional downloads permission in the click before sending this.
        if (!selfUpdateAllowed()) return { started: false as const, filename: "" }
        const stored = (await browser.storage.local.get("extensionUpdate"))["extensionUpdate"] as
            | { available?: boolean; downloadUrl?: string; downloadName?: string }
            | undefined
        const url = stored?.downloadUrl
        if (stored?.available !== true || !url || !isReleaseDownloadUrl(url)) {
            return { started: false as const, filename: "" }
        }
        const filename = downloadFileName(stored.downloadName, url)
        await browser.downloads.download({ url, filename })
        return { started: true as const, filename }
    },
    "sources:list": async () => {
        await userSourcesReady()
        const labels = new Map((await listSourceLabels()).map(info => [info.id, info]))
        return sourceRegistry.list().map(adapter => ({
            id: adapter.manifest.id,
            label: labels.get(adapter.manifest.id)?.label ?? UNLISTED_SOURCE_LABEL,
            position: labels.get(adapter.manifest.id)?.position ?? 0,
            official: labels.get(adapter.manifest.id)?.official ?? false,
            domains: adapter.manifest.domains,
            capabilities: adapter.manifest.capabilities,
            canSearch: Boolean(adapter.search),
            homepage: adapter.manifest.homepage
        }))
    },
    "sources:ping": async () => {
        const checks = await Promise.all(
            sourceRegistry.list().map(async adapter => {
                const origin =
                    adapter.manifest.homepage ??
                    (adapter.manifest.domains[0] ? `https://${adapter.manifest.domains[0]}` : undefined)
                if (!origin) return { id: adapter.manifest.id, alive: false, status: "dead" as const }
                const controller = new AbortController()
                const timer = setTimeout(() => controller.abort(), 10000)
                try {
                    // Background fetches are privileged - no CORS restriction for origins
                    // in host_permissions. Distinguish four states:
                    //   live  - server answered normally (2xx/3xx) from a domain the adapter
                    //           actually registers
                    //   moved - server answered normally, but the final URL (after redirects -
                    //           fetch follows them by default) lands on a domain the adapter
                    //           doesn't register. Likely a hijacked/parked/repurposed domain
                    //           still returning 200s, not the real source anymore
                    //   gated - bot-blocked (403/429 from CF or rate-limiting);
                    //           chapter reads still work via the tab fallback
                    //   dead  - truly unreachable (timeout, DNS, 5xx)
                    let res = await fetch(origin, {
                        method: "HEAD",
                        signal: controller.signal,
                        credentials: "omit"
                    })
                    // Some live sites reject HEAD outright (404/405) even though a normal
                    // GET succeeds - retry once with GET before declaring the source dead.
                    if (res.status === 404 || res.status === 405) {
                        res = await fetch(origin, {
                            method: "GET",
                            signal: controller.signal,
                            credentials: "omit"
                        })
                    }
                    if (res.status === 403 || res.status === 429) {
                        return { id: adapter.manifest.id, alive: true, status: "gated" as const }
                    }
                    if (res.status >= 400) {
                        return { id: adapter.manifest.id, alive: false, status: "dead" as const }
                    }
                    let finalHost: string | undefined
                    try {
                        finalHost = res.url ? new URL(res.url).hostname : undefined
                    } catch {
                        finalHost = undefined
                    }
                    if (finalHost && !matchesSourceDomain(finalHost, adapter.manifest.domains)) {
                        return { id: adapter.manifest.id, alive: true, status: "moved" as const, finalHost }
                    }
                    return { id: adapter.manifest.id, alive: true, status: "live" as const }
                } catch {
                    return { id: adapter.manifest.id, alive: false, status: "dead" as const }
                } finally {
                    clearTimeout(timer)
                }
            })
        )
        await browser.storage.local.set({
            sourceHealth: Object.fromEntries(checks.map(c => [c.id, { alive: c.alive, at: Date.now() }]))
        })
        return checks
    },
    "sources:health": async () => {
        const stored = await browser.storage.local.get("sourceHealth")
        return stored["sourceHealth"] ?? {}
    },
    "source:permission:check": async () => {
        return await checkSourcePermission()
    },
    "manga:search": async request => {
        const settings = await getSettings()
        const excluded = new Set(settings.searchDisabledSourceIds)
        return await searchManga(request.query, excluded)
    },
    "manga:chapters": async request => {
        const settings = await getSettings()
        return await getMangaChapters(request.mangaId, settings.language)
    },
    "manga:genres": async request => {
        const manga = await db.manga.get(request.mangaId)
        if (!manga) return [] as string[]
        // Return cached genres immediately if available, skip the network call.
        if (manga.genres && manga.genres.length > 0) return manga.genres
        const genres = await resolveGenresFor({
            sourceId: manga.sourceId,
            ...(manga.sourceMangaId ? { sourceMangaId: manga.sourceMangaId } : {}),
            ...(manga.mangaUrl ? { mangaUrl: manga.mangaUrl } : {})
        })
        if (genres.length > 0) {
            void updateManga(request.mangaId, { genres } as Partial<LibraryManga>)
        }
        return genres
    }
}
