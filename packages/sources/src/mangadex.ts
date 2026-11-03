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
import { z } from "zod"

const SOURCE_ID = "mangadex"
const API_ORIGIN = "https://api.mangadex.org"
const WEB_ORIGIN = "https://mangadex.org"
const UPLOADS_ORIGIN = "https://uploads.mangadex.org"
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_CHAPTERS = 500
const PAGE_SIZE = 100

const localizedStringsSchema = z.record(z.string(), z.string())
const relationshipSchema = z.object({
    id: z.string(),
    type: z.string(),
    attributes: z.record(z.string(), z.unknown()).optional()
})
const mangaSchema = z.object({
    id: z.string(),
    type: z.literal("manga"),
    attributes: z.object({
        title: localizedStringsSchema,
        altTitles: z.array(localizedStringsSchema).optional(),
        status: z.enum(["ongoing", "completed", "hiatus", "cancelled"]).optional(),
        lastChapter: z.string().nullish(),
        createdAt: z.string(),
        updatedAt: z.string(),
        tags: z
            .array(
                z.object({
                    attributes: z.object({ name: localizedStringsSchema }).optional()
                })
            )
            .optional()
    }),
    relationships: z.array(relationshipSchema).optional()
})
const mangaResponseSchema = z.object({
    result: z.literal("ok"),
    data: mangaSchema
})
const mangaListSchema = z.object({
    result: z.literal("ok"),
    data: z.array(mangaSchema)
})
const chapterSchema = z.object({
    id: z.string(),
    type: z.literal("chapter"),
    attributes: z.object({
        chapter: z.string().nullable().optional(),
        title: z.string().nullable().optional(),
        translatedLanguage: z.string(),
        publishAt: z.string().optional(),
        readableAt: z.string().optional()
    }),
    relationships: z.array(relationshipSchema).optional()
})
const chapterResponseSchema = z.object({
    result: z.literal("ok"),
    data: chapterSchema
})
const chapterFeedSchema = z.object({
    result: z.literal("ok"),
    data: z.array(chapterSchema),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    total: z.number().int().nonnegative()
})
const atHomeSchema = z.object({
    result: z.literal("ok"),
    baseUrl: z.string().url(),
    chapter: z.object({
        hash: z.string().min(1),
        data: z.array(z.string().min(1))
    })
})

function extractId(url: URL, kind: "chapter" | "title"): string | undefined {
    if (!matchesSourceDomain(url.hostname, ["mangadex.org", "www.mangadex.org"])) {
        return undefined
    }

    const segments = url.pathname.split("/").filter(Boolean)
    const kindIndex = segments.indexOf(kind)
    const id = kindIndex === -1 ? undefined : segments[kindIndex + 1]
    return id !== undefined && UUID_PATTERN.test(id) ? id.toLowerCase() : undefined
}

function requireInputId(
    input: { url: URL | undefined; sourceId: string | undefined },
    kind: "chapter" | "title"
): string {
    const id = input.url === undefined ? input.sourceId : extractId(input.url, kind)
    const normalized = id?.replace(new RegExp(`^${SOURCE_ID}:(?:manga|chapter):`), "").toLowerCase()

    if (normalized === undefined || !UUID_PATTERN.test(normalized)) {
        throw new SourceError(
            input.url === undefined ? "invalid-input" : "unsupported-url",
            `A valid MangaDex ${kind === "title" ? "manga" : kind} ID or URL is required`
        )
    }
    return normalized
}

function pickLocalized(values: Record<string, string>, languages: readonly string[] = ["en"]): string {
    for (const language of languages) {
        const value = values[language]?.trim()
        if (value) {
            return value
        }
    }
    return (
        Object.keys(values)
            .sort()
            .map(key => values[key]?.trim())
            .find(Boolean) ?? ""
    )
}

function timestamp(value: string, fallback: number): number {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? fallback : parsed
}

function normalizeTitle(title: string): string {
    return title.trim().toLocaleLowerCase("en").replace(/\s+/g, " ")
}

function mangaUrl(id: string): string {
    return `${WEB_ORIGIN}/title/${id}`
}

