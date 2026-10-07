import type { MangaRecord, SourceLinkRecord } from "@amr/contracts"
import {
    createBoundedRequestClient,
    type ResolveMangaInput,
    type SourceContext,
    type SourceManga,
    type SourceSearchResult
} from "@amr/source-sdk"
import { sourceRegistry } from "@amr/sources"
import type { LibraryManga } from "./database"
import { diag } from "./diag-log"
import { SOURCE_ORIGINS, sourceOrigins } from "./permissions"

export function findSource(url: URL) {
    return sourceRegistry.match(url)
}

export function getSourceById(sourceId: string) {
    return sourceRegistry.get(sourceId)
}

// The ids of every registered source whose manifest declares the "pages" capability.
// Used as a rankCandidates tie-break (a source that can serve pages in-app ranks
// above a chapters-only mirror). Computed from the registry so background-context
// callers don't need to round-trip through the sources:list message.
export function getPagesCapableSourceIds(): Set<string> {
    return new Set(
        sourceRegistry
            .list()
            .filter(adapter => adapter.manifest.capabilities.includes("pages"))
            .map(adapter => adapter.manifest.id)
    )
}

export const wrapFetch = (requestUrl: string, init: Parameters<typeof fetch>[1]) =>
    fetch(requestUrl, init).then(r => ({
        ok: r.ok,
        status: r.status,
        url: r.url,
        // Pass headers + the raw body stream so the bounded client can reject an over-cap
        // Content-Length up front and read the body incrementally (aborting past the byte cap)
        // instead of buffering an unbounded response whole. text() stays as the fallback.
        // Guarded because a real Response always carries these but a stubbed fetch may not.
        ...(r.headers ? { headers: Object.fromEntries(r.headers) as Readonly<Record<string, string>> } : {}),
        ...(r.body ? { body: r.body } : {}),
        text: () => r.text()
    }))

// createSourceContext builds a fresh client PER OPERATION (per manga resolve, per
// chapter list, per cover fetch, etc.) so each operation gets its own independent
// requestCount/maxRequests budget - see request.ts's per-instance rate-limit throw.
// Without that, one source hit across many operations in a single service-worker
// lifetime (e.g. a checkUpdates pass over 10+ titles) would trip "request-limit"
// permanently for that source until the SW restarts.
//
// The response CACHE, however, is looked up per sourceId from this module-scope
// registry and threaded into each fresh client via options.cache, so operations
// against the same source that land seconds apart (e.g. resolveCover then
// resolveGenres fetching the identical manga-page HTML) share cached bodies
// instead of each paying a full network fetch. Only the cache is shared - the
// request-count budget is deliberately NOT shared (see request.ts's `cache` option
// comment).
const sourceResponseCaches = new Map<string, Map<string, { body: string; expiresAt: number }>>()

function getSourceResponseCache(sourceId: string): Map<string, { body: string; expiresAt: number }> {
    let cache = sourceResponseCaches.get(sourceId)
    if (!cache) {
        cache = new Map()
        sourceResponseCaches.set(sourceId, cache)
    }
    return cache
}

// overrides lets specific call paths (e.g. library:switch's chapter-list fetch,
// see listChaptersForSource) bound the timeout/retry budget tighter than the
// defaults below - every other caller of createSourceContext omits it and is
// completely unaffected.
// Request origins of a profile-backed source (user-added or seeded), keyed by the owning source id.
// A source with an entry here is a PROFILE source: it may reach only these origins, never the
// bundled SOURCE_ORIGINS list, so a profile cannot piggyback on host access granted to some other
// site. Bundled adapters have no entry and keep SOURCE_ORIGINS.
const extraSourceOrigins = new Map<string, readonly string[]>()

export function setExtraSourceOrigins(sourceId: string, origins: readonly string[]): void {
    extraSourceOrigins.set(sourceId, origins)
}

export function clearExtraSourceOrigins(sourceId: string): void {
    extraSourceOrigins.delete(sourceId)
}

// The origins a background tab opened for this source's pages may stay on: its own declared origins
// for a profile-backed (user-added or seeded) source, and undefined for a bundled one, whose pages
// may legitimately hop between the domains it rotates through.
export function tabOriginsForSource(sourceId: string): string[] | undefined {
    const own = extraSourceOrigins.get(sourceId)
    return own ? [...own] : undefined
}

