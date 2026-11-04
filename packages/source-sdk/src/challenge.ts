// Recognising a bot challenge from the response alone. Nothing here is keyed on a site: the same rules
// apply to every source, bundled or user-added. Detection only ever classifies a response. It never
// attempts to answer the challenge.

export type ChallengeReason = "header" | "path" | "html-for-json" | "marker"

// Challenge pages carry their markers near the top, so a large real page is never scanned whole.
const SCAN_LIMIT = 128 * 1024

// Markers that only a challenge page itself carries, safe to trust on a 200 response. A site behind
// Cloudflare gets `/cdn-cgi/challenge-platform/scripts/jsd/` injected into ordinary pages, so that path
// is deliberately not here.
const CHALLENGE_PAGE = [
    /<title[^>]*>\s*(?:just a moment|attention required|checking your browser|verifying you are human|ddos-guard)/i,
    /^\s*just a moment/i,
    /id=["']challenge-(?:running|error-text|form|stage)["']/i,
    /_cf_chl_opt|__cf_chl_|cf-browser-verification/i,
    /bot challenge not passed/i
]

// Weaker hints, only meaningful on a response that was already refused, or to keep polling a tab that
// may still be mid-challenge.
const CHALLENGE_HINT =
    /challenge-platform\/(?!scripts\/jsd)|cf-turnstile|cf_chl|ddos-guard\.net|just a moment\.\.\.|attention required|checking your browser|verify(?:ing)? you are (?:a )?human|sgcaptcha|captcha-delivery/i

export function isChallengePage(html: string): boolean {
    const head = html.slice(0, SCAN_LIMIT)
    return CHALLENGE_PAGE.some(marker => marker.test(head))
}

export function hasChallengeMarker(html: string): boolean {
    return isChallengePage(html) || CHALLENGE_HINT.test(html.slice(0, SCAN_LIMIT))
}

const CHALLENGE_SEGMENTS = new Set(["challenge", "challenges", "captcha", "bot-check", "botcheck", "human-check"])
// A slug under one of these is a title or a listing that happens to use the word, not an interstitial.
const CATALOG_PARENTS = new Set([
    "author",
    "book",
    "books",
    "category",
    "chapter",
    "comic",
    "comics",
    "genre",
    "genres",
    "manga",
    "manhua",
    "manhwa",
    "novel",
    "novels",
    "read",
    "search",
    "series",
    "tag",
    "tags",
    "title",
    "titles",
    "webtoon",
    "webtoons"
])

export function isChallengePath(pathname: string): boolean {
    const segments = pathname.toLowerCase().split("/").filter(Boolean)
    if (segments.some(segment => segment === "challenge-platform" || segment.startsWith("__cf_chl"))) return true
    return segments.slice(0, 2).some((segment, index) => {
        if (!CHALLENGE_SEGMENTS.has(segment)) return false
        const parent = segments[index - 1]
        return parent === undefined || !CATALOG_PARENTS.has(parent)
    })
}

function hasChallengeHeader(headers: Readonly<Record<string, string>> | undefined): boolean {
    if (!headers) return false
    if (headers["cf-mitigated"]?.toLowerCase() === "challenge") return true
    const waf = headers["x-amzn-waf-action"]?.toLowerCase()
    return waf === "challenge" || waf === "captcha"
}

// What can be decided before reading the body: a challenge response header, or a redirect onto a
// challenge path. A request for a path that already looks like that (a title slugged "challenge") is
// not a redirect onto an interstitial.
export function detectChallengeBeforeBody(input: {
    requestUrl: URL
    finalUrl?: URL | undefined
    headers?: Readonly<Record<string, string>> | undefined
}): ChallengeReason | undefined {
    if (hasChallengeHeader(input.headers)) return "header"
    const { finalUrl, requestUrl } = input
    if (finalUrl && finalUrl.pathname !== requestUrl.pathname && isChallengePath(finalUrl.pathname)) {
        return isChallengePath(requestUrl.pathname) ? undefined : "path"
    }
    return undefined
}

// JSON is never scanned for markers: a title or a comment may well contain the word "challenge".
export function detectChallengeInBody(input: {
    status: number
    body: string
    expectJson: boolean
    headers?: Readonly<Record<string, string>> | undefined
}): ChallengeReason | undefined {
    const { status, body, expectJson } = input
    const type = input.headers?.["content-type"]?.toLowerCase() ?? ""
    if (/^\s*[{[]/.test(body) || type.includes("json")) return undefined
    if (status >= 200 && status < 300) {
        if (expectJson && (type.includes("text/html") || /^\s*<(?:!doctype|html|head|body)/i.test(body))) {
            return "html-for-json"
        }
        return isChallengePage(body) ? "marker" : undefined
    }
    if (status === 403 || status === 503) return hasChallengeMarker(body) ? "marker" : undefined
    return undefined
}
