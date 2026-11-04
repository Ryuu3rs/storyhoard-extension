import {
    SourceError,
    UNNUMBERED_SORT_KEY,
    assignListSortKeys,
    decodeHtmlEntities as decodeEntities,
    parseChapterNumber,
    sanitizeScrapedText,
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

const SOURCE_ID = "weebcentral"
const ORIGIN = "https://weebcentral.com"
const DOMAIN = "weebcentral.com"

// Weeb Central uses Postgres ULIDs - 26 chars from Crockford base32.
const ULID_CHARS = "[0-9A-HJKMNP-TV-Z]{26}"
const SERIES_RE = new RegExp(`^/series/(${ULID_CHARS})(?:/[^/]*)?/?$`, "i")
const CHAPTER_RE = new RegExp(`^/chapters/(${ULID_CHARS})(?:/.*)?$`, "i")

const BROWSER_HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5"
}

function captureGroup(match: RegExpMatchArray, index: number): string | undefined {
    const v = match[index]
    return typeof v === "string" ? v : undefined
}

function extractSeriesId(url: URL): string | undefined {
    if (url.hostname !== DOMAIN && url.hostname !== `www.${DOMAIN}`) return undefined
    const m = url.pathname.match(SERIES_RE)
    return m ? captureGroup(m, 1)?.toUpperCase() : undefined
}

function extractChapterId(url: URL): string | undefined {
    if (url.hostname !== DOMAIN && url.hostname !== `www.${DOMAIN}`) return undefined
    const m = url.pathname.match(CHAPTER_RE)
    return m ? captureGroup(m, 1)?.toUpperCase() : undefined
}

// Extract a float chapter number from a title string, e.g. "Chapter 1", "Ch. 1.5",
// "Vol.2 Chapter 12", "Episode 246". Weeb Central labels webtoon series "Episode N" rather than
// "Chapter N" (live-verified), so an episode marker must be recognised too - otherwise every
// episode parses to undefined and assignListSortKeys collapses the whole series to position/1000
// sortKeys (Episode 17 -> 0.017, Episode 269 -> 0.269), sinking a caught-up series below its own
// real lastRead. Falls back to the first bare number so a numeric-only label still resolves.
// Returns undefined when the text has no parseable number at all (e.g. "Extra", "Special") -
// callers decide the fallback since the right one differs by context (see extractChapterList vs
// extractChapterPageMeta below).
function chapterNumberFromText(text: string): number | undefined {
    const marked = text.match(/\b(?:chapter|chap|ch|episode|ep)\b\.?\s*#?\s*(\d+(?:[.-]\d+)?)/i)
    if (marked?.[1] !== undefined) return parseChapterNumber(marked[1].replace("-", "."))
    const bare = text.trim().match(/^(\d+(?:\.\d+)?)$/)
    return bare?.[1] !== undefined ? parseChapterNumber(bare[1]) : undefined
}

// Weeb Central chapter/search anchors wrap a hidden "Last Read" indicator span
// (x-show, Alpine.js) ahead of the label. sanitizeScrapedText already removes the
// inline SVG <style> block and the trailing <time> timestamp (the shared leak fix),
// but the x-show span is site-specific: its content "Last Read" is real text, so
// only removing the <span> block itself keeps it out of the label. Run this before
// handing the anchor inner HTML to sanitizeScrapedText.
function stripAnchorNoise(html: string): string {
    return html.replace(/<span\b[^>]*\bx-show="[^"]*"[^>]*>[\s\S]*?<\/span>/gi, " ")
}

function extractCoverUrl(html: string): string | undefined {
    const patterns = [
        /<meta\s[^>]*\bproperty="og:image"\s[^>]*\bcontent="(https?:\/\/[^"]+)"/i,
        /<meta\s[^>]*\bcontent="(https?:\/\/[^"]+)"\s[^>]*\bproperty="og:image"/i
    ]
    for (const p of patterns) {
        const m = html.match(p)
        if (m) return captureGroup(m, 1)
    }
    return undefined
}

