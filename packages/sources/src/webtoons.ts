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
    type SourcePageMatch
} from "@amr/source-sdk"

const SOURCE_ID = "webtoons"
const ORIGIN = "https://www.webtoons.com"
const DOMAIN = "webtoons.com"

// Webtoons images are served from Naver's CDN and require the correct Referer.
const BROWSER_HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    Referer: ORIGIN
}

function captureGroup(m: RegExpMatchArray, i: number): string | undefined {
    const v = m[i]
    return typeof v === "string" ? v : undefined
}

function extractTitle(html: string, fallback: string): string {
    const og =
        html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) ??
        html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:title"/i)
    if (og) {
        const raw = decodeEntities(captureGroup(og, 1) ?? "")
        const cleaned = raw.split(/\s*[-|]\s*WEBTOON/i)[0]?.trim()
        if (cleaned && cleaned.length > 1) return cleaned
    }
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    const h1Text = h1 ? decodeEntities((captureGroup(h1, 1) ?? "").replace(/<[^>]+>/g, "").trim()) : ""
    if (h1Text.length > 1) return h1Text
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

// Return the first 3 path segments as /lang/genre/slug for list URL construction.
function pathPrefix(url: URL): string {
    const segs = url.pathname.split("/").filter(Boolean)
    return "/" + segs.slice(0, 3).join("/")
}

// Canonical series prefix URL - used as mangaUrl so that chapter URLs (which share the
// same /lang/genre/slug/ prefix) match via startsWith in trackExternalChapter.
function seriesPrefixUrl(url: URL): string {
    return `${ORIGIN}${pathPrefix(url)}/`
}

// Parse episode links from a list page, returning chapters oldest-first.
function extractEpisodes(html: string, titleNo: string): SourceChapter[] {
    const mangaId = `${SOURCE_ID}:manga:${titleNo}`
    const out: SourceChapter[] = []
    const seen = new Set<string>()
    // href="...viewer?title_no=X&episode_no=Y" or "?episode_no=Y&title_no=X"
    for (const m of html.matchAll(/href="([^"]+\bviewer\?[^"]*\bepisode_no=(\d+)[^"]*)"/gi)) {
        const epNo = captureGroup(m, 2)
        if (!epNo || seen.has(epNo)) continue

        // Use the actual href from HTML (decoded) so the stored URL matches what the
        // browser shows - chapter:siblings lookup uses exact URL string comparison.
        const rawHref = captureGroup(m, 1) ?? ""
        const decodedHref = rawHref.replace(/&amp;/g, "&")
        const epUrl = decodedHref.startsWith("http") ? decodedHref : `${ORIGIN}${decodedHref}`

        // List/viewer pages show "Recommended for you" widgets linking to OTHER
        // series' episodes, which also match this href pattern - only accept links
        // whose title_no matches this series, or the chapter list gets polluted with
        // wrong-series episodes (breaks Prev/Next entirely).
        let linkTitleNo: string | null
        try {
            linkTitleNo = new URL(epUrl).searchParams.get("title_no")
        } catch {
            continue
        }
        if (linkTitleNo !== titleNo) continue
        seen.add(epNo)
        const sortKey = Number(epNo)

        // Extract episode title from URL slug (e.g. "ep-5-some-title" → "Some Title").
        const slugMatch = decodedHref.match(/\/([^/]+)\/viewer\?/)
        const slug = slugMatch?.[1] ?? ""
        let epTitle: string
        if (slug.match(/^ep-\d+-/)) {
            epTitle = slug
                .replace(/^ep-\d+-/, "")
                .replace(/-/g, " ")
                .replace(/\b\w/g, c => c.toUpperCase())
        } else {
            epTitle = `Episode ${epNo}`
        }

        out.push({
            id: `${SOURCE_ID}:chapter:${titleNo}:${epNo}`,
            mangaId,
            sourceId: SOURCE_ID,
            sourceChapterId: epNo,
            title: epTitle,
            url: epUrl,
            sortKey,
            language: "en"
        })
    }
    // List pages show newest-first; reverse to oldest-first for AMR sort order.
    out.reverse()
    return out
}

// Extract image URLs from a viewer page.
// Webtoons puts the real URL in data-url on <img class="_images"> in the initial HTML.
// Scope the search to the actual episode content area (#content / .viewer_lst) to avoid
// capturing anti-bot decoy images injected before the content section.
function extractImages(html: string): string[] {
    const urls: string[] = []
    const seen = new Set<string>()

    // Find the start of the actual episode content area.
    const contentIdx = html.search(/\bid=(?:"content"|'content')|\bclass="viewer_lst"/)
    const scope = contentIdx >= 0 ? html.slice(contentIdx) : html

    for (const m of scope.matchAll(/data-url="(https?:\/\/[^"]+)"/gi)) {
        const u = captureGroup(m, 1)
        if (u && !seen.has(u)) {
            seen.add(u)
            urls.push(u)
        }
    }
    if (urls.length > 0) return urls
    // Fallback: src / data-src on elements with _images class
    for (const m of scope.matchAll(/<img\b[^>]+class="[^"]*_images[^"]*"[^>]*>/gi)) {
        const tag = captureGroup(m, 0) ?? ""
        const src = tag.match(/\bdata-src="(https?:\/\/[^"]+)"/i)?.[1] ?? tag.match(/\bsrc="(https?:\/\/[^"]+)"/i)?.[1]
        if (src && !seen.has(src)) {
            seen.add(src)
            urls.push(src)
        }
    }
    return urls
}

