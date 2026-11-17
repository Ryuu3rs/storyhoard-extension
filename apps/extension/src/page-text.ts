// Text a web page chose (an address slug, a link's label, a title it reports) becomes a title, a chapter
// label or a notification line only through here. The page is untrusted, so what comes out is one line of
// plain text: control and format characters are dropped (direction overrides and isolates that would flip
// how the text reads, zero-width characters that hide or split words), whitespace and line breaks collapse
// to single spaces, and the length is capped by whole characters as a reader sees them, so an emoji or an
// accented letter is never cut in half.

export const MAX_PAGE_TITLE_LENGTH = 200

// A zero-width joiner is kept only between two emoji, where it builds one emoji (a family, a flag).
const STRAY_JOINER = /(?<!\p{Extended_Pictographic}[\u{FE0F}\u{1F3FB}-\u{1F3FF}]?)‍|‍(?!\p{Extended_Pictographic})/gu
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cs}]|(?!‍)\p{Cf}/gu

function graphemes(text: string): string[] {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
        return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), s => s.segment)
    }
    return Array.from(text)
}

export function sanitizePageText(raw: unknown, maxLength: number = MAX_PAGE_TITLE_LENGTH): string {
    if (typeof raw !== "string") return ""
    const cleaned = raw.replace(STRAY_JOINER, "").replace(CONTROL_OR_FORMAT, " ").replace(/\s+/g, " ").trim()
    if (cleaned.length <= maxLength) return cleaned
    const parts = graphemes(cleaned)
    if (parts.length <= maxLength) return cleaned
    return parts.slice(0, maxLength).join("").trim()
}
