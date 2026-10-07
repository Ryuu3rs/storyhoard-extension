import { sourceRegistry } from "@amr/sources"
import { isNumberedChapter, latestNumberedChapter, matchesSourceDomain } from "@amr/source-sdk"
import { normalizeTitle } from "@amr/normalize"
import {
    applyUpdateCheckResult,
    cacheCover,
    clampPoisonedMangahubLocally,
    db,
    repairMangahubChapters,
    updateManga,
    type LibraryManga
} from "../database"
import {
    checkSourcePermission,
    getMangaChapters,
    listChaptersForSource,
    listMangaChapters,
    resolveCoverFor,
    resolveGenresFor,
    searchManga
} from "../sources"
import { fetchCoverBlob } from "../background/covers"
import { resolveMetadata } from "../metadata"
import { diag } from "../diag-log"
import { getSettings } from "../settings"
import { isNewerVersion } from "../update-check"
import { EXTENSION_UPDATE_INTERVAL_HOURS, GITHUB_RELEASES_URL } from "../background/alarms"
import { isProfileSource, isTrackingOnlySource } from "../arch-sources"
import { isBotBlocked } from "../background/capture"
import { MANGAHUB_INTERNAL_ID_MIN, purgeStaleMangahubChapterRows } from "../background/chapter-cache"
import { delay, type HandlerMap } from "../background/handler-types"
import { publishLive } from "../live"
import { notifyNewChapters } from "../notifications"

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

