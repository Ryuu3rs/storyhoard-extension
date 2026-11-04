import {
    SourceError,
    SourceRequestError,
    UNNUMBERED_SORT_KEY,
    decodeHtmlEntities as decodeEntities,
    matchesSourceDomain,
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

// Config-driven adapter for the MangaStream / MangaReader (Theme: ts) WordPress
// family. One factory covers the whole template - a new site is a config row.
// Chapter pages embed images in a `ts_reader.run({...sources:[{images:[]}]})`
// blob and/or a `#readerarea` block.
export type MangaStreamConfig = {
    id: string
    name: string
    origin: string
    domains: string[]
    // Series URL base, e.g. "manga" -> /manga/<slug>/. Default "manga".
    mangaPath?: string
    language?: string
    rateLimit?: { requests: number; intervalMs: number }
    // "hierarchical": chapters live at /<mangaPath>/<manga-slug>/<num>/ instead of
    // the flat root slug containing "chapter". Use for sites like KappaBeast.
    chapterFormat?: "flat" | "hierarchical"
    // Extra origin patterns for a cover/page-image CDN host that differs from this
    // site's own domain(s) - see SourceManifest.imageOrigins in @amr/source-sdk.
    imageOrigins?: readonly string[]
}

function captureGroup(match: RegExpMatchArray, index: number): string | undefined {
    const v = match[index]
    return typeof v === "string" ? v : undefined
}

// Navigation / widget labels that leak into a whole-page anchor scan. A real
// search result is a manga title, never one of these control labels.
const JUNK_TITLES = new Set([
    "top",
    "latest",
    "completed",
    "ongoing",
    "popular",
    "hot",
    "new",
    "new titles",
    "updated",
    "update",
    "trending",
    "recommended",
    "random",
    "genres",
    "genre",
    "bookmark",
    "bookmarks",
    "home",
    "manga",
    "manga list",
    "comics",
    "all",
    "view all",
    "see all",
    "a-z",
    "advanced search",
    "search",
    "more",
    "login",
    "register"
])

function isJunkTitle(title: string): boolean {
    const t = title.trim().toLowerCase()
    return t.length < 2 || JUNK_TITLES.has(t)
}

function getImgAttr(tag: string, ...attrNames: string[]): string | undefined {
    for (const attr of attrNames) {
        const escaped = attr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const dq = tag.match(new RegExp(`\\b${escaped}="([^"]*)"`, "i"))
        if (dq) {
            const v = captureGroup(dq, 1)
            if (v && !v.startsWith("data:") && v.startsWith("http")) return v
        }
        const sq = tag.match(new RegExp(`\\b${escaped}='([^']*)'`, "i"))
        if (sq) {
            const v = captureGroup(sq, 1)
            if (v && !v.startsWith("data:") && v.startsWith("http")) return v
        }
    }
    return undefined
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function extractStreamImages(html: string): string[] {
    // Strategy 1: ts_reader.run({...}) JSON with sources[].images[].
    const tsMatch = html.match(/ts_reader\.run\((\{[\s\S]*?\})\)\s*;?/)
    const raw = tsMatch ? captureGroup(tsMatch, 1) : undefined
    if (raw) {
        try {
            const cfg = JSON.parse(raw) as { sources?: Array<{ images?: unknown }> }
            for (const source of cfg.sources ?? []) {
                if (Array.isArray(source.images)) {
                    const urls = source.images.filter((u): u is string => typeof u === "string" && u.startsWith("http"))
                    if (urls.length > 0) return urls
                }
            }
        } catch {
            // fall through to DOM scan
        }
    }

    // Strategy 2: imgs inside #readerarea.
    const area = html.match(/<div[^>]*\bid=["']readerarea["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)
    const scope = area ? (captureGroup(area, 1) ?? html) : html
    const tags = [...scope.matchAll(/<img\b[^>]*>/gi)].map(m => captureGroup(m, 0) ?? "").filter(Boolean)
    const urls = tags
        .map(t => getImgAttr(t, "src", "data-src", "data-lazy-src"))
        .filter((u): u is string => u !== undefined && /\.(jpe?g|png|webp|gif)/i.test(u))
    return urls
}

function extractCoverUrl(html: string): string | undefined {
    const patterns = [
        /<meta\s[^>]*\bproperty="og:image"\s[^>]*\bcontent="(https?:\/\/[^"]+)"/i,
        /<meta\s[^>]*\bcontent="(https?:\/\/[^"]+)"\s[^>]*\bproperty="og:image"/i,
        /<meta\s[^>]*\bname="twitter:image"\s[^>]*\bcontent="(https?:\/\/[^"]+)"/i
    ]
    for (const p of patterns) {
        const m = html.match(p)
        const v = m ? captureGroup(m, 1) : undefined
        if (v) return v
    }
    // A series page with no share tags still marks its own cover. Related-series thumbnails are not marked.
    const marked = html.match(/\bclass="thumb"[^>]*\bitemprop="image"[^>]*>\s*<img\b[^>]*>/i)?.[0]
    return marked?.match(/\b(?:data-src|src)="(https?:\/\/[^"]+)"/i)?.[1]
}

