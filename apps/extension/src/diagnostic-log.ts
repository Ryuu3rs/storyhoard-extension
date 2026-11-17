// Plain-text formatter for the user-exportable diagnostic log. Built by explicit
// string construction (never DOM-copied) so line breaks survive a clipboard copy, and
// every free-text field is flattened to one line (reusing updates-failure-log's Unicode
// sanitizer) so an injected newline can't forge a log line. Secrets are redacted before
// the log ever leaves the device - both known values (passed in) and by token pattern.

import type { LogEntry } from "./database"
import { flatten } from "./updates-failure-log"

// Backstop patterns for tokens that might appear in a captured message even if the exact
// value wasn't passed in `secrets` (e.g. a token echoed inside a fetch error string).
const TOKEN_PATTERNS: readonly RegExp[] = [
    /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub PAT (ghp_/gho_/ghu_/ghs_/ghr_)
    /github_pat_[A-Za-z0-9_]{20,}/g, // fine-grained GitHub PAT
    /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, // Authorization: Bearer <token>
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g // bare JWT (header.payload.signature)
]

// Last backstop for an opaque random token with no recognisable prefix (the weeb.ltd device link is
// one): a long run that mixes upper case, lower case and digits. Slugs, UUIDs, ULIDs and hex hashes
// never mix all three, so they survive.
const OPAQUE_RUN = /[A-Za-z0-9_-]{24,}/g

function looksLikeOpaqueToken(run: string): boolean {
    return /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run)
}

function redact(text: string, secrets: readonly string[]): string {
    let out = text
    for (const secret of secrets) {
        // The log text is flattened (zero-width chars stripped, whitespace collapsed)
        // before it reaches here, so a secret carrying a U+200B or a double space no
        // longer matches the raw value literally. Redact both the raw secret and its
        // flattened form so an encoded variant can't slip past the literal split/join.
        for (const variant of new Set([secret, flatten(secret)])) {
            // Only redact non-trivial values so a blank/short config field can't blank the log.
            if (variant && variant.length >= 4) out = out.split(variant).join("[redacted]")
        }
    }
    for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, "[redacted]")
    return out.replace(OPAQUE_RUN, run => (looksLikeOpaqueToken(run) ? "[redacted]" : run))
}

// A point-in-time picture of the library the log lines alone don't carry. Answers the
// "why is X still unread / did the update check see it" questions a bare event log can't.
export type LibrarySnapshot = {
    total: number
    // Newest completed update check's counts, if one has run (from updateStatus).
    lastUpdateCheck?: {
        at: number
        checked: number
        updated: number
        failed: number
    }
    bySource: readonly { sourceId: string; count: number }[]
    // Titles the app currently considers to have unread/new chapters, capped.
    unread: readonly { title: string; sourceId: string; read: number | null; latest: number | null }[]
    unreadTotal: number
}

export type DiagnosticLogMeta = {
    version: string
    browser: string
    // Known secret values (AniList/gist tokens, community userId/secret, gist id, weeb.ltd device link and account id) to
    // redact literally. Empty/undefined entries are ignored.
    secrets: readonly string[]
    // Optional library picture rendered as a section above the event log.
    snapshot?: LibrarySnapshot
}

function formatSnapshot(s: LibrarySnapshot): string {
    const bySource = s.bySource.length ? s.bySource.map(b => `${flatten(b.sourceId)} ${b.count}`).join(", ") : "(none)"
    const lines = [`Library snapshot: ${s.total} titles`, `  by source: ${bySource}`]
    if (s.lastUpdateCheck) {
        const c = s.lastUpdateCheck
        lines.push(
            `  last update check: ${new Date(c.at).toISOString()} - checked ${c.checked}, updated ${c.updated}, failed ${c.failed}`
        )
    } else {
        lines.push(`  last update check: (none recorded)`)
    }
    lines.push(`  titles with unread/new chapters: ${s.unreadTotal}`)
    for (const u of s.unread) {
        lines.push(
            `    - ${flatten(u.title)} [${flatten(u.sourceId)}] read ${u.read ?? "-"} / latest ${u.latest ?? "-"}`
        )
    }
    if (s.unreadTotal > s.unread.length) {
        lines.push(`    ... and ${s.unreadTotal - s.unread.length} more`)
    }
    return lines.join("\n")
}

export function formatDiagnosticLog(entries: readonly LogEntry[], meta: DiagnosticLogMeta): string {
    const secrets = meta.secrets.filter((s): s is string => typeof s === "string" && s.length > 0)
    const header = [
        "StoryHoard diagnostic log",
        `generated: ${new Date().toISOString()}`,
        `extension version: ${meta.version}`,
        `browser: ${meta.browser}`,
        `log entries: ${entries.length}`
    ].join("\n")
    // Redact the snapshot too: manga titles/sourceIds are scraped from third-party sites, so
    // a token-shaped value there must be stripped by the same known-secret + TOKEN_PATTERNS
    // pass the event-log lines get. Without this the whole snapshot section bypassed redaction.
    const snapshotBlock = meta.snapshot ? `\n\n${redact(formatSnapshot(meta.snapshot), secrets)}` : ""

    const lines = entries.map(entry => {
        const time = new Date(entry.ts).toISOString()
        const src = entry.sourceId ? ` [${flatten(entry.sourceId)}]` : ""
        const detail = entry.detail ? ` | ${flatten(entry.detail)}` : ""
        // Redact the WHOLE assembled line, not per-field, so a secret is stripped no
        // matter which field it lands in (scope/sourceId were previously un-redacted)
        // and a secret spanning message+detail is caught too.
        const line = `${time} ${entry.level.toUpperCase()} ${flatten(entry.scope)}${src}: ${flatten(entry.message)}${detail}`
        return redact(line, secrets)
    })

    return `${header}${snapshotBlock}\n\n${lines.join("\n") || "(no entries)"}`
}
