import { sanitizePageText } from "./page-text"
import { getSettings } from "./settings"

export const MAX_NOTIFIED_TITLE_LENGTH = 60

// Shared id so the background click handler can recognise our own notification and open
// the app (rather than reacting to any notification in the browser).
export const NEW_CHAPTERS_NOTIFICATION_ID = "amr-new-chapters"

// Fires a single aggregate desktop notification for the titles that gained a new chapter
// on the last update check. Opt-out via the notifyNewChapters setting. Best-effort: it
// swallows every failure so it can never break the update loop, and no-ops when the
// notifications API is unavailable.
export async function notifyNewChapters(titles: readonly string[]): Promise<void> {
    if (titles.length === 0) return
    try {
        const settings = await getSettings()
        if (!settings.notifyNewChapters) return
        if (!browser.notifications?.create) return

        // A title can come from a page the user visited, so each is one capped line of plain text: the
        // notification carries the extension's name and icon, and must not carry a message a page wrote.
        const shown = titles.slice(0, 5).map(text => sanitizePageText(text, MAX_NOTIFIED_TITLE_LENGTH) || "Untitled")
        const title = titles.length === 1 ? "New chapter available" : `${titles.length} titles updated`
        const message =
            titles.length === 1
                ? shown[0]!
                : shown.join(", ") + (titles.length > shown.length ? `, and ${titles.length - shown.length} more` : "")

        await browser.notifications.create(NEW_CHAPTERS_NOTIFICATION_ID, {
            type: "basic",
            iconUrl: browser.runtime.getURL("/icons/icon_128.png"),
            title,
            message
        })
    } catch (error) {
        console.warn("[AMR] Failed to show new-chapter notification", error)
    }
}
