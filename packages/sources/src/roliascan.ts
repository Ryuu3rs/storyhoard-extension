import { z } from "zod"
import {
    SourceError,
    UNNUMBERED_SORT_KEY,
    matchesSourceDomain,
    parseChapterNumber,
    type ListChaptersInput,
    type ResolveChapterInput,
    type ResolveMangaInput,
    type ResolvedChapter,
    type SourceAdapter,
    type SourceChapter,
    type SourceContext,
    type SourceManga,
    type SourcePageMatch,
    type SourceSearchResult
} from "@amr/source-sdk"
import { md5 } from "./md5"

// Rolia Scan runs the custom "MangaTaro" WordPress theme. It exposes a clean JSON API under
// /auth/* (public, no login for reads): search, the per-series chapter list, and the chapter
// image list. The chapter-list endpoint is guarded by a time-based anti-scrape token that is
// generated entirely client-side - md5(unixSeconds + "mng_ch_" + YYYYMMDDHH_utc), first 16
// hex chars - so it is reproducible here with no server secret. Page images are served from a
// separate CDN host (roliascan.org), declared via imageOrigins.

const SOURCE_ID = "roliascan"
const ORIGIN = "https://roliascan.com"
const DOMAINS = ["roliascan.com", "www.roliascan.com"]
const LANGUAGE = "en"

const HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: ORIGIN + "/"
}

// /manga/{slug}                       → series page
// /read/{slug}/ch{num}-{chapterId}    → chapter reader (chapterId is the numeric post id)
const MANGA_RE = /^\/manga\/([a-z0-9][a-z0-9-]*)\/?$/
const CHAPTER_RE = /^\/read\/([a-z0-9][a-z0-9-]*)\/ch([\d.]+)-(\d+)\/?$/

function matchMangaSlug(url: URL): string | undefined {
    if (!matchesSourceDomain(url.hostname, DOMAINS)) return undefined
    return url.pathname.match(MANGA_RE)?.[1]
}

function matchChapterParts(url: URL): { slug: string; num: string; chapterId: string } | undefined {
    if (!matchesSourceDomain(url.hostname, DOMAINS)) return undefined
    const m = url.pathname.match(CHAPTER_RE)
    if (!m) return undefined
    return { slug: m[1]!, num: m[2]!, chapterId: m[3]! }
}

// The anti-scrape token the theme's manga.js signs the chapter-list request with. Hour is UTC
// (Date.toISOString), matching the site; a request built one client-second later still verifies
// because the server allows the current and adjacent hour bucket.
function apiToken(): { _t: string; _ts: string } {
    const ts = Math.floor(Date.now() / 1000)
    const hour = new Date().toISOString().slice(0, 13).replace(/[-T:]/g, "")
    return { _t: md5(`${ts}mng_ch_${hour}`).slice(0, 16), _ts: String(ts) }
}

const searchSchema = z.object({
    results: z
        .array(
            z.object({
                id: z.union([z.number(), z.string()]),
                title: z.string(),
                slug: z.string(),
                permalink: z.string().optional(),
                thumbnail: z.string().nullish(),
                alt_titles: z.array(z.string()).optional()
            })
        )
        .default([])
})

const chaptersSchema = z.object({
    chapters: z
        .array(
            z.object({
                id: z.union([z.number(), z.string()]),
                chapter: z.union([z.number(), z.string()]),
                title: z.string().nullish(),
                url: z.string()
            })
        )
        .default([])
})

const contentSchema = z.object({ images: z.array(z.string()).default([]) })

