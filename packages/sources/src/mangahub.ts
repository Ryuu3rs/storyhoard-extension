import {
    SourceError,
    SourceRequestError,
    decodeHtmlEntities as decodeEntities,
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

const SOURCE_ID = "mangahub"
const ORIGIN = "https://mangahub.io"
const DOMAIN = "mangahub.io"

// mangahub.io's chapter-list pages carry two anchor styles per real chapter: a
// canonical one (href .../chapter-{N} where N really is the chapter number) and an
// "alternate version" id-slug one (href .../chapter-{internalId} where internalId is a
// SITE-WIDE sequential counter observed up to ~2.65 million, completely unrelated to
// any single manga's chapter count). This is a floor on that counter, NOT a ceiling on
// real chapter counts - no series on this site has anywhere near 100k chapters, so any
// bare href number at or above this is treated as an internal id rather than a genuine
// chapter number. Exported so resolveChapter below reuses the exact same threshold
// instead of a second copy of the magic number.
export const INTERNAL_ID_MIN = 100_000

// MangaHub's /search route is server-rendered (confirmed via direct fetch - no
// __NEXT_DATA__ blob, no GraphQL call needed): each result is a plain
// `<div class="media-manga media">` card in the initial HTML response, and
// pagination is a normal link-driven `/search/page/{n}` route. Fetch a handful
// of pages and concatenate, same approach as browsing the site with JS off.
const SEARCH_MAX_PAGES = 3

const BROWSER_HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    Referer: ORIGIN
}

// The site adds a numeric suffix to many series ids (solo-leveling_105), and redirects the plain
// id to the suffixed page.
function withoutSiteSuffix(slug: string): string {
    return slug.replace(/_\d+$/, "") || slug
}

function captureGroup(m: RegExpMatchArray, i: number): string | undefined {
    const v = m[i]
    return typeof v === "string" ? v : undefined
}

function cleanTitle(raw: string): string {
    return raw
        .replace(/^Read\s+/i, "")
        .replace(/\s+Manga\s+Online(\s+for\s+Free)?$/i, "")
        .trim()
}

function extractTitle(html: string, fallback: string): string {
    const og =
        html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) ??
        html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:title"/i)
    if (og) {
        const raw = decodeEntities(captureGroup(og, 1) ?? "")
        const cleaned = cleanTitle(raw)
        if (cleaned.length > 1) return cleaned
    }
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    if (title) {
        const raw = decodeEntities((captureGroup(title, 1) ?? "").replace(/<[^>]+>/g, "").trim())
        const cleaned = cleanTitle(raw)
        if (cleaned.length > 1) return cleaned
    }
    return fallback
}

function extractCover(html: string): string | undefined {
    const patterns = [
        /<meta[^>]+property="og:image"[^>]+content="(https?:\/\/[^"]+)"/i,
        /<meta[^>]+content="(https?:\/\/[^"]+)"[^>]+property="og:image"/i
    ]
    for (const p of patterns) {
        const m = html.match(p)
        if (m) return captureGroup(m, 1)
    }
    return undefined
}

// Chapter URLs: https://mangahub.io/chapter/{chSlug}/chapter-{N}
// chSlug may differ from manga slug (e.g. solo-leveling_105 vs solo-leveling).
// Extract N as a float for sort order.
function parseChapterNumber(chapterPath: string): number | undefined {
    const m = chapterPath.match(/\/chapter-(\d+(?:\.\d+)?)\/?$/i)
    return m?.[1] !== undefined ? Number(m[1]) : undefined
}

// Chapter pages' <title>/og:title reliably read "... Chapter {N} ..." for real chapter
// pages. Used by resolveChapter as the primary source of truth for the true chapter
// number - see the INTERNAL_ID_MIN fallback below it for why the URL alone isn't enough.
function extractChapterNumberFromTitle(html: string): number | undefined {
    const og =
        html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) ??
        html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:title"/i)
    const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    for (const raw of [og ? captureGroup(og, 1) : undefined, titleTag ? captureGroup(titleTag, 1) : undefined]) {
        if (!raw) continue
        const m = decodeEntities(raw).match(/chapter\s+(\d+(?:\.\d+)?)/i)
        if (m?.[1] !== undefined) return Number(m[1])
    }
    return undefined
}