// The request scope for a source. A profile source is confined to its own declared origins (and,
// as it is user-supplied, to public https destinations); a bundled adapter uses SOURCE_ORIGINS.
function requestScopeFor(sourceId: string): { allowedOrigins: readonly string[]; requirePublicHttps: boolean } {
    const own = extraSourceOrigins.get(sourceId)
    return own
        ? { allowedOrigins: own, requirePublicHttps: true }
        : { allowedOrigins: SOURCE_ORIGINS, requirePublicHttps: false }
}

function createSourceContext(
    sourceId: string,
    rateLimit?: { requests: number; intervalMs: number },
    overrides?: { timeoutMs?: number; maxRetries?: number }
): SourceContext {
    const request = createBoundedRequestClient({
        fetch: wrapFetch,
        // Pass every origin entry through as-is - exact origins like
        // "https://mangadex.org/*" and wildcard host patterns like
        // "*://*.mangafreak.me/*" are both understood natively by the bounded
        // request client's origin allowlist (see createOriginAllowlist in
        // request.ts), so nothing needs to be stripped or filtered out here.
        ...requestScopeFor(sourceId),
        maxRequests: 20,
        maxResponseBytes: 10 * 1024 * 1024,
        timeoutMs: overrides?.timeoutMs ?? 15_000,
        cacheTtlMs: 60_000,
        cache: getSourceResponseCache(sourceId),
        ...(rateLimit ? { rateLimit } : {}),
        ...(overrides?.maxRetries !== undefined ? { maxRetries: overrides.maxRetries } : {})
    })
    return {
        request,
        now: () => Date.now(),
        logger: {
            debug: (message, details) => console.debug(`[AMR source] ${message}`, details),
            warn: (message, details) => console.warn(`[AMR source] ${message}`, details)
        }
    }
}

// Resolve the canonical sourceMangaId from a manga page URL by delegating to
// the adapter. This handles sites like MangaDex where last path segment is an
// SEO slug, not the internal ID (/title/{uuid}/{slug} → returns the UUID).
// Falls back to last path segment for adapters that fail (e.g. CF-gated sites).
export async function resolveMangaUrl(url: URL): Promise<string> {
    const source = sourceRegistry.match(url)
    if (!source) throw new Error("No adapter for this URL")
    const result = await source.resolveManga(
        { url },
        createSourceContext(source.manifest.id, source.manifest.requestRateLimit)
    )
    if (!result.sourceMangaId) throw new Error("Adapter returned empty sourceMangaId")
    return result.sourceMangaId
}

export async function resolveCoverFor(manga: {
    sourceId: string
    sourceMangaId?: string
    mangaUrl?: string
}): Promise<string | undefined> {
    const source = sourceRegistry.get(manga.sourceId)
    if (!source?.resolveCover) return undefined
    const input: { sourceMangaId?: string; url?: URL } = {}
    if (manga.sourceMangaId) input.sourceMangaId = manga.sourceMangaId
    if (manga.mangaUrl) {
        try {
            input.url = new URL(manga.mangaUrl)
        } catch {
            // ignore malformed stored URL
        }
    }
    if (input.sourceMangaId === undefined && input.url === undefined) return undefined
    return source.resolveCover(input, createSourceContext(source.manifest.id, source.manifest.requestRateLimit))
}

// Fetch series-level metadata (title, cover) from the manga page. Used by the external-
// track path: when resolveChapter was blocked (CF gate / anti-scrape), the title falls
// back to a humanized slug with no cover. The manga page itself is often reachable even
// when the chapter page is not, so a best-effort resolveManga recovers the real
// title/cover. Genres are left to backfillMangaGenres. Returns undefined on any failure -
// callers keep the slug title.
export async function resolveMangaMetadata(manga: {
    sourceId: string
    sourceMangaId?: string
    mangaUrl?: string
}): Promise<{ title?: string; coverUrl?: string } | undefined> {
    const source = sourceRegistry.get(manga.sourceId)
    if (!source) return undefined
    const input: ResolveMangaInput = {}
    if (manga.sourceMangaId) input.sourceMangaId = manga.sourceMangaId
    if (manga.mangaUrl) {
        try {
            input.url = new URL(manga.mangaUrl)
        } catch {
            // ignore malformed stored URL
        }
    }
    if (input.sourceMangaId === undefined && input.url === undefined) return undefined
    try {
        const resolved = await source.resolveManga(
            input,
            createSourceContext(source.manifest.id, source.manifest.requestRateLimit)
        )
        return {
            ...(resolved.manga.title ? { title: resolved.manga.title } : {}),
            ...(resolved.manga.coverUrl ? { coverUrl: resolved.manga.coverUrl } : {})
        }
    } catch {
        return undefined
    }
}

