// ARCHITECTURE TRACK A - experimental.
//
// The generic engine: turns a validated Site Profile (data) into a SourceAdapter (the
// contract every downstream consumer already speaks). No profile-specific code runs here -
// only regex extraction and closed-namespace template interpolation. There is deliberately
// no eval/Function, no DRM/token/anti-scrape handshake, and no challenge-bypass: a site that
// needs those is out of scope by design (council hard-ban B1).

import {
    SourceError,
    UNNUMBERED_SORT_KEY,
    createOriginAllowlist,
    matchesSourceDomain,
    parseChapterLabel,
    parseChapterNumber,
    sanitizeScrapedText,
    type ListChaptersInput,
    type ResolveChapterInput,
    type ResolveMangaInput,
    type ResolvedChapter,
    type ResolvedPage,
    type SourceAdapter,
    type SourceChapter,
    type SourceContext,
    type SourceManga,
    type SourceManifest,
    type SourcePageMatch,
    type SourceSearchResult
} from "@amr/source-sdk"
import { interpolate } from "./interpolate"
import { decodeSlug, slugPattern } from "./slug"
import type { SiteProfile } from "./profile-schema"

// Upper bound on raw regex matches examined per fetched page, so a hostile or oversized page cannot
// turn one regex pass into an unbounded loop. Duplicate and foreign links count here, chapters do not.
const MAX_ITEMS_PER_PAGE = 50_000

// Upper bound on the chapters one listing returns. When a list is longer, the highest-numbered
// (newest) chapters are kept and the cut is logged.
const MAX_CHAPTERS_PER_LIST = 5000

// "10-5" and "10_5" in a URL are the decimal chapter 10.5; the list stores the number as 10.5.
function normalizeChapterNumber(raw: string): string {
    return raw.replace(/^(\d+)[-_](\d+)$/, "$1.$2")
}

// The chapter number a link's visible text names ("Ch. 86", "Chapter 70: Title"), as the same decimal
// string the URL path produces. Undefined when the text names none (a "Latest" or "Read first" link).
function chapterNumberFromText(rawText: string | undefined): string | undefined {
    if (!rawText) return undefined
    const { number } = parseChapterLabel(sanitizeScrapedText(rawText))
    return number === undefined ? undefined : String(number)
}

function originOf(profile: SiteProfile): string {
    return profile.origin.replace(/\/$/, "")
}

function absolute(url: string, origin: string): string {
    try {
        return new URL(url, origin).toString()
    } catch {
        return url
    }
}

// First capture: a named group `title`/`cover`/`url` if the pattern declares one, else group 1.
function firstCapture(pattern: string, html: string, named?: string): string | undefined {
    const m = new RegExp(pattern).exec(html)
    if (!m) return undefined
    if (named && m.groups?.[named] !== undefined) return m.groups[named]
    return m[1]
}

function* globalMatches(pattern: string, html: string): Generator<RegExpExecArray> {
    const re = new RegExp(pattern, new RegExp(pattern).flags.includes("g") ? undefined : "g")
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null) {
        yield m
        if (m.index === re.lastIndex) re.lastIndex++
    }
}

function slugFromUrl(url: URL, profile: SiteProfile): string | undefined {
    const chapter = profile.match.chapter ? url.pathname.match(new RegExp(profile.match.chapter)) : null
    if (chapter?.[1]) return chapter[1]
    const manga = url.pathname.match(new RegExp(profile.match.manga))
    return manga?.[1]
}

function makeManga(
    profile: SiteProfile,
    slug: string,
    title: string,
    coverUrl: string | undefined,
    now: number,
    // The real series URL when one is in hand (the user opened it). Needed for sites whose
    // series URL can't be rebuilt from a bare slug (query-param identity, genre segments, etc.)
    // so listChapters later fetches the right page instead of the bare origin.
    explicitUrl?: string
): SourceManga {
    const seriesUrl =
        explicitUrl ??
        (profile.series.urlTemplate
            ? absolute(interpolate(profile.series.urlTemplate, { slug }), originOf(profile))
            : `${originOf(profile)}/`)
    return {
        manga: {
            id: `${profile.id}:manga:${slug}`,
            title,
            normalizedTitle: title.toLocaleLowerCase("en"),
            ...(coverUrl ? { coverUrl } : {}),
            authors: [],
            status: "unknown",
            addedAt: now,
            updatedAt: now
        },
        sourceId: profile.id,
        sourceMangaId: slug,
        url: seriesUrl
    }
}