// Bounded on the inner-content capture ({0,600}?) as insurance against a pathological
// unterminated-anchor scan across a multi-MB document. `<a\b[^>]*?\bhref="` (rather than
// requiring href to be the very first attribute) tolerates markup variation like a
// leading class attribute.
const CHAPTER_ANCHOR_RE =
    /<a\b[^>]*?\bhref="(https?:\/\/mangahub\.io\/chapter\/([^/"]+)\/chapter-(\d+(?:\.\d+)?))"[^>]*>([\s\S]{0,600}?)<\/a>/gi

// Matches the visible "#<!-- -->{N}" chapter-number span's text content - the HTML
// comment is a React hydration artifact between the "#" and the digits, tolerated but
// not required (plain "#{N}" also matches).
const VISIBLE_CHAPTER_NUM_RE = /#(?:<!--\s*-->)?\s*(\d+(?:\.\d+)?)/

type ChapterAnchorMatch = {
    url: string
    slug: string
    slugNum: number
    innerHtml: string
}

function extractChapters(html: string, mangaId: string, expectedSlug: string): SourceChapter[] {
    const matches: ChapterAnchorMatch[] = []
    for (const m of html.matchAll(CHAPTER_ANCHOR_RE)) {
        const url = captureGroup(m, 1)
        const slug = captureGroup(m, 2)
        const slugNumRaw = captureGroup(m, 3)
        if (!url || !slug || slugNumRaw === undefined) continue
        matches.push({ url, slug, slugNum: Number(slugNumRaw), innerHtml: captureGroup(m, 4) ?? "" })
    }
    if (matches.length === 0) return []

    // Every mangahub page also carries a "you might also like" slider with chapter anchors for
    // OTHER titles, so only this title's own anchors count. Its id may be saved without the
    // site's suffix (black-clover for /chapter/black-clover_138/...), and the site redirects that
    // address to the suffixed page, whose anchors all carry the suffix. An exact match still wins,
    // in case the slider shows a different series that happens to share the base name.
    const exactMatches = matches.filter(match => match.slug === expectedSlug)
    const sameSlugMatches =
        exactMatches.length > 0
            ? exactMatches
            : matches.filter(match => withoutSiteSuffix(match.slug) === withoutSiteSuffix(expectedSlug))
    // The real slug has zero matched anchors at all - a genuine "no chapters found"
    // case, not a misattribution. Return empty rather than falling back to the
    // (foreign) vote winner's anchors.
    if (sameSlugMatches.length === 0) return []

    // Dedupe by the TRUE chapter number, not by URL - the canonical anchor and the
    // "alternate version" id-slug anchor for the same real chapter yield different URLs
    // but must collapse into a single chapter record.
    const byChNum = new Map<number, { url: string; canonical: boolean }>()
    for (const match of sameSlugMatches) {
        const visible = match.innerHtml.match(VISIBLE_CHAPTER_NUM_RE)
        let chNum: number | undefined
        if (visible?.[1] !== undefined) {
            chNum = Number(visible[1])
        } else if (match.slugNum < INTERNAL_ID_MIN) {
            // No visible number - only trust the href number itself when it's below the
            // internal-id floor. Otherwise this match is unusable, not a real chapter.
            chNum = match.slugNum
        }
        if (chNum === undefined || !Number.isFinite(chNum)) continue

        const canonical = match.slugNum === chNum
        const existing = byChNum.get(chNum)
        if (!existing) {
            byChNum.set(chNum, { url: match.url, canonical })
            continue
        }
        // A canonical-shaped match always wins over an id-slug match for the same
        // chNum, regardless of encounter order in the document. If BOTH matches are
        // canonical-shaped (shouldn't normally happen after the same-slug filter above,
        // but handled defensively), the FIRST one wins - never let a later canonical
        // match silently replace an earlier one via plain last-write-wins Map semantics.
        if (canonical && !existing.canonical) {
            byChNum.set(chNum, { url: match.url, canonical })
        }
    }

    const out: SourceChapter[] = []
    for (const [chNum, entry] of byChNum) {
        const chNumStr = String(chNum)
        out.push({
            id: `${SOURCE_ID}:chapter:${mangaId.replace(`${SOURCE_ID}:manga:`, "")}:${chNumStr}`,
            mangaId,
            sourceId: SOURCE_ID,
            sourceChapterId: chNumStr,
            title: `Chapter ${chNumStr}`,
            url: entry.url,
            sortKey: chNum,
            language: "en"
        })
    }
    out.sort((a, b) => a.sortKey - b.sortKey)
    return out
}

