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
    matchesSourceDomain,
    parseChapterNumber,
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
import type { SiteProfile } from "./profile-schema"

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
        const title = rawTitle?.trim() || slug.replace(/-/g, " ")
        const rawCover = profile.series.coverPattern
            ? firstCapture(profile.series.coverPattern, html, "cover")
            : undefined
        const coverUrl = rawCover ? absolute(rawCover, ORIGIN) : undefined
        return { title, coverUrl }
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
            const slug = slugFromUrl(url, profile)
            if (!slug) return null
            const mangaUrl = profile.series.urlTemplate
                ? absolute(interpolate(profile.series.urlTemplate, { slug }), ORIGIN)
                : url.toString()
            return { sourceMangaId: slug, mangaUrl }
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
            const slug = input.manga.sourceMangaId
            const listUrl = profile.list.urlTemplate
                ? absolute(interpolate(profile.list.urlTemplate, { slug }), ORIGIN)
                : input.manga.url
            const parentId = input.manga.manga.id
            const pagination = profile.list.pagination
            const maxPages = pagination ? pagination.maxPages : 1
            const chapters: SourceChapter[] = []
            const seenNums = new Set<string>()
            for (let page = 1; page <= maxPages; page++) {
                const pageUrl = new URL(listUrl)
                if (pagination) pageUrl.searchParams.set(pagination.param, String(page))
                const html = await context.request.getText(pageUrl, { headers })
                let added = 0
                for (const m of globalMatches(profile.list.itemPattern, html)) {
                    const chapterUrl = m.groups?.chapterUrl
                    const numStr = m.groups?.chapterNumber
                    if (!chapterUrl || !numStr || seenNums.has(numStr)) continue
                    seenNums.add(numStr)
                    added++
                    const chapterTitle = m.groups?.chapterTitle?.trim()
                    chapters.push({
                        id: `${profile.id}:chapter:${slug}:${numStr}`,
                        mangaId: parentId,
                        sourceId: profile.id,
                        sourceChapterId: numStr,
                        title: chapterTitle ? `Ch.${numStr} - ${chapterTitle}` : `Ch.${numStr}`,
                        url: absolute(chapterUrl, ORIGIN),
                        sortKey: parseChapterNumber(numStr) ?? UNNUMBERED_SORT_KEY,
                        language
                    })
                }
                // Stop once a page yields no new chapters (end of pagination).
                if (pagination && added === 0) break
            }
            return chapters
        },

        async resolveChapter(input: ResolveChapterInput, context: SourceContext): Promise<ResolvedChapter> {
            if (!input.url) throw new SourceError("invalid-input", "A chapter URL is required")
            const chapterMatch = profile.match.chapter
                ? input.url.pathname.match(new RegExp(profile.match.chapter))
                : null
            const slug = chapterMatch?.[1] ?? slugFromUrl(input.url, profile)
            if (!slug) throw new SourceError("unsupported-url", `Not a recognised ${profile.name} chapter URL`)
            const num = chapterMatch?.[2] ?? "1"

            const now = context.now()
            const manga = makeManga(profile, slug, slug.replace(/-/g, " "), undefined, now)
            const chapterId = `${profile.id}:chapter:${slug}:${num}`
            const chapter: SourceChapter = {
                id: chapterId,
                mangaId: manga.manga.id,
                sourceId: profile.id,
                sourceChapterId: num,
                title: `Ch.${num}`,
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
                      for (const m of globalMatches(profile.search.itemPattern, html)) {
                          const resultUrl = m.groups?.url
                          const title = m.groups?.title?.trim()
                          if (!resultUrl || !title) continue
                          const absUrl = absolute(resultUrl, ORIGIN)
                          const slug = slugFromUrl(new URL(absUrl), profile)
                          if (!slug) continue
                          const cover = m.groups?.cover
                          results.push({
                              sourceId: profile.id,
                              sourceMangaId: slug,
                              title,
                              url: absUrl,
                              ...(cover ? { coverUrl: absolute(cover, ORIGIN) } : {})
                          })
                      }
                      return results
                  }
              }
            : {})
    }
}
