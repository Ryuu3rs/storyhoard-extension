// Side-effect-only import, deliberately first: @amr/contracts/src/domain.ts's
// disableZodEvalProbe() disables zod's eval capability probe (which otherwise
// trips a CSP console warning under MV3's `script-src 'self'`) and runs once
// at that module's own top level, as a side effect of importing it - no call
// needed here. Declaring the import first guarantees @amr/contracts evaluates
// before @amr/sources (imported next) constructs its own schemas - see
// packages/sources/src/mangadex.ts, which builds zod schemas without
// importing @amr/contracts. Per ES module evaluation order, a module's
// *imports* (unlike its own plain statements) always evaluate before any
// subsequent sibling import, so import declaration order is what matters.
import "@amr/contracts"
import { sourceRegistry } from "@amr/sources"
import { runtimeRequestSchema, type RuntimeRequest } from "../src/runtime"
import { searchMangaStreaming } from "../src/sources"
import { success, failure, type HandlerContext } from "../src/background/handler-types"
import { clearAddedBadge, ADD_BADGE_ALARM_NAME } from "../src/background/capture"
import { handleTabUpdated, forgetTab } from "../src/background/tab-updated"
import { beginUserSourcesInit, userSourcesReady } from "../src/background/user-sources-ready"
import { NEW_CHAPTERS_NOTIFICATION_ID } from "../src/notifications"
import { createBackup } from "../src/database"
import { registerSeededSources, runSourceMigrationSeed } from "../src/migration/seed-register"
import {
    updateAlarmName,
    communityAlarmName,
    syncAlarmName,
    anilistAlarmName,
    extensionUpdateAlarmName,
    backupAlarmName,
    accountAlarmName,
    analyticsAlarmName,
    officialSitesAlarmName,
    configureAccountAlarm,
    configureUpdateAlarm,
    configureSyncAlarm,
    configureCommunityAlarm,
    configureAniListAlarm,
    configureBackupAlarm,
    configureExtensionUpdateAlarm,
    configureAnalyticsAlarm,
    configureOfficialSitesAlarm
} from "../src/background/alarms"
import { refreshOfficialSites } from "../src/official-sources"
import { flushUsageAnalytics } from "../src/background/analytics-flush"
import { initUserSources } from "../src/arch-sources"
import {
    checkUpdates,
    checkExtensionUpdate,
    backfillMangaGenres,
    clearStaleUpdateProgress,
    abortLongRunningTasks,
    markUpdatePending,
    clearUpdatePending
} from "../src/handlers/updates-sources"
import { runCommunitySync } from "../src/handlers/community"
import { runAccountSync } from "../src/handlers/account"
import { runAniListSync, abortAniListSync } from "../src/handlers/anilist"
import { autoPush, runAutoBackup } from "../src/handlers/data-sync-settings"
import { getSettings } from "../src/settings"
import { handlers } from "../src/background/dispatch"
import { MUTATION_SCOPES } from "../src/background/mutation-scopes"
import { publishLive } from "../src/live"

