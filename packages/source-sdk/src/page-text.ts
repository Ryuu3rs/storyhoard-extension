// Text a web page chose (an address slug, a link's label, a title it reports or its own markup scraped by a
// site profile) becomes a title, a chapter label or a notification line only through here. The page is
// untrusted, so what comes out is one line of plain text: control and format characters are dropped
// (direction overrides and isolates that would flip how the text reads, zero-width characters that hide or
// split words), invisible fillers count as spaces, other default-ignorable characters go, a character keeps
// at most a few stacking combining marks, whitespace and line breaks collapse to single spaces, and the length is
// capped by whole characters as a reader sees them (an emoji or an accented letter is never cut in half) and
// then by code units. Text with nothing visible left becomes "", so a caller's fallback takes over.

export const MAX_PAGE_TITLE_LENGTH = 200
export const MAX_MARKS_PER_CHARACTER = 8
const UNITS_PER_CHARACTER = 4

// A zero-width joiner is kept only between two emoji, where it builds one emoji (a family, a flag).
const STRAY_JOINER =
    /(?<!\p{Extended_Pictographic}[\u{FE0F}\u{1F3FB}-\u{1F3FF}]?)\u{200D}|\u{200D}(?!\p{Extended_Pictographic})/gu
// The emoji presentation selector is kept only where it styles an emoji or a keycap.
const STRAY_EMOJI_SELECTOR = /(?<![\p{Extended_Pictographic}#*0-9])\u{FE0F}/gu
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cs}]|(?!\u{200D})\p{Cf}/gu
// Characters that draw as blank space without being whitespace: Hangul fillers and the blank braille cell.
const INVISIBLE_FILLER = /[\u{115F}\u{1160}\u{3164}\u{FFA0}\u{2800}]/gu
const IGNORABLE = /(?![\u{200D}\u{FE0F}])\p{Default_Ignorable_Code_Point}/gu
const MARK_RUN = /\p{M}+/gu
// Only marks drawn above or below a character stack into a tower. Spacing marks (the vowels and medials of
// Myanmar and Indic scripts) sit beside it, so they never count toward the cap.
const STACKING_MARK = /[\p{Mn}\p{Me}]/u
const VISIBLE = /[^\s\p{M}\u{200D}]/u

function capStackingMarks(run: string): string {
    let stacked = 0
    let out = ""
    for (const mark of run) {
        if (STACKING_MARK.test(mark)) {
            if (stacked >= MAX_MARKS_PER_CHARACTER) continue
            stacked++
        }
        out += mark
    }
    return out
}

function graphemes(text: string): string[] {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
        return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), s => s.segment)
    }
    return Array.from(text)
}

function capByUnits(parts: readonly string[], maxUnits: number): string {
    let out = ""
    for (const part of parts) {
        if (out.length + part.length > maxUnits) break
        out += part
    }
    return out
}

export function sanitizePageText(raw: unknown, maxLength: number = MAX_PAGE_TITLE_LENGTH): string {
    if (typeof raw !== "string") return ""
    const cleaned = raw
        .replace(STRAY_JOINER, "")
        .replace(STRAY_EMOJI_SELECTOR, "")
        .replace(CONTROL_OR_FORMAT, " ")
        .replace(INVISIBLE_FILLER, " ")
        .replace(IGNORABLE, "")
        .replace(MARK_RUN, capStackingMarks)
        .replace(/\s+/g, " ")
        .trim()
    if (!VISIBLE.test(cleaned)) return ""
    const maxUnits = maxLength * UNITS_PER_CHARACTER
    if (cleaned.length <= maxLength) return cleaned
    const parts = graphemes(cleaned)
    if (parts.length <= maxLength && cleaned.length <= maxUnits) return cleaned
    return capByUnits(parts.slice(0, maxLength), maxUnits).trim()
}