export async function resolveGenresFor(manga: {
    sourceId: string
    sourceMangaId?: string
    mangaUrl?: string
}): Promise<string[]> {
    const source = sourceRegistry.get(manga.sourceId)
    if (!source?.resolveGenres) return []
    const input: { sourceMangaId?: string; url?: URL } = {}
    if (manga.sourceMangaId) input.sourceMangaId = manga.sourceMangaId
    if (manga.mangaUrl) {
        try {
            input.url = new URL(manga.mangaUrl)
        } catch {
            // ignore malformed stored URL
        }
    }
    if (input.sourceMangaId === undefined && input.url === undefined) return []
    try {
        return await source.resolveGenres(
            input,
            createSourceContext(source.manifest.id, source.manifest.requestRateLimit)
        )
    } catch {
        return []
    }
}

export async function resolveChapterUrl(url: string) {
    const parsedUrl = new URL(url)
    const source = findSource(parsedUrl)

    if (!source || source.match(parsedUrl) !== "chapter") {
        throw new Error(`This chapter is not supported (${parsedUrl.hostname}${parsedUrl.pathname})`)
    }

    return source.resolveChapter(
        { url: parsedUrl },
        createSourceContext(source.manifest.id, source.manifest.requestRateLimit)
    )
}

// Resolve a chapter using pre-fetched HTML (tab injection fallback for bot-blocked sites).
// The chapter URL is served from `html`; any secondary requests use a limited normal client.
export async function resolveChapterFromHtml(urlStr: string, html: string) {
    const parsedUrl = new URL(urlStr)
    const source = findSource(parsedUrl)
    if (!source || source.match(parsedUrl) !== "chapter") {
        throw new Error(`This chapter is not supported (${parsedUrl.hostname}${parsedUrl.pathname})`)
    }

    const fallbackClient = createBoundedRequestClient({
        fetch: wrapFetch,
        ...requestScopeFor(source.manifest.id),
        maxRequests: 5,
        maxResponseBytes: 5 * 1024 * 1024,
        timeoutMs: 15_000
    })

    const context: SourceContext = {
        request: {
            getText: async (url, opts) => {
                // Match on origin+pathname so adapters that append query params (e.g. Madara
                // appends ?style=list) still get the pre-fetched HTML instead of re-fetching.
                if (url.origin + url.pathname === parsedUrl.origin + parsedUrl.pathname) return html
                return fallbackClient.getText(url, opts)
            },
            getJson: (url, schema, opts) => fallbackClient.getJson(url, schema, opts),
            postForm: (url, params, opts) => fallbackClient.postForm(url, params, opts),
            postJson: (url, body, schema, opts) => fallbackClient.postJson(url, body, schema, opts)
        },
        now: () => Date.now(),
        logger: {
            debug: (message, details) => console.debug(`[AMR source tab] ${message}`, details),
            warn: (message, details) => console.warn(`[AMR source tab] ${message}`, details)
        }
    }

    return source.resolveChapter({ url: parsedUrl }, context)
}

// List chapters using pre-fetched HTML (tab injection fallback for bot-blocked
// sources) for the library:switch handler's chapter-list fetch. Mirrors
// resolveChapterFromHtml above - the manga URL is served from `html`; any
// secondary requests use a limited normal client.
//
// Assumes `mangaUrl` has the same origin+pathname as whatever URL the adapter's
// listChapters() actually fetches internally (e.g. kagane's series page) - if
// it doesn't, the HTML-serving match below silently misses and falls through
// to a real (likely-403ing) fetch via the fallback client.
export async function listChaptersFromSourceHtml(
    manga: LibraryManga,
    sourceId: string,
    sourceMangaId: string,
    mangaUrl: string,
    html: string
) {
    const source = sourceRegistry.get(sourceId)
    if (!source) throw new Error("That source is not supported")
    const parsedUrl = new URL(mangaUrl)

    const fallbackClient = createBoundedRequestClient({
        fetch: wrapFetch,
        ...requestScopeFor(sourceId),
        maxRequests: 5,
        maxResponseBytes: 5 * 1024 * 1024,
        timeoutMs: 15_000
    })

    const context: SourceContext = {
        request: {
            getText: async (url, opts) => {
                if (url.origin + url.pathname === parsedUrl.origin + parsedUrl.pathname) return html
                return fallbackClient.getText(url, opts)
            },
            getJson: (url, schema, opts) => fallbackClient.getJson(url, schema, opts),
            postForm: (url, params, opts) => fallbackClient.postForm(url, params, opts),
            postJson: (url, body, schema, opts) => fallbackClient.postJson(url, body, schema, opts)
        },
        now: () => Date.now(),
        logger: {
            debug: (message, details) => console.debug(`[AMR source tab] ${message}`, details),
            warn: (message, details) => console.warn(`[AMR source tab] ${message}`, details)
        }
    }

    const sourceManga: SourceManga = { manga, sourceId, sourceMangaId, url: mangaUrl }
    return source.listChapters({ manga: sourceManga, limit: 500 }, context)
}

