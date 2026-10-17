// Plain-text, copy-pasteable log of the titles that failed an update check, for the
// user to hand to a maintainer. Built by explicit string construction (never
// DOM-copied) so the card layout can't drop line breaks, and every interpolated
// free-text field is flattened to one line so an embedded newline in a title or error
// message can't forge a new log line or section heading.

export type UpdateFailureEntry = {
    mangaId: string
    title: string
    message: string
}

export type UpdateFailureMeta = {
    version: string
    checkedAt: number
    checked: number
    updated: number
    failed: number
    // sourceId -> failure count for this run. Lets the log show the failure
    // distribution across all failed titles, not just the sampled per-title rows.
    failuresBySource?: Record<string, number>
    // sourceId -> count of titles SKIPPED because the site blocks automated checks
    // (Cloudflare challenge etc.). Not failures - chapters still load in the reader -
    // so they're reported in their own section, never mixed into the failure rows.
    skippedSources?: Record<string, number>
    // sourceId -> count of titles that can't be checked until relinked (retired/removed
    // adapter, no source link, or an unparseable link). Actionable, not a failure to chase.
    needsRelink?: Record<string, number>
    // The specific titles behind the needs-relink counts. When present the log names them (title
    // only, never the source host) instead of the per-source count fallback.
    relinkTitles?: ReadonlyArray<{ mangaId: string; title: string; sourceId: string }>
    // sourceId -> count of titles on a source that cannot list chapters: tracked, but new chapters are
    // never auto-detected. Informational, not a failure.
    trackingOnly?: Record<string, number>
    // sourceId -> count of titles whose chapter list came back empty although they already had a
    // chapter (the source profile has probably stopped matching its site).
    emptyLists?: Record<string, number>
}

const ZWJ = 0x200d
// C1 controls that move to a new line but aren't matched by JS \s: NEL, IND, RI. Mapped
// to a space so a title using them as a separator doesn't get its words glued together.
const LINE_MOVE_C1 = new Set([0x84, 0x85, 0x8d])

// Strip whole Unicode categories rather than hand-picked ranges, so sibling characters
// in the same class can't slip through the way earlier range-by-range attempts kept
// missing (ZWJ vs other zero-widths, one C1 control vs its siblings, one bidi mark vs
// the tag block). Cc = controls (ESC and friends - terminal forgery), Cf = format
// (bidi overrides that reorder text, invisible tag characters that smuggle hidden
// payloads, zero-width spaces), Cs = lone surrogates (invalid UTF-16 that corrupts the
// clipboard). ZWJ is the one Cf kept: it joins emoji sequences and can't forge or hide
// the log's structural markers. Emoji variation selectors (Mn) and skin-tone modifiers
// (So) are outside these categories and survive untouched.
const STRIP_CATEGORY = /\p{Cc}|\p{Cf}|\p{Cs}/u
// Characters that render with no visible advance width, used to decide the "(untitled)"
// fallback: whitespace, format/ignorable characters (Hangul fillers, remaining joiners),
// and ZWJ. A field made only of these shows blank and must get the placeholder.
const INVISIBLE = /\p{White_Space}|\p{Default_Ignorable_Code_Point}/u

export function flatten(s: unknown): string {
    let out = ""
    for (const ch of String(s)) {
        const code = ch.codePointAt(0) ?? 0
        if (LINE_MOVE_C1.has(code)) {
            out += " "
            continue
        }
        // Whitespace (incl. tab/newline/CR and exotic spaces) is kept for the \s+ collapse
        // below, which turns it into a single ordinary space - preserving word boundaries.
        if (/\s/u.test(ch)) {
            out += ch
            continue
        }
        if (code === ZWJ) {
            out += ch
            continue
        }
        if (STRIP_CATEGORY.test(ch)) continue
        out += ch
    }
    return out.replace(/\s+/g, " ").trim()
}

function isVisuallyEmpty(s: string): boolean {
    for (const ch of s) {
        if ((ch.codePointAt(0) ?? 0) === ZWJ) continue
        if (INVISIBLE.test(ch)) continue
        return false
    }
    return true
}

function orPlaceholder(s: string, placeholder: string): string {
    return isVisuallyEmpty(s) ? placeholder : s
}

function isoOrUnknown(ts: number): string {
    // new Date(NaN).toISOString() throws, and checkedAt can be missing/NaN before the
    // first check completes - never let formatting the log throw. A finite-but-out-of-
    // range timestamp (e.g. 8.64e15 + 1) also throws RangeError, which the catch covers.
    if (!Number.isFinite(ts)) return "unknown"
    try {
        return new Date(ts).toISOString()
    } catch {
        return "unknown"
    }
}

function num(n: unknown): string {
    return typeof n === "number" && Number.isFinite(n) ? String(n) : "?"
}

// A chapter error message is free text a source adapter produced, and some messages interpolate a
// URL or a bare origin (a redirected/parked mirror, a failed fetch), which would put a source host
// back into this host-free log. Replace any URL and any bare domain-like token with a neutral
// marker. Applied only to messages - titles are the user's own library text - so over-redacting a
// status string that happens to contain a dotted token is acceptable.
function redactHosts(s: string): string {
    return s
        .replace(/\b(?:https?|ftp|wss?):\/\/\S+/gi, "[link]")
        .replace(/\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}\b/gi, "[site]")
}

