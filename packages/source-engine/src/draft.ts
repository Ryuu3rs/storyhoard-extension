// ARCHITECTURE TRACK A - experimental.
//
// Turn DOM signals captured from the current tab into a DRAFT Site Profile. This is the
// inference core of the no-code "capture from this tab" builder: it fills the reliable fields
// (origin, domains, title/cover patterns) exactly, and makes a best-effort guess at the
// list/pages patterns. The result is a starting point the user reviews and the import-time
// health-check validates - it is not expected to be perfect, just close.

export type CaptureSignals = {
    url: string
    ogTitle?: string | undefined
    ogImage?: string | undefined
    ogSiteName?: string | undefined
    // Links found on the page: href (absolute or relative) + visible text.
    links: Array<{ href: string; text: string }>
    // Candidate page-image URLs (img src and data-url values).
    images: string[]
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Generalize a path into a match regex by turning its last non-empty segment into a capture.
function pathToMatch(pathname: string): string {
    const segs = pathname.replace(/\/+$/, "").split("/")
    const last = segs.length > 0 ? segs.length - 1 : 0
    const prefix = segs.slice(0, last).map(escapeRegex).join("/")
    return `^${prefix}/([^/]+)/?$`
}

// Pick the most frequent host among candidate image URLs.
// From the chapter-like links (those containing a number), pick the dominant shape and build an
// itemPattern. Digits become the chapter-number capture; the varying slug segment is widened.
function guessListPattern(links: Array<{ href: string; text: string }>): string | undefined {
    const numbered = links.filter(l => /\d/.test(l.href))
    if (numbered.length === 0) return undefined
    // Group by shape: digits -> "#". Pick the biggest group.
    const groups = new Map<string, string[]>()
    for (const l of numbered) {
        const shape = l.href.replace(/\d+/g, "#")
        const arr = groups.get(shape) ?? []
        arr.push(l.href)
        groups.set(shape, arr)
    }
    let sample: string | undefined
    let bestN = 0
    for (const [, hrefs] of groups) {
        if (hrefs.length > bestN) {
            bestN = hrefs.length
            sample = hrefs[0]
        }
    }
    if (!sample) return undefined
    // Build: escape the sample, replace the last number run with the number capture, and widen
    // path segments made of letters/digits/._- that look like a slug (keep structure/literals).
    const NUM = "\u0001"
    let withNum = sample
    const lastNum = sample.match(/\d+(?:\.\d+)?(?!.*\d)/)
    if (lastNum && lastNum.index !== undefined) {
        withNum = sample.slice(0, lastNum.index) + NUM + sample.slice(lastNum.index + lastNum[0].length)
    }
    const escaped = escapeRegex(withNum).replace(NUM, "(?<chapterNumber>[0-9.]+)")
    return `href="(?<chapterUrl>${escaped})"`
}

export function draftProfileFromSignals(signals: CaptureSignals): Record<string, unknown> {
    let origin = ""
    let host = ""
    let pathname = "/"
    try {
        const u = new URL(signals.url)
        origin = u.origin
        host = u.hostname
        pathname = u.pathname
    } catch {
        // leave blanks for the user to fill
    }

    const id =
        host
            .replace(/^www\./, "")
            .replace(/[^a-z0-9.-]/gi, "-")
            .toLowerCase() || "my-source"
    const name =
        signals.ogTitle
            ?.split("|")[0]
            ?.split(/\s+-\s+/)[0]
            ?.trim() ||
        host ||
        "My Source"

    const titlePattern = signals.ogTitle
        ? 'property="og:title" content="(?<title>[^"]+)"'
        : "<title>(?<title>[^<]+)</title>"
    const coverPattern = signals.ogImage ? 'property="og:image" content="(?<cover>[^"]+)"' : undefined

    const listPattern = guessListPattern(signals.links)

    // Format 2: the shipped engine resolves chapter LISTS (for background update-checks) but never
    // extracts page images, so the draft carries no `pages` and capabilities omit "pages". Reading
    // happens on the site's own rendered page.
    return {
        profileFormat: 2,
        id,
        name,
        engine: "generic",
        numberingKind: "chapter",
        origin: origin || "https://example.com",
        domains: host ? [host] : ["example.com"],
        languages: ["en"],
        capabilities: ["chapters", "manga"],
        requestRateLimit: { requests: 3, intervalMs: 1000 },
        origins: origin ? [`${origin}/*`] : ["https://example.com/*"],
        match: {
            manga: pathToMatch(pathname),
            // chapter URL isn't visible from a series page - the user fills this (capture again
            // on a chapter page, or edit). A sensible placeholder:
            chapter: "^/REPLACE-with-a-chapter-url-pattern/([^/]+)/?$"
        },
        series: {
            titlePattern,
            ...(coverPattern ? { coverPattern } : {})
        },
        list: { itemPattern: listPattern ?? 'href="(?<chapterUrl>REPLACE_(?<chapterNumber>[0-9.]+))"' }
    }
}

// Chapter-page drafting (the "add this site" flow). The user is looking at a CHAPTER page, so the
// reliable anchor is the current URL's own shape: it yields the chapter match, the series match,
// the series URL template and a chapter-list item pattern, with no need to guess from page links.

const NUMBER = "[0-9]+(?:\\.[0-9]+)?"
const CHAPTER_WORD = "(?:chapter|chap|ch|episode|ep|issue)"
const CHAPTER_SEGMENT = new RegExp(
    `^(?<lead>(?:[^/]*[-_])?)(?<kw>${CHAPTER_WORD}[-_.]*)(?<num>\\d+(?:\\.\\d+)?)(?<post>(?:[-_][^/]*)?)$`,
    "i"
)
const CHAPTER_KEYWORD_SEGMENT = /^(?:chapter|chap|ch|episode|ep)$/i
const NUMERIC_SEGMENT = /^\d+(?:\.\d+)?$/

export type ChapterShape = {
    // Path regexes: for `chapterMatch`, group 1 is the series slug and group 2 the chapter number.
    chapterMatch: string
    mangaMatch: string
    // Series URL template, e.g. "/manga/{slug}".
    seriesTemplate: string
    // Global item pattern for the series page. Carries a literal `{slug}` token the engine fills
    // with the series' own slug, so a sidebar of other titles' chapters is never swept in.
    itemPattern: string
    slug: string
}

// Derive the chapter/series URL shape from a chapter URL path, or undefined when the path does
// not look like "<prefix>/<series>/<chapter-N>[/<tail>]".
export function deriveChapterShape(pathname: string): ChapterShape | undefined {
    const segs = pathname.split("/").filter(Boolean)
    let slugIdx = -1
    let chapterPieces: string[] = []
    let itemChapterPieces: string[] = []
    let tail: string[] = []

    for (let ci = segs.length - 1; ci >= 1 && slugIdx < 0; ci--) {
        const m = CHAPTER_SEGMENT.exec(segs[ci]!)
        if (!m?.groups || CHAPTER_SEGMENT.test(segs[ci - 1]!)) continue
        const { lead, kw, post } = m.groups as { lead: string; kw: string; post: string }
        // A series-name lead ("one-piece-chapter-12") stays generic so it matches every series.
        const piece = (num: string): string => `${lead ? "[^/]*[-_]" : ""}${escapeRegex(kw)}${num}${escapeRegex(post)}`
        slugIdx = ci - 1
        chapterPieces = [piece(`(${NUMBER})`)]
        itemChapterPieces = [piece(`(?<chapterNumber>${NUMBER})`)]
        tail = segs.slice(ci + 1)
    }
    if (slugIdx < 0) {
        for (let k = segs.length - 2; k >= 1 && slugIdx < 0; k--) {
            if (!CHAPTER_KEYWORD_SEGMENT.test(segs[k]!) || !NUMERIC_SEGMENT.test(segs[k + 1]!)) continue
            slugIdx = k - 1
            chapterPieces = [escapeRegex(segs[k]!), `(${NUMBER})`]
            itemChapterPieces = [escapeRegex(segs[k]!), `(?<chapterNumber>${NUMBER})`]
            tail = segs.slice(k + 2)
        }
    }
    if (slugIdx < 0 || tail.length > 2) return undefined

    const slug = segs[slugIdx]!
    const prefix = segs.slice(0, slugIdx)
    const prefixRegex = prefix.map(escapeRegex)
    const tailRegex = tail.map(escapeRegex)
    const chapterPath = [...prefixRegex, "([^/]+)", ...chapterPieces, ...tailRegex].join("/")
    const itemPath = [...prefixRegex, "{slug}", ...itemChapterPieces, ...tailRegex].join("/")
    return {
        chapterMatch: `^/${chapterPath}/?$`,
        mangaMatch: `^/${[...prefixRegex, "([^/]+)"].join("/")}/?$`,
        seriesTemplate: `/${[...prefix, "{slug}"].join("/")}`,
        itemPattern: `href=["'](?<chapterUrl>(?:(?:https?:)?//[^"'/]+)?/${itemPath}/?)["']`,
        slug
    }
}

// Cheap URL-only check: does this look like a chapter/reader page? Needs no DOM and no host access.
export function looksLikeChapterUrl(url: string): boolean {
    try {
        return deriveChapterShape(new URL(url).pathname) !== undefined
    } catch {
        return false
    }
}

function titleCase(s: string): string {
    return s
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ")
}

// A site's display name: og:site_name when present, else the registrable label of the host.
function siteDisplayName(signals: CaptureSignals, host: string): string {
    const fromMeta = signals.ogSiteName?.trim()
    if (fromMeta) return fromMeta
    const labels = host.replace(/^www\./, "").split(".")
    const label = labels.length > 1 ? labels[labels.length - 2]! : labels[0]!
    return titleCase(label) || host || "My Source"
}

export type ChapterDraft = {
    profile: Record<string, unknown>
    // A concrete series page URL for the current chapter's series, used to health-check the draft.
    seriesUrl: string
    // False when the page's own links do not corroborate the derived chapter shape.
    matchOk: boolean
}

// Draft a format-2 profile from a chapter page. Returns undefined when the URL does not look like
// a chapter page, so the caller offers nothing rather than a broken source.
export function draftProfileFromChapterPage(signals: CaptureSignals): ChapterDraft | undefined {
    let url: URL
    try {
        url = new URL(signals.url)
    } catch {
        return undefined
    }
    const shape = deriveChapterShape(url.pathname)
    if (!shape) return undefined

    const base = draftProfileFromSignals(signals)
    const profile = {
        ...base,
        name: siteDisplayName(signals, url.hostname),
        match: { manga: shape.mangaMatch, chapter: shape.chapterMatch },
        series: { ...(base["series"] as Record<string, unknown>), urlTemplate: shape.seriesTemplate },
        list: { itemPattern: shape.itemPattern }
    }
    const seriesUrl = new URL(shape.seriesTemplate.replace("{slug}", shape.slug), url.origin).toString()
    const corroborate = new RegExp(shape.itemPattern.replace("{slug}", escapeRegex(shape.slug)))
    const matchOk = signals.links.length === 0 || signals.links.some(l => corroborate.test(`href="${l.href}"`))
    return { profile, seriesUrl, matchOk }
}