// Normalize a title the same way entrypoints/app/App.svelte's normTitle does
// (lowercase, non-letter/number runs collapsed to a single space, trimmed) so
// matching behaves consistently between the mirror-check UI and search here.
// Uses the Unicode letter/number classes (\p{L}\p{N}) rather than [a-z0-9] so
// CJK/Cyrillic/other-script tokens survive; a Latin-only class would collapse a
// whole non-Latin query to "" and make matchesQuery admit every title.
function normTitle(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
}

// Some per-site adapters' own search endpoints are fuzzy/broad server-side (e.g.
// typing "best" can return titles that don't contain "best" at all). Require every
// whitespace-separated token in the normalized query to appear as a substring
// somewhere in the normalized title - plain substring/token containment, no
// fuzzy scoring or edit-distance matching.
export function matchesQuery(title: string, query: string): boolean {
    const normalizedTitle = normTitle(title)
    const tokens = normTitle(query).split(" ").filter(Boolean)
    if (tokens.length === 0) return true
    return tokens.every(token => normalizedTitle.includes(token))
}

// A result passes if the query matches the main title OR any alt title the source
// surfaced (e.g. MangaDex's Japanese/romanized alternate titles). Results without
// altTitles behave exactly as before - title-only match.
function matchesQueryWithAltTitles(result: SourceSearchResult, query: string): boolean {
    if (matchesQuery(result.title, query)) return true
    return (result.altTitles ?? []).some(altTitle => matchesQuery(altTitle, query))
}

// Per-adapter memo of consecutive race-timeout rejections from searchManga (NOT
// searchMangaStreaming, which is unaffected - see below). After SEARCH_SKIP_AFTER
// consecutive timeouts a source is skipped entirely for SEARCH_RETRY_PROBE_MS,
// then probed once. A concurrent worker pool (ImportReconcile.svelte's "Search
// all" sweep) can run many searchManga calls overlapping in time, all potentially
// observing the SAME source timing out in the SAME rough window - the
// searchStartedAt > entry.lastIncrementAt guard in the settle handler below makes
// streak-counting sequential across the whole sweep so that looks like one bad
// instant, not three independently-counted failures.
type SearchTimeoutEntry = { streak: number; lastIncrementAt: number; lastProbeAt: number }
const searchTimeoutStreaks = new Map<string, SearchTimeoutEntry>()
const SEARCH_SKIP_AFTER = 3
const SEARCH_RETRY_PROBE_MS = 60_000

function shouldIncludeInSearch(sourceId: string): boolean {
    const entry = searchTimeoutStreaks.get(sourceId)
    if (!entry || entry.streak < SEARCH_SKIP_AFTER) return true
    if (Date.now() - entry.lastProbeAt > SEARCH_RETRY_PROBE_MS) {
        entry.lastProbeAt = Date.now() // stamp at dispatch time, prevents concurrent double-probe
        return true
    }
    return false
}

// mangahub paginates its search up to 3 pages under its own rate limit and can
// legitimately take 4-6s+, longer than the 10s default every other adapter races
// against.
const SEARCH_RACE_TIMEOUT_MS: Record<string, number> = { mangahub: 12_000 }