export const webtoonsAdapter: SourceAdapter = {
    manifest: {
        id: SOURCE_ID,
        name: "WEBTOON",
        domains: [DOMAIN, `www.${DOMAIN}`],
        languages: ["en"],
        capabilities: ["pages", "chapters"],
        requestRateLimit: { requests: 2, intervalMs: 1500 },
        fixtureVersion: 1,
        homepage: ORIGIN
    },

    match(url: URL): SourcePageMatch {
        if (url.hostname !== DOMAIN && url.hostname !== `www.${DOMAIN}`) return "none"
        if (url.pathname.includes("/viewer") && url.searchParams.has("title_no")) return "chapter"
        if (url.pathname.includes("/list") && url.searchParams.has("title_no")) return "manga"
        return "none"
    },

    async resolveManga(input: ResolveMangaInput, ctx: SourceContext): Promise<SourceManga> {
        const titleNo = input.sourceMangaId ?? input.url?.searchParams.get("title_no") ?? undefined
        if (!titleNo) throw new SourceError("invalid-input", "No title_no in URL or sourceMangaId")
        // A stored series URL is the bare /lang/genre/slug/ prefix, which the site answers with a 404.
        const fetchUrl = new URL(
            `${ORIGIN}${input.url ? pathPrefix(input.url) : "/en/fantasy/unknown"}/list?title_no=${encodeURIComponent(titleNo)}`
        )
        const html = await ctx.request.getText(fetchUrl, { headers: BROWSER_HEADERS })
        const title = extractTitle(html, `Series ${titleNo}`)
        const coverUrl = extractCover(html)
        // Return the series path prefix as the manga URL so that any chapter URL
        // (which shares /lang/genre/slug/) matches via startsWith in trackExternalChapter.
        const mangaUrl = seriesPrefixUrl(fetchUrl)
        return {
            manga: {
                id: `${SOURCE_ID}:manga:${titleNo}`,
                title,
                normalizedTitle: title.toLocaleLowerCase("en").replace(/\s+/g, " "),
                authors: [],
                status: "unknown",
                ...(coverUrl ? { coverUrl } : {}),
                addedAt: ctx.now(),
                updatedAt: ctx.now()
            },
            sourceId: SOURCE_ID,
            sourceMangaId: titleNo,
            url: mangaUrl
        }
    },

    async listChapters(input: ListChaptersInput, ctx: SourceContext): Promise<SourceChapter[]> {
        const { manga } = input
        const titleNo = manga.sourceMangaId
        // Always build the list URL from the source manga ID so this works regardless of
        // whether manga.url is the old list URL or the new series prefix.
        const prefix = pathPrefix(new URL(manga.url))
        const listBase = new URL(`${ORIGIN}${prefix}/list?title_no=${titleNo}`)
        const MAX_PAGES = 50

        const all: SourceChapter[] = []
        const seen = new Set<string>()

        for (let page = 1; page <= MAX_PAGES; page++) {
            const pageUrl = new URL(listBase.toString())
            pageUrl.searchParams.set("page", String(page))
            const html = await ctx.request.getText(pageUrl, { headers: BROWSER_HEADERS })
            const episodes = extractEpisodes(html, titleNo)
            if (episodes.length === 0) break
            let added = 0
            for (const ep of episodes) {
                if (!seen.has(ep.sourceChapterId)) {
                    seen.add(ep.sourceChapterId)
                    all.push(ep)
                    added++
                }
            }
            // If we added nothing new this page, stop
            if (added === 0) break
            // Require a query-param boundary before "page=" so an incidental substring like a
            // "listpage=2" analytics param doesn't false-positive a next page. `?`/`&` are the
            // raw boundaries; `;` covers Webtoons' HTML-encoded `&amp;page=`. \D after the digit
            // still stops page=1 matching page=10.
            const hasNext = new RegExp(`[?&;]page=${page + 1}(?:\\D|$)`).test(html)
            if (!hasNext) break
        }

        all.sort((a, b) => a.sortKey - b.sortKey)
        return all
    },

    async resolveCover(input: { sourceMangaId?: string; url?: URL }, ctx: SourceContext): Promise<string | undefined> {
        const titleNo = input.sourceMangaId ?? input.url?.searchParams.get("title_no") ?? undefined
        if (!titleNo) return undefined
        // Build the list URL the same way getChapterListUrl does below: reuse the
        // series path prefix from a stored mangaUrl (handles both the legacy
        // .../list?title_no=X shape and the newer series-prefix shape), or fall back
        // to the /en/fantasy/unknown/ trick from resolveManga when only the bare
        // title_no is known - Webtoons redirects that to the canonical genre/slug URL.
        const fetchUrl = input.url
            ? new URL(`${ORIGIN}${pathPrefix(input.url)}/list?title_no=${encodeURIComponent(titleNo)}`)
            : new URL(`${ORIGIN}/en/fantasy/unknown/list?title_no=${encodeURIComponent(titleNo)}`)
        try {
            const html = await ctx.request.getText(fetchUrl, { headers: BROWSER_HEADERS })
            return extractCover(html)
        } catch {
            return undefined
        }
    },

    parseMangaUrl(url: URL): { sourceMangaId: string; mangaUrl: string } | null {
        const titleNo = url.searchParams.get("title_no")
        if (!titleNo) return null
        // Return the series path prefix so chapter URLs (e.g. /en/genre/slug/ep-5/viewer)
        // match via startsWith against the stored mangaUrl.
        return { sourceMangaId: titleNo, mangaUrl: seriesPrefixUrl(url) }
    },

    getChapterListUrl(sourceMangaId: string, mangaUrl: string): string | null {
        // mangaUrl may be the new series prefix (https://www.webtoons.com/en/fantasy/slug/)
        // or, for library entries added before that format existed, the old list URL
        // itself (.../slug/list?title_no=X) - pathPrefix() normalizes either shape to
        // the bare /lang/genre/slug prefix, same as listChapters does below.
        try {
            const base = new URL(mangaUrl)
            const prefix = pathPrefix(base)
            return `${ORIGIN}${prefix}/list?title_no=${encodeURIComponent(sourceMangaId)}`
        } catch {
            return null
        }
    },

    async resolveChapter(input: ResolveChapterInput, ctx: SourceContext): Promise<ResolvedChapter> {
        if (!input.url) throw new SourceError("invalid-input", "Chapter URL required for WEBTOON")
        const url = input.url
        const titleNo = url.searchParams.get("title_no")
        const episodeNo = input.sourceChapterId ?? url.searchParams.get("episode_no")
        if (!titleNo || !episodeNo) throw new SourceError("invalid-input", "Missing title_no or episode_no in URL")
        // episode_no flows into sortKey via Number(); a non-numeric value (malformed/adversarial
        // viewer URL that still has title_no, which match() waves through) would become NaN and
        // sort into an arbitrary position. Reject it here rather than store a NaN sortKey.
        if (!/^\d+$/.test(episodeNo)) throw new SourceError("invalid-input", "episode_no must be numeric")

        const html = await ctx.request.getText(url, { headers: BROWSER_HEADERS })
        const images = extractImages(html)
        if (images.length === 0) {
            // Viewer images are JS-rendered; direct SW fetch returns minimal HTML.
            // Signal bot-block to trigger the tab-render fallback (real browser session
            // with locale cookies, full JS execution, data-url attributes in DOM).
            throw new SourceRequestError("blocked")
        }

        // Fetch list page for real series title and cover art.
        // This runs in the second (tab-injected) call where images were found.
        // The list page SW fetch may be bot-blocked; fall back to viewer HTML
        // (tab-injected, fully rendered) which also carries og:title / og:image.
        const segs = url.pathname.split("/").filter(Boolean)
        const mangaUrl = seriesPrefixUrl(url)
        const listPageUrl = new URL(`${ORIGIN}/${segs.slice(0, 3).join("/")}/list?title_no=${titleNo}`)
        const listHtml = await ctx.request.getText(listPageUrl, { headers: BROWSER_HEADERS }).catch(() => "")
        const seriesTitle = extractTitle(listHtml, "") || extractTitle(html, `Series ${titleNo}`)
        const seriesCover = extractCover(listHtml) ?? extractCover(html)

        const manga: SourceManga = {
            manga: {
                id: `${SOURCE_ID}:manga:${titleNo}`,
                title: seriesTitle,
                normalizedTitle: seriesTitle.toLocaleLowerCase("en").replace(/\s+/g, " "),
                authors: [],
                status: "unknown",
                ...(seriesCover ? { coverUrl: seriesCover } : {}),
                addedAt: ctx.now(),
                updatedAt: ctx.now()
            },
            sourceId: SOURCE_ID,
            sourceMangaId: titleNo,
            url: mangaUrl
        }

        return {
            manga,
            chapter: {
                id: `${SOURCE_ID}:chapter:${titleNo}:${episodeNo}`,
                mangaId: `${SOURCE_ID}:manga:${titleNo}`,
                sourceId: SOURCE_ID,
                sourceChapterId: episodeNo,
                title: `Episode ${episodeNo}`,
                url: url.toString(),
                sortKey: Number(episodeNo),
                language: "en"
            },
            pages: images.map((imgUrl, i) => ({ id: String(i), url: imgUrl }))
        }
    }
}
