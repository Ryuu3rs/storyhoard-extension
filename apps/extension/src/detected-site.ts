// A reader page the user has not followed, recognised from the shape of its own address. Nothing here
// is stored, registered or fetched: it is a pure matcher derived from one chapter URL, used to check
// that the chapter links the user's own page shows belong to the same site and the same title. It is
// what lets passive tracking work on a site that has no registered source.

import { deriveChapterShape, isNonReaderHost } from "@amr/source-engine"
import type { SourcePageMatch } from "@amr/source-sdk"
import { isAddableUrl } from "./source-scope"

// Rows tracked on a detected site are filed under this namespace. The namespace is what keeps them
// tracking-only: no source is ever registered under it, so nothing fetches for it in the background.
export const DETECTED_SOURCE_PREFIX = "detected:"

// Longest path the matcher will test. Links come from the page, so they are length-bounded first.
const MAX_PATH_LENGTH = 2048

export type DetectedPage = {
    // "detected:<host without www>", the id this site's tracked titles are filed under.
    sourceId: string
    // The series slug read from the chapter URL.
    sourceMangaId: string
    // The series page address, built from the URL shape.
    mangaUrl: string
    // The page's own origin and its www/apex twin, as host patterns.
    allowedOrigins: string[]
    match: (url: URL) => SourcePageMatch
    // The series slug a chapter URL belongs to, or undefined when it is not a chapter of this shape.
    ownerOf: (url: URL) => string | undefined
    // False when the chapter segment is an internal id, so the number can only come from the page text.
    numberFromUrl: boolean
}

export function isDetectedSourceId(sourceId: string): boolean {
    return sourceId.startsWith(DETECTED_SOURCE_PREFIX)
}

// The registered source id a followed site gets, which is also what a detected site's id is built
// from, so promoting a detected site files its titles under the id the follow will create.
export function siteIdForHost(host: string): string {
    return (
        host
            .toLowerCase()
            .replace(/^www\./, "")
            .replace(/[^a-z0-9.-]/g, "-") || "site"
    )
}

export function detectedSourceIdFor(host: string): string {
    return `${DETECTED_SOURCE_PREFIX}${siteIdForHost(host)}`
}

function twinHost(host: string): string {
    return host.startsWith("www.") ? host.slice(4) : `www.${host}`
}

// Derive the matcher from a chapter URL. Undefined when the page is not one the extension may observe
// (not a public https site, one of the extension's own or already-supported hosts, a known non-reader
// site) or when the address does not look like "<prefix>/<series>/<chapter>". deriveChapterShape also
// refuses paths under wiki, news, podcast, forum and similar segments.
export function detectedPageFor(rawUrl: string): DetectedPage | undefined {
    let url: URL
    try {
        url = new URL(rawUrl)
    } catch {
        return undefined
    }
    if (!isAddableUrl(url) || isNonReaderHost(url.toString())) return undefined
    const shape = deriveChapterShape(url.pathname)
    if (!shape) return undefined

    const host = url.hostname.toLowerCase()
    const hosts = new Set([host, twinHost(host)])
    const allowedOrigins = [...hosts].map(h => `https://${h}/*`)
    const chapterPath = new RegExp(shape.chapterMatch)
    const mangaPath = new RegExp(shape.mangaMatch)
    const ownOrigin = (candidate: URL): boolean => candidate.protocol === "https:" && hosts.has(candidate.hostname)

    const ownerOf = (candidate: URL): string | undefined => {
        if (!ownOrigin(candidate) || candidate.pathname.length > MAX_PATH_LENGTH) return undefined
        return chapterPath.exec(candidate.pathname)?.[1]
    }
    const mangaUrl = new URL(
        shape.seriesTemplate.replace("{slug}", () => shape.slug),
        url.origin
    ).toString()

    return {
        sourceId: detectedSourceIdFor(host),
        sourceMangaId: shape.slug,
        mangaUrl,
        allowedOrigins,
        match: candidate => {
            if (!ownOrigin(candidate) || candidate.pathname.length > MAX_PATH_LENGTH) return "none"
            if (chapterPath.test(candidate.pathname)) return "chapter"
            return mangaPath.test(candidate.pathname) ? "manga" : "none"
        },
        ownerOf,
        numberFromUrl: !shape.opaqueId
    }
}
