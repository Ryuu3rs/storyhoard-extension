// Default-on ANONYMOUS usage analytics (H7 ruling / H9). This is the ONLY default-on off-device
// stream; it is deliberately separate from the opt-in community channel (community.ts, C7/C8) and
// must never carry titles, genres, source ids, URLs, usernames, notes, ratings, progress, free text,
// or any per-install or per-account identifier - only an allowlisted event name + a count + a day +
// app version + platform. Legal basis: legitimate interests (see ECO_ANALYTICS_LIA.md); opt-out honoured
// on every surface (local Settings toggle + the linked account's analyticsOptOut). Wire per
// ECO_ANALYTICS_INGEST_CONTRACT.md (contract C9). Network + pure helpers only; the background
// reads local events and drives the flush, exactly as community sync is orchestrated elsewhere.

import type { AnalyticsEvent } from "./database"
import type { AppSettings } from "./settings"
import { getCommunityProfile, noteUsageDataChoice, usageDataHeldForCommunityOnly } from "./community"

const STALE_INSTALL_ID_KEY = "analyticsInstallId"
const ANALYTICS_WATERMARK_KEY = "analyticsUsageWatermark"
const STALE_UNCONFIRMED_WATERMARK_KEY = "analyticsUnconfirmedWatermark"
const USAGE_NOTICE_SHOWN_KEY = "usageNoticeShownAt"
const USAGE_NOTICE_DONE_KEY = "usageNoticeDone"

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
    // H34 Phase A onboarding funnel. The ingest skips a name it does not list and counts the rest of
    // the batch, so a name can ship before the server lists it.
    "install",
    "account_linked",
    "first_title_added",
    // Count of Discover rail opens. Carries no title.
    "discover_rail_open"
])

// The ingest refuses a request with more events than this, or one event counting more than MAX_EVENT_COUNT.
// It adds up events that share a name, so a large count goes as several events.
export const MAX_EVENTS_PER_REQUEST = 100
export const MAX_EVENT_COUNT = 10_000

export function usageRequests(events: UsageEvent[]): UsageEvent[][] {
    const pieces: UsageEvent[] = []
    for (const event of events) {
        for (let left = event.count; left > 0; left -= MAX_EVENT_COUNT) {
            pieces.push({ ...event, count: Math.min(left, MAX_EVENT_COUNT) })
        }
    }
    const requests: UsageEvent[][] = []
    for (let i = 0; i < pieces.length; i += MAX_EVENTS_PER_REQUEST) {
        requests.push(pieces.slice(i, i + MAX_EVENTS_PER_REQUEST))
    }
    return requests
}

export type UsagePlatform = "firefox" | "chrome"

export type UsageEvent = { name: string; ts: number; count: number }

export type UsagePayload = {
    client: "extension"
    platform: UsagePlatform
    appVersion: string
    events: UsageEvent[]
}

// Older builds kept an analytics install id, which batches no longer carry, and a second watermark for
// names sent in a request of their own.
export async function dropStaleAnalyticsKeys(): Promise<void> {
    await browser.storage.local.remove([STALE_INSTALL_ID_KEY, STALE_UNCONFIRMED_WATERMARK_KEY])
}

// Effective on/off. Honours the local Settings opt-out and the linked account's opt-out. On by default
// on every browser (owner ruling, ECO_ANALYTICS_CONSENT_MODEL.md section 0), but the flush sends nothing
// until the one-time notice has been shown.
// On Firefox it also needs the browser's data permission: the manifest declares nothing is collected
// without consent, and Firefox offers this choice at install and on the add-on's permissions page.
export function usageAnalyticsEnabled(
    settings: Pick<AppSettings, "usageAnalytics">,
    platform: UsagePlatform,
    accountOptOut: boolean,
    firefoxDataGranted: boolean
): boolean {
    if (accountOptOut) return false
    if (!settings.usageAnalytics) return false
    if (platform === "firefox" && !firefoxDataGranted) return false
    return true
}

// data_collection is newer than the browser typings this project uses.
export const USAGE_DATA_PERMISSION = { data_collection: ["technicalAndInteraction"] } as never

// A grant held only because community features asked for it is not consent to usage analytics.
export async function firefoxDataGranted(): Promise<boolean> {
    try {
        return (await browser.permissions.contains(USAGE_DATA_PERMISSION)) && !(await usageDataHeldForCommunityOnly())
    } catch {
        return false
    }
}