// Aggregate search across every adapter that supports it. Sources without
// granted host permission fail their origin check and are skipped (allSettled).
// sourceHealth is intentionally NOT used here - a source can be flagged dead for
// chapter fetching but still have a working search endpoint.
export async function searchManga(
    query: string,
    excludeSourceIds?: ReadonlySet<string>
): Promise<SourceSearchResult[]> {
    const searchStartedAt = Date.now()
    const searchable = sourceRegistry
        .list()
        .filter(
            adapter =>
                !!adapter.search &&
                !excludeSourceIds?.has(adapter.manifest.id) &&
                shouldIncludeInSearch(adapter.manifest.id)
        )
    const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
        Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))])
    const settled = await Promise.allSettled(
        searchable.map(adapter =>
            withTimeout(
                adapter.search!(query, createSourceContext(adapter.manifest.id, adapter.manifest.requestRateLimit)),
                SEARCH_RACE_TIMEOUT_MS[adapter.manifest.id] ?? 10_000
            )
        )
    )
    settled.forEach((result, i) => {
        const sourceId = searchable[i]!.manifest.id
        if (result.status === "fulfilled") {
            searchTimeoutStreaks.delete(sourceId)
            return
        }
        // Only count genuine race-timeout rejections (the sentinel Error thrown by
        // withTimeout above), not SourceError/fast-failure rejections like 403/DNS
        // from the adapter's own search() call.
        const isTimeout = result.reason instanceof Error && result.reason.message === "timeout"
        if (!isTimeout) return
        const entry = searchTimeoutStreaks.get(sourceId) ?? { streak: 0, lastIncrementAt: 0, lastProbeAt: 0 }
        if (searchStartedAt > entry.lastIncrementAt) {
            entry.streak += 1
            entry.lastIncrementAt = Date.now()
            searchTimeoutStreaks.set(sourceId, entry)
        }
    })
    return settled
        .flatMap(result => (result.status === "fulfilled" ? result.value : []))
        .filter(result => matchesQueryWithAltTitles(result, query))
}

// Streaming variant - fires all adapters concurrently and calls onPartial as each
// adapter settles, then calls onDone when all are complete. Enables progressive UI.
// An optional signal lets the caller (background.ts's search port) cancel: once
// aborted, no further partials are delivered and onDone is suppressed, so a closed
// search UI or a superseding query can't have stale results appended to it.
export function searchMangaStreaming(
    query: string,
    onPartial: (results: SourceSearchResult[], sourceId: string) => void,
    onDone: () => void,
    signal?: AbortSignal,
    excludeSourceIds?: ReadonlySet<string>,
    // Fired once per source as it settles (matched, empty, timed out, or errored) so the UI can
    // show true progress. onPartial only fires for sources that matched, so counting partials
    // undercounts and the "X/Y sources" indicator stalls on a no-match-heavy query.
    onSettled?: (sourceId: string) => void
): void {
    const searchable = sourceRegistry
        .list()
        .filter(adapter => !!adapter.search && !excludeSourceIds?.has(adapter.manifest.id))
    if (searchable.length === 0) {
        if (!signal?.aborted) onDone()
        return
    }
    const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
        Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))])
    let remaining = searchable.length
    for (const adapter of searchable) {
        withTimeout(
            adapter.search!(query, createSourceContext(adapter.manifest.id, adapter.manifest.requestRateLimit)),
            SEARCH_RACE_TIMEOUT_MS[adapter.manifest.id] ?? 10_000
        )
            .then(results => {
                if (signal?.aborted) return
                const matched = results.filter(result => matchesQueryWithAltTitles(result, query))
                if (matched.length > 0) onPartial(matched, adapter.manifest.id)
            })
            .catch(() => {})
            .finally(() => {
                if (!signal?.aborted) onSettled?.(adapter.manifest.id)
                if (--remaining === 0 && !signal?.aborted) onDone()
            })
    }
}

export type MangaSearchResult = SourceSearchResult

// Filter a chapter list to a preferred language for reader listing + prev/next
// navigation. Chapters with no language tag are always kept (single-language scrape
// sources don't distinguish, so their untagged chapters must survive). If NOTHING
// matches the preferred language - e.g. a source that tags everything "en" while the
// user prefers "fr", or a title only translated in another language - fall back to the
// full list so the reader is never stranded with an empty chapter list.
export function chaptersForLanguage<T extends { language?: string | undefined }>(
    chapters: T[],
    language: string | undefined
): T[] {
    if (!language) return chapters
    const matched = chapters.filter(c => !c.language || c.language === language)
    return matched.length > 0 ? matched : chapters
}