function extractSeriesTitle(html: string, fallback: string): string {
    // Try og:title first (most reliable on series pages)
    const og =
        html.match(/<meta\s[^>]*\bproperty="og:title"\s[^>]*\bcontent="([^"]+)"/i) ??
        html.match(/<meta\s[^>]*\bcontent="([^"]+)"\s[^>]*\bproperty="og:title"/i)
    if (og) {
        const raw = decodeEntities(captureGroup(og, 1) ?? "")
        const cleaned = raw.split(/\s*[-|]\s*Weeb\s*Central/i)[0]?.trim()
        if (cleaned && cleaned.length > 1) return cleaned
    }
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    const h1Text = h1 ? sanitizeScrapedText(captureGroup(h1, 1) ?? "") : ""
    if (h1Text.length > 1) return h1Text
    return fallback
}

// Parse the chapter list from a series page.
//
// Chapter links are /chapters/{ULID} or /chapters/{ULID}/ - the href may be relative or
// absolute (weebcentral emits absolute https://weebcentral.com/... hrefs as of 2025; the old
// relative-only regex matched none of them).
//
// The series page lists chapters newest-first (descending chapter number) - live-verified
// against weebcentral.com/series/<id> (Chapter 200 first, counting down to Chapter 0 last).
// Bonus/extra entries with no parseable chapter number (e.g. "Extra") get their sortKey
// interpolated between the two real chapter numbers they sit next to in the document, walking
// forward in chronological (ascending) order - detected from the document regardless of
// whether it happens to list chapters ascending or descending, so an unparseable title never
// collapses to sortKey 0 and sorts before every real chapter (the previous bug).
function extractChapterList(html: string, seriesId: string): SourceChapter[] {
    const parentId = `${SOURCE_ID}:manga:${seriesId}`
    const seen = new Set<string>()
    const entries: { chapterId: string; text: string; parsedKey: number | undefined }[] = []

    for (const a of html.matchAll(
        /<a\b[^>]*\bhref="(?:https?:\/\/(?:www\.)?weebcentral\.com)?\/chapters\/([0-9A-Z]{26})[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
    )) {
        const chapterId = captureGroup(a, 1)?.toUpperCase()
        const inner = captureGroup(a, 2) ?? ""
        if (!chapterId || seen.has(chapterId)) continue
        seen.add(chapterId)
        const text = sanitizeScrapedText(stripAnchorNoise(inner))
        entries.push({ chapterId, text, parsedKey: chapterNumberFromText(text) })
    }

    // The series page lists chapters newest-first (descending). Unnumbered bonus
    // entries interpolate between the real chapters they sit next to.
    const sortKeys = assignListSortKeys(entries, e => e.parsedKey, "newest-first")
    return entries.map((entry, i) => {
        const sortKey = sortKeys[i] as number
        return {
            id: `${SOURCE_ID}:chapter:${entry.chapterId}`,
            mangaId: parentId,
            sourceId: SOURCE_ID,
            sourceChapterId: entry.chapterId,
            title: entry.text || `Chapter ${Number.isFinite(sortKey) ? sortKey : "?"}`,
            url: `${ORIGIN}/chapters/${entry.chapterId}/`,
            sortKey,
            language: "en"
        }
    })
}

function extractImages(html: string): string[] {
    const urls: string[] = []
    for (const tag of html.matchAll(/<img\b[^>]*>/gi)) {
        const t = captureGroup(tag, 0) ?? ""
        for (const attr of ["src", "data-src"]) {
            const m = t.match(new RegExp(`\\b${attr}="(https?://[^"]+)"`, "i"))
            const url = m ? captureGroup(m, 1) : undefined
            if (url && !url.startsWith("data:") && /\.(jpe?g|png|webp|gif|avif)/i.test(url)) {
                urls.push(url)
                break
            }
        }
    }
    return urls
}