export function createAdapterFromProfile(profile: SiteProfile): SourceAdapter {
    const ORIGIN = originOf(profile)
    const headers = {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
    }
    const language = profile.languages[0]!

    // A cover URL comes out of a regex over untrusted page HTML, and the extension later fetches it.
    // Only an https URL on one of the profile's own origins (or image hosts) is kept; anything else
    // (another host, a loopback/private address, a non-https scheme) is dropped, so a page cannot
    // aim the cover fetch somewhere the user never granted.
    const isOwnOrigin = (() => {
        try {
            return createOriginAllowlist([...profile.origins, ...(profile.imageOrigins ?? [])])
        } catch {
            return () => false
        }
    })()
    function safeCoverUrl(raw: string | undefined): string | undefined {
        if (!raw) return undefined
        try {
            const url = new URL(raw, ORIGIN)
            return url.protocol === "https:" && isOwnOrigin(url.origin) ? url.toString() : undefined
        } catch {
            return undefined
        }
    }

    // A chapter URL comes out of a regex over untrusted page HTML (an ad, a comment or a sidebar can
    // carry any link) and is stored, shown and later opened as a chapter of this source. Only an
    // http(s) URL on one of the profile's own origins is kept, so a page cannot plant a "new chapter"
    // on a host the user never added.
    const isChapterOrigin = (() => {
        try {
            return createOriginAllowlist([profile.origin, ...profile.origins])
        } catch {
            return () => false
        }
    })()
    function ownChapterUrl(raw: string): string | undefined {
        try {
            const url = new URL(raw, ORIGIN)
            const web = url.protocol === "https:" || url.protocol === "http:"
            return web && isChapterOrigin(url.origin) ? url.toString() : undefined
        } catch {
            return undefined
        }
    }

    const manifest: SourceManifest = {
        id: profile.id,
        name: profile.name,
        domains: profile.domains,
        languages: profile.languages,
        capabilities: profile.capabilities,
        requestRateLimit: profile.requestRateLimit,
        fixtureVersion: 1,
        homepage: ORIGIN,
        ...(profile.imageOrigins ? { imageOrigins: profile.imageOrigins } : {})
    }

    async function fetchSeries(slug: string, seriesUrl: string, context: SourceContext) {
        const html = await context.request.getText(new URL(seriesUrl), { headers })
        const rawTitle = firstCapture(profile.series.titlePattern, html, "title")
        const title = (rawTitle ? sanitizeScrapedText(rawTitle) : "") || decodeSlug(slug).replace(/-/g, " ")
        const rawCover = profile.series.coverPattern
            ? firstCapture(profile.series.coverPattern, html, "cover")
            : undefined
        return { title, coverUrl: safeCoverUrl(rawCover) }
    }

    return {
        manifest,

        match(url: URL): SourcePageMatch {
            if (!matchesSourceDomain(url.hostname, profile.domains)) return "none"
            if (profile.match.chapter && new RegExp(profile.match.chapter).test(url.pathname)) return "chapter"
            if (new RegExp(profile.match.manga).test(url.pathname)) return "manga"
            return "none"
        },

        parseMangaUrl(url: URL): { sourceMangaId: string; mangaUrl: string } | null {
            if (!matchesSourceDomain(url.hostname, profile.domains)) return null
            const slug = slugFromUrl(url, profile)
            if (!slug) return null
            try {
                const mangaUrl = profile.series.urlTemplate
                    ? absolute(interpolate(profile.series.urlTemplate, { slug }), ORIGIN)
                    : url.toString()
                return { sourceMangaId: slug, mangaUrl }
            } catch {
                return null
            }
        },

        async resolveManga(input: ResolveMangaInput, context: SourceContext): Promise<SourceManga> {
            const slug = input.url ? slugFromUrl(input.url, profile) : input.sourceMangaId
            if (!slug) throw new SourceError("invalid-input", `A valid ${profile.name} manga URL is required`)
            const seriesUrl =
                input.url?.toString() ??
                (profile.series.urlTemplate
                    ? absolute(interpolate(profile.series.urlTemplate, { slug }), ORIGIN)
                    : undefined)
            if (!seriesUrl) throw new SourceError("invalid-input", "Cannot build a series URL for this id")
            const { title, coverUrl } = await fetchSeries(slug, seriesUrl, context)
            return makeManga(profile, slug, title, coverUrl, context.now(), seriesUrl)
        },

        async listChapters(input: ListChaptersInput, context: SourceContext): Promise<SourceChapter[]> {
            const list = profile.list
            if (!list) return []
            const slug = input.manga.sourceMangaId
            const listUrl = list.urlTemplate
                ? absolute(interpolate(list.urlTemplate, { slug }), ORIGIN)
                : input.manga.url
            const parentId = input.manga.manga.id
            // numberSource "text"/"title": the URL holds only an internal chapter id, so each chapter's
            // number is read from its link's visible text instead. Links whose text names no chapter
            // ("Read first", "Latest") are skipped.
            const textNumbered = profile.numberSource !== undefined && profile.numberSource !== "url"
            // A literal `{slug}` token in the item pattern becomes this series' own slug, so a page
            // that also lists other titles' chapters (a "latest updates" sidebar) never leaks in.
            const itemPattern = (
                textNumbered ? (list.itemTextPattern ?? list.itemPattern) : list.itemPattern
            ).replaceAll("{slug}", () => slugPattern(slug))
            const pagination = list.pagination
            const maxPages = pagination ? pagination.maxPages : 1
            const chapters: SourceChapter[] = []
            const seenNums = new Set<string>()
            for (let page = 1; page <= maxPages; page++) {
                const pageUrl = new URL(listUrl)
                if (pagination) pageUrl.searchParams.set(pagination.param, String(page))
                const html = await context.request.getText(pageUrl, { headers })
                let added = 0
                let scanned = 0
                for (const m of globalMatches(itemPattern, html)) {
                    if (++scanned > MAX_ITEMS_PER_PAGE) break
                    const chapterUrl = m.groups?.chapterUrl
                    const labelNumber = textNumbered ? chapterNumberFromText(m.groups?.chapterText) : undefined
                    const rawNum = textNumbered ? labelNumber : m.groups?.chapterNumber
                    const numStr = rawNum ? normalizeChapterNumber(rawNum) : undefined
                    if (!chapterUrl || !numStr || seenNums.has(numStr)) continue
                    const ownUrl = ownChapterUrl(chapterUrl)
                    if (!ownUrl) continue
                    seenNums.add(numStr)
                    added++
                    const chapterTitle = m.groups?.chapterTitle ? sanitizeScrapedText(m.groups.chapterTitle) : undefined
                    chapters.push({
                        id: `${profile.id}:chapter:${slug}:${numStr}`,
                        mangaId: parentId,
                        sourceId: profile.id,
                        sourceChapterId: numStr,
                        title: chapterTitle ? `Ch.${numStr} - ${chapterTitle}` : `Ch.${numStr}`,
                        url: ownUrl,
                        sortKey: parseChapterNumber(numStr) ?? UNNUMBERED_SORT_KEY,
                        language
                    })
                }
                // Stop once a page yields no new chapters (end of pagination).
                if (pagination && added === 0) break
            }
            if (chapters.length <= MAX_CHAPTERS_PER_LIST) return chapters
            context.logger.warn("Chapter list truncated to the newest chapters", {
                sourceId: profile.id,
                found: chapters.length,
                kept: MAX_CHAPTERS_PER_LIST
            })
            const rank = (chapter: SourceChapter): number =>
                Number.isFinite(chapter.sortKey) ? chapter.sortKey : Number.NEGATIVE_INFINITY
            const kept = new Set([...chapters].sort((a, b) => rank(b) - rank(a)).slice(0, MAX_CHAPTERS_PER_LIST))
            return chapters.filter(chapter => kept.has(chapter))
        },

        async resolveChapter(input: ResolveChapterInput, context: SourceContext): Promise<ResolvedChapter> {
            if (!input.url) throw new SourceError("invalid-input", "A chapter URL is required")
            const chapterMatch = profile.match.chapter
                ? input.url.pathname.match(new RegExp(profile.match.chapter))
                : null
            const slug = chapterMatch?.[1] ?? slugFromUrl(input.url, profile)
            if (!slug) throw new SourceError("unsupported-url", `Not a recognised ${profile.name} chapter URL`)
            // A chapter regex with no number group (the migration seed uses these where the URL
            // carries no chapter number) is UNNUMBERED, keyed by its path - never "1", which would
            // collide with the real Chapter 1 and let a capture clobber its read progress.
            // A text-numbered profile's URL group is an internal id, never a number: the chapter is
            // keyed by that id and left unnumbered until the caller supplies the number it read.
            const textNumbered = profile.numberSource !== undefined && profile.numberSource !== "url"
            const num = chapterMatch?.[2] && !textNumbered ? normalizeChapterNumber(chapterMatch[2]) : undefined
            const chapterKey = num ?? (textNumbered ? chapterMatch?.[2] : undefined) ?? input.url.pathname

            const now = context.now()
            const manga = makeManga(profile, slug, decodeSlug(slug).replace(/-/g, " "), undefined, now)
            const chapterId = `${profile.id}:chapter:${slug}:${chapterKey}`
            const chapter: SourceChapter = {
                id: chapterId,
                mangaId: manga.manga.id,
                sourceId: profile.id,
                sourceChapterId: chapterKey,
                title: num === undefined ? "Chapter" : `Ch.${num}`,
                url: input.url.toString(),
                sortKey: parseChapterNumber(num) ?? UNNUMBERED_SORT_KEY,
                language
            }

            // Image extraction only when the profile declares `pages`. A shipped (format-2) profile
            // omits it: the on-site panel reads the user's own already-rendered tab, so the engine
            // never fetches or extracts page images - resolveChapter is inert and returns no pages.
            // Only an arch-only sideload "Classic reader" profile carries `pages`.
            if (!profile.pages) return { manga, chapter, pages: [] }

            const html = await context.request.getText(input.url, { headers })
            let pageUrls: string[] = []
            for (const pattern of profile.pages.imagePatterns) {
                const found: string[] = []
                for (const m of globalMatches(pattern, html)) {
                    const url = m.groups?.url ?? m[1]
                    if (url) found.push(absolute(url, ORIGIN))
                }
                if (found.length > 0) {
                    pageUrls = found
                    break
                }
            }
            if (profile.pages.include) {
                const inc = new RegExp(profile.pages.include)
                pageUrls = pageUrls.filter(u => inc.test(u))
            }
            if (profile.pages.exclude) {
                const exc = new RegExp(profile.pages.exclude)
                pageUrls = pageUrls.filter(u => !exc.test(u))
            }
            if (pageUrls.length === 0) throw new SourceError("invalid-response", "No page images in this chapter")

            const pages: ResolvedPage[] = pageUrls.map((url, i) => ({ id: `${chapterId}:page:${i + 1}`, url }))
            return { manga, chapter, pages }
        },

        ...(profile.search
            ? {
                  async search(query: string, context: SourceContext): Promise<SourceSearchResult[]> {
                      if (!query.trim() || !profile.search) return []
                      const url = absolute(interpolate(profile.search.urlTemplate, { query }), ORIGIN)
                      const html = await context.request.getText(new URL(url), { headers })
                      const results: SourceSearchResult[] = []
                      let scanned = 0
                      for (const m of globalMatches(profile.search.itemPattern, html)) {
                          if (++scanned > MAX_ITEMS_PER_PAGE) break
                          const resultUrl = m.groups?.url
                          const title = m.groups?.title ? sanitizeScrapedText(m.groups.title) : undefined
                          if (!resultUrl || !title) continue
                          const absUrl = absolute(resultUrl, ORIGIN)
                          const slug = slugFromUrl(new URL(absUrl), profile)
                          if (!slug) continue
                          const cover = safeCoverUrl(m.groups?.cover)
                          results.push({
                              sourceId: profile.id,
                              sourceMangaId: slug,
                              title,
                              url: absUrl,
                              ...(cover ? { coverUrl: cover } : {})
                          })
                      }
                      return results
                  }
              }
            : {})
    }
}
