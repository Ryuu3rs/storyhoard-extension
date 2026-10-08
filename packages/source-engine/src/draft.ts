// ARCHITECTURE TRACK A - experimental.
//
// Turn DOM signals captured from the current tab into a DRAFT Site Profile. This is the
// inference core of the no-code "capture from this tab" builder: it fills the reliable fields
// (origin, domains, title/cover patterns) exactly, and makes a best-effort guess at the
// list/pages patterns. The result is a starting point the user reviews and the import-time
// health-check validates - it is not expected to be perfect, just close.

import { OPAQUE_ID_MIN, parseChapterLabel, type ChapterLabelKind } from "@amr/source-sdk"
import { slugPattern } from "./slug"

export type CaptureSignals = {
    url: string
    ogTitle?: string | undefined
    ogImage?: string | undefined
    ogSiteName?: string | undefined
    // Links found on the page: href (absolute or relative) + visible text.
    links: Array<{ href: string; text: string }>
    // Candidate page-image URLs (img src and data-url values).
    images: string[]
    // Count of images rendered at a size a reader page uses for a page (not icons, avatars or thumbs).
    largeImages?: number | undefined
    // True when the page has a recognisable reader container element.
    readerContainer?: boolean | undefined
    // The document's declared language (<html lang>), e.g. "en" or "pt-BR".
    lang?: string | undefined
    // document.title, which on many readers carries the chapter label ("Series - Chapter 70").
    docTitle?: string | undefined
    // <meta property="og:type">, e.g. "book", "article", "video.episode".
    ogType?: string | undefined
    // The @type strings found in the page's JSON-LD blocks (capped), e.g. ["ComicSeries"].
    jsonLd?: string[] | undefined
    // True when at least three page-sized images share one parent element (a vertical image strip).
    imageStrip?: boolean | undefined
    // Whether the page offers a previous and a next chapter control.
    chapterNav?: { prev: boolean; next: boolean } | undefined
    // The reader framework the page's markup fingerprints as.
    readerEngine?: "madara" | "mangastream" | "dm5" | undefined
    // Text of the selected / current entry in a chapter list or dropdown, e.g. "Ch. 86".
    activeChapterText?: string | undefined
}

export const BADGE_THRESHOLD = 0.5

const POSITIVE_JSON_LD = new Set(["comicseries", "comicissue", "book", "chapter", "publicationissue", "periodical"])
const NEGATIVE_JSON_LD = new Set([
    "newsarticle",
    "tvseries",
    "tvepisode",
    "tvseason",
    "videoobject",
    "recipe",
    "course"
])
const NEGATIVE_OG_TYPE = /^(?:video|tv|music)(?:[._]|$)/i
// Hosts that are never a manga reader: encyclopaedias and media sites a "chapter-3" url can land on,
// plus the extension's own first-party services.
const NON_READER_HOSTS = [
    "wikipedia.org",
    "wikimedia.org",
    "fandom.com",
    "wikia.com",
    "youtube.com",
    "youtu.be",
    "netflix.com",
    "imdb.com",
    "twitch.tv",
    "spotify.com",
    "weeb.ltd",
    "anilist.co",
    "myanimelist.net",
    "github.com"
]

function isNonReaderHost(url: string): boolean {
    try {
        const host = new URL(url).hostname.toLowerCase()
        return NON_READER_HOSTS.some(reserved => host === reserved || host.endsWith(`.${reserved}`))
    } catch {
        return false
    }
}