// From a chapter page, extract the linked series ULID and the chapter title.
function extractChapterPageMeta(html: string): { seriesId?: string; title: string; sortKey: number } {
    // Look for a link to /series/{ULID}... - href may be relative or absolute (see
    // extractChapterList above for why).
    const seriesMatch = html.match(
        /<a\b[^>]*\bhref="(?:https?:\/\/(?:www\.)?weebcentral\.com)?\/series\/([0-9A-Z]{26})[^"]*"[^>]*>([\s\S]*?)<\/a>/i
    )
    const seriesId = seriesMatch ? captureGroup(seriesMatch, 1)?.toUpperCase() : undefined

    // Chapter title: prefer og:title or <title>, strip site/series suffix
    const og =
        html.match(/<meta\s[^>]*\bproperty="og:title"\s[^>]*\bcontent="([^"]+)"/i) ??
        html.match(/<meta\s[^>]*\bcontent="([^"]+)"\s[^>]*\bproperty="og:title"/i)
    let title = ""
    if (og) {
        const raw = decodeEntities(captureGroup(og, 1) ?? "")
        title = raw.split(/\s*[-|]\s*/)[0]?.trim() ?? ""
    }
    if (!title) {
        const docTitle = html.match(/<title>([^<]+)<\/title>/i)
        const raw = docTitle ? decodeEntities(captureGroup(docTitle, 1) ?? "") : ""
        title = raw.split(/\s*[-|]\s*/)[0]?.trim() ?? ""
    }
    // Unlike extractChapterList, this function only ever sees a single chapter's title in
    // isolation - there's no surrounding chapter list to interpolate a position from. Fall back
    // to +Infinity (not 0) so an unparseable title (e.g. "Extra") sorts to the end of a chapter
    // list rather than before every real chapter.
    const sortKey = chapterNumberFromText(title) ?? UNNUMBERED_SORT_KEY
    return {
        ...(seriesId ? { seriesId } : {}),
        title: title || `Chapter ${sortKey === UNNUMBERED_SORT_KEY ? "?" : sortKey}`,
        sortKey
    }
}

// Each search result card on /search/data renders TWO anchors to the same series (live-verified
// against weebcentral.com/search/data): a mobile-only card with no class attribute on the <a>
// itself, whose text can include an "Official" ribbon badge ahead of the title (e.g. "Official
// Solo Leveling"), and a desktop-only anchor carrying class="line-clamp-1 link link-hover" with
// just the clean title text. The badge anchor always comes first in the document.
//
// The "Official" ribbon is NOT a reliable text marker - live-verified across a 32-result search,
// only 8 results had the ribbon at all, while every single result had exactly one link-hover
// anchor. So dedup must prefer the link-hover anchor structurally, not by stripping badge text.
const LINK_HOVER_CLASS_RE = /\bclass="[^"]*\blink-hover\b[^"]*"/i

function extractSearchResults(html: string): SourceSearchResult[] {
    const order: string[] = []
    const bySeriesId = new Map<string, { href: string | undefined; title: string; isCleanAnchor: boolean }>()

    // href may be relative or absolute (see extractChapterList above for why); the capture
    // group only ever grabs the relative path portion, so the ${ORIGIN}${href} join below
    // still works either way.
    for (const a of html.matchAll(
        /<a\b([^>]*)\bhref="(?:https?:\/\/(?:www\.)?weebcentral\.com)?(\/series\/([0-9A-Z]{26})[^"]*)"([^>]*)>([\s\S]*?)<\/a>/gi
    )) {
        const attrsBefore = captureGroup(a, 1) ?? ""
        const href = captureGroup(a, 2)
        const seriesId = captureGroup(a, 3)?.toUpperCase()
        const attrsAfter = captureGroup(a, 4) ?? ""
        const inner = captureGroup(a, 5) ?? ""
        if (!seriesId) continue

        const title = sanitizeScrapedText(stripAnchorNoise(inner))
        if (title.length < 2) continue

        const isCleanAnchor = LINK_HOVER_CLASS_RE.test(attrsBefore) || LINK_HOVER_CLASS_RE.test(attrsAfter)

        const existing = bySeriesId.get(seriesId)
        if (!existing) {
            order.push(seriesId)
            bySeriesId.set(seriesId, { href, title, isCleanAnchor })
        } else if (isCleanAnchor && !existing.isCleanAnchor) {
            // Prefer the desktop clean-title anchor over the mobile badge anchor, regardless of
            // which one was encountered first in the document.
            bySeriesId.set(seriesId, { href, title, isCleanAnchor })
        }
    }

    const out: SourceSearchResult[] = []
    for (const seriesId of order) {
        const result = bySeriesId.get(seriesId)
        if (!result) continue
        out.push({
            sourceId: SOURCE_ID,
            sourceMangaId: seriesId,
            title: result.title,
            url: result.href ? `${ORIGIN}${result.href}` : `${ORIGIN}/series/${seriesId}`
        })
    }
    return out
}

