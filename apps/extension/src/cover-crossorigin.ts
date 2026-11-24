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

// Catalog cover hosts that answer a browser with a bot check instead of the image. Their covers load through
// weeb.ltd's cover route, at display and fetch time only: the stored address stays the original.
export const PROXIED_COVER_HOSTS = ["uploads.mangadex.org"] as const

export function proxiedCoverUrl(raw: string, siteBase?: string): string
export function proxiedCoverUrl(raw: string | undefined, siteBase?: string): string | undefined
export function proxiedCoverUrl(raw: string | undefined, siteBase = SITE_BASE): string | undefined {
    if (raw === undefined) return raw
    let url: URL
    try {
        url = new URL(raw)
    } catch {
        return raw
    }
    if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return raw
    if (!(PROXIED_COVER_HOSTS as readonly string[]).includes(url.hostname)) return raw
    return `${siteBase}${CATALOG_COVER_PATH}?u=${encodeURIComponent(raw)}`
}

// For a library cover as shown (after proxiedCoverUrl). A catalog cover takes the Discover rule; a cover from a
// site the user follows loads with no crossorigin mode, as before, since some of those hosts need their cookies.
export function libraryCoverMode(
    src: string | undefined,
    permittedOrigins: readonly string[],
    siteBase = SITE_BASE
): "anonymous" | undefined {
    if (!src) return undefined
    let url: URL
    try {
        url = new URL(src)
    } catch {
        return undefined
    }
    return isCatalogCoverUrl(url, siteBase) ? coverCrossOrigin(src, permittedOrigins, siteBase) : undefined
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