// Rank how likely a captured page is a manga/comic reader from several independent client-side
// signals. Positive evidence is additive; evidence that the page is something else (video, TV, news,
// a wiki or first-party host) subtracts. Returns the score and the names of the signals that fired so
// a caller can show or log why. Pages whose signals carry no content measurements at all (an older
// capture) are given the benefit of the doubt by the caller, not by this function.
export function scoreReaderPage(signals: CaptureSignals): { score: number; signals: string[] } {
    const fired: string[] = []
    let score = 0
    const add = (name: string, weight: number): void => {
        fired.push(name)
        score += weight
    }
    const large = signals.largeImages ?? 0
    const nav = signals.chapterNav
    const ogType = signals.ogType?.trim().toLowerCase() ?? ""
    const jsonLd = (signals.jsonLd ?? []).map(type => type.toLowerCase())

    if (large >= 3 || signals.imageStrip === true) add("image-strip", 0.6)
    if (signals.readerContainer === true && (large >= 1 || signals.images.length >= 2)) add("reader-container", 0.5)
    if (signals.readerContainer === true && nav?.prev === true && nav.next === true) add("reader-nav", 0.4)
    const bookLike = ogType === "book" || ogType === "article" || ogType.startsWith("books.")
    if (bookLike || jsonLd.some(type => POSITIVE_JSON_LD.has(type))) add("structured-data", 0.3)
    if (signals.readerEngine !== undefined) add("reader-engine", 0.3)
    if (looksLikeChapterUrl(signals.url)) add("chapter-url", 0.2)

    if (NEGATIVE_OG_TYPE.test(ogType)) add("non-reader-og-type", -0.5)
    if (jsonLd.some(type => NEGATIVE_JSON_LD.has(type))) add("non-reader-structured-data", -0.5)
    if (isNonReaderHost(signals.url)) add("non-reader-host", -0.5)

    return { score: Math.max(0, Math.round(score * 100) / 100), signals: fired }
}

// Cheap content check that a page is a reader. A wiki, podcast or news page whose URL merely contains
// "chapter-3" or "episode-12" scores below the badge threshold.
export function looksLikeReaderPage(signals: CaptureSignals): boolean {
    return scoreReaderPage(signals).score >= BADGE_THRESHOLD
}

// The hosts a drafted profile covers. An apex host (reader.example) also covers its www twin, so a
// site added from one form keeps matching the other; a www host or a deeper subdomain covers only
// itself. Both stay inside the profile's own origin, which is what the scope check requires.
const SECOND_LEVEL_SUFFIX = /^(?:co|com|org|net|ac|gov|edu)$/i

function isApexHost(host: string): boolean {
    const labels = host.split(".")
    if (labels.length === 2) return true
    return labels.length === 3 && labels[2]!.length === 2 && SECOND_LEVEL_SUFFIX.test(labels[1]!)
}

function hostsFor(host: string): string[] {
    if (!host) return []
    return isApexHost(host) && !host.startsWith("www.") ? [host, `www.${host}`] : [host]
}

// "pt-BR" -> "pt". Anything that is not a plain 2-3 letter language tag falls back to English.
function languageOf(lang: string | undefined): string {
    const primary = lang?.trim().split(/[-_]/)[0]?.toLowerCase()
    return primary && /^[a-z]{2,3}$/.test(primary) ? primary : "en"
}

// Captured hrefs come from the page being inspected, so they are length-bounded before any pattern
// work touches them.
const MAX_LINK_LENGTH = 2048

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
    const numbered = links.filter(l => l.href.length <= MAX_LINK_LENGTH && /\d/.test(l.href))
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
    // Last number run, found in one linear pass (a lookahead-based "no digit after me" regex goes
    // cubic on a long digit run, and the href is attacker-controlled page content).
    const lastNum = [...sample.matchAll(/\d+(?:\.\d+)?/g)].pop()
    if (lastNum && lastNum.index !== undefined) {
        withNum = sample.slice(0, lastNum.index) + NUM + sample.slice(lastNum.index + lastNum[0].length)
    }
    const escaped = escapeRegex(withNum).replace(NUM, "(?<chapterNumber>[0-9.]+)")
    return `href="(?<chapterUrl>${escaped})"`
}

export function draftProfileFromSignals(signals: CaptureSignals): Record<string, unknown> {
    return baseDraft(signals, guessListPattern(signals.links))
}