function extractGenres(html: string): string[] {
    const mgenMatch = html.match(/<span[^>]*\bclass=["'][^"']*\bmgen\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)
    const scope = mgenMatch ? (captureGroup(mgenMatch, 1) ?? "") : html
    const anchors = [...scope.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)]
    const out: string[] = []
    const seen = new Set<string>()
    for (const a of anchors) {
        const href = captureGroup(a, 1) ?? ""
        if (!mgenMatch && !/\/genres?\//i.test(href)) continue
        const text = sanitizeScrapedText(captureGroup(a, 2) ?? "")
        const key = text.toLowerCase()
        if (text.length < 2 || seen.has(key)) continue
        seen.add(key)
        out.push(text)
        if (out.length >= 15) break
    }
    return out
}

// Sites separate a title from their name with a hyphen, a bar, or a typographic dash.
const TITLE_SEPARATOR = new RegExp(`\\s+[-|${String.fromCodePoint(0x2013, 0x2014)}]\\s+`)

function extractTitle(html: string, fallbackSlug: string): string {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/)
    const titleText = titleMatch ? captureGroup(titleMatch, 1) : undefined
    if (titleText) {
        // Whitespace required on both sides - a bare hyphen inside a word (e.g.
        // "Max-Level") isn't a "<title> - <site>" boundary and shouldn't be split on.
        const cleaned = sanitizeScrapedText(titleText)
            .split(TITLE_SEPARATOR)[0]
            ?.replace(/\s+Chapter\s+\d[\d.]*$/i, "")
            .trim()
        if (cleaned) return cleaned
    }
    return fallbackSlug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())
}