const DAY_MS = 86_400_000

// Collapse raw local rows into one {name, ts, count} per event name, ts being the start of the UTC day of
// the latest row. Drops any row whose name is not allowlisted and forwards NOTHING else from the row (no
// sourceId, no detail).
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
    return [...byName.entries()].map(([name, v]) => ({ name, ts: Math.floor(v.ts / DAY_MS) * DAY_MS, count: v.count }))
}

// Everything at or before this has been sent or dropped.
export async function getUsageWatermark(): Promise<number> {
    const stored = await browser.storage.local.get(ANALYTICS_WATERMARK_KEY)
    return (stored[ANALYTICS_WATERMARK_KEY] as number | undefined) ?? 0
}

export async function setUsageWatermark(ts: number): Promise<void> {
    await browser.storage.local.set({ [ANALYTICS_WATERMARK_KEY]: ts })
}

// Only moves forward, so a window restart made while a flush was sending is never undone.
export async function advanceUsageWatermark(ts: number): Promise<void> {
    if (ts > (await getUsageWatermark())) await setUsageWatermark(ts)
}

// Analytics starts (or starts again) now: nothing recorded before this moment is ever sent.
export async function restartUsageWindow(now = Date.now()): Promise<void> {
    await setUsageWatermark(now)
}

// An update from a build that never showed the notice: that build counted under its own rules, so what it
// recorded is never sent.
export async function restartUsageWindowOnUpdate(): Promise<void> {
    if ((await getUsageNoticeState()).shownAt === undefined) await restartUsageWindow()
}

// Firefox: the user's own answer on usage analytics, from Settings or the notice. On (after Firefox granted
// it): the grant is theirs, and the window restarts, because a grant community already held fires no
// permissions.onAdded. Off: the grant stays while community still needs it.
export async function chooseUsageData(on: boolean): Promise<void> {
    if (await noteUsageDataChoice(on, (await getCommunityProfile()).enabled)) {
        await browser.permissions.remove(USAGE_DATA_PERMISSION)
    }
    if (on) await restartUsageWindow()
}

// The one-time notice that tells the user analytics is on, links to the policy and offers Off. Nothing is
// sent until it has been shown; it stays up until the user answers it.
export type UsageNoticeState = { shownAt?: number; done: boolean }

export async function getUsageNoticeState(): Promise<UsageNoticeState> {
    const stored = await browser.storage.local.get([USAGE_NOTICE_SHOWN_KEY, USAGE_NOTICE_DONE_KEY])
    const shownAt = stored[USAGE_NOTICE_SHOWN_KEY]
    return {
        ...(typeof shownAt === "number" && shownAt > 0 ? { shownAt } : {}),
        done: stored[USAGE_NOTICE_DONE_KEY] === true
    }
}

// Stamped the first time the notice is on screen; the flush sends nothing before this exists.
export async function markUsageNoticeShown(now = Date.now()): Promise<void> {
    if ((await getUsageNoticeState()).shownAt !== undefined) return
    await browser.storage.local.set({ [USAGE_NOTICE_SHOWN_KEY]: now })
}

export async function finishUsageNotice(now = Date.now()): Promise<void> {
    await markUsageNoticeShown(now)
    await browser.storage.local.set({ [USAGE_NOTICE_DONE_KEY]: true })
}

// Caller gates on usageAnalyticsEnabled + analyticsConfigured. The server skips a name it does not list and
// counts the rest, so only a malformed batch is refused. "refused" is a 400: the server will refuse the same
// events every time, so the caller drops them. No answer, a 429 or a 5xx throws, and the caller keeps
// the window for the next flush. At most 100 events / 16 KB per the contract (usageRequests). No device
// link goes with it: the caller applies the account's opt-out and age rule first, from the account status.
export async function apiSendUsage(payload: UsagePayload): Promise<"sent" | "refused"> {
    if (!analyticsConfigured) throw new Error("Usage analytics is not configured in this build.")
    const res = await fetch(`${ANALYTICS_API_BASE}/api/analytics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify(payload)
    })
    if (res.ok) return "sent"
    if (res.status === 400) return "refused"
    throw new Error(`Usage analytics send failed: ${res.status}`)
}
