// The event names the live weeb.ltd ingest accepts. Copied from EVENT_NAMES in weeb.ltd's
// lib/analytics-events.ts (master, 2026-11-17); update it by hand when the server list changes. The ingest
// refuses a whole batch (400) carrying any name not listed here, more than 100 events, or a count over 10,000.
export const SERVER_EVENT_NAMES: ReadonlySet<string> = new Set([
    "app_opened",
    "reader_opened",
    "discover_viewed",
    "library_viewed",
    "search_used",
    "settings_opened",
    "capture_ok",
    "capture_error",
    "update_applied",
    "buy_link_clicked",
    "discover_rail_open",
    "app_installed",
    "app_active",
    "onboarding_started",
    "onboarding_step",
    "onboarding_completed",
    "onboarding_skipped",
    "account_linked",
    "first_title_added",
    "upsell_viewed",
    "upsell_later",
    "waitlist_joined",
    "trial_started",
    "trial_converted",
    "trial_cancelled"
])

export function serverAccepts(events: { name: string; count: number }[]): boolean {
    return (
        events.length > 0 &&
        events.length <= 100 &&
        events.every(e => SERVER_EVENT_NAMES.has(e.name) && e.count >= 1 && e.count <= 10_000)
    )
}
