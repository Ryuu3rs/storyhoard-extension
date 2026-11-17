// A catalog cover is an <img> on the extension's page. On a host the extension holds a permission for, the
// session rule in background/cover-cookies.ts removes the image host's cookies. On any other host the
// browser will not apply that rule, so the image loads in CORS mode without credentials instead: no cookie
// goes, and the cover shows only if its server allows it.

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

export function coverCrossOrigin(src: string, permittedOrigins: readonly string[]): "anonymous" | undefined {
    let url: URL
    try {
        url = new URL(src)
    } catch {
        return undefined
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
    return permittedOrigins.some(pattern => patternMatches(pattern, url)) ? undefined : "anonymous"
}
