import { isPublicHttpsUrl } from "@amr/source-sdk"

const MAX_COVER_BYTES = 2 * 1024 * 1024

function isPublicCoverUrl(raw: string): boolean {
    try {
        return isPublicHttpsUrl(new URL(raw))
    } catch {
        return false
    }
}

// Fetch a remote cover and return it as a Blob for caching in the covers table
// (see cacheCover in ../database). Reuses the size/content-type guard that used
// to gate inlineCover's base64 encoding, minus the encoding step itself - covers
// are cached as Blobs now, never inlined as data: URIs into coverUrl.
// Returns undefined on any failure so callers can treat this as best-effort.
export async function fetchCoverBlob(url: string): Promise<Blob | undefined> {
    // A cover URL can come out of a regex over untrusted page HTML. Only a public https URL is ever
    // fetched (never http, loopback, a private-network address or an IP literal), and the host it
    // finally lands on after redirects must pass the same test. The browser fetch API hides the
    // redirect hops, so the final URL is checked before the body is read.
    if (!isPublicCoverUrl(url)) return undefined
    try {
        // Note: `Referer` is a forbidden header name per the fetch spec, so a
        // service-worker fetch can never set it - Naver's pstatic.net CDN (which
        // serves Webtoons covers) has been verified to serve images fine without
        // one, so no header is needed here.
        const res = await fetch(url, { credentials: "omit" })
        if (!res.ok) return undefined
        if (res.url && !isPublicCoverUrl(res.url)) return undefined
        const blob = await res.blob()
        if (blob.size === 0 || blob.size > MAX_COVER_BYTES || !blob.type.startsWith("image/")) return undefined
        return blob
    } catch {
        return undefined
    }
}