function chapterUrl(id: string): string {
    return `${WEB_ORIGIN}/chapter/${id}`
}

function mapManga(data: z.infer<typeof mangaSchema>, now: number): SourceManga {
    const title = pickLocalized(data.attributes.title)
    if (!title) {
        throw new SourceError("invalid-response", `MangaDex manga ${data.id} has no title`)
    }

    const cover = data.relationships?.find(relationship => relationship.type === "cover_art")
    const fileName = cover?.attributes?.["fileName"]
    const coverUrl =
        typeof fileName === "string"
            ? `${UPLOADS_ORIGIN}/covers/${data.id}/${encodeURIComponent(fileName)}.256.jpg`
            : undefined

    return {
        manga: {
            id: `${SOURCE_ID}:manga:${data.id}`,
            title,
            normalizedTitle: normalizeTitle(title),
            ...(coverUrl === undefined ? {} : { coverUrl }),
            authors: [],
            status: data.attributes.status ?? "unknown",
            addedAt: timestamp(data.attributes.createdAt, now),
            updatedAt: timestamp(data.attributes.updatedAt, now)
        },
        sourceId: SOURCE_ID,
        sourceMangaId: data.id,
        url: mangaUrl(data.id)
    }
}

// MangaDex serves one row per (chapter-number x language x scanlation group), so a
// 41-chapter series can return 200+ feed rows. Collapse to ONE row per chapter number so
// the library count, reader nav, and updates feed all see 41, not 227. Winner per number:
// the preferred language first, then the most recently readable, then the lexicographically
// smallest id as a DETERMINISTIC tiebreak - stable across refreshes so a title's
// lastReadChapterId keeps pointing at the same row. Unnumbered/oneshot rows are never
// collapsed (each is kept by its own id).
function dedupeByChapterNumber(
    raw: z.infer<typeof chapterSchema>[],
    preferredLanguage: string | undefined
): z.infer<typeof chapterSchema>[] {
    const readableOf = (c: z.infer<typeof chapterSchema>) => c.attributes.readableAt ?? c.attributes.publishAt ?? ""
    const isBetter = (candidate: z.infer<typeof chapterSchema>, current: z.infer<typeof chapterSchema>): boolean => {
        if (preferredLanguage) {
            const candPref = candidate.attributes.translatedLanguage === preferredLanguage
            const curPref = current.attributes.translatedLanguage === preferredLanguage
            if (candPref !== curPref) return candPref
        }
        const candReadable = readableOf(candidate)
        const curReadable = readableOf(current)
        if (candReadable !== curReadable) return candReadable > curReadable
        return candidate.id < current.id
    }
    const byNumber = new Map<string, z.infer<typeof chapterSchema>>()
    const unnumbered: z.infer<typeof chapterSchema>[] = []
    for (const chapter of raw) {
        const number = chapter.attributes.chapter?.trim()
        if (!number) {
            unnumbered.push(chapter)
            continue
        }
        const current = byNumber.get(number)
        if (!current || isBetter(chapter, current)) byNumber.set(number, chapter)
    }
    return [...byNumber.values(), ...unnumbered]
}

function mapChapter(data: z.infer<typeof chapterSchema>, mangaId: string): SourceChapter {
    const number = data.attributes.chapter?.trim()
    const subtitle = data.attributes.title?.trim()
    const title = [number ? `Chapter ${number}` : "Oneshot", subtitle].filter(Boolean).join(": ")

    return {
        id: `${SOURCE_ID}:chapter:${data.id}`,
        mangaId: `${SOURCE_ID}:manga:${mangaId}`,
        sourceId: SOURCE_ID,
        sourceChapterId: data.id,
        title,
        url: chapterUrl(data.id),
        // A null/oneshot/unparseable chapter number is unnumbered - it must sort to
        // the end, never collapse to sortKey 0 (which sorts before Chapter 1 and
        // clobbers reading progress). A literal "0" stays 0 (a genuine Chapter 0).
        sortKey: parseChapterNumber(number) ?? UNNUMBERED_SORT_KEY,
        language: data.attributes.translatedLanguage
    }
}

