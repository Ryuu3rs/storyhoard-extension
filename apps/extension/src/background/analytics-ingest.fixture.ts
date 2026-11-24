// The event names the live weeb.ltd ingest counts. Copied from EVENT_NAMES in weeb.ltd's
// lib/analytics-events.ts (master, 2026-11-24); update it by hand when the server list changes.
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
    "install",
    "panel_action",
    "on_site_track",
    "resolve_direct",
    "resolve_tab",
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

type SentEvent = { name: string; count: number }

// The ingest refuses (400) only a malformed batch: no events, or more than 100. An event whose name it does not
// list, or whose count is under 1 or over 10,000, is skipped and the rest of the batch is counted (204).
export function serverIngest(
    events: SentEvent[],
    names: ReadonlySet<string> = SERVER_EVENT_NAMES
): { status: 204 | 400; counted: SentEvent[] } {
    if (events.length === 0 || events.length > 100) return { status: 400, counted: [] }
    return { status: 204, counted: events.filter(e => names.has(e.name) && e.count >= 1 && e.count <= 10_000) }
}
