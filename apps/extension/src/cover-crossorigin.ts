import { SITE_BASE } from "./account"

// The cover hosts the extension itself names for catalog covers. The session rule in
// background/cover-cookies.ts removes their cookies from the extension's own image loads; images from any
// other host, such as the sites the user follows, keep theirs, because some of those hosts need them.
export const CATALOG_COVER_HOSTS = ["s4.anilist.co", "cdn.myanimelist.net", "uploads.mangadex.org"] as const
export const CATALOG_COVER_PATH = "/api/cover"

export function isCatalogCoverUrl(url: URL, siteBase = SITE_BASE): boolean {
    if (url.protocol !== "https:") return false
    if ((CATALOG_COVER_HOSTS as readonly string[]).includes(url.hostname)) return true
    const site = new URL(siteBase)
    return url.origin === site.origin && url.pathname.startsWith(CATALOG_COVER_PATH)
}

function patternMatches(pattern: string, url: URL): boolean {
    if (pattern === "<all_urls>") return true
    const match = /^(\*|https?):\/\/([^/]+)\//.exec(pattern)
    if (!match) return false
    const [, scheme, host] = match
    if (scheme === "*" ? !/^https?:$/.test(url.protocol) : url.protocol !== `${scheme}:`) return false
    if (host === "*") return true
    if (host!.startsWith("*.")) {
        const base = host!.slice(2)
        return url.hostname === base || url.hostname.endsWith(`.${base}`)
    }
    return url.hostname === host
}

// For a Discover or search cover. The browser applies the cookie rule only on a catalog cover host the
// extension holds a permission for; any other cover loads in CORS mode without credentials instead, so no
// cookie goes, and the cover shows only if its server allows it.
export function coverCrossOrigin(
    src: string,
    permittedOrigins: readonly string[],
    siteBase = SITE_BASE
): "anonymous" | undefined {
    let url: URL
    try {
        url = new URL(src)
    } catch {
        return undefined
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
    const ruleApplies =
        isCatalogCoverUrl(url, siteBase) && permittedOrigins.some(pattern => patternMatches(pattern, url))
    return ruleApplies ? undefined : "anonymous"
}