// Fetch MangaDex chapters for the Home search chapter-list panel.
// Routes through the bounded request client via the MangaDex adapter (fixes I3).
export async function getMangaChapters(mangaId: string, language = "en") {
    const chapters = await listChaptersBySource("mangadex", mangaId, `https://mangadex.org/title/${mangaId}`)
    const filtered = language ? chapters.filter(ch => !ch.language || ch.language === language) : chapters
    return filtered
        .sort((a, b) => b.sortKey - a.sortKey)
        .map(ch => ({
            id: ch.sourceChapterId,
            title: ch.title,
            chapter: Number.isFinite(ch.sortKey) ? String(ch.sortKey) : undefined,
            url: ch.url
        }))
}

export type MangaChapter = Awaited<ReturnType<typeof getMangaChapters>>[number]

export async function checkSourcePermission(): Promise<boolean> {
    return browser.permissions.contains({ origins: sourceOrigins() })
}

export async function requestSourcePermission(): Promise<boolean> {
    return browser.permissions.request({ origins: sourceOrigins() })
}

// List chapters from an arbitrary source/mirror for a manga already in the
// library - used to switch a title to a different mirror (G8). `overrides` lets
// the library:switch handler bound this specific fetch's timeout/retry budget
// tighter than the default (see createSourceContext) - every other caller omits
// it and keeps the default ~15s/2-retry budget.
export async function listChaptersForSource(
    manga: LibraryManga,
    sourceId: string,
    sourceMangaId: string,
    mangaUrl: string,
    overrides?: { timeoutMs?: number; maxRetries?: number },
    languages?: string[]
) {
    const source = sourceRegistry.get(sourceId)
    if (!source) throw new Error("That source is not supported")
    const sourceManga: SourceManga = { manga, sourceId, sourceMangaId, url: mangaUrl }
    const chapters = await source.listChapters(
        { manga: sourceManga, limit: 500, ...(languages && languages.length > 0 ? { languages } : {}) },
        createSourceContext(source.manifest.id, source.manifest.requestRateLimit, overrides)
    )
    diag.info("chapters", `listed ${chapters.length} chapters for ${sourceId}`, { sourceMangaId })
    return chapters
}

// List chapters for a source/manga that may not be in the library (used by the
// reader for prev/next navigation).
export async function listChaptersBySource(
    sourceId: string,
    sourceMangaId: string,
    mangaUrl: string,
    languages?: string[]
) {
    const source = sourceRegistry.get(sourceId)
    if (!source) throw new Error("That source is not supported")
    const stub: MangaRecord = {
        id: `${sourceId}:manga:${sourceMangaId}`,
        title: sourceMangaId,
        normalizedTitle: sourceMangaId,
        authors: [],
        status: "unknown",
        addedAt: 0,
        updatedAt: 0
    }
    const sourceManga: SourceManga = { manga: stub, sourceId, sourceMangaId, url: mangaUrl }
    const chapters = await source.listChapters(
        { manga: sourceManga, limit: 500, ...(languages && languages.length > 0 ? { languages } : {}) },
        createSourceContext(source.manifest.id, source.manifest.requestRateLimit)
    )
    diag.info("chapters", `listed ${chapters.length} chapters for ${sourceId}`, { sourceMangaId })
    return chapters
}

export async function listMangaChapters(manga: LibraryManga, link: SourceLinkRecord, language = "en") {
    const source = sourceRegistry.get(link.sourceId)
    if (!source) throw new Error("The source link cannot be refreshed")
    // Links created by the external-track path before sourceMangaId was persisted (or by
    // any path that only stored the manga URL) can still be refreshed as long as the
    // adapter can parse the id back out of that URL - do that here rather than giving up.
    let sourceMangaId = link.sourceMangaId
    if (!sourceMangaId) {
        try {
            sourceMangaId = source.parseMangaUrl?.(new URL(link.url))?.sourceMangaId ?? undefined
        } catch {
            sourceMangaId = undefined
        }
    }
    if (!sourceMangaId) throw new Error("The source link cannot be refreshed")
    const sourceManga: SourceManga = {
        manga,
        sourceId: link.sourceId,
        sourceMangaId,
        url: link.url
    }
    return source.listChapters(
        {
            manga: sourceManga,
            languages: link.language ? [link.language] : [language],
            limit: 500
        },
        createSourceContext(source.manifest.id, source.manifest.requestRateLimit)
    )
}