// A series' numeric manga id (needed by the chapter-list API) + display metadata, scraped from
// the SSR'd series page. The chapter list container carries data-manga-id; the cover follows the
// content/media/manga-{id}-cover pattern and og:title holds a clean title.
async function fetchSeries(
    slug: string,
    context: SourceContext
): Promise<{ mangaId?: string; title: string; coverUrl?: string }> {
    const html = await context.request.getText(new URL(`${ORIGIN}/manga/${slug}/`), { headers: HEADERS })
    const mangaId = html.match(/data-manga-id="(\d+)"/)?.[1] ?? html.match(/manga-(\d+)-cover/)?.[1]
    const rawTitle =
        html.match(/property="og:title"\s+content="([^"]+)"/i)?.[1] ??
        html.match(/content="([^"]+)"\s+property="og:title"/i)?.[1]
    const title = rawTitle
        ? rawTitle
              .replace(/\s*(?:Manhwa|Manga|Manhua)?\s*\|.*$/i, "")
              .replace(/&amp;/g, "&")
              .replace(/&#0?39;|&apos;/g, "'")
              .replace(/&quot;/g, '"')
              .trim()
        : slug.replace(/-/g, " ")
    const coverRel = html.match(/content\/media\/manga-\d+-cover-[^"'\s)]+\.(?:jpg|jpeg|png|webp)/i)?.[0]
    const coverUrl =
        (coverRel ? `${ORIGIN}/${coverRel}` : undefined) ?? html.match(/property="og:image"\s+content="([^"]+)"/i)?.[1]
    return { ...(mangaId ? { mangaId } : {}), title, ...(coverUrl ? { coverUrl } : {}) }
}

function makeManga(slug: string, title: string, coverUrl: string | undefined, now: number): SourceManga {
    return {
        manga: {
            id: `${SOURCE_ID}:manga:${slug}`,
            title,
            normalizedTitle: title.toLocaleLowerCase("en"),
            ...(coverUrl ? { coverUrl } : {}),
            authors: [],
            status: "unknown",
            addedAt: now,
            updatedAt: now
        },
        sourceId: SOURCE_ID,
        sourceMangaId: slug,
        url: `${ORIGIN}/manga/${slug}`
    }
}

export const roliascanAdapter: SourceAdapter = {
    manifest: {
        id: SOURCE_ID,
        name: "Rolia Scan",
        domains: DOMAINS,
        languages: [LANGUAGE],
        capabilities: ["pages", "chapters"],
        requestRateLimit: { requests: 3, intervalMs: 1000 },
        fixtureVersion: 1,
        homepage: ORIGIN,
        // Page + cover images are served from the sibling CDN host, not roliascan.com.
        imageOrigins: ["https://roliascan.org/*"]
    },

    match(url: URL): SourcePageMatch {
        if (matchChapterParts(url)) return "chapter"
        if (matchMangaSlug(url)) return "manga"
        return "none"
    },

    parseMangaUrl(url: URL): { sourceMangaId: string; mangaUrl: string } | null {
        const slug = matchChapterParts(url)?.slug ?? matchMangaSlug(url)
        if (!slug) return null
        return { sourceMangaId: slug, mangaUrl: `${ORIGIN}/manga/${slug}` }
    },

    async resolveManga(input: ResolveMangaInput, context: SourceContext): Promise<SourceManga> {
        const slug = input.url ? matchMangaSlug(input.url) : input.sourceMangaId
        if (!slug) throw new SourceError("invalid-input", "A valid Rolia Scan manga URL is required")
        const { title, coverUrl } = await fetchSeries(slug, context)
        return makeManga(slug, title, coverUrl, context.now())
    },

    async listChapters(input: ListChaptersInput, context: SourceContext): Promise<SourceChapter[]> {
        const slug = input.manga.sourceMangaId
        const mangaId = (await fetchSeries(slug, context)).mangaId
        if (!mangaId) throw new SourceError("invalid-response", "Could not resolve the Rolia Scan series id")
        const params = new URLSearchParams({
            manga_id: mangaId,
            offset: "0",
            limit: "500",
            order: "asc",
            ...apiToken()
        })
        const { chapters } = await context.request.getJson(
            new URL(`${ORIGIN}/auth/manga-chapters?${params}`),
            chaptersSchema,
            { headers: HEADERS }
        )
        const parentId = input.manga.manga.id
        return chapters.map(c => {
            const numStr = String(c.chapter)
            const sortKey = parseChapterNumber(numStr) ?? UNNUMBERED_SORT_KEY
            const label = c.title && c.title !== "N/A" ? `Ch.${numStr} - ${c.title}` : `Ch.${numStr}`
            return {
                id: `${SOURCE_ID}:chapter:${slug}:${numStr}`,
                mangaId: parentId,
                sourceId: SOURCE_ID,
                sourceChapterId: numStr,
                title: label,
                url: c.url,
                sortKey,
                language: LANGUAGE
            }
        })
    },

    async resolveChapter(input: ResolveChapterInput, context: SourceContext): Promise<ResolvedChapter> {
        if (!input.url) throw new SourceError("invalid-input", "A chapter URL is required")
        const parts = matchChapterParts(input.url)
        if (!parts) throw new SourceError("unsupported-url", "Not a recognised Rolia Scan chapter URL")
        const { slug, num, chapterId } = parts
        const now = context.now()

        const { images } = await context.request.getJson(
            new URL(`${ORIGIN}/auth/chapter-content?chapter_id=${chapterId}`),
            contentSchema,
            { headers: HEADERS }
        )
        // Keep only real page images from the CDN's per-chapter folder; the API appends a static
        // "rolia-end" promo card that isn't part of the chapter.
        const pageUrls = images.filter(u => /\/storage\/chapters\//.test(u) && !/rolia-end/i.test(u))
        if (pageUrls.length === 0) throw new SourceError("invalid-response", "No page images in this chapter")

        let title = slug.replace(/-/g, " ")
        let coverUrl: string | undefined
        try {
            const series = await fetchSeries(slug, context)
            title = series.title
            coverUrl = series.coverUrl
        } catch {
            // Reader still works with the slug-derived title; metadata enrichment fixes it.
        }
        const manga = makeManga(slug, title, coverUrl, now)
        const chapterId2 = `${SOURCE_ID}:chapter:${slug}:${num}`
        const chapter: SourceChapter = {
            id: chapterId2,
            mangaId: manga.manga.id,
            sourceId: SOURCE_ID,
            sourceChapterId: num,
            title: `Ch.${num}`,
            url: input.url.toString(),
            sortKey: parseChapterNumber(num) ?? UNNUMBERED_SORT_KEY,
            language: LANGUAGE
        }
        const pages = pageUrls.map((url, i) => ({ id: `${chapterId2}:page:${i + 1}`, url }))
        return { manga, chapter, pages }
    },

    async resolveCover(
        input: { sourceMangaId?: string; url?: URL },
        context: SourceContext
    ): Promise<string | undefined> {
        const slug = input.sourceMangaId ?? (input.url ? matchMangaSlug(input.url) : undefined)
        if (!slug) return undefined
        return (await fetchSeries(slug, context)).coverUrl
    },

    async search(query: string, context: SourceContext): Promise<SourceSearchResult[]> {
        if (!query.trim()) return []
        try {
            const url = new URL(`${ORIGIN}/auth/search`)
            url.searchParams.set("q", query)
            url.searchParams.set("limit", "20")
            const { results } = await context.request.getJson(url, searchSchema, { headers: HEADERS })
            return results.map(r => {
                const alt = r.alt_titles?.flatMap(a => a.split("|").map(s => s.trim())).filter(Boolean) ?? []
                return {
                    sourceId: SOURCE_ID,
                    sourceMangaId: r.slug,
                    title: r.title,
                    url: r.permalink ?? `${ORIGIN}/manga/${r.slug}`,
                    ...(r.thumbnail ? { coverUrl: r.thumbnail } : {}),
                    ...(alt.length > 0 ? { altTitles: alt } : {})
                }
            })
        } catch (error) {
            context.logger.warn("Rolia Scan search failed - returning no results", {
                query,
                error: error instanceof Error ? error.message : String(error)
            })
            return []
        }
    }
}