export async function checkUpdates(sourceId?: string) {
    if (updateCheckRunning) return
    // An extension update is waiting to be applied - idle so the browser can apply it
    // instead of starting a multi-minute loop that keeps the worker busy (Bug 22).
    if (await isUpdatePending()) return
    updateCheckRunning = true
    updateCheckAborted = false
    const startedAt = Date.now()
    // Hoisted out of the try so the catch below can still write an accurate terminal
    // progress record after an unexpected mid-loop throw (Bug 8).
    let done = 0
    let total = 0
    try {
        let manga: LibraryManga[]
        let language: string
        try {
            const settings = await getSettings()
            const all = await db.manga.toArray()
            const scoped = sourceId ? all.filter(item => item.sourceId === sourceId) : all
            manga = scoped.filter(item => !item.manualTracking && !item.onHold)
            language = settings.language
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
            if (!sourceId) {
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
        const errors: Array<{ mangaId: string; title: string; message: string }> = []
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
        const bumpRelink = (id: string) => needsRelinkCounts.set(id, (needsRelinkCounts.get(id) ?? 0) + 1)
        // Per-sourceId count of titles on a profile source that has no chapter list at all
        // (recognition-only). They stay tracked, but new chapters can never be detected for them, so
        // they get their own notice instead of counting as "checked, nothing new".
        const trackingOnlyCounts = new Map<string, number>()
        // Per-sourceId count of titles on a profile source whose chapter list came back EMPTY although
        // the title already had a chapter. That is a profile that stopped matching its site (a redesign,
        // a changed address pattern), not "no new chapters", so it is surfaced rather than swallowed.
        const emptyListCounts = new Map<string, number>()

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

        for (const item of manga) {
            // Between-titles abort point: an extension update is waiting and needs the
            // worker idle. Stop cleanly here (never mid-transaction) and let the finally
            // below mark progress not-running so the UI doesn't show a wedged check.
            if (updateCheckAborted) break
            const link = await db.sourceLinks.get(item.id)
            if (!link) {
                // No source link at all - the title can't be checked. Surface it as a relink
                // candidate rather than silently incrementing done and moving on (which left
                // these titles updating nowhere and appearing in no count).
                bumpRelink(item.sourceId)
                diag.warn("update-check", `no source link for ${item.sourceId}`, { mangaId: item.id })
                done += 1
                continue
            }
            if (!sourceRegistry.get(link.sourceId)) {
                // The source adapter is retired/removed (e.g. manganato). Every check would
                // throw the generic "cannot be refreshed" and hard-fail forever; bucket it as
                // needs-relink instead, and don't even attempt the fetch.
                bumpRelink(link.sourceId)
                done += 1
                continue
            }
            if (isTrackingOnlySource(link.sourceId)) {
                trackingOnlyCounts.set(link.sourceId, (trackingOnlyCounts.get(link.sourceId) ?? 0) + 1)
                done += 1
                continue
            }
            {
                await writeProgress(item.title)
                try {
                    const chapters = await listMangaChapters(item, link, language)
                    if (chapters.length === 0 && isProfileSource(link.sourceId) && item.latestChapterId) {
                        emptyListCounts.set(item.sourceId, (emptyListCounts.get(item.sourceId) ?? 0) + 1)
                        diag.warn("update-check", `empty chapter list from ${item.sourceId}`, { mangaId: item.id })
                        done += 1
                        continue
                    }
                    // Prefer the highest NUMBERED chapter - an unguarded reduce over every
                    // sortKey lets a single unnumbered chapter (Infinity) win the "latest"
                    // contest and become latestChapterId/sourceUrl, pointing the manga at a
                    // chapter with no real number. Only fall back to picking among whatever
                    // was fetched (the old reduce) when NOTHING fetched is numbered - that
                    // keeps applyUpdateCheckResult's documented "non-finite means advanced"
                    // id-change self-heal working for a manga with no numbered chapters at all.
                    const latest =
                        latestNumberedChapter(chapters) ??
                        chapters.reduce(
                            (current, chapter) => (chapter.sortKey > (current?.sortKey ?? -1) ? chapter : current),
                            chapters[0]
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
                    const { advanced } = await applyUpdateCheckResult({
                        mangaId: item.id,
                        chapters,
                        latest,
                        previousLatestChapterId: item.latestChapterId,
                        previousLatestChapterNumber: item.latestChapterNumber,
                        ...(link.sourceId === "mangahub"
                            ? { purgeStaleMangahub: (ids: Set<string>) => purgeStaleMangahubChapterRows(item.id, ids) }
                            : {})
                    })
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
                } catch (error) {
                    if (isBotBlocked(error)) {
                        botBlockedCounts.set(item.sourceId, (botBlockedCounts.get(item.sourceId) ?? 0) + 1)
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
                        bumpRelink(item.sourceId)
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
                        const message = error instanceof Error ? error.message : "Update failed"
                        errors.push({ mangaId: item.id, title: item.title, message })
                        diag.warn("update-check", `failed for ${item.sourceId}`, { mangaId: item.id, message })
                    }
                } finally {
                    // Pause between every iteration (success or failure) so sites don't
                    // rate-limit when the library has many titles from the same source.
                    await delay(400)
                }
            }
            done += 1
        }

        // Keep only the most recent handful of errors so the status stays small.
        const status = {
            checked,
            updated,
            failed,
            checkedAt: Date.now(),
            errors: errors.slice(0, 20),
            // Bot-block skips are NOT failures (failed stays 0) - a whole source refusing
            // automated checks while its chapters still load in the reader. Kept in their
            // own field, sorted worst-first, so the UI can render them as an expected
            // "skipped" notice instead of burying them in the failure list where they read
            // as something broken that should clear.
            skippedSources: Object.fromEntries([...botBlockedCounts].sort((a, b) => b[1] - a[1])),
            // Sorted worst-first, serialised as a plain object (storage.local can't hold a
            // Map) so the failure log can render a "failures by source" tally over all 450,
            // not just the 20 sampled rows above.
            failuresBySource: Object.fromEntries([...failuresBySource].sort((a, b) => b[1] - a[1])),
            // Titles that need relinking (retired/removed adapter, no source link, or an
            // unparseable link) - shown as an actionable "relink these" bucket, not a failure.
            needsRelink: Object.fromEntries([...needsRelinkCounts].sort((a, b) => b[1] - a[1])),
            // Profile sources that cannot list chapters at all: tracked, but new chapters are never
            // auto-detected. Shown as a notice, never counted as "checked".
            trackingOnly: Object.fromEntries([...trackingOnlyCounts].sort((a, b) => b[1] - a[1])),
            // Profile sources that returned no chapters for a title that already had one: the profile
            // has probably stopped matching its site.
            emptyLists: Object.fromEntries([...emptyListCounts].sort((a, b) => b[1] - a[1]))
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
        if (!sourceId && !updateCheckAborted) finalWrite["updateStatus"] = status
        await browser.storage.local.set(finalWrite)
        // Record the run in the diagnostic log so an export actually shows update-check
        // activity (previously only per-title FAILURES were logged, so a clean run left the
        // log unchanged between checks). Bounded detail: the advanced titles + per-source
        // block/failure tallies, not every checked title.
        diag.info(
            "update-check",
            `run ${sourceId ?? "all"}: checked ${checked}, updated ${updated}, failed ${failed}`,
            {
                aborted: updateCheckAborted,
                updatedTitles: updatedTitles.slice(0, 50),
                botBlocked: Object.fromEntries(botBlockedCounts),
                failuresBySource: Object.fromEntries(failuresBySource),
                needsRelink: Object.fromEntries(needsRelinkCounts),
                trackingOnly: Object.fromEntries(trackingOnlyCounts),
                emptyLists: Object.fromEntries(emptyListCounts)
            }
        )
        // Notify only on a full, non-aborted check (same gate as the library-wide status)
        // so a single-source refresh doesn't fire, and only when something actually
        // advanced. Best-effort - never blocks or throws into the caller.
        if (!sourceId && !updateCheckAborted) void notifyNewChapters(updatedTitles)
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
const MANGAHUB_CHAPTER_REPAIR_FLAG = "mangahubChapterRepairDone3"

// One-time repair sweep for libraries poisoned by the pre-fix extractChapters bug
// (MangaHub's id-slug "alternate version" chapter anchors getting ingested as real
// chapters, inflating latestChapterNumber into the hundreds-of-thousands/millions range
// - see INTERNAL_ID_MIN in packages/sources/src/mangahub.ts). latestChapterNumber only
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
            .where("sourceId")
            .equals("mangahub")
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
                if (await clampPoisonedMangahubLocally(manga.id)) {
                    publishLive(["chapters", "library"], [manga.id])
                }

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

export async function checkExtensionUpdate(force = false): Promise<void> {
    const stored = (await browser.storage.local.get("extensionUpdate"))["extensionUpdate"] as
        | { checkedAt: number }
        | undefined
    if (!force && stored && Date.now() - stored.checkedAt < EXTENSION_UPDATE_INTERVAL_HOURS * 3_600_000) return
    // Clear stale result before fetch so the UI never shows an outdated banner
    // while the fresh check is in-flight.
    if (force) await browser.storage.local.remove("extensionUpdate")
    try {
        const response = await fetch(GITHUB_RELEASES_URL, {
            headers: { Accept: "application/vnd.github.v3+json" }
        })
        if (!response.ok) return
        const json = (await response.json()) as {
            tag_name?: string
            html_url?: string
            assets?: { name?: string; browser_download_url?: string }[]
        }
        const latestVersion = (json.tag_name ?? "").replace(/^v/, "")
        const releaseUrl = json.html_url ?? ""
        if (!latestVersion) return
        const currentVersion = browser.runtime.getManifest().version
        // Pick the release asset that matches THIS build's browser (assets are named
        // storyhoard-<v>-chrome.zip / -firefox.zip) so the in-app "Download update"
        // button grabs the right one without the user hunting on GitHub. Edge and any
        // other Chromium build take the chrome zip.
        const wantSuffix = import.meta.env.BROWSER === "firefox" ? "-firefox.zip" : "-chrome.zip"
        const asset = (json.assets ?? []).find(a => typeof a.name === "string" && a.name.endsWith(wantSuffix))
        await browser.storage.local.set({
            extensionUpdate: {
                available: isNewerVersion(latestVersion, currentVersion),
                latestVersion,
                releaseUrl,
                downloadUrl: asset?.browser_download_url ?? "",
                downloadName: asset?.name ?? "",
                checkedAt: Date.now()
            }
        })
    } catch {
        // best-effort
    }
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
                    if (coverUrl) {
                        await updateManga(manga.id, { coverUrl } as Partial<LibraryManga>)
                        try {
                            const blob = await fetchCoverBlob(coverUrl)
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
                        if (!fresh.coverUrl && meta.coverUrl) patch.coverUrl = meta.coverUrl
                    }
                } catch {
                    // Provider unavailable - keep the stamped metadataUpdatedAt so the
                    // title retries after the window instead of every run.
                }
                await updateManga(manga.id, patch)
                if (patch.coverUrl) {
                    try {
                        const blob = await fetchCoverBlob(patch.coverUrl)
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
    const all = await db.chapters.where("mangaId").equals(mangaId).sortBy("sortKey")
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
        void checkUpdates(request.sourceId).catch(error => {
            console.error("[AMR] Update check crashed unexpectedly", error)
        })
        return { started: true }
    },
    "updates:get": async () => {
        const stored = await browser.storage.local.get("updateStatus")
        return stored["updateStatus"] ?? null
    },
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
        // Download the browser-matching release zip (resolved during the update check)
        // into the user's Downloads folder. This is the closest MV3 gets to a self-update:
        // an extension cannot install a package into itself, so the final "load unpacked /
        // drag into about:addons" step stays manual. Firefox users who installed from AMO
        // get real auto-update instead and never need this.
        const stored = (await browser.storage.local.get("extensionUpdate"))["extensionUpdate"] as
            | { downloadUrl?: string; downloadName?: string }
            | undefined
        const url = stored?.downloadUrl
        if (!url) return { started: false as const, filename: "" }
        const filename = stored?.downloadName || url.split("/").pop() || "storyhoard.zip"
        await browser.downloads.download({ url, filename })
        return { started: true as const, filename }
    },
    "sources:list": async () => {
        return sourceRegistry.list().map(adapter => ({
            id: adapter.manifest.id,
            name: adapter.manifest.name,
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
