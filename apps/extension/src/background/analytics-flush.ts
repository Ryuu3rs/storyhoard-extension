import { getAccountProfile } from "../account"
import {
    analyticsConfigured,
    apiSendUsage,
    buildUsageBatch,
    getAnalyticsInstallId,
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
// name+count, and send. Gated on the endpoint being configured and the user not having opted out
// (local toggle + Chrome first-run choice; a linked account's opt-out is enforced server-side via
// the token). The watermark only advances after a successful send, so a failed flush re-sends next
// time; buildUsageBatch drops anything not on the allowlist so no new local event leaks by default.
// While it is off the watermark keeps moving, so turning it on later never sends what came before.
export async function flushUsageAnalytics(): Promise<void> {
    if (!analyticsConfigured) return
    const settings = await getSettings()
    const granted = platform === "firefox" && (await firefoxDataGranted())
    if (!usageAnalyticsEnabled(settings, platform, false, granted)) {
        await setUsageWatermark(Date.now())
        return
    }

    const since = await getUsageWatermark()
    const rows = await db.analyticsEvents.where("ts").above(since).toArray()
    if (rows.length === 0) return

    const maxTs = rows.reduce((m, r) => (r.ts > m ? r.ts : m), since)
    const events = buildUsageBatch(rows)
    if (events.length > 0) {
        const account = await getAccountProfile()
        const token = account.token && !account.invalid ? account.token : undefined
        await apiSendUsage(
            {
                client: "extension",
                platform,
                appVersion: browser.runtime.getManifest().version,
                installId: await getAnalyticsInstallId(),
                events
            },
            token
        )
    }
    await setUsageWatermark(maxTs)
}
