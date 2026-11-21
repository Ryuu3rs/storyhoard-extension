import { getAccountProfile } from "../account"
import {
    analyticsConfigured,
    apiSendUsage,
    buildUsageBatch,
    getUsageNoticeState,
    getUsageWatermarks,
    setUsageWatermark,
    setUsageWatermarks,
    firefoxDataGranted,
    UNCONFIRMED_USAGE_EVENTS,
    usageAnalyticsEnabled,
    usageRequests,
    type UsageEvent,
    type UsagePayload,
    type UsagePlatform
} from "../analytics-usage"
import { db } from "../database"
import { getSettings } from "../settings"

const platform: UsagePlatform = import.meta.env.BROWSER === "firefox" ? "firefox" : "chrome"

// "waiting" until the one-time notice has been on screen; "off" when the user turned it off (local toggle,
// Firefox's data permission, or a linked account's opt-out, which also covers the account's age rule).
async function usageState(): Promise<"waiting" | "off" | "on"> {
    const settings = await getSettings()
    const account = await getAccountProfile()
    const linked = Boolean(account.token && !account.invalid)
    const granted = platform === "firefox" && (await firefoxDataGranted())
    const accountOptOut = linked && account.analyticsOptOut === true
    if ((await getUsageNoticeState()).shownAt === undefined) return "waiting"
    return usageAnalyticsEnabled(settings, platform, accountOptOut, granted) ? "on" : "off"
}

// Whether this install's usage may be counted at all, by the batches below or by weeb.ltd's search counts.
export async function usageStatsAllowed(): Promise<boolean> {
    return (await usageState()) === "on"
}

// Read the local usage events recorded since the last flush, aggregate to allowlisted
// name+count, and send. Gated on the endpoint being configured, the one-time notice having been shown, and
// the user not having opted out. buildUsageBatch drops anything not on the allowlist so no new local event
// leaks by default. While it is off the watermark keeps moving, and turning it back on moves it to that
// moment, so what came before is never sent.
export async function flushUsageAnalytics(): Promise<void> {
    if (!analyticsConfigured) return
    const state = await usageState()
    // Until the notice has been on screen nothing is sent; what is recorded meanwhile waits for it, and is
    // dropped instead if the user answers it with Off.
    if (state === "waiting") return
    if (state === "off") {
        await setUsageWatermark(Date.now())
        return
    }

    const marks = await getUsageWatermarks()
    const rows = await db.analyticsEvents.where("ts").above(Math.min(marks.main, marks.unconfirmed)).toArray()
    if (rows.length === 0) return

    const upTo = rows.reduce((m, r) => (r.ts > m ? r.ts : m), 0)
    const payload = (events: UsageEvent[]): UsagePayload => ({
        client: "extension",
        platform,
        appVersion: browser.runtime.getManifest().version,
        events
    })
    // Names the live server may not accept go in their own request, so they never cost the main batch. A
    // refused (400) request is dropped: resending it would be refused again and hold the window forever. No
    // answer, a 429 or a 5xx keeps that lane's window for the next flush.
    const next = { ...marks }
    let failure: unknown
    for (const lane of ["main", "unconfirmed"] as const) {
        const since = marks[lane]
        const events = buildUsageBatch(
            rows.filter(r => r.ts > since && UNCONFIRMED_USAGE_EVENTS.has(r.event) === (lane === "unconfirmed"))
        )
        try {
            for (const request of usageRequests(events)) await apiSendUsage(payload(request))
            next[lane] = Math.max(since, upTo)
        } catch (error) {
            failure ??= error
        }
    }
    await setUsageWatermarks(next)
    if (failure !== undefined) throw failure
}
