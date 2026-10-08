import type { ChapterRecord, MangaRecord } from "@amr/contracts"
import type { ZodType } from "zod"

export type SourcePageMatch = "chapter" | "manga" | "none"

export type SourceCapability = "chapters" | "manga" | "pages"

export type SourceManifest = {
    id: string
    name: string
    domains: string[]
    languages: string[]
    capabilities: SourceCapability[]
    requestRateLimit: {
        requests: number
        intervalMs: number
    }
    fixtureVersion: number
    homepage?: string
    // Where readers can tip the site's own team (Ko-fi, Patreon...). Shown next to the
    // extension's own support link, always labelled so the two are never confused.
    supportUrl?: string
    // Optional extra host-permission origin patterns for cover/page-image CDN hosts
    // that differ from the adapter's own site domain(s) - e.g. a separate subdomain
    // (storage.example.com) or an entirely different CDN host. Additive: adapters
    // that omit this are unaffected. Per-family origin generators (madaraOrigins,
    // mangaStreamOrigins, mangaBuddyOrigins, fanfoxFamilyOrigins) fold this into the
    // origins they export, and permissions.ts folds those into SOURCE_ORIGINS - so a
    // site's image CDN is granted automatically instead of needing a manual patch to
    // BASE_SOURCE_ORIGINS every time a user hits a CORS error in the console.
    imageOrigins?: readonly string[]
}

export type SourceManga = {
    manga: MangaRecord
    sourceId: string
    sourceMangaId: string
    url: string
}

export type SourceChapter = ChapterRecord & {
    sourceChapterId: string
    language: string
}

export type ResolvedPage = {
    id: string
    url: string
}

export type ResolvedChapter = {
    manga: SourceManga
    chapter: SourceChapter
    pages: ResolvedPage[]
}

export type ResolveMangaInput = {
    url?: URL
    sourceMangaId?: string
}

export type ListChaptersInput = {
    manga: SourceManga
    languages?: readonly string[]
    limit?: number
}

export type ResolveChapterInput = {
    url?: URL
    sourceChapterId?: string
}

export type SourceSearchResult = {
    sourceId: string
    sourceMangaId: string
    title: string
    url: string
    coverUrl?: string
    // Latest hosted chapter number/label if the search surface exposes it - lets
    // the UI show which mirrors are actively updated (G7).
    latestChapter?: string
    // Alternate/native/romanized titles the source's search API returned for this
    // result. Optional - most adapters don't populate it. Lets client-side query
    // filters match on alt titles even when the query doesn't appear in `title`.
    altTitles?: string[]
}

export type SourceRequestOptions = {
    headers?: Readonly<Record<string, string>>
}

export interface SourceRequestClient {
    getJson<T>(url: URL, schema: ZodType<T>, options?: SourceRequestOptions): Promise<T>
    getText(url: URL, options?: SourceRequestOptions): Promise<string>
    postForm(url: URL, params: Record<string, string>, options?: SourceRequestOptions): Promise<string>
    // POST a JSON body (Content-Type: application/json) and validate the JSON response
    // against a schema. For APIs that require a real `application/json` request body -
    // postForm always sends `application/x-www-form-urlencoded`, which some JSON-only
    // APIs reject outright.
    postJson<T>(url: URL, body: unknown, schema: ZodType<T>, options?: SourceRequestOptions): Promise<T>
}

export type SourceLogger = {
    debug(message: string, details?: Readonly<Record<string, unknown>>): void
    warn(message: string, details?: Readonly<Record<string, unknown>>): void
}

export type SourceContext = {
    request: SourceRequestClient
    now(): number
    logger: SourceLogger
}

export interface SourceAdapter {
    readonly manifest: SourceManifest
    match(url: URL): SourcePageMatch
    resolveManga(input: ResolveMangaInput, context: SourceContext): Promise<SourceManga>
    listChapters(input: ListChaptersInput, context: SourceContext): Promise<SourceChapter[]>
    resolveChapter(input: ResolveChapterInput, context: SourceContext): Promise<ResolvedChapter>
    // Optional: fetch just the cover image URL for a series, by its source manga id
    // and/or manga page URL. Used to backfill covers for library entries that were
    // added by reading a chapter (which may not carry a reliable cover).
    resolveCover?(input: { sourceMangaId?: string; url?: URL }, context: SourceContext): Promise<string | undefined>
    // Optional: fetch a title's genre/tag names so the app can suggest tags. Best
    // effort - adapters return [] rather than throwing when genres aren't available.
    resolveGenres?(input: { sourceMangaId?: string; url?: URL }, context: SourceContext): Promise<string[]>
    // Optional: search this source for a title. Adapters that can't search omit it.
    search?(query: string, context: SourceContext): Promise<SourceSearchResult[]>
    // Optional: derive manga ID and list URL from a chapter URL without network.
    // Used to prime the chapter list for panel prev/next when chapter resolve fails (bot-block).
    parseMangaUrl?(url: URL): { sourceMangaId: string; mangaUrl: string } | null
    // Optional: collapse a source manga id / slug to a rotation-stable canonical form. Sites
    // like Asura rotate a per-series slug hash, so the raw id changes over time even though it
    // is the same series. External-chapter tracking uses this to match a rotated chapter URL
    // back to the existing library entry instead of forking a duplicate. Return the input
    // unchanged when there is nothing to normalize.
    normalizeSourceMangaId?(sourceMangaId: string): string
    // Optional: return the URL of the chapter-list page for this series.
    // When listChapters returns 0 results (list page is JS-rendered and the service
    // worker fetch returns empty HTML), background.ts falls back to tab-injecting
    // this URL and mining episode links from the fully-rendered DOM.
    getChapterListUrl?(sourceMangaId: string, mangaUrl: string): string | null
    // Optional: when true and a service-worker listChapters returns 0 (the manga page
    // is bot-walled / behind Cloudflare so a plain SW fetch 403s), the extension
    // tab-renders the manga page URL and re-runs THIS adapter's listChapters against
    // that HTML. Unlike getChapterListUrl (which mines <a> links from a standalone list
    // page), this reuses the adapter's own parse - for sources like Comix that synthesise
    // the whole list from one SSR field (latestChapter) the browser-rendered page exposes.
    chapterListViaMangaPageTab?: boolean
    // Optional: the same extraction listChapters runs, over HTML the caller already holds (a page
    // rendered in a tab). No request is made. Used for sources whose list is built in the browser.
    listChaptersFromHtml?(input: ListChaptersInput, html: string): SourceChapter[]
    // Optional: the page a background tab should render to read this series' chapter list, when it
    // is not the series page itself.
    chapterListRenderUrl?(sourceMangaId: string, mangaUrl: string): string
}