export default defineBackground(() => {
    // The in-memory registry is rebuilt on every worker start (including an idle wake), so profile
    // registration starts first and every tab/message handler below waits on this promise before it
    // consults the registry. Without the wait, a worker woken by a navigation sees an already-added
    // site as unknown. Both calls re-register stored profiles; a bundled adapter is never displaced.
    beginUserSourcesInit(() => Promise.all([initUserSources(), registerSeededSources()]))

    // When an extension update is downloaded and waiting, the browser holds it back
    // until the worker goes idle. A long rate-limited update check keeps the worker
    // busy for minutes, deferring the update - and force-updating mid-check could wedge
    // the install until a full restart. Aborting the check lets the worker idle so the
    // browser applies the pending update on its own, at a safe point. We deliberately do
    // NOT call runtime.reload() here: a forced reload would abort an in-flight import,
    // restore, or sync-pull (silently rolling the whole transaction back) and tear down
    // any open reader/dashboard tabs mid-use. Letting the browser's own hold-until-idle
    // apply the update avoids yanking active work; onStartup's clearStaleUpdateProgress
    // then resets any progress record the killed check left behind.
    browser.runtime.onUpdateAvailable.addListener(() => {
        // Latch first (persistent), then abort. abortLongRunningTasks only stops a task
        // that is running RIGHT NOW; the latch also blocks the NEXT alarm-driven check or
        // backfill from starting, so an update that arrives while idle isn't re-deferred
        // by a fresh long loop. Cleared on the next onStartup/onInstalled.
        void markUpdatePending()
        abortLongRunningTasks()
        abortAniListSync()
    })

    // One-time, additive seed of generic-engine profiles for the sources in THIS library (see
    // src/migration/seed-register.ts). A failure must never break install/update housekeeping.
    const migrationSeed = (): Promise<void> =>
        runSourceMigrationSeed().then(
            () => undefined,
            error => console.error("[AMR] Source migration seed failed", error)
        )

    browser.runtime.onInstalled.addListener(details => {
        // The new version is now running, so any pending-update latch has served its
        // purpose - clear it before the backfill reads it, or a leftover flag would skip
        // the backfill forever.
        void clearStaleUpdateProgress()
        void configureUpdateAlarm()
        void configureSyncAlarm()
        void configureCommunityAlarm()
        void configureAccountAlarm()
        void configureAniListAlarm()
        void getSettings().then(settings => configureBackupAlarm(settings.autoBackup))
        void configureExtensionUpdateAlarm()
        void configureAnalyticsAlarm()
        void configureOfficialSitesAlarm()
        void refreshOfficialSites()
        // force=true: bypass 24h throttle and clear stale banner on every install/update
        void checkExtensionUpdate(true)
        if (details.reason === "update") {
            // Snapshot the library the first time a new version runs, so a bad update (or
            // a migration/sync that goes wrong afterwards) is always recoverable from
            // Data -> Restore. The browser can't run our code BEFORE it swaps in the new
            // version, so this first-run snapshot is the earliest safe point. Chain the
            // genre backfill AFTER the snapshot resolves so the backfill's writes don't
            // race the snapshot's read of the same tables (Bug 23).
            void createBackup("pre-update")
                .catch(() => {})
                // Seed AFTER the snapshot so the pre-update backup captures the untouched library.
                .then(() => migrationSeed())
                .then(() => clearUpdatePending())
                .then(() => backfillMangaGenres())
        } else {
            void migrationSeed()
            void clearUpdatePending().then(() => backfillMangaGenres())
        }
    })

    // Re-arm alarms on browser startup in case they were cleared (profile wipe,
    // browser crash, edge-case alarm storage corruption). onInstalled only fires
    // on install/update, so without this, a lost alarm silently breaks until the
    // next extension update.
    browser.runtime.onStartup.addListener(() => {
        void clearStaleUpdateProgress()
        void configureUpdateAlarm()
        void configureSyncAlarm()
        void configureCommunityAlarm()
        void configureAccountAlarm()
        void configureAniListAlarm()
        void getSettings().then(settings => configureBackupAlarm(settings.autoBackup))
        void configureExtensionUpdateAlarm()
        void configureAnalyticsAlarm()
        void configureOfficialSitesAlarm()
        void refreshOfficialSites()
        void checkExtensionUpdate()
        // Clear any stale pending-update latch before the backfill reads it (the update
        // applied, or was abandoned when the browser restarted), so a leftover flag can't
        // skip the backfill forever.
        void clearUpdatePending().then(() => backfillMangaGenres())
        void migrationSeed()
        // Clear any "ADD" badge left stuck by a capture whose clear-timeout never ran
        // because the worker was suspended.
        void clearAddedBadge()
    })

    browser.alarms.onAlarm.addListener(alarm => {
        // Every alarm dispatch is a fire-and-forget async call in the service worker: a
        // rejection (e.g. a transient IndexedDB/storage read failing before the routine's own
        // try) would otherwise surface as an unhandled promise rejection. Wrap each uniformly
        // so one flaky read is logged, not thrown into the SW's global handler.
        const guard = (name: string, run: () => Promise<unknown>) =>
            void run().catch(error => console.error(`[AMR] Scheduled ${name} crashed`, error))
        if (alarm.name === updateAlarmName) guard("update check", checkUpdates)
        if (alarm.name === communityAlarmName) guard("community sync", runCommunitySync)
        if (alarm.name === accountAlarmName) guard("account sync", runAccountSync)
        if (alarm.name === syncAlarmName) guard("gist auto-push", autoPush)
        if (alarm.name === anilistAlarmName) guard("AniList sync", runAniListSync)
        if (alarm.name === extensionUpdateAlarmName) guard("extension-update check", checkExtensionUpdate)
        if (alarm.name === backupAlarmName) guard("auto-backup", runAutoBackup)
        if (alarm.name === analyticsAlarmName) guard("usage analytics", flushUsageAnalytics)
        if (alarm.name === officialSitesAlarmName) guard("official-sites refresh", refreshOfficialSites)
        if (alarm.name === ADD_BADGE_ALARM_NAME) guard("badge clear", clearAddedBadge)
    })

    // Clicking a "new chapters" notification opens the library so the user can jump in.
    // Focus an existing dashboard tab instead of stacking up a fresh one on every click
    // (mirrors the reader's goToApp existing-tab logic).
    browser.notifications.onClicked.addListener(id => {
        if (id !== NEW_CHAPTERS_NOTIFICATION_ID) return
        void (async () => {
            const appUrl = browser.runtime.getURL("/app.html")
            try {
                const existing = await browser.tabs.query({ url: `${appUrl}*` })
                const existingTab = existing.find(t => t.id !== undefined)
                if (existingTab?.id !== undefined) {
                    await browser.tabs.update(existingTab.id, { active: true })
                    if (existingTab.windowId !== undefined) {
                        await browser.windows.update(existingTab.windowId, { focused: true })
                    }
                } else {
                    await browser.tabs.create({ url: appUrl })
                }
            } catch {
                await browser.tabs.create({ url: appUrl }).catch(() => {})
            }
            await browser.notifications.clear(id)
        })()
    })

    // Unfiltered on both browsers: a user-added site's origin is not in SOURCE_ORIGINS, so a
    // Firefox URL filter would never fire for it. captureChapter ignores non-source URLs internally.
    browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        void handleTabUpdated(tabId, changeInfo, tab).catch(error => {
            console.warn("[AMR] Tab update handling failed", error)
        })
    })
    browser.tabs.onRemoved.addListener(forgetTab)

    // Streaming search via long-lived port so the UI can show results per-source
    // as each adapter settles instead of waiting for all to finish.
    browser.runtime.onConnect.addListener(port => {
        if (port.name !== "search-stream") return
        // The controller for the current query on this port. A new query aborts the
        // previous one so its late partials are dropped instead of interleaving with the
        // fresh results; a disconnect (search UI closed) aborts it so in-flight adapter
        // work stops feeding a dead port.
        let activeController: AbortController | null = null
        port.onMessage.addListener((msg: { type: string; query: string }) => {
            if (msg.type !== "manga:search" || !msg.query) return
            activeController?.abort()
            const controller = new AbortController()
            activeController = controller
            void Promise.all([userSourcesReady(), getSettings()]).then(([, settings]) => {
                if (controller.signal.aborted) return
                const excluded = new Set(settings.searchDisabledSourceIds)
                const searchable = sourceRegistry.list().filter(a => !!a.search && !excluded.has(a.manifest.id))
                port.postMessage({ type: "start", total: searchable.length })
                searchMangaStreaming(
                    msg.query,
                    (results, sourceId) => {
                        if (controller.signal.aborted) return
                        try {
                            port.postMessage({ type: "partial", results, sourceId })
                        } catch {
                            // port may have disconnected
                        }
                    },
                    () => {
                        if (controller.signal.aborted) return
                        try {
                            port.postMessage({ type: "done" })
                        } catch {
                            // port may have disconnected
                        }
                    },
                    controller.signal,
                    excluded,
                    sourceId => {
                        if (controller.signal.aborted) return
                        try {
                            port.postMessage({ type: "settled", sourceId })
                        } catch {
                            // port may have disconnected
                        }
                    }
                )
            })
        })
        port.onDisconnect.addListener(() => {
            activeController?.abort()
            activeController = null
        })
    })

    browser.runtime.onMessage.addListener((message, sender) => {
        return (async () => {
            try {
                const request = runtimeRequestSchema.parse(message)
                // A worker woken by this message must finish re-registering the added sources before
                // any handler decides whether a page or a library row belongs to a known source.
                await userSourcesReady()
                const handler = handlers[request.type]
                const ctx: HandlerContext = { sender }
                const data = await (handler as (r: RuntimeRequest, c: HandlerContext) => Promise<unknown>)(request, ctx)
                const scopes = MUTATION_SCOPES[request.type]
                if (scopes) {
                    publishLive(
                        scopes,
                        "mangaId" in request && typeof request.mangaId === "string" ? [request.mangaId] : undefined
                    )
                }
                return success(data)
            } catch (error) {
                return failure(error)
            }
        })()
    })
})
