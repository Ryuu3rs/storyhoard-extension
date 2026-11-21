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

const ZWJ = "‍"
const JOINER = /[\u{200C}\u{200D}]/gu
// A zero-width joiner or non-joiner is spelling inside a word of a script whose letters join (Persian,
// Bengali, Sinhala, a Malayalam chillu): kept after a letter of such a script, with its marks, when a letter
// follows or when it comes straight after a mark such as a virama.
const WORD_JOINER =
    /(?<=(?![\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])\p{L}\p{M}*)[\u{200C}\u{200D}](?:(?=\p{L})|(?<=\p{M}.))/uy
// A zero-width joiner between two emoji builds one emoji (a family, a flag).
const EMOJI_JOINER =
    /(?<=\p{Extended_Pictographic}[\u{FE0F}\u{1F3FB}-\u{1F3FF}]?)\u{200D}(?=\p{Extended_Pictographic})/uy
// The emoji presentation selector is kept only where it styles an emoji or a keycap.
const STRAY_EMOJI_SELECTOR = /(?<![\p{Extended_Pictographic}#*0-9])\u{FE0F}/gu
// Tag characters survive only as a subdivision flag: a black flag, a region code in tags, a cancel tag.
const CONTROL_OR_FORMAT =
    /(\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,6}\u{E007F})|[\p{Cc}\p{Cs}]|(?![\u{200C}\u{200D}])\p{Cf}/gu
// Characters that draw as blank space without being whitespace: Hangul fillers and the blank braille cell.
const INVISIBLE_FILLER = /[\u{115F}\u{1160}\u{3164}\u{FFA0}\u{2800}]/gu
// Joiners, emoji selectors and tags still here passed the checks above. An ideographic variation selector
// picks the glyph of the kanji before it, the form a Japanese name is written in.
const IGNORABLE =
    /(?![\u{200C}\u{200D}\u{FE0F}\u{E0020}-\u{E007F}]|(?<=\p{Ideographic})[\u{E0100}-\u{E01EF}])\p{Default_Ignorable_Code_Point}/gu
const MARK_RUN = /\p{M}+/gu
// Only marks drawn above or below a character stack into a tower. Spacing marks (the vowels and medials of
// Myanmar and Indic scripts) sit beside it, so they never count toward the cap.
const STACKING_MARK = /[\p{Mn}\p{Me}]/u
const VISIBLE = /[^\s\p{M}\u{200C}\u{200D}]/u

// A stray joiner goes; a stray non-joiner splits the words around it.
function keepJoiner(joiner: string, offset: number, text: string): string {
    const at = (pattern: RegExp) => {
        pattern.lastIndex = offset
        return pattern.test(text)
    }
    if (at(WORD_JOINER) || (joiner === ZWJ && at(EMOJI_JOINER))) return joiner
    return joiner === ZWJ ? "" : " "
}

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

// The first `limit` graphemes only, so a huge input is never segmented past what can be kept.
function leadingGraphemes(text: string, limit: number): string[] {
    const segments: Iterable<string | Intl.SegmentData> =
        typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
            ? new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)
            : text
    const parts: string[] = []
    for (const part of segments) {
        parts.push(typeof part === "string" ? part : part.segment)
        if (parts.length >= limit) break
    }
    return parts
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
        .replace(JOINER, keepJoiner)
        .replace(STRAY_EMOJI_SELECTOR, "")
        .replace(CONTROL_OR_FORMAT, (_, flag: string | undefined) => flag ?? " ")
        .replace(INVISIBLE_FILLER, " ")
        .replace(IGNORABLE, "")
        .replace(MARK_RUN, capStackingMarks)
        .replace(/\s+/g, " ")
        .trim()
    if (!VISIBLE.test(cleaned)) return ""
    const maxUnits = maxLength * UNITS_PER_CHARACTER
    if (cleaned.length <= maxLength) return cleaned
    const parts = leadingGraphemes(cleaned, maxLength + 1)
    if (parts.length <= maxLength && cleaned.length <= maxUnits) return cleaned
    return capByUnits(parts.slice(0, maxLength), maxUnits).trim()
}