export const weebCentralAdapter: SourceAdapter = {
    manifest: {
        id: SOURCE_ID,
        name: "Weeb Central",
        domains: [DOMAIN, `www.${DOMAIN}`],
        languages: ["en"],
        capabilities: ["pages", "chapters"],
        requestRateLimit: { requests: 3, intervalMs: 1000 },
        fixtureVersion: 1,
        homepage: ORIGIN
    },

    match(url: URL): SourcePageMatch {
        if (extractChapterId(url)) return "chapter"
        if (extractSeriesId(url)) return "manga"
        return "none"
    },

    async resolveManga(input: ResolveMangaInput, context: SourceContext): Promise<SourceManga> {
        const seriesId = input.url ? extractSeriesId(input.url) : input.sourceMangaId?.toUpperCase()
        if (!seriesId) throw new SourceError("invalid-input", "A valid Weeb Central series URL is required")
        const now = context.now()
        let title = seriesId
        let coverUrl: string | undefined
        try {
            const html = await context.request.getText(new URL(`${ORIGIN}/series/${seriesId}`), {
                headers: BROWSER_HEADERS
            })
            title = extractSeriesTitle(html, seriesId)
            coverUrl = extractCoverUrl(html)
        } catch {
            // Fall back to id-derived title
        }
        return {
            manga: {
                id: `${SOURCE_ID}:manga:${seriesId}`,
                title,
                normalizedTitle: title.toLocaleLowerCase("en"),
                ...(coverUrl ? { coverUrl } : {}),
                authors: [],
                status: "unknown",
                addedAt: now,
                updatedAt: now
            },
            sourceId: SOURCE_ID,
            sourceMangaId: seriesId,
            url: `${ORIGIN}/series/${seriesId}`
        }
    },

    async listChapters(input: ListChaptersInput, context: SourceContext): Promise<SourceChapter[]> {
        const seriesId = input.manga.sourceMangaId
        if (!seriesId) throw new SourceError("invalid-input", "A valid Weeb Central series id is required")
        // The main series page SSRs only a windowed subset of chapters (first few +
        // latest few - live-verified: ~9 of 244), which truncated the reader's chapter
        // list. The full contiguous list lives behind this dedicated htmx endpoint (same
        // /chapters/{ULID} anchor markup, newest-first), as the legacy adapter used.
        const html = await context.request.getText(new URL(`${ORIGIN}/series/${seriesId}/full-chapter-list`), {
            headers: BROWSER_HEADERS
        })
        const chapters = extractChapterList(html, seriesId)
        chapters.sort((a, b) => a.sortKey - b.sortKey)
        return input.limit ? chapters.slice(-input.limit) : chapters
    },

    async resolveCover(
        input: { sourceMangaId?: string; url?: URL },
        context: SourceContext
    ): Promise<string | undefined> {
        const seriesId = input.sourceMangaId?.toUpperCase() ?? (input.url ? extractSeriesId(input.url) : undefined)
        if (!seriesId) return undefined
        try {
            const html = await context.request.getText(new URL(`${ORIGIN}/series/${seriesId}`), {
                headers: BROWSER_HEADERS
            })
            return extractCoverUrl(html)
        } catch {
            return undefined
        }
    },

    async search(query: string, context: SourceContext): Promise<SourceSearchResult[]> {
        if (!query.trim()) return []
        try {
            // /search only renders the static advanced-search FORM page (zero real result
            // links - live-verified). The actual results come from /search/data, the htmx
            // endpoint the form's "load"/"submit" triggers fetch from. Live-verified required
            // params: "text" (the query), "sort" (radio: "Best Match" | "Alphabet" |
            // "Popularity" | "Subscribers" | "Recently Added" | "Latest Updates"), "order"
            // (radio: "Ascending" | "Descending"), and "display_mode" (radio: "Full Display" |
            // "Minimal Display") - omitting display_mode returns a 400. "Best Match" is the
            // form's own default sort for a text search.
            const url = new URL(`${ORIGIN}/search/data`)
            url.searchParams.set("text", query)
            url.searchParams.set("sort", "Best Match")
            url.searchParams.set("order", "Ascending")
            url.searchParams.set("display_mode", "Full Display")
            const html = await context.request.getText(url, {
                headers: { ...BROWSER_HEADERS, "HX-Request": "true" }
            })
            return extractSearchResults(html)
        } catch {
            return []
        }
    },

    async resolveChapter(input: ResolveChapterInput, context: SourceContext): Promise<ResolvedChapter> {
        const chapterId = input.url ? extractChapterId(input.url) : input.sourceChapterId?.toUpperCase()
        if (!chapterId) throw new SourceError("invalid-input", "A chapter URL or ID is required")

        const chapterPageUrl = `${ORIGIN}/chapters/${chapterId}/`
        const imagesUrl = new URL(`${ORIGIN}/chapters/${chapterId}/images`)
        imagesUrl.searchParams.set("is_prev", "False")
        imagesUrl.searchParams.set("current_page", "1")

        // Fetch chapter page (manga metadata + chapter title) and images concurrently.
        // The HTMX images endpoint may be bot-blocked - treat failure as empty images so
        // the series metadata is still preserved and siblings can be cached for panel nav.
        const [chapterHtml, imagesHtml] = await Promise.all([
            context.request.getText(new URL(chapterPageUrl), { headers: BROWSER_HEADERS }),
            context.request
                .getText(imagesUrl, {
                    headers: { ...BROWSER_HEADERS, "HX-Request": "true", Referer: chapterPageUrl }
                })
                .catch(() => "")
        ])

        const imageUrls = extractImages(imagesHtml)
        if (imageUrls.length === 0) {
            context.logger.warn("WeebCentral images unavailable - preserving series metadata for panel nav", {
                chapterId
            })
        }

        const { seriesId, title: chapterTitle, sortKey } = extractChapterPageMeta(chapterHtml)
        const now = context.now()
        const mangaRecordId = seriesId ? `${SOURCE_ID}:manga:${seriesId}` : `${SOURCE_ID}:manga:unknown`

        let seriesTitle = "Unknown"
        let coverUrl: string | undefined
        if (seriesId) {
            try {
                const seriesHtml = await context.request.getText(new URL(`${ORIGIN}/series/${seriesId}`), {
                    headers: BROWSER_HEADERS
                })
                seriesTitle = extractSeriesTitle(seriesHtml, seriesId)
                coverUrl = extractCoverUrl(seriesHtml)
            } catch {
                seriesTitle = seriesId
            }
        }

        const manga: SourceManga = {
            manga: {
                id: mangaRecordId,
                title: seriesTitle,
                normalizedTitle: seriesTitle.toLocaleLowerCase("en"),
                ...(coverUrl ? { coverUrl } : {}),
                authors: [],
                status: "unknown",
                addedAt: now,
                updatedAt: now
            },
            sourceId: SOURCE_ID,
            sourceMangaId: seriesId ?? chapterId,
            url: seriesId ? `${ORIGIN}/series/${seriesId}` : `${ORIGIN}/chapters/${chapterId}/`
        }

        const fullChapterId = `${SOURCE_ID}:chapter:${chapterId}`
        const chapter: SourceChapter = {
            id: fullChapterId,
            mangaId: mangaRecordId,
            sourceId: SOURCE_ID,
            sourceChapterId: chapterId,
            title: chapterTitle,
            url: chapterPageUrl,
            sortKey,
            language: "en"
        }

        const pages = imageUrls.map((url, i) => ({ id: `${fullChapterId}:page:${i + 1}`, url }))
        context.logger.debug("Resolved Weeb Central chapter", { chapterId, pageCount: pages.length })
        return { manga, chapter, pages }
    }
}
