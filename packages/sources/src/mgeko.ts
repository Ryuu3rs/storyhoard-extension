import {
    SourceError,
    UNNUMBERED_SORT_KEY,
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

const SOURCE_ID = "mgeko"
const ORIGIN = "https://www.mgeko.cc"
const DOMAINS = ["mgeko.cc", "www.mgeko.cc"]

const BROWSER_HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    Referer: ORIGIN + "/"
}

function extractChapterSlug(url: URL): string | undefined {
    if (!matchesSourceDomain(url.hostname, DOMAINS)) return undefined
    const match = url.pathname.match(/^\/reader\/en\/([^/]+)\/?$/)
    return match?.[1]
}

function extractMangaSlug(url: URL): string | undefined {
    if (!matchesSourceDomain(url.hostname, DOMAINS)) return undefined
    const match = url.pathname.match(/^\/manga\/([^/]+)\/?$/)
    return match?.[1]
}

// Parse slug like "manga-title-chapter-52-eng-li" into parts
function parseChapterSlug(slug: string): { mangaSlug: string; chapterNumber: string | undefined; mangaTitle: string } {
    const chapterMatch = slug.match(/^(.*)-chapter-(\d+(?:-\d+)?)(?:-|$)/)
    if (chapterMatch) {
        const mangaSlug = chapterMatch[1] ?? slug
        const raw = chapterMatch[2] ?? "1"
        const chapterNumber = raw.replace("-", ".")
        const mangaTitle = mangaSlug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())
        return { mangaSlug, chapterNumber, mangaTitle }
    }
    // A "-chapter-" slug with no numeric token (e.g. "...-chapter-extra-...") is
    // unnumbered: leave chapterNumber undefined so the caller maps it to
    // UNNUMBERED_SORT_KEY instead of fabricating "1" and colliding with real Chapter 1.
    const mangaSlug = slug.replace(/-chapter-.*$/i, "") || slug
    const mangaTitle = mangaSlug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())
    return { mangaSlug, chapterNumber: undefined, mangaTitle }
}

function captureGroup(match: RegExpMatchArray, index: number): string | undefined {
    const v = match[index]
    return typeof v === "string" ? v : undefined
}

function tryParseJsonArray(raw: string): string[] {
    // Handle JS arrays with single-quoted strings
    try {
        const urls = JSON.parse(raw.replace(/'/g, '"')) as unknown[]
        return urls.filter((u): u is string => typeof u === "string" && u.startsWith("http"))
    } catch {
        return []
    }
}

function extractJsArrayVar(html: string, ...varNames: string[]): string[] {
    for (const name of varNames) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const m = html.match(
            new RegExp(`(?:var\\s+|window\\.)?${escaped}\\s*=\\s*(\\[[\\s\\S]*?\\])[;,]?\\s*(?:\\n|$)`)
        )
        if (m) {
            const raw = captureGroup(m, 1)
            if (raw) {
                const urls = tryParseJsonArray(raw)
                if (urls.length > 0) return urls
            }
        }
    }
    return []
}

function extractCoverUrl(html: string): string | undefined {
    const patterns = [
        /<meta\s[^>]*\bproperty="og:image"\s[^>]*\bcontent="(https?:\/\/[^"]+)"/i,
        /<meta\s[^>]*\bcontent="(https?:\/\/[^"]+)"\s[^>]*\bproperty="og:image"/i,
        /<meta\s[^>]*\bname="twitter:image"\s[^>]*\bcontent="(https?:\/\/[^"]+)"/i,
        /<meta\s[^>]*\bcontent="(https?:\/\/[^"]+)"\s[^>]*\bname="twitter:image"/i
    ]
    for (const p of patterns) {
        const m = html.match(p)
        const v = m ? captureGroup(m, 1) : undefined
        if (v) return v
    }
    return undefined
}