// Chapter page images - extracted after tab render (JS-driven reader).
// MangaHub renders <img> tags whose CDN URL (mhcdn.net / mghcdn.com / imgx.mghubcdn.com)
// may live on any of several attributes: the lazy-loader leaves the real URL on data-src
// (or data-original / data-lazy-src / srcset) until each image scrolls into view, so a
// single un-scrolled snapshot has real src only on the initial preload window. Walk every
// <img> in document order and take the first CDN URL it carries across all those attrs.
const CDN_URL_RE = /(https?:\/\/[^"'\s]*(?:mhcdn|mghcdn|mghubcdn)[^"'\s]+)/i

function extractImages(html: string): string[] {
    const urls: string[] = []
    const seen = new Set<string>()
    for (const tag of html.matchAll(/<img\b[^>]*>/gi)) {
        const el = tag[0]
        const candidates = [
            /\bsrc="([^"]+)"/i,
            /\bdata-src="([^"]+)"/i,
            /\bdata-original="([^"]+)"/i,
            /\bdata-lazy-src="([^"]+)"/i,
            /\bsrcset="([^",\s]+)/i
        ]
        for (const re of candidates) {
            const attr = el.match(re)
            const value = attr ? captureGroup(attr, 1) : undefined
            const cdn = value?.match(CDN_URL_RE)
            const u = cdn ? captureGroup(cdn, 1) : undefined
            if (u && !seen.has(u)) {
                seen.add(u)
                urls.push(u)
                break
            }
        }
    }
    return urls
}

// Search result cards look like:
// <div class="media-manga media">
//   <div class="media-left"><a href=".../manga/SLUG"><img src="COVER" alt="TITLE"/></a></div>
//   <div class="media-body"><h4 class="media-heading">[optional hot label]<a href=".../manga/SLUG">TITLE</a>...
//     <span><a href=".../chapter/SLUG/chapter-N">#N</a> chapters published (...)</span>
//     <p>...genre links...</p>
//   </div>
// </div>
// Split on the card marker so each block is scoped to one card; the last block
// trails off into unrelated page content (e.g. the "Popular" slider). The title
// match is already anchor-scoped (mangahub.io/manga/SLUG) so it can't leak, but
// the chapter number used to be a bare `chapter-(\d+)` scan over the WHOLE card
// block - for the last card that block runs to end-of-page, so a coincidental
// "chapter-N" anywhere in that trailing junk (or a future markup change putting
// the CDN cover URL or another link before the real chapter anchor) could win
// instead of the real one. Scope it to the actual chapter-link anchor's href.
const CHAPTER_LINK_RE = /<a\s+href="https?:\/\/(?:www\.)?mangahub\.io\/chapter\/[^"/]+\/chapter-(\d+(?:\.\d+)?)"/i

function extractSearchResults(html: string): SourceSearchResult[] {
    const blocks = [
        ...html.matchAll(/<div class="media-manga media">([\s\S]*?)(?=<div class="media-manga media">|$)/gi)
    ]
    const out: SourceSearchResult[] = []
    const seen = new Set<string>()
    const linkRe = /<a\s+href="https?:\/\/(?:www\.)?mangahub\.io\/manga\/([^"/]+)"[^>]*>([\s\S]*?)<\/a>/gi
    for (const block of blocks) {
        const scope = captureGroup(block, 1) ?? ""
        const anchors = [...scope.matchAll(linkRe)]
        const slug = anchors[0] ? captureGroup(anchors[0], 1) : undefined
        if (!slug || seen.has(slug)) continue
        seen.add(slug)
        // The thumbnail anchor wraps only an <img> (no text); the heading anchor
        // has the title text - take the first anchor with non-empty text.
        let title = ""
        for (const a of anchors) {
            const text = decodeEntities((captureGroup(a, 2) ?? "").replace(/<[^>]+>/g, "").trim())
            if (text.length > 0) {
                title = text
                break
            }
        }
        if (!title) title = slug.replace(/-/g, " ")
        const imgMatch = scope.match(/<img\b[^>]+src="(https?:\/\/[^"]+)"/i)
        const coverUrl = imgMatch ? captureGroup(imgMatch, 1) : undefined
        const chapMatch = scope.match(CHAPTER_LINK_RE)
        const latestChapter = chapMatch ? captureGroup(chapMatch, 1) : undefined
        out.push({
            sourceId: SOURCE_ID,
            sourceMangaId: slug,
            title,
            url: `${ORIGIN}/manga/${slug}`,
            ...(coverUrl ? { coverUrl } : {}),
            ...(latestChapter ? { latestChapter } : {})
        })
    }
    return out
}

