// ARCHITECTURE TRACK A - experimental.
//
// Turn DOM signals captured from the current tab into a DRAFT Site Profile. This is the
// inference core of the no-code "capture from this tab" builder: it fills the reliable fields
// (origin, domains, title/cover patterns) exactly, and makes a best-effort guess at the
// list/pages patterns. The result is a starting point the user reviews and the import-time
// health-check validates - it is not expected to be perfect, just close.

export type CaptureSignals = {
    url: string
    ogTitle?: string
    ogImage?: string
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
function dominantImageHost(images: string[]): string | undefined {
    const counts = new Map<string, number>()
    for (const url of images) {
        try {
            const host = new URL(url).host
            counts.set(host, (counts.get(host) ?? 0) + 1)
        } catch {
            // skip relative/invalid
        }
    }
    let best: string | undefined
    let bestN = 0
    for (const [host, n] of counts) {
        if (n > bestN) {
            best = host
            bestN = n
        }
    }
    return best
}

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
    const imgHost = dominantImageHost(signals.images)
    const imagePatterns = imgHost
        ? [`<img[^>]+(?:src|data-url)="(?<url>https?://${escapeRegex(imgHost)}/[^"]+)"`]
        : ['<img[^>]+src="(?<url>https?://[^"]+\\.(?:jpg|jpeg|png|webp)[^"]*)"']

    return {
        profileFormat: 1,
        id,
        name,
        engine: "generic",
        origin: origin || "https://example.com",
        domains: host ? [host] : ["example.com"],
        languages: ["en"],
        capabilities: ["pages", "chapters", "manga"],
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
        list: { itemPattern: listPattern ?? 'href="(?<chapterUrl>REPLACE_(?<chapterNumber>[0-9.]+))"' },
        pages: { imagePatterns }
    }
}
