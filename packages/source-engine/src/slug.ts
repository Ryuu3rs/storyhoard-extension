// A series slug comes out of url.pathname, so a non-ASCII slug arrives already percent-encoded
// ("%E3%81%82"). Two consequences the engine has to handle: interpolating it into a URL template must
// not encode it a second time, and matching it inside a page must accept every way the page may write
// it (encoded, raw, lower-case hex, or as HTML entities).

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Decode a percent-encoded slug once. A slug that is not valid percent-encoding is returned as-is.
export function decodeSlug(slug: string): string {
    try {
        return decodeURIComponent(slug)
    } catch {
        return slug
    }
}

// A per-series hash some sites append to a slug ("the-title-3f9c2b71"): six or more hex characters that mix
// digits and letters. A real token ("no-8", "season-2", "x10", "2049", "facade") never matches.
const HASH_TOKEN = /^(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,}$/i

// The slug without a trailing per-series hash. Only cut when a word is left in front of it, so a slug that
// is an opaque id from end to end (a UUID, a bare hash) is kept whole rather than shortened to part of it.
export function stripSlugHash(slug: string): string {
    const cut = slug.lastIndexOf("-")
    if (cut <= 0 || !HASH_TOKEN.test(slug.slice(cut + 1))) return slug
    const head = slug.slice(0, cut).replace(/-+$/, "")
    const isWord = (segment: string): boolean =>
        /\p{L}/u.test(segment) && !(/^[0-9a-f]+$/i.test(segment) && /\d/.test(segment))
    const hasWord = head.split(/[-_]+/).some(isWord)
    return hasWord ? head : slug
}

// The readable name a series slug stands for when the page names none: decoded, hash dropped, separators
// as spaces, each word capitalised ("lantern-keeper-3f9c2b71" -> "Lantern Keeper").
export function seriesNameFromSlug(slug: string): string {
    return stripSlugHash(decodeSlug(slug))
        .replace(/[-_]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/(^|[^\p{L}\p{N}'])(\p{Ll})/gu, (_match, before: string, letter: string) => {
            return before + letter.toLocaleUpperCase("en")
        })
}

const PLAIN_SLUG = /^[A-Za-z0-9._~-]+$/

// Percent escapes match their hex digits in either case.
function caseInsensitiveEscapes(escaped: string): string {
    return escaped.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex: string) => {
        const digit = (c: string): string => (/[A-Fa-f]/.test(c) ? `[${c.toUpperCase()}${c.toLowerCase()}]` : c)
        return `%${digit(hex[0]!)}${digit(hex[1]!)}`
    })
}

// One character of the decoded slug as it may be written in markup: raw, or as a numeric entity.
function charPattern(ch: string): string {
    if (/^[A-Za-z0-9._~-]$/.test(ch)) return escapeRegex(ch)
    if (ch === "&") return "(?:&amp;|&#0*38;|&#[xX]0*26;|&)"
    const cp = ch.codePointAt(0)!
    return `(?:${escapeRegex(ch)}|&#0*${cp};|&#[xX]0*${cp.toString(16)};)`
}

// A regex source matching the slug however a page writes it. A plain ASCII slug is just escaped.
export function slugPattern(slug: string): string {
    if (PLAIN_SLUG.test(slug)) return escapeRegex(slug)
    const decoded = decodeSlug(slug)
    const forms = new Set<string>([
        caseInsensitiveEscapes(escapeRegex(slug)),
        caseInsensitiveEscapes(escapeRegex(encodeSafely(decoded))),
        [...decoded].map(charPattern).join("")
    ])
    return `(?:${[...forms].join("|")})`
}

function encodeSafely(value: string): string {
    try {
        return encodeURIComponent(value)
    } catch {
        return value
    }
}