async function fetchManga(id: string, context: SourceContext): Promise<SourceManga> {
    const url = new URL(`/manga/${id}`, API_ORIGIN)
    url.searchParams.append("includes[]", "cover_art")
    const response = await context.request.getJson(url, mangaResponseSchema)
    return mapManga(response.data, context.now())
}

async function fetchChapter(id: string, context: SourceContext): Promise<z.infer<typeof chapterSchema>> {
    const response = await context.request.getJson(new URL(`/chapter/${id}`, API_ORIGIN), chapterResponseSchema)
    return response.data
}

function relatedMangaId(chapter: z.infer<typeof chapterSchema>): string {
    const mangaId = chapter.relationships?.find(relationship => relationship.type === "manga")?.id
    if (mangaId === undefined || !UUID_PATTERN.test(mangaId)) {
        throw new SourceError("invalid-response", `MangaDex chapter ${chapter.id} has no valid manga relationship`)
    }
    return mangaId.toLowerCase()
}

export const mangadexAdapter: SourceAdapter = {
    manifest: {
        id: SOURCE_ID,
        name: "MangaDex",
        domains: ["mangadex.org", "www.mangadex.org"],
        languages: ["*"],
        capabilities: ["manga", "chapters", "pages"],
        requestRateLimit: {
            requests: 5,
            intervalMs: 1000
        },
        // The API docs require a User-Agent that is not spoofed. A browser-shaped one gets 403
        // "Bot challenge not passed", the extension's own name gets 200 with no cookie.
        identifiedRequestHosts: ["api.mangadex.org"],
        fixtureVersion: 1
    },

    match(url: URL): SourcePageMatch {
        if (extractId(url, "chapter") !== undefined) {
            return "chapter"
        }
        if (extractId(url, "title") !== undefined) {
            return "manga"
        }
        return "none"
    },

    async resolveManga(input: ResolveMangaInput, context: SourceContext): Promise<SourceManga> {
        const id = requireInputId({ url: input.url, sourceId: input.sourceMangaId }, "title")
        return fetchManga(id, context)
    },

    async resolveCover(
        input: { sourceMangaId?: string; url?: URL },
        context: SourceContext
    ): Promise<string | undefined> {
        const id = input.sourceMangaId ?? (input.url ? extractId(input.url, "title") : undefined)
        if (!id) return undefined
        const manga = await fetchManga(id, context)
        return manga.manga.coverUrl
    },

    async resolveGenres(input: { sourceMangaId?: string; url?: URL }, context: SourceContext): Promise<string[]> {
        try {
            const id = input.sourceMangaId ?? (input.url ? extractId(input.url, "title") : undefined)
            if (!id) return []
            const url = new URL(`/manga/${id}`, API_ORIGIN)
            url.searchParams.append("includes[]", "cover_art")
            const response = await context.request.getJson(url, mangaResponseSchema)
            const names = (response.data.attributes.tags ?? [])
                .map(tag => (tag.attributes ? pickLocalized(tag.attributes.name) : ""))
                .map(name => name.trim())
                .filter(Boolean)
            return [...new Set(names)].slice(0, 15)
        } catch {
            return []
        }
    },

    async search(query: string, context: SourceContext): Promise<SourceSearchResult[]> {
        const url = new URL("/manga", API_ORIGIN)
        url.searchParams.set("title", query)
        url.searchParams.set("limit", "20")
        url.searchParams.append("includes[]", "cover_art")
        url.searchParams.append("order[relevance]", "desc")
        for (const rating of ["safe", "suggestive", "erotica", "pornographic"]) {
            url.searchParams.append("contentRating[]", rating)
        }
        const response = await context.request.getJson(url, mangaListSchema)
        return response.data.map(item => {
            const cover = item.relationships?.find(r => r.type === "cover_art")
            const fileName = cover?.attributes?.["fileName"]
            const coverUrl =
                typeof fileName === "string"
                    ? `${UPLOADS_ORIGIN}/covers/${item.id}/${encodeURIComponent(fileName)}.256.jpg`
                    : undefined
            const lastChapter = item.attributes.lastChapter
            const altTitles = [
                ...new Set(
                    (item.attributes.altTitles ?? [])
                        .flatMap(entry => Object.values(entry))
                        .map(value => value.trim())
                        .filter(Boolean)
                )
            ]
            return {
                sourceId: SOURCE_ID,
                sourceMangaId: item.id,
                title: pickLocalized(item.attributes.title) ?? "Unknown",
                url: mangaUrl(item.id),
                ...(coverUrl ? { coverUrl } : {}),
                ...(lastChapter ? { latestChapter: lastChapter } : {}),
                ...(altTitles.length > 0 ? { altTitles } : {})
            }
        })
    },

    async listChapters(input: ListChaptersInput, context: SourceContext): Promise<SourceChapter[]> {
        if (input.manga.sourceId !== SOURCE_ID || !UUID_PATTERN.test(input.manga.sourceMangaId)) {
            throw new SourceError("invalid-input", "The manga does not belong to MangaDex")
        }

        const requestedLimit = Math.min(Math.max(input.limit ?? MAX_CHAPTERS, 1), MAX_CHAPTERS)
        const languages = input.languages ?? []

        // Fetch the raw feed for a given language set. The feed is ordered oldest-first; for
        // a series longer than the cap we keep the NEWEST chapters, so once the first
        // response reveals the total, jump the offset to the tail window (total - cap) and
        // page forward from there.
        const fetchRaw = async (langs: readonly string[]): Promise<z.infer<typeof chapterSchema>[]> => {
            const raw: z.infer<typeof chapterSchema>[] = []
            let baseOffset = 0
            let tailResolved = false
            while (raw.length < requestedLimit) {
                const pageLimit = Math.min(PAGE_SIZE, requestedLimit - raw.length)
                const url = new URL(`/manga/${input.manga.sourceMangaId}/feed`, API_ORIGIN)
                url.searchParams.set("limit", String(pageLimit))
                url.searchParams.set("offset", String(baseOffset + raw.length))
                url.searchParams.set("order[chapter]", "asc")
                for (const language of langs) {
                    url.searchParams.append("translatedLanguage[]", language)
                }
                for (const rating of ["safe", "suggestive", "erotica", "pornographic"]) {
                    url.searchParams.append("contentRating[]", rating)
                }
                const response = await context.request.getJson(url, chapterFeedSchema)
                if (!tailResolved) {
                    tailResolved = true
                    if (response.total > requestedLimit) {
                        baseOffset = response.total - requestedLimit
                        continue
                    }
                }
                raw.push(...response.data)
                if (response.data.length === 0 || response.offset + response.data.length >= response.total) {
                    break
                }
            }
            return raw.slice(0, requestedLimit)
        }

        let raw = await fetchRaw(languages)
        // Graceful language fallback: if the series has NO chapters in the preferred
        // language, re-fetch across all languages so a fully-foreign-language title still
        // shows chapters instead of an empty reader.
        if (raw.length === 0 && languages.length > 0) {
            raw = await fetchRaw([])
        }

        return dedupeByChapterNumber(raw, languages[0]).map(chapter => mapChapter(chapter, input.manga.sourceMangaId))
    },

    async resolveChapter(input: ResolveChapterInput, context: SourceContext): Promise<ResolvedChapter> {
        const id = requireInputId({ url: input.url, sourceId: input.sourceChapterId }, "chapter")
        const chapterData = await fetchChapter(id, context)
        const mangaId = relatedMangaId(chapterData)
        const [manga, atHome] = await Promise.all([
            fetchManga(mangaId, context),
            context.request.getJson(new URL(`/at-home/server/${id}`, API_ORIGIN), atHomeSchema)
        ])
        const chapter = mapChapter(chapterData, mangaId)
        const pages = atHome.chapter.data.map((fileName, index) => ({
            id: `${chapter.id}:page:${index + 1}`,
            url: `${atHome.baseUrl}/data/${atHome.chapter.hash}/${encodeURIComponent(fileName)}`
        }))

        context.logger.debug("Resolved MangaDex chapter", {
            chapterId: id,
            pageCount: pages.length
        })

        return { manga, chapter, pages }
    }
}
