import { isPublicHttpsUrl } from "@amr/source-sdk"

const MAX_COVER_BYTES = 2 * 1024 * 1024
const COVER_TIMEOUT_MS = 15_000

function isPublicCoverUrl(raw: string): boolean {
    try {
        return isPublicHttpsUrl(new URL(raw))
    } catch {
        return false
    }
}

// Read at most MAX_COVER_BYTES of the body, stopping (and cancelling the transfer) the moment it is
// exceeded, so a hostile host cannot make the worker buffer an unbounded response. A response that
// exposes no stream (test fakes, exotic environments) falls back to blob() with a post-read cap.
async function readBoundedBlob(res: Response): Promise<Blob | undefined> {
    const declared = Number(res.headers?.get?.("content-length"))
    if (Number.isFinite(declared) && declared > MAX_COVER_BYTES) {
        await res.body?.cancel().catch(() => undefined)
        return undefined
    }
    const stream = res.body
    if (!stream || typeof stream.getReader !== "function") {
        const blob = await res.blob()
        return blob.size > MAX_COVER_BYTES ? undefined : blob
    }
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_COVER_BYTES) {
            await reader.cancel().catch(() => undefined)
            return undefined
        }
        chunks.push(value)
    }
    return new Blob(chunks as BlobPart[], { type: res.headers?.get?.("content-type")?.split(";")[0]?.trim() ?? "" })
}

// Fetch a remote cover and return it as a Blob for caching in the covers table
// (see cacheCover in ../database). Reuses the size/content-type guard that used
// to gate inlineCover's base64 encoding, minus the encoding step itself - covers
// are cached as Blobs now, never inlined as data: URIs into coverUrl.
// Returns undefined on any failure so callers can treat this as best-effort.
// The body is read under a size cap and a timeout, never as one unbounded blob().
export async function fetchCoverBlob(url: string): Promise<Blob | undefined> {
    // A cover URL can come out of a regex over untrusted page HTML. Only a public https URL is ever
    // fetched (never http, loopback, a private-network address or an IP literal), and the host it
    // finally lands on after redirects must pass the same test. The browser fetch API hides the
    // redirect hops, so the final URL is checked before the body is read.
    if (!isPublicCoverUrl(url)) return undefined
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), COVER_TIMEOUT_MS)
    try {
        // Note: `Referer` is a forbidden header name per the fetch spec, so a
        // service-worker fetch can never set it - Naver's pstatic.net CDN (which
        // serves Webtoons covers) has been verified to serve images fine without
        // one, so no header is needed here.
        const res = await fetch(url, { credentials: "omit", signal: controller.signal })
        if (!res.ok) return undefined
        if (res.url && !isPublicCoverUrl(res.url)) return undefined
        const blob = await readBoundedBlob(res)
        if (!blob || blob.size === 0 || blob.size > MAX_COVER_BYTES || !blob.type.startsWith("image/")) return undefined
        return blob
    } catch {
        return undefined
    } finally {
        clearTimeout(timer)
    }
}
