import type { RelinkReason } from "./update-check-cause"

// Sorts what an update check could not do by the action that fixes it, so the page shows one button per
// group instead of one row per error.

export type FixTitle = { mangaId: string; title: string; sourceId: string; detail: string }

export type FixGroups = {
    // Titles whose site has no working source behind it, one row per site. Turning the site back on (or
    // finding the titles elsewhere) fixes every title on it at once.
    sites: Array<{ sourceId: string; titles: FixTitle[] }>
    // Sites that asked for a browser check, as the update check reported them.
    visit: Array<{ origin: string; sourceId: string; count: number; openUrl: string; sampleTitle: string }>
    // Titles whose page is gone or whose link is missing or unreadable: found again on the user's sites.
    lost: FixTitle[]
    // Temporary trouble (offline, busy, rate limited). The next check retries by itself.
    retry: FixTitle[]
    // Anything else, shown with its message.
    other: FixTitle[]
}

type ErrorRow = { mangaId: string; title: string; message: string; sourceId?: string; cause?: string }
type RelinkRow = { mangaId: string; title: string; sourceId: string; reason?: RelinkReason }

export type UpdateStatusLike = {
    errors?: ErrorRow[]
    relinkTitles?: RelinkRow[]
    needsVerify?: FixGroups["visit"]
}

const LOST_CAUSES = new Set(["http-404", "http-410", "parse"])
const RETRY_CAUSES = new Set(["network", "timeout", "request-limit", "blocked", "http-429"])

// Older stored statuses have no cause on their rows, so the message is read as a fallback.
function causeOf(row: ErrorRow): string {
    if (row.cause) return row.cause
    const status = /status (\d{3})/.exec(row.message)?.[1]
    if (status) return `http-${status}`
    if (/request limit/i.test(row.message)) return "request-limit"
    if (/timed out/i.test(row.message)) return "timeout"
    if (/^request failed$/i.test(row.message.trim())) return "network"
    return "other"
}

const RELINK_DETAIL: Record<RelinkReason, string> = {
    "no-link": "No link saved",
    "site-off": "Site not connected",
    "bad-link": "Link can't be read"
}

const ERROR_DETAIL: Record<string, string> = {
    "http-404": "Page gone",
    "http-410": "Page gone",
    parse: "Page changed",
    network: "Site didn't answer",
    timeout: "Site too slow",
    "request-limit": "Too many requests",
    blocked: "Site busy",
    "http-429": "Too many requests"
}

export function groupUpdateProblems(status: UpdateStatusLike | null | undefined): FixGroups {
    const groups: FixGroups = { sites: [], visit: status?.needsVerify ?? [], lost: [], retry: [], other: [] }
    const bySite = new Map<string, FixTitle[]>()
    const seen = new Set<string>()
    for (const row of status?.relinkTitles ?? []) {
        if (seen.has(row.mangaId)) continue
        seen.add(row.mangaId)
        const reason = row.reason ?? "no-link"
        const title: FixTitle = {
            mangaId: row.mangaId,
            title: row.title,
            sourceId: row.sourceId,
            detail: RELINK_DETAIL[reason]
        }
        if (reason === "site-off") {
            const list = bySite.get(row.sourceId) ?? []
            list.push(title)
            bySite.set(row.sourceId, list)
        } else {
            groups.lost.push(title)
        }
    }
    groups.sites = [...bySite]
        .map(([sourceId, titles]) => ({ sourceId, titles }))
        .sort((a, b) => b.titles.length - a.titles.length)
    for (const row of status?.errors ?? []) {
        if (seen.has(row.mangaId)) continue
        seen.add(row.mangaId)
        const cause = causeOf(row)
        const title: FixTitle = {
            mangaId: row.mangaId,
            title: row.title,
            sourceId: row.sourceId ?? "",
            detail: ERROR_DETAIL[cause] ?? row.message
        }
        if (LOST_CAUSES.has(cause)) groups.lost.push(title)
        else if (RETRY_CAUSES.has(cause) || /^http-5\d\d$/.test(cause)) groups.retry.push(title)
        else groups.other.push(title)
    }
    return groups
}

// A title that is only a site's hostname ("mangadex.org"), left by an older capture.
export function isHostnameTitle(title: string): boolean {
    return /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(title.trim())
}
