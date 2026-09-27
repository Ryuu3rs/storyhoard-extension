// Manual "Find source" resolve+adopt wiring for a single library entry (slice 3 of
// the tracker-first source resolver). These are the pure request builders and the
// gate that decides which library rows get offered the flow - the Svelte component
// (entrypoints/app/FindSource.svelte) only orchestrates them across the message
// boundary. Adoption reuses the existing library:switch primitive unchanged, so
// switchMangaSource still does the in-place partial update that preserves
// workId/rating/categories/notes/progress and remaps the read chapter by number.

import type { MangaSearchResult } from "./sources"
import type { RuntimeRequest } from "./runtime"

type SourceResolveRequest = Extract<RuntimeRequest, { type: "source:resolve" }>
type LibrarySwitchRequest = Extract<RuntimeRequest, { type: "library:switch" }>

// A library entry has no live readable source the user can open - it exists only as
// tracking metadata (a synthetic anilist.co/import row from a tracker import or a
// read-only Discover add) or its stored source is a dead hostname-style import that
// update checks can't reach (manualTracking + a dotted sourceId, matching the broken-
// link panel's own rule). Rows with a real adapter source id (no dot, e.g. "mangadex")
// are excluded unless the caller flags them as needing a relink. Manual only: this
// just decides whether to OFFER the flow, never acts on its own.
export function entryNeedsSource(manga: { sourceId: string; manualTracking?: boolean }, needsRelink = false): boolean {
    if (needsRelink) return true
    if (manga.sourceId === "anilist.co" || manga.sourceId === "import") return true
    return Boolean(manga.manualTracking) && manga.sourceId.includes(".")
}

// Build the read-only source:resolve request for a library entry, tracker-first: an
// AniList id (when the row carries one) lets the resolver derive tracker-authoritative
// Latin title variants lazily through the metadata chain; searchTitles passes any
// variants the caller already holds so that derivation is skipped; title is the always-
// present fallback query. Variants are trimmed and de-duped into a fresh plain array so
// nothing reactive crosses the runtime message boundary.
export function buildResolveRequest(
    manga: { title: string; anilistId?: number },
    searchTitles?: readonly string[]
): SourceResolveRequest {
    const variants = [...new Set((searchTitles ?? []).map(t => t.trim()).filter(Boolean))]
    return {
        type: "source:resolve",
        title: manga.title,
        ...(manga.anilistId !== undefined ? { anilistId: manga.anilistId } : {}),
        ...(variants.length > 0 ? { searchTitles: variants } : {})
    }
}

// Build the library:switch adopt request that repoints an entry at a chosen live-source
// candidate. This is the existing switch primitive, unchanged - switchMangaSource does
// the in-place partial update (preserving workId/rating/categories/notes/progress and
// remapping the read chapter by number), so no data is lost. allowTabFallback mirrors
// the manual mirror-switch path: a user-initiated pick may open a tab to clear a bot-
// block on the series page; the background auto-resolve pass passes false so it never
// opens a tab (same rule as the auto-link sweep). Reads only primitive fields into a
// fresh plain object, so a candidate held in $state never leaks a proxy across the
// message boundary.
export function buildAdoptRequest(
    mangaId: string,
    candidate: { sourceId: string; sourceMangaId: string; url: string },
    allowTabFallback = true
): LibrarySwitchRequest {
    return {
        type: "library:switch",
        mangaId,
        sourceId: candidate.sourceId,
        sourceMangaId: candidate.sourceMangaId,
        mangaUrl: candidate.url,
        allowTabFallback
    }
}

export type { MangaSearchResult }