function extractGenres(html: string): string[] {
    const blockMatch = html.match(/<[^>]*\bclass=["'][^"']*\bgenres\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|ul|p)>/i)
    const scope = blockMatch ? (captureGroup(blockMatch, 1) ?? "") : html
    const anchors = [...scope.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)]
    const out: string[] = []
    const seen = new Set<string>()
    for (const a of anchors) {
        const href = captureGroup(a, 1) ?? ""
        if (!blockMatch && !/\/genre/i.test(href)) continue
        const text = sanitizeScrapedText(captureGroup(a, 2) ?? "")
        const key = text.toLowerCase()
        if (text.length < 2 || seen.has(key)) continue
        seen.add(key)
        out.push(text)
        if (out.length >= 15) break
    }
    return out
}

// The series a chapter page belongs to. Its address can keep a series name the site has since changed.
function seriesLinkOf(html: string): { slug: string; title: string } | undefined {
    const link = html.match(/<h1>\s*<a\s+href="\/manga\/([^"/]+)\/?"[^>]*\btitle="([^"]*)"/i)
    const slug = link ? captureGroup(link, 1) : undefined
    return link && slug ? { slug, title: sanitizeScrapedText(captureGroup(link, 2) ?? "") } : undefined
}

// A series id without what the site changes on its own: a short code in front ("dz91-") and a marker behind.
function stableSlug(slug: string): string {
    return slug.replace(/^(?=[a-z0-9]{3,5}-)[a-z]*\d[a-z0-9]*-/, "").replace(/-mg\d+$/, "")
}

function extractChapterList(html: string, mangaSlug: string): SourceChapter[] {
    const mangaId = `${SOURCE_ID}:manga:${mangaSlug}`
    const linkRe = /href="\/reader\/en\/([^"]+?)(?:\/)?"/gi
    const seen = new Set<string>()
    const chapters: SourceChapter[] = []
    // A renamed series lists chapters under both its names, so inside its own list no name check applies.
    const list = html.match(/<ul\b[^>]*\bchapter-list\b[^>]*>([\s\S]*?)<\/ul>/i)
    const scope = list ? captureGroup(list, 1) : undefined

    for (const m of (scope ?? html).matchAll(linkRe)) {
        const chapterSlug = m[1]
        if (!chapterSlug || seen.has(chapterSlug)) continue
        if (!scope && !chapterSlug.startsWith(`${mangaSlug}-chapter-`)) continue
        seen.add(chapterSlug)

        const { chapterNumber } = parseChapterSlug(chapterSlug)
        const chapterId = `${SOURCE_ID}:chapter:${chapterSlug}`

        chapters.push({
            id: chapterId,
            mangaId,
            sourceId: SOURCE_ID,
            sourceChapterId: chapterSlug,
            title: chapterNumber ? `Chapter ${chapterNumber}` : "Chapter",
            url: `${ORIGIN}/reader/en/${chapterSlug}/`,
            sortKey: parseChapterNumber(chapterNumber) ?? UNNUMBERED_SORT_KEY,
            language: "en"
        })
    }

    return chapters.sort((a, b) => b.sortKey - a.sortKey)
}

// Search results render as <li class="novel-item"> cards; the anchor's title
// attribute carries the clean manga title (its inner text mixes in author,
// chapter, and summary text). The cover is lazy-loaded: data-src holds the
// real (relative) image path, src holds a shared "loading.gif" placeholder.
function extractSearchResults(html: string): SourceSearchResult[] {
    const out: SourceSearchResult[] = []
    const seen = new Set<string>()
    for (const item of html.matchAll(/<li[^>]*\bnovel-item\b[^>]*>([\s\S]*?)<\/li>/gi)) {
        const block = item[1] ?? ""
        const anchorMatch = block.match(/<a\s+href="(\/manga\/([^"/]+)\/?)"[^>]*\btitle="([^"]*)"/i)
        if (!anchorMatch) continue
        const href = captureGroup(anchorMatch, 1)
        const slug = captureGroup(anchorMatch, 2)
        if (!href || !slug || seen.has(slug)) continue
        seen.add(slug)
        const title = sanitizeScrapedText(captureGroup(anchorMatch, 3) ?? "")
        if (title.length < 2) continue
        const imgTag = block.match(/<img\b[^>]*>/i)?.[0]
        const coverPath = imgTag?.match(/\bdata-src="([^"]+)"/i)?.[1] ?? imgTag?.match(/\bsrc="([^"]+)"/i)?.[1]
        const coverUrl =
            coverPath && !/loading\.gif$/i.test(coverPath) ? new URL(coverPath, ORIGIN).toString() : undefined
        out.push({
            sourceId: SOURCE_ID,
            sourceMangaId: slug,
            title,
            url: new URL(href, ORIGIN).toString(),
            ...(coverUrl ? { coverUrl } : {})
        })
    }
    return out
}

