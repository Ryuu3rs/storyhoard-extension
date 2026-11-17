import { getAccountProfile } from "../account"
import {
    analyticsConfigured,
    apiSendUsage,
    buildUsageBatch,
    getAnalyticsInstallId,
    getUsageNoticeState,
    getUsageWatermark,
    setUsageWatermark,
    firefoxDataGranted,
    usageAnalyticsEnabled,
    type UsagePlatform
} from "../analytics-usage"
import { db } from "../database"
import { getSettings } from "../settings"

const platform: UsagePlatform = import.meta.env.BROWSER === "firefox" ? "firefox" : "chrome"

// Read the local usage events recorded since the last flush, aggregate to allowlisted
// name+count, and send. Gated on the endpoint being configured, the one-time notice having been shown, and
// the user not having opted out (local toggle, Firefox's data permission, and a linked account's opt-out
// once the account reports it; the server also drops batches from an opted-out account). The watermark
// only advances after a successful send, so a failed flush re-sends next time; buildUsageBatch drops
// anything not on the allowlist so no new local event leaks by default. While it is off the watermark
// keeps moving, and turning it back on moves it to that moment, so what came before is never sent.
export async function flushUsageAnalytics(): Promise<void> {
    if (!analyticsConfigured) return
    const settings = await getSettings()
    const account = await getAccountProfile()
    const linked = Boolean(account.token && !account.invalid)
    const granted = platform === "firefox" && (await firefoxDataGranted())
    const accountOptOut = linked && account.analyticsOptOut === true
    // Until the notice has been on screen nothing is sent; what is recorded meanwhile waits for it, and is
    // dropped instead if the user answers it with Off.
    if ((await getUsageNoticeState()).shownAt === undefined) return
    if (!usageAnalyticsEnabled(settings, platform, accountOptOut, granted)) {
        await setUsageWatermark(Date.now())
        return
    }

    const since = await getUsageWatermark()
    const rows = await db.analyticsEvents.where("ts").above(since).toArray()
    if (rows.length === 0) return

    const maxTs = rows.reduce((m, r) => (r.ts > m ? r.ts : m), since)
    const events = buildUsageBatch(rows)
    if (events.length > 0) {
        await apiSendUsage(
            {
                client: "extension",
                platform,
                appVersion: browser.runtime.getManifest().version,
                installId: await getAnalyticsInstallId(),
                events
            },
            linked ? account.token : undefined
        )
    }
    await setUsageWatermark(maxTs)
}