export function formatUpdateFailureLog(errors: readonly UpdateFailureEntry[], meta: UpdateFailureMeta): string {
    const header = [
        "StoryHoard update-failure log",
        `checked at: ${isoOrUnknown(meta?.checkedAt)}`,
        `extension version: ${orPlaceholder(flatten(meta?.version), "unknown")}`,
        `checked: ${num(meta?.checked)} | updated: ${num(meta?.updated)} | failed: ${num(meta?.failed)}`
    ].join("\n")

    // This log is meant to be pasted into a support chat, so it never names the source hosts: a
    // site name trips reader-site auto-moderation and puts it in public. Each source is shown as a
    // neutral "Source N" label, assigned the first time that source is rendered (so the worst
    // failing source reads as "Source 1") and stable within this one log. The user's own title text
    // stays (it is their library), and the chapter error messages stay (generic status, not hosts).
    const labels = new Map<string, string>()
    const labelFor = (id: string): string => {
        let label = labels.get(id)
        if (label === undefined) {
            label = `Source ${labels.size + 1}`
            labels.set(id, label)
        }
        return label
    }

    const relinkTitles = Array.isArray(meta?.relinkTitles)
        ? meta.relinkTitles.filter((t): t is { mangaId: string; title: string; sourceId: string } => t != null)
        : []

    const finiteEntries = (m: Record<string, number> | undefined): Array<[string, number]> =>
        m && typeof m === "object"
            ? Object.entries(m)
                  .filter(([, count]) => typeof count === "number" && Number.isFinite(count))
                  .sort((a, b) => b[1] - a[1])
            : []

    // Failure distribution across every failed title (the per-title rows below are only a sample).
    const sourceRows = finiteEntries(meta?.failuresBySource).map(([source, count]) => `- ${labelFor(source)}: ${count}`)
    const bySourceSection = sourceRows.length > 0 ? `\n\nfailures by source:\n${sourceRows.join("\n")}` : ""

    // Skipped (bot-blocked) sources - expected, not failures.
    const skippedRows = finiteEntries(meta?.skippedSources).map(
        ([source, count]) => `- ${labelFor(source)}: ${count} title(s) - chapters still load in the reader`
    )
    const skippedSection =
        skippedRows.length > 0
            ? `\n\nskipped (site blocks automated checks, not a failure):\n${skippedRows.join("\n")}`
            : ""

    // Titles that need relinking - the source was retired/removed, has no link, or its link can't
    // be read. When the titles are known they are listed by name (never the host) so the user can
    // find and relink each one; otherwise it falls back to a neutral per-source count.
    let relinkSection = ""
    if (relinkTitles.length > 0) {
        const rows = relinkTitles.map(t => `- ${orPlaceholder(flatten(t.title), "(untitled)")} - relink this title`)
        // The listed titles are capped by the producer, but the per-source counts cover every one, so
        // the heading reports the true total and notes when only some are listed - otherwise a user
        // with more than the cap would relink the shown ones and think they were done.
        const total = finiteEntries(meta?.needsRelink).reduce((sum, [, count]) => sum + count, 0)
        const trueTotal = Math.max(total, rows.length)
        const countNote =
            trueTotal > rows.length
                ? `${trueTotal} titles, showing ${rows.length}`
                : `${rows.length} title${rows.length === 1 ? "" : "s"}`
        const heading = `needs relink (${countNote}; the source was retired or the link can't be read)`
        relinkSection = `\n\n${heading}:\n${rows.join("\n")}`
    } else {
        const relinkRows = finiteEntries(meta?.needsRelink).map(
            ([source, count]) => `- ${labelFor(source)}: ${count} title(s) - relink these titles`
        )
        relinkSection =
            relinkRows.length > 0
                ? `\n\nneeds relink (source retired or link can't be read):\n${relinkRows.join("\n")}`
                : ""
    }

    const countSection = (counts: Record<string, number> | undefined, heading: string, suffix: string): string => {
        const rows = finiteEntries(counts).map(
            ([source, count]) => `- ${labelFor(source)}: ${count} title(s) - ${suffix}`
        )
        return rows.length > 0 ? `\n\n${heading}:\n${rows.join("\n")}` : ""
    }
    const trackingOnlySection = countSection(
        meta?.trackingOnly,
        "tracking only (new chapters are not auto-detected)",
        "not checked for new chapters"
    )
    const emptyListsSection = countSection(
        meta?.emptyLists,
        "empty chapter list (the site profile may have stopped matching)",
        "returned no chapters"
    )

    // Per-title failure sample. The internal chapter/manga id is NOT included: it embeds the source
    // id (and a detected-site id embeds its host), which would defeat the host-free labelling above.
    const rows = (Array.isArray(errors) ? errors : []).filter((e): e is UpdateFailureEntry => e != null)
    const body =
        rows.length > 0
            ? rows
                  .map(e => {
                      const title = orPlaceholder(flatten(e.title), "(untitled)")
                      const message = orPlaceholder(redactHosts(flatten(e.message)), "(no message)")
                      return `- ${title}: ${message}`
                  })
                  .join("\n")
            : "(no per-title errors recorded)"

    return `${header}${bySourceSection}${skippedSection}${relinkSection}${trackingOnlySection}${emptyListsSection}\n\n${body}`
}