export function createMangaStreamAdapter(config: MangaStreamConfig): SourceAdapter {
    const mangaPath = config.mangaPath ?? "manga"
    const language = config.language ?? "en"
    const isHierarchical = config.chapterFormat === "hierarchical"
    const escPath = escapeRegex(mangaPath)
    const mangaRe = new RegExp(`^/${escPath}/([^/]+)/?$`)
    // Hierarchical: /<mangaPath>/<manga-slug>/<chapter-num>/
    // Flat (default): root slug containing the word "chapter"
    const chapterRe: RegExp = isHierarchical
        ? new RegExp(`^/${escPath}/([^/]+)/(\\d+(?:[.-]\\d+)?)/?$`)
        : /^\/([a-z0-9][a-z0-9._-]*chapter[a-z0-9._-]*)\/?$/i

    const browserHeaders = {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        Referer: config.origin + "/"
    }

    function chapterSlug(url: URL): string | undefined {
        if (!matchesSourceDomain(url.hostname, config.domains)) return undefined
        if (isHierarchical) {
            const m = url.pathname.match(chapterRe)
            return m ? `${m[1]}/${m[2]}` : undefined
        }
        return url.pathname.match(chapterRe)?.[1]
    }

    function mangaSlug(url: URL): string | undefined {
        if (!matchesSourceDomain(url.hostname, config.domains)) return undefined
        return url.pathname.match(mangaRe)?.[1]
    }

    // The series a chapter page says it belongs to. A flat chapter address can keep a series name the
    // site has since changed, so this is the only reliable way from a chapter to its series.
    function seriesLinkOf(html: string): { slug: string; title: string } | undefined {
        const link = html.match(/\bclass="allc"[^>]*>[\s\S]*?<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
        if (!link) return undefined
        try {
            const slug = mangaSlug(new URL(captureGroup(link, 1) ?? "", config.origin))
            return slug ? { slug, title: sanitizeScrapedText(captureGroup(link, 2) ?? "") } : undefined
        } catch {
            return undefined
        }
    }

    // undefined when nothing parses (unnumbered special) - never default to "1", which
    // collided such chapters with the real Chapter 1 and defeated the UNNUMBERED sentinel.
    function chapterNumberOf(slug: string): string | undefined {
        if (isHierarchical) {
            return slug.split("/").pop()?.replace("-", ".")
        }
        const m = slug.match(/chapter[-_ ]?(\d+(?:[.-]\d+)?)/i)
        const raw = m ? captureGroup(m, 1) : undefined
        return raw ? raw.replace("-", ".") : undefined
    }

    // MangaStream/Asura render search hits inside `.listupd`; each card is an
    // anchor carrying a `title` attribute. Scope to that region and require the
    // title attribute so nav/sidebar links never leak in as fake results.
    function extractSearchResults(html: string): SourceSearchResult[] {
        const originPath = `${escapeRegex(config.origin)}/${escPath}`
        const listIdx = html.search(/class=["'][^"']*\blistupd\b/i)
        const region = listIdx === -1 ? html : html.slice(listIdx)
        const itemRe = new RegExp(`<a\\s+href="(${originPath}/([^"/]+)/?)"[^>]*\\stitle="([^"]+)"`, "gi")
        const out: SourceSearchResult[] = []
        const seen = new Set<string>()
        for (const m of region.matchAll(itemRe)) {
            const url = captureGroup(m, 1)
            const slug = captureGroup(m, 2)
            const rawTitle = captureGroup(m, 3)
            if (!url || !slug || !rawTitle || seen.has(slug)) continue
            const title = decodeEntities(rawTitle).trim()
            if (isJunkTitle(title)) continue
            seen.add(slug)
            out.push({
                sourceId: config.id,
                sourceMangaId: slug,
                title: title || slug.replace(/-/g, " "),
                url
            })
        }
        return out
    }

    function extractChapterList(html: string, slug: string): SourceChapter[] {
        const mangaId = `${config.id}:manga:${slug}`
        const out: SourceChapter[] = []
        const seen = new Set<string>()

        // restrictSlug (used only by the whole-page fallback) requires a flat chapter slug
        // to belong to THIS series: `<manga-slug>-chapter-N`. Without it the fallback would
        // swallow "Latest Update"/recommended widget links to OTHER series' chapters that
        // merely contain "chapter" in the last segment, inventing foreign chapters (and false
        // "new chapter" notifications). The <li> pass passes no restrictSlug - it's already
        // scoped to the chapter-list container.
        function pushHref(href: string, restrictSlug?: string): void {
            let absolute: URL
            try {
                absolute = new URL(href, config.origin)
            } catch {
                return
            }
            let cslug: string
            if (isHierarchical) {
                const m = absolute.pathname.match(chapterRe)
                if (!m) return
                cslug = `${m[1]}/${m[2]}`
            } else {
                if (!matchesSourceDomain(absolute.hostname, config.domains)) return
                const lastSeg = absolute.pathname.replace(/\/$/, "").split("/").pop()
                if (!lastSeg || !/chapter/i.test(lastSeg)) return
                // Belongs-to-this-series check for the whole-page fallback: the slug must be a
                // prefix AND `chapter` must appear as a later token. Allowing intervening tokens
                // keeps legit specials/extras (<slug>-extra-chapter-1, <slug>-season-2-chapter-1)
                // while still excluding OTHER series' links (solo-leveling-chapter-200).
                if (
                    restrictSlug &&
                    !(
                        lastSeg.startsWith(restrictSlug) &&
                        /(?:^|-)chapter[-_]/i.test(lastSeg.slice(restrictSlug.length))
                    )
                )
                    return
                cslug = lastSeg
            }
            if (seen.has(cslug)) return
            seen.add(cslug)
            const number = chapterNumberOf(cslug)
            out.push({
                id: `${config.id}:chapter:${cslug}`,
                mangaId,
                sourceId: config.id,
                sourceChapterId: cslug,
                title: number ? `Chapter ${number}` : cslug,
                url: absolute.toString(),
                sortKey: parseChapterNumber(number) ?? UNNUMBERED_SORT_KEY,
                language
            })
        }

        const items = [...html.matchAll(/<li[^>]*\bdata-num=["']([^"']+)["'][^>]*>([\s\S]*?)<\/li>/gi)]
        const fallback = items.length === 0 ? [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)] : []
        const blocks =
            items.length > 0 ? items.map(m => captureGroup(m, 2) ?? "") : fallback.map(m => captureGroup(m, 1) ?? "")
        for (const block of blocks) {
            const a = block.match(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
            const href = a ? captureGroup(a, 1) : undefined
            if (href) pushHref(href)
        }

        // Theme-variant fallback: some ts-family sites (e.g. Spider Scans) dropped the
        // <li data-num> #chapterlist markup and render the list as bare <a href> cards
        // pointing at /chapter/<manga-slug>-chapter-N. Only when the <li> pass found
        // nothing (flat sites only - hierarchical relies on the path-shape match) scan
        // every same-domain anchor whose last segment looks like a chapter. Dedup by
        // slug keeps the Start-Reading / First nav buttons from double-counting.
        if (out.length === 0 && !isHierarchical) {
            for (const m of html.matchAll(/<a\s+[^>]*\bhref=["']([^"']+)["']/gi)) {
                const href = captureGroup(m, 1)
                if (href) pushHref(href, slug)
            }
        }

        return out
    }

    return {
        manifest: {
            id: config.id,
            name: config.name,
            domains: config.domains,
            languages: [language],
            capabilities: ["pages", "chapters"],
            requestRateLimit: config.rateLimit ?? { requests: 3, intervalMs: 1000 },
            fixtureVersion: 1,
            homepage: config.origin,
            ...(config.imageOrigins ? { imageOrigins: config.imageOrigins } : {})
        },

        // Resolve the manga from a URL so mark-read tracks the right title when a
        // CF-gated resolveChapter is blocked on the paste path, and so chapter:siblings
        // can resolve the manga for its number fallback. A series URL always yields the
        // slug; a hierarchical chapter URL (/mangaPath/slug/num) carries it too. A FLAT
        // chapter URL (a root slug containing "chapter") does NOT contain the manga slug,
        // so return null there rather than guessing a wrong one - resolveChapter reads it
        // from the page in that case.
        parseMangaUrl(url: URL): { sourceMangaId: string; mangaUrl: string } | null {
            const series = mangaSlug(url)
            if (series) return { sourceMangaId: series, mangaUrl: `${config.origin}/${mangaPath}/${series}/` }
            if (isHierarchical) {
                const slug = url.pathname.match(chapterRe)?.[1]
                if (slug) return { sourceMangaId: slug, mangaUrl: `${config.origin}/${mangaPath}/${slug}/` }
            }
            return null
        },

        match(url: URL): SourcePageMatch {
            if (chapterSlug(url)) return "chapter"
            if (mangaSlug(url)) return "manga"
            return "none"
        },

        async resolveManga(input: ResolveMangaInput, context: SourceContext): Promise<SourceManga> {
            const slug = input.url ? mangaSlug(input.url) : input.sourceMangaId
            if (!slug) throw new SourceError("invalid-input", `A valid ${config.name} manga URL is required`)
            const now = context.now()
            const title = slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())
            return {
                manga: {
                    id: `${config.id}:manga:${slug}`,
                    title,
                    normalizedTitle: title.toLowerCase(),
                    authors: [],
                    status: "unknown",
                    addedAt: now,
                    updatedAt: now
                },
                sourceId: config.id,
                sourceMangaId: slug,
                url: `${config.origin}/${mangaPath}/${slug}/`
            }
        },

        async listChapters(input: ListChaptersInput, context: SourceContext): Promise<SourceChapter[]> {
            const slug = input.manga.sourceMangaId
            if (!slug) throw new SourceError("invalid-input", `A valid ${config.name} manga id is required`)
            const html = await context.request.getText(new URL(`${config.origin}/${mangaPath}/${slug}/`), {
                headers: browserHeaders
            })
            const chapters = extractChapterList(html, slug)
            chapters.sort((a, b) => a.sortKey - b.sortKey)
            return input.limit ? chapters.slice(-input.limit) : chapters
        },

        async resolveCover(
            input: { sourceMangaId?: string; url?: URL },
            context: SourceContext
        ): Promise<string | undefined> {
            const slug = input.sourceMangaId ?? (input.url ? mangaSlug(input.url) : undefined)
            if (!slug) return undefined
            try {
                const html = await context.request.getText(new URL(`${config.origin}/${mangaPath}/${slug}/`), {
                    headers: browserHeaders
                })
                return extractCoverUrl(html)
            } catch {
                return undefined
            }
        },

        async findMovedSeries(input, context) {
            for (const url of input.chapterUrls.slice(0, 3)) {
                if (!chapterSlug(url)) continue
                try {
                    const series = seriesLinkOf(await context.request.getText(url, { headers: browserHeaders }))
                    if (series) {
                        return {
                            sourceMangaId: series.slug,
                            mangaUrl: `${config.origin}/${mangaPath}/${series.slug}/`,
                            ...(series.title ? { title: series.title } : {})
                        }
                    }
                } catch {
                    // That chapter is gone too. An older one may still answer.
                }
            }
            return null
        },

        async resolveGenres(input: { sourceMangaId?: string; url?: URL }, context: SourceContext): Promise<string[]> {
            const slug = input.sourceMangaId ?? (input.url ? mangaSlug(input.url) : undefined)
            if (!slug) return []
            try {
                const html = await context.request.getText(new URL(`${config.origin}/${mangaPath}/${slug}/`), {
                    headers: browserHeaders
                })
                return extractGenres(html)
            } catch {
                return []
            }
        },

        async search(query: string, context: SourceContext): Promise<SourceSearchResult[]> {
            const url = new URL(`${config.origin}/`)
            url.searchParams.set("s", query)
            try {
                const html = await context.request.getText(url, { headers: browserHeaders })
                return extractSearchResults(html)
            } catch {
                return []
            }
        },

        async resolveChapter(input: ResolveChapterInput, context: SourceContext): Promise<ResolvedChapter> {
            if (!input.url) throw new SourceError("invalid-input", "A chapter URL is required")
            const slug = chapterSlug(input.url)
            if (!slug) throw new SourceError("unsupported-url", "This chapter URL is not supported")

            const html = await context.request.getText(input.url, { headers: browserHeaders })
            const imageUrls = extractStreamImages(html)
            if (imageUrls.length === 0) {
                const isBlocked =
                    /cf_chl|challenge-platform|cf-browser-verification|__cf_chl_captcha|ddos-guard\.net/i.test(html)
                const msg = `No images found [html:${html.length}b blocked=${isBlocked}]`
                if (isBlocked)
                    throw new SourceRequestError("blocked", undefined, { url: input.url.toString(), debug: msg })
                throw new SourceError("invalid-response", msg)
            }

            const mangaSlugGuess = isHierarchical
                ? (slug.split("/")[0] ?? slug)
                : slug.replace(/-?chapter[-_]?\d.*$/i, "") || slug
            const series = isHierarchical ? undefined : seriesLinkOf(html)
            const seriesSlug = series?.slug ?? mangaSlugGuess
            const number = chapterNumberOf(slug)
            const coverUrl = extractCoverUrl(html)
            const title = series?.title || extractTitle(html, mangaSlugGuess)
            const now = context.now()
            const mangaId = `${config.id}:manga:${seriesSlug}`
            const chapterId = `${config.id}:chapter:${slug}`

            const manga: SourceManga = {
                manga: {
                    id: mangaId,
                    title,
                    normalizedTitle: title.toLocaleLowerCase("en"),
                    ...(coverUrl ? { coverUrl } : {}),
                    authors: [],
                    status: "unknown",
                    addedAt: now,
                    updatedAt: now
                },
                sourceId: config.id,
                sourceMangaId: seriesSlug,
                url: `${config.origin}/${mangaPath}/${seriesSlug}/`,
                ...(seriesSlug !== mangaSlugGuess ? { formerSourceMangaIds: [mangaSlugGuess] } : {})
            }

            const chapter: SourceChapter = {
                id: chapterId,
                mangaId,
                sourceId: config.id,
                sourceChapterId: slug,
                title: number ? `Chapter ${number}` : slug,
                url: input.url.toString(),
                sortKey: parseChapterNumber(number) ?? UNNUMBERED_SORT_KEY,
                language
            }

            const pages = imageUrls.map((url, i) => ({ id: `${chapterId}:page:${i + 1}`, url }))
            context.logger.debug(`Resolved ${config.name} chapter`, { chapterId, pageCount: pages.length })
            return { manga, chapter, pages }
        }
    }
}