function baseDraft(signals: CaptureSignals, listPattern: string | undefined): Record<string, unknown> {
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

    // Only a plain https origin on the default port widens to the apex/www pair; anything else keeps
    // exactly the host it was captured on.
    const widened = origin !== "" && origin === `https://${host}`
    const hosts = widened ? hostsFor(host) : host ? [host] : []

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
        domains: hosts.length > 0 ? hosts : ["example.com"],
        languages: [languageOf(signals.lang)],
        capabilities: ["chapters", "manga"],
        requestRateLimit: { requests: 3, intervalMs: 1000 },
        origins: widened ? hosts.map(h => `https://${h}/*`) : origin ? [`${origin}/*`] : ["https://example.com/*"],
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

// A chapter number is bounded, and "10-5" / "10_5" is the decimal 10.5 (the engine normalizes it), so a
// numeric dash suffix is part of the number and never a pinned literal suffix.
const NUMBER = "[0-9]{1,6}(?:[._-][0-9]{1,6})?"
const CHAPTER_WORD = "(?:chapter|chap|ch|episode|ep|issue)"
const CHAPTER_SEGMENT = new RegExp(
    `^(?<lead>(?:[^/]*[-_])?)(?<kw>${CHAPTER_WORD}[-_.]*)(?<num>\\d{1,6}(?:[._-]\\d{1,6})?)(?<post>(?:[-_][^/]*)?)$`,
    "i"
)
const CHAPTER_KEYWORD_SEGMENT = /^(?:chapter|chap|ch|episode|ep)$/i
const NUMERIC_SEGMENT = /^\d{1,6}(?:[._-]\d{1,6})?$/
// A bare integer segment longer than a chapter number can be (7-12 digits) is an internal chapter id,
// as in "/title/{slug}/chapter/9475194".
const LONG_ID_SEGMENT = /^\d{7,12}$/
const OPAQUE_ID = "[0-9]{1,12}"
// Path areas that hold "chapter-3" / "episode-12" / "issue-12" style pages which are not manga or
// comic readers (wiki articles, podcasts, TV, news, blogs, ...). A path under one is never drafted.
const NON_READER_SEGMENT =
    /^(?:wiki|wikis|news|blog|blogs|article|articles|podcast|podcasts|tv|television|video|videos|watch|movie|movies|film|films|radio|music|album|albums|forum|forums|topic|topics|thread|threads|docs|doc|help|support|course|courses|lesson|lessons|tutorial|tutorials|learn)$/i

export type ChapterShape = {
    // Path regexes: for `chapterMatch`, group 1 is the series slug and group 2 the chapter number.
    chapterMatch: string
    mangaMatch: string
    // Series URL template, e.g. "/manga/{slug}".
    seriesTemplate: string
    // Global item pattern for the series page. Carries a literal `{slug}` token the engine fills
    // with the series' own slug, so a sidebar of other titles' chapters is never swept in.
    itemPattern: string
    // The same chapter links as `itemPattern`, but capturing the visible anchor text as `chapterText`
    // instead of a number from the href. For sites whose URL carries only an internal chapter id.
    itemTextPattern: string
    // True when the URL's chapter segment is an internal id (an integer at or above OPAQUE_ID_MIN), not
    // a chapter number, so the real number has to come from the page text.
    opaqueId: boolean
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
    let opaqueId = false

    for (let ci = segs.length - 1; ci >= 1 && slugIdx < 0; ci--) {
        const m = CHAPTER_SEGMENT.exec(segs[ci]!)
        if (!m?.groups || CHAPTER_SEGMENT.test(segs[ci - 1]!)) continue
        const { lead, kw, post, num: rawNum } = m.groups as { lead: string; kw: string; post: string; num: string }
        opaqueId = Number.parseFloat(rawNum.replace(/[_-]/, ".")) >= OPAQUE_ID_MIN
        // A series-name lead ("one-piece-chapter-12") stays generic so it matches every series.
        const piece = (num: string): string =>
            `${lead ? "[^/\"'<>]*[-_]" : ""}${escapeRegex(kw)}${num}${escapeRegex(post)}`
        slugIdx = ci - 1
        chapterPieces = [piece(`(${NUMBER})`)]
        itemChapterPieces = [piece(`(?<chapterNumber>${NUMBER})`)]
        tail = segs.slice(ci + 1)
    }
    if (slugIdx < 0) {
        for (let k = segs.length - 2; k >= 1 && slugIdx < 0; k--) {
            if (!CHAPTER_KEYWORD_SEGMENT.test(segs[k]!)) continue
            const idSegment = segs[k + 1]!
            const longId = LONG_ID_SEGMENT.test(idSegment)
            if (!longId && !NUMERIC_SEGMENT.test(idSegment)) continue
            slugIdx = k - 1
            opaqueId = longId || Number.parseFloat(idSegment.replace(/[_-]/, ".")) >= OPAQUE_ID_MIN
            const idPattern = opaqueId ? OPAQUE_ID : NUMBER
            chapterPieces = [escapeRegex(segs[k]!), `(${idPattern})`]
            itemChapterPieces = [escapeRegex(segs[k]!), `(?<chapterNumber>${idPattern})`]
            tail = segs.slice(k + 2)
        }
    }
    if (slugIdx < 0 || tail.length > 2) return undefined

    const slug = segs[slugIdx]!
    const prefix = segs.slice(0, slugIdx)
    if (NON_READER_SEGMENT.test(slug) || prefix.some(seg => NON_READER_SEGMENT.test(seg))) return undefined
    const prefixRegex = prefix.map(escapeRegex)
    const tailRegex = tail.map(escapeRegex)
    const chapterPath = [...prefixRegex, "([^/]+)", ...chapterPieces, ...tailRegex].join("/")
    const itemPath = [...prefixRegex, "{slug}", ...itemChapterPieces, ...tailRegex].join("/")
    const itemUrl = (path: string): string => `(?<chapterUrl>(?:(?:https?:)?//[^"'/]+)?/${path}/?)`
    // The number group becomes non-capturing: the visible anchor text is the number source here. One
    // optional wrapper tag (a <span> inside the <a>) is tolerated before the text.
    const itemTextPath = itemPath.replace("(?<chapterNumber>", "(?:")
    return {
        chapterMatch: `^/${chapterPath}/?$`,
        mangaMatch: `^/${[...prefixRegex, "([^/]+)"].join("/")}/?$`,
        seriesTemplate: `/${[...prefix, "{slug}"].join("/")}`,
        itemPattern: `href=["']${itemUrl(itemPath)}["']`,
        itemTextPattern: `<a\\b[^>]*?href=["']${itemUrl(itemTextPath)}["'][^>]*>(?:\\s*<[^>]{1,100}>)?\\s*(?<chapterText>[^<]{1,80})`,
        opaqueId,
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
    // Skip a second-level registry label (foo.co.uk -> "foo", not "Co").
    const registrable =
        labels.length > 2 &&
        labels[labels.length - 1]!.length === 2 &&
        SECOND_LEVEL_SUFFIX.test(labels[labels.length - 2]!)
            ? labels.length - 3
            : labels.length - 2
    const label = labels.length > 1 ? labels[registrable]! : labels[0]!
    return titleCase(label) || host || "My Source"
}

export type ChapterDraft = {
    profile: Record<string, unknown>
    // A concrete series page URL for the current chapter's series, used to health-check the draft.
    seriesUrl: string
    // False when the page's own links do not corroborate the derived chapter shape.
    matchOk: boolean
}

// A chapter label rather than a bare number: page titles routinely end in a number that is not a
// chapter ("Mob Psycho 100"), so the title is only trusted when it names a chapter.
const LABELLED_CHAPTER = /(?:\b(?:chapter|chap|ch|episode|ep|issue|no|vol(?:ume)?)\b\.?\s*|#\s*)\d/i

function pathOf(href: string, base: URL): string | undefined {
    try {
        return new URL(href, base).pathname.replace(/\/+$/, "")
    } catch {
        return undefined
    }
}

function opaqueIdLength(url: URL, shape: ChapterShape): number {
    return new RegExp(shape.chapterMatch).exec(url.pathname)?.[2]?.length ?? 0
}

// Where a readable chapter number can come from on a page whose URL has only an internal id, and what
// kind of numbering the site's labels use. Undefined when no source yields a number.
function textNumbering(
    signals: CaptureSignals,
    url: URL,
    shape: ChapterShape
): { source: "text" | "title"; kind: ChapterLabelKind } | undefined {
    const here = url.pathname.replace(/\/+$/, "")
    const own = signals.links.find(
        l =>
            l.href.length <= MAX_LINK_LENGTH &&
            pathOf(l.href, url) === here &&
            parseChapterLabel(l.text).number !== undefined
    )
    const active = signals.activeChapterText
    const activeNumbered = active !== undefined && parseChapterLabel(active).number !== undefined
    const title = signals.docTitle
    const titleNumbered =
        title !== undefined && LABELLED_CHAPTER.test(title) && parseChapterLabel(title).number !== undefined
    if (!own && !activeNumbered && !titleNumbered) return undefined

    // The dominant label kind across the page's own chapter links decides the numbering kind.
    const corroborate = new RegExp(shape.itemPattern.replace("{slug}", () => slugPattern(shape.slug)))
    const counts = new Map<ChapterLabelKind, number>()
    const tally = (text: string): void => {
        const label = parseChapterLabel(text)
        if (label.number !== undefined) counts.set(label.kind, (counts.get(label.kind) ?? 0) + 1)
    }
    for (const l of signals.links) {
        if (l.href.length <= MAX_LINK_LENGTH && corroborate.test(`href="${l.href}"`)) tally(l.text)
    }
    if (active !== undefined) tally(active)
    if (title !== undefined && titleNumbered) tally(title)
    let kind: ChapterLabelKind = "chapter"
    let best = 0
    for (const [candidate, n] of counts) {
        if (n > best) {
            best = n
            kind = candidate
        }
    }
    return { source: own || activeNumbered ? "text" : "title", kind }
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

    // When the URL carries only an internal chapter id, the chapter number has to come from the page
    // text. A site that offers no readable number at all is not drafted if its id is too long to ever
    // have been a chapter number (nothing sensible could be stored); a short id keeps the URL reading.
    const text = shape.opaqueId ? textNumbering(signals, url, shape) : undefined
    if (shape.opaqueId && !text && opaqueIdLength(url, shape) > 6) return undefined

    // The chapter-page list pattern comes from the URL shape, so the link-based guess is skipped.
    const base = baseDraft(signals, undefined)
    const profile = {
        ...base,
        name: siteDisplayName(signals, url.hostname),
        match: { manga: shape.mangaMatch, chapter: shape.chapterMatch },
        series: { ...(base["series"] as Record<string, unknown>), urlTemplate: shape.seriesTemplate },
        list: text
            ? { itemPattern: shape.itemPattern, itemTextPattern: shape.itemTextPattern }
            : { itemPattern: shape.itemPattern },
        ...(text ? { numberSource: text.source, numberingKind: text.kind } : {})
    }
    // Function replacers: a slug taken from the URL path can contain "$&" / "$'" (legal in a path),
    // which a string replacement would expand instead of inserting literally.
    const seriesUrl = new URL(
        shape.seriesTemplate.replace("{slug}", () => shape.slug),
        url.origin
    ).toString()
    const corroborate = new RegExp(shape.itemPattern.replace("{slug}", () => slugPattern(shape.slug)))
    const matchOk =
        signals.links.length === 0 ||
        signals.links.some(l => l.href.length <= MAX_LINK_LENGTH && corroborate.test(`href="${l.href}"`))
    return { profile, seriesUrl, matchOk }
}
