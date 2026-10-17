// Default-on ANONYMOUS usage analytics (H7 ruling / H9). This is the ONLY default-on off-device
// stream; it is deliberately separate from the opt-in community channel (community.ts, C7/C8) and
// must never carry titles, genres, source ids, URLs, usernames, notes, ratings, progress, or any
// free text - only an allowlisted event name + a count + app version + platform + an anonymous
// install id. Legal basis: legitimate interests (see ECO_ANALYTICS_LIA.md); opt-out honoured on
// every surface (local Settings toggle + the linked account's analyticsOptOut). Wire per
// ECO_ANALYTICS_INGEST_CONTRACT.md (contract C9). Network + pure helpers only; the background
// reads local events and drives the flush, exactly as community sync is orchestrated elsewhere.

import type { AnalyticsEvent } from "./database"
import type { AppSettings } from "./settings"

const ANALYTICS_INSTALL_KEY = "analyticsInstallId"
const ANALYTICS_WATERMARK_KEY = "analyticsUsageWatermark"

// Injected at build time (VITE_ANALYTICS_API_URL); never hardcoded. When unset the client
// no-ops, exactly like the community client, so a build without the endpoint sends nothing.
const ANALYTICS_API_BASE = (import.meta.env.VITE_ANALYTICS_API_URL as string | undefined) ?? ""
export const analyticsConfigured = ANALYTICS_API_BASE.length > 0

// The only event names allowed off-device. These mirror the local AnalyticsEvent union; anything
// not here is dropped at the source so a future local event can never leak by default.
export const ALLOWED_USAGE_EVENTS: ReadonlySet<AnalyticsEvent["event"]> = new Set([
    "capture_ok",
    "capture_error",
    "reader_opened",
    "on_site_track",
    "panel_action",
    "resolve_direct",
    "resolve_tab",
    // H34 Phase A onboarding funnel. Inert until the server ingest allowlist (A6/C9) lists them;
    // the server drops unknown names, so emitting them early is safe.
    "install",
    "account_linked",
    "first_title_added"
])

export type UsagePlatform = "firefox" | "chrome"

export type UsageEvent = { name: string; ts: number; count: number }

export type UsagePayload = {
    client: "extension"
    platform: UsagePlatform
    appVersion: string
    installId: string
    events: UsageEvent[]
}

// A random, anonymous per-install id for analytics ONLY - distinct from the community installId
// (community.ts) and, like it, excluded from the export/backup envelope so a restore never carries
// an old install's id. Not a user identifier.
export async function getAnalyticsInstallId(): Promise<string> {
    const stored = await browser.storage.local.get(ANALYTICS_INSTALL_KEY)
    const existing = stored[ANALYTICS_INSTALL_KEY] as string | undefined
    if (existing) return existing
    const id = crypto.randomUUID()
    await browser.storage.local.set({ [ANALYTICS_INSTALL_KEY]: id })
    return id
}

// Effective on/off. Default-on (Firefox), honours the local Settings opt-out and the linked
// account's opt-out. On Chrome, collection stays OFF until an affirmative first-run choice
// (usageAnalyticsChoice), because the Chrome Web Store requires consent before collection; a
// settings opt-out alone does not satisfy it. While sideloaded this simply means Chrome users
// must make the choice once.
export function usageAnalyticsEnabled(
    settings: Pick<AppSettings, "usageAnalytics" | "usageAnalyticsChoice">,
    platform: UsagePlatform,
    accountOptOut: boolean
): boolean {
    if (accountOptOut) return false
    if (!settings.usageAnalytics) return false
    if (platform === "chrome" && !settings.usageAnalyticsChoice) return false
    return true
}

// Collapse raw local rows into one {name, ts, count} per event name. Drops any row whose name is
// not allowlisted and forwards NOTHING else from the row (no sourceId, no detail).
export function buildUsageBatch(rows: Array<Pick<AnalyticsEvent, "event" | "ts">>): UsageEvent[] {
    const byName = new Map<string, { ts: number; count: number }>()
    for (const row of rows) {
        if (!ALLOWED_USAGE_EVENTS.has(row.event)) continue
        const cur = byName.get(row.event)
        if (cur) {
            cur.count += 1
            if (row.ts > cur.ts) cur.ts = row.ts
        } else {
            byName.set(row.event, { ts: row.ts, count: 1 })
        }
    }
    return [...byName.entries()].map(([name, v]) => ({ name, ts: v.ts, count: v.count }))
}

export async function getUsageWatermark(): Promise<number> {
    const stored = await browser.storage.local.get(ANALYTICS_WATERMARK_KEY)
    return (stored[ANALYTICS_WATERMARK_KEY] as number | undefined) ?? 0
}

export async function setUsageWatermark(ts: number): Promise<void> {
    await browser.storage.local.set({ [ANALYTICS_WATERMARK_KEY]: ts })
}

// Fire-and-forget POST. Caller gates on usageAnalyticsEnabled + analyticsConfigured and only
// advances the watermark after this resolves, so a failed send re-sends next flush (the server
// dedups by installId + name + window). At most 100 events / 16 KB per the contract.
export async function apiSendUsage(payload: UsagePayload, token?: string): Promise<void> {
    if (!analyticsConfigured) throw new Error("Usage analytics is not configured in this build.")
    // When the extension is linked to an account, pass the device token so the server can honour
    // that account's analyticsOptOut and under-18 status (the contract's server-side enforcement).
    // Unauthed requests are accepted for account-less users; the local Settings toggle gates both.
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(`${ANALYTICS_API_BASE}/api/analytics`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
    })
    if (!res.ok) throw new Error(`Usage analytics send failed: ${res.status}`)
}