function extractImages(html: string): string[] {
    // Strategy 1: JS array variables (chapImages, chapterImages, imageList, images, pages)
    const jsArrayUrls = extractJsArrayVar(
        html,
        "chapImages",
        "chapterImages",
        "imageList",
        "images",
        "pages",
        "page_images"
    )
    if (jsArrayUrls.length > 0) return jsArrayUrls

    // Strategy 2: JSON object with images/pages key
    const jsonObjMatch = html.match(/["']?images["']?\s*:\s*(\[[\s\S]*?\])/)
    if (jsonObjMatch) {
        const raw = captureGroup(jsonObjMatch, 1)
        if (raw) {
            const urls = tryParseJsonArray(raw)
            if (urls.length > 0) return urls
        }
    }

    // Collect all img tags for attribute-order-safe extraction
    const imgTags = [...html.matchAll(/<img\b[^>]*>/gi)].map(m => captureGroup(m, 0) ?? "").filter(Boolean)

    function getImgUrl(tag: string): string | undefined {
        for (const attr of ["src", "data-src", "data-lazy-src"]) {
            const m = tag.match(new RegExp(`\\b${attr}="(https?://[^"]+)"`, "i"))
            const url = m ? captureGroup(m, 1) : undefined
            if (url && !url.startsWith("data:")) return url
        }
        return undefined
    }

    // Strategy 3: imgsrv CDN images
    const imgsrvTags = imgTags.filter(t => /imgsrv/i.test(t))
    if (imgsrvTags.length > 0) {
        const urls = imgsrvTags.map(getImgUrl).filter((u): u is string => u !== undefined)
        if (urls.length > 0) return urls
    }

    // Strategy 4: gallery block images
    const galleryMatches = [...html.matchAll(/<li[^>]*blocks-gallery-item[^>]*>[\s\S]*?<img\b[^>]*>/gi)]
        .map(m => captureGroup(m, 0) ?? "")
        .filter(Boolean)
    if (galleryMatches.length > 0) {
        const tagMatches = galleryMatches.flatMap(block =>
            [...block.matchAll(/<img\b[^>]*>/gi)].map(m => captureGroup(m, 0) ?? "").filter(Boolean)
        )
        const urls = tagMatches.map(getImgUrl).filter((u): u is string => u !== undefined)
        if (urls.length > 0) return urls
    }

    // Strategy 5: any image-like src from chapter content area
    const contentIdx = Math.max(
        html.indexOf("chapter-content"),
        html.indexOf("reading-content"),
        html.indexOf("chapter_content")
    )
    if (contentIdx !== -1) {
        const section = html.slice(contentIdx, contentIdx + 200_000)
        const sectionTags = [...section.matchAll(/<img\b[^>]*>/gi)].map(m => captureGroup(m, 0) ?? "").filter(Boolean)
        const urls = sectionTags
            .map(getImgUrl)
            .filter((u): u is string => u !== undefined && /\.(jpe?g|png|webp|gif)/i.test(u))
        if (urls.length > 0) return urls
    }

    return []
}

export const mgekoAdapter: SourceAdapter = {
    manifest: {
        id: SOURCE_ID,
        name: "Mgeko",
        domains: DOMAINS,
        languages: ["en"],
        capabilities: ["chapters", "pages"],
        requestRateLimit: { requests: 3, intervalMs: 1000 },
        fixtureVersion: 1,
        homepage: ORIGIN
    },

    match(url: URL): SourcePageMatch {
        if (extractChapterSlug(url)) return "chapter"
        if (extractMangaSlug(url)) return "manga"
        return "none"
    },

    async resolveManga(input: ResolveMangaInput, context: SourceContext): Promise<SourceManga> {
        const slug = input.url ? extractMangaSlug(input.url) : input.sourceMangaId
        if (!slug) throw new SourceError("invalid-input", "A valid Mgeko manga URL is required")
        const now = context.now()
        const title = slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())
        return {
            manga: {
                id: `${SOURCE_ID}:manga:${slug}`,
                title,
                normalizedTitle: title.toLowerCase(),
                authors: [],
                status: "unknown",
                addedAt: now,
                updatedAt: now
            },
            sourceId: SOURCE_ID,
            sourceMangaId: slug,
            url: `${ORIGIN}/manga/${slug}/`
        }
    },

    async listChapters(input: ListChaptersInput, context: SourceContext): Promise<SourceChapter[]> {
        const slug = input.manga.sourceMangaId
        if (!slug) throw new SourceError("invalid-input", "A valid Mgeko manga URL is required")
        const html = await context.request.getText(new URL(`${ORIGIN}/manga/${slug}/`), {
            headers: BROWSER_HEADERS
        })
        return extractChapterList(html, slug)
    },

    async resolveCover(
        input: { sourceMangaId?: string; url?: URL },
        context: SourceContext
    ): Promise<string | undefined> {
        const slug = input.sourceMangaId ?? (input.url ? extractMangaSlug(input.url) : undefined)
        if (!slug) return undefined
        try {
            const html = await context.request.getText(new URL(`${ORIGIN}/manga/${slug}/`), {
                headers: BROWSER_HEADERS
            })
            return extractCoverUrl(html)
        } catch {
            return undefined
        }
    },

    async resolveGenres(input: { sourceMangaId?: string; url?: URL }, context: SourceContext): Promise<string[]> {
        const slug = input.sourceMangaId ?? (input.url ? extractMangaSlug(input.url) : undefined)
        if (!slug) return []
        try {
            const html = await context.request.getText(new URL(`${ORIGIN}/manga/${slug}/`), {
                headers: BROWSER_HEADERS
            })
            return extractGenres(html)
        } catch {
            return []
        }
    },

    async findMovedSeries(input, context) {
        for (const url of input.chapterUrls.slice(0, 3)) {
            if (!extractChapterSlug(url)) continue
            try {
                const series = seriesLinkOf(await context.request.getText(url, { headers: BROWSER_HEADERS }))
                if (series) {
                    return {
                        sourceMangaId: series.slug,
                        mangaUrl: `${ORIGIN}/manga/${series.slug}/`,
                        ...(series.title ? { title: series.title } : {})
                    }
                }
            } catch {
                // That chapter is gone too. An older one may still answer.
            }
        }
        // A changed code in front of the id takes the old chapter addresses with it, so only a search is left.
        // Only the same id under its code counts: a title that merely looks alike is another series.
        const stable = stableSlug(input.sourceMangaId)
        const words = stable.split("-")
        // The site's search wants the title's own punctuation ("Mr." and "Auto-Hunting" miss), which a slug
        // has lost, so the words most likely to carry it are dropped in turn.
        for (const query of [words, words.slice(1), words.slice(1, -1)]) {
            if (query.length < 2) continue
            const results = await mgekoAdapter.search?.(query.join(" "), context)
            const found = results?.find(r => stableSlug(r.sourceMangaId) === stable)
            if (found) return { sourceMangaId: found.sourceMangaId, mangaUrl: found.url, title: found.title }
        }
        return null
    },

    async search(query: string, context: SourceContext): Promise<SourceSearchResult[]> {
        if (!query.trim()) return []
        try {
            const url = new URL(`${ORIGIN}/search/`)
            url.searchParams.set("search", query)
            const html = await context.request.getText(url, { headers: BROWSER_HEADERS })
            return extractSearchResults(html)
        } catch {
            return []
        }
    },

    async resolveChapter(input: ResolveChapterInput, context: SourceContext): Promise<ResolvedChapter> {
        if (!input.url) throw new SourceError("invalid-input", "A chapter URL is required")
        const chapterSlug = extractChapterSlug(input.url)
        if (!chapterSlug) throw new SourceError("unsupported-url", "This chapter URL is not supported")

        const html = await context.request.getText(input.url, { headers: BROWSER_HEADERS })
        const imageUrls = extractImages(html)

        if (imageUrls.length === 0) {
            throw new SourceError("invalid-response", "No images found in chapter page")
        }

        const { mangaSlug: guessedSlug, chapterNumber, mangaTitle: guessedTitle } = parseChapterSlug(chapterSlug)
        const series = seriesLinkOf(html)
        const mangaSlug = series?.slug ?? guessedSlug
        const mangaTitle = series?.title || guessedTitle
        const coverUrl = extractCoverUrl(html)
        const now = context.now()
        const mangaId = `${SOURCE_ID}:manga:${mangaSlug}`
        const chapterId = `${SOURCE_ID}:chapter:${chapterSlug}`

        const manga: SourceManga = {
            manga: {
                id: mangaId,
                title: mangaTitle,
                normalizedTitle: mangaTitle.toLocaleLowerCase("en"),
                ...(coverUrl ? { coverUrl } : {}),
                authors: [],
                status: "unknown",
                addedAt: now,
                updatedAt: now
            },
            sourceId: SOURCE_ID,
            sourceMangaId: mangaSlug,
            url: `${ORIGIN}/manga/${mangaSlug}/`,
            ...(mangaSlug !== guessedSlug ? { formerSourceMangaIds: [guessedSlug] } : {})
        }

        const chapter: SourceChapter = {
            id: chapterId,
            mangaId,
            sourceId: SOURCE_ID,
            sourceChapterId: chapterSlug,
            title: chapterNumber ? `Chapter ${chapterNumber}` : "Chapter",
            url: input.url.toString(),
            sortKey: parseChapterNumber(chapterNumber) ?? UNNUMBERED_SORT_KEY,
            language: "en"
        }

        const pages = imageUrls.map((url, i) => ({
            id: `${chapterId}:page:${i + 1}`,
            url
        }))

        context.logger.debug("Resolved Mgeko chapter", { chapterId, pageCount: pages.length })

        return { manga, chapter, pages }
    }
}