export const mangahubAdapter: SourceAdapter = {
    manifest: {
        id: SOURCE_ID,
        name: "MangaHub",
        domains: [DOMAIN, `www.${DOMAIN}`],
        languages: ["en"],
        capabilities: ["pages", "chapters"],
        requestRateLimit: { requests: 2, intervalMs: 2000 },
        fixtureVersion: 1,
        homepage: ORIGIN
    },

    match(url: URL): SourcePageMatch {
        if (url.hostname !== DOMAIN && url.hostname !== `www.${DOMAIN}`) return "none"
        if (url.pathname.startsWith("/manga/") && url.pathname.split("/").filter(Boolean).length === 2) return "manga"
        if (url.pathname.startsWith("/chapter/") && url.pathname.includes("/chapter-")) return "chapter"
        return "none"
    },

    // Map a manga OR chapter URL to the manga slug. Without this, a chapter URL added by
    // paste (where the CF-gated resolveChapter can be blocked and the add falls back to
    // generic tracking) had its slug derived from the path, which is /chapter/{chSlug}/...
    // - so the first segment "chapter" became the slug, producing mangahub:manga:chapter
    // titled "Chapter" that could never refresh. chSlug carries an optional _<n> suffix
    // that differs from the manga slug (solo-leveling_105 vs solo-leveling); strip it,
    // matching resolveChapter's own derivation.
    parseMangaUrl(url: URL): { sourceMangaId: string; mangaUrl: string } | null {
        if (url.hostname !== DOMAIN && url.hostname !== `www.${DOMAIN}`) return null
        const parts = url.pathname.split("/").filter(Boolean)
        let slug: string | undefined
        if (parts[0] === "manga") slug = parts[1]
        else if (parts[0] === "chapter" && parts[1]) slug = withoutSiteSuffix(parts[1])
        if (!slug) return null
        return { sourceMangaId: slug, mangaUrl: `${ORIGIN}/manga/${slug}` }
    },

    normalizeSourceMangaId(sourceMangaId: string): string {
        return withoutSiteSuffix(sourceMangaId)
    },

    async resolveManga(input: ResolveMangaInput, ctx: SourceContext): Promise<SourceManga> {
        const slug = input.sourceMangaId ?? input.url?.pathname.split("/").filter(Boolean)[1]
        if (!slug) throw new SourceError("invalid-input", "No manga slug")
        const url = new URL(`${ORIGIN}/manga/${slug}`)
        const html = await ctx.request.getText(url, { headers: BROWSER_HEADERS })
        const title = extractTitle(html, slug)
        const coverUrl = extractCover(html)
        return {
            manga: {
                id: `${SOURCE_ID}:manga:${slug}`,
                title,
                normalizedTitle: title.toLocaleLowerCase("en").replace(/\s+/g, " "),
                authors: [],
                status: "unknown",
                ...(coverUrl ? { coverUrl } : {}),
                addedAt: ctx.now(),
                updatedAt: ctx.now()
            },
            sourceId: SOURCE_ID,
            sourceMangaId: slug,
            url: url.toString()
        }
    },

    async resolveCover(input: { sourceMangaId?: string; url?: URL }, ctx: SourceContext): Promise<string | undefined> {
        const slug = input.sourceMangaId ?? input.url?.pathname.split("/").filter(Boolean)[1]
        if (!slug) return undefined
        try {
            const url = new URL(`${ORIGIN}/manga/${slug}`)
            const html = await ctx.request.getText(url, { headers: BROWSER_HEADERS })
            return extractCover(html)
        } catch {
            return undefined
        }
    },

    async listChapters(input: ListChaptersInput, ctx: SourceContext): Promise<SourceChapter[]> {
        const { manga } = input
        const mangaUrl = new URL(manga.url)
        const html = await ctx.request.getText(mangaUrl, { headers: BROWSER_HEADERS })
        return extractChapters(html, manga.manga.id, manga.sourceMangaId)
    },

    async search(query: string, ctx: SourceContext): Promise<SourceSearchResult[]> {
        const trimmed = query.trim()
        if (!trimmed) return []

        const out: SourceSearchResult[] = []
        const seen = new Set<string>()
        for (let page = 1; page <= SEARCH_MAX_PAGES; page++) {
            const url = new URL(`${ORIGIN}/search/page/${page}`)
            url.searchParams.set("q", trimmed)
            url.searchParams.set("order", "POPULAR")
            url.searchParams.set("genre", "all")

            let html: string
            try {
                html = await ctx.request.getText(url, { headers: BROWSER_HEADERS })
            } catch {
                // Stop paginating on a request failure but keep whatever earlier
                // pages already yielded rather than discarding partial results.
                break
            }

            const pageResults = extractSearchResults(html)
            if (pageResults.length === 0) break

            for (const r of pageResults) {
                if (seen.has(r.sourceMangaId)) continue
                seen.add(r.sourceMangaId)
                out.push(r)
            }
        }
        return out
    },

    async resolveChapter(input: ResolveChapterInput, ctx: SourceContext): Promise<ResolvedChapter> {
        if (!input.url) throw new SourceError("invalid-input", "Chapter URL required for MangaHub")
        const url = input.url

        // Chapter pages are behind Cloudflare JS challenge - tab render required.
        // When the user is already on the page the browser has cf_clearance; SW fetch
        // may succeed. If blocked (403/challenge HTML), fall through to tab render.
        let html: string
        try {
            html = await ctx.request.getText(url, { headers: BROWSER_HEADERS })
        } catch (e) {
            // Only convert known CDN/reverse-proxy block statuses to "blocked" - other
            // errors (404, network timeout, parse failure) should surface as-is instead
            // of masking the real cause and wasting a tab-render fallback attempt.
            if (e instanceof SourceRequestError && (e.status === 403 || e.status === 502 || e.status === 503)) {
                throw new SourceRequestError("blocked", e.status)
            }
            throw e
        }
        // Cloudflare challenge response - treat as blocked
        if (html.includes("__CF$cv$params") || html.includes("/cdn-cgi/challenge-platform/")) {
            throw new SourceRequestError("blocked")
        }

        const images = extractImages(html)
        if (images.length === 0) throw new SourceRequestError("blocked")

        const pathParts = url.pathname.split("/").filter(Boolean)
        const chSlug = pathParts[1] ?? ""
        const mangaSlug = withoutSiteSuffix(chSlug)

        // Derive the TRUE chapter number - never fall back to 0. Id-slug chapter URLs
        // (.../chapter-{internalId}) actually 302-REDIRECT to the plain manga page (not
        // a 404/error), which is the COMMON outcome when resolving through one of these
        // - the redirect lands on a page whose title has no chapter number at all. A
        // silent 0-fallback here would create a "Chapter 0" record (sortKey 0, which is
        // BELOW INTERNAL_ID_MIN so no junk-purge would ever catch it) and flow into
        // lastReadChapterNumber via the normal save-progress path, silently corrupting a
        // user's real reading position downward.
        const titleChNum = extractChapterNumberFromTitle(html)
        const slugNum = parseChapterNumber(url.pathname)
        const chNum = titleChNum ?? (slugNum !== undefined && slugNum < INTERNAL_ID_MIN ? slugNum : undefined)
        if (chNum === undefined) {
            throw new SourceError(
                "invalid-response",
                "Could not determine the chapter number for this MangaHub chapter"
            )
        }

        const listUrl = new URL(`${ORIGIN}/manga/${mangaSlug}`)
        const manga: SourceManga = {
            manga: {
                id: `${SOURCE_ID}:manga:${mangaSlug}`,
                title: mangaSlug,
                normalizedTitle: mangaSlug,
                authors: [],
                status: "unknown",
                addedAt: ctx.now(),
                updatedAt: ctx.now()
            },
            sourceId: SOURCE_ID,
            sourceMangaId: mangaSlug,
            url: listUrl.toString(),
            // A title added from search keeps the site's suffix. Reading it must not start a second entry.
            ...(chSlug !== mangaSlug ? { formerSourceMangaIds: [chSlug] } : {})
        }

        return {
            manga,
            chapter: {
                id: `${SOURCE_ID}:chapter:${mangaSlug}:${chNum}`,
                mangaId: `${SOURCE_ID}:manga:${mangaSlug}`,
                sourceId: SOURCE_ID,
                sourceChapterId: String(chNum),
                title: `Chapter ${chNum}`,
                url: url.toString(),
                sortKey: chNum,
                language: "en"
            },
            pages: images.map((imgUrl, i) => ({ id: String(i), url: imgUrl }))
        }
    }
}
