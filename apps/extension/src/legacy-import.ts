import type { ChapterRecord, SourceLinkRecord } from "@amr/contracts"
import { sourceRegistry } from "@amr/sources"
import { UNNUMBERED_SORT_KEY } from "@amr/source-sdk"
import type { HistoryEvent, LibraryManga, PageBookmark } from "./database"

type LegacyManga = {
    m?: string
    n?: string
    u?: string
    l?: string
    ut?: number
    g?: string
    wt?: boolean
    // Last-read chapter object present in newer old-AMR exports: cn.name carries the
    // human chapter label ("Chapter 185", "Ch.112", "Episode 185", "85 - Message"),
    // which yields the read number even for sources whose chapter URL has none
    // (MangaDex uuid, Weeb Central ulid). Absent in older exports.
    cn?: { name?: string; url?: string }
}
// A legacy page bookmark: a specific page within a chapter. u=manga url, c=chapter
// url, h=chapter label, a=page number (1-based, as a string), s=page image url.
type LegacyBookmark = {
    m?: string
    n?: string
    u?: string
    c?: string
    h?: string
    o?: string
    t?: string
    s?: string
    a?: string
}
type LegacyExport = { mangas: LegacyManga[]; bookmarks?: LegacyBookmark[] }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MANGA_PATH_MARKERS = ["manga", "comic", "comics", "series", "manhwa", "manhua", "title", "read"]

// Old AMR stored URLs on domains that have since changed or that the new registry lists under a different canonical hostname.
//
// Every value here MUST be a currently-registered adapter id (packages/sources/src/index.ts).
// An alias whose target has since been retired is worse than no alias at all: it produces
// a real-looking sourceId (no dot) that App.svelte's reconcile-needed check
// (`m.sourceId.includes(".")`) never flags, so the import silently fails every future
// update check with no reconcile UI ever offered. Domains with no alias fall through to
// `resolvedSourceId = primary.hostname` below (a dot-containing id), which IS caught by
// that check - so when an adapter is retired, remove its aliases here rather than leaving
// them pointing at a dead id.
const LEGACY_DOMAIN_ALIASES: Readonly<Record<string, string>> = {
    // AsuraScans - old AMR used asura.gg and www.asurascans.com before the domain settled
    "asura.gg": "asurascans",
    "www.asurascans.com": "asurascans",
    // MangaRead - old AMR accepted mangaread.org without www prefix
    "mangaread.org": "mangaread",
    // Dynasty Scans - ensure the apex domain without www is covered
    "dynasty-scans.com": "dynasty-scans",
    // MangaSushi - old AMR used .net, new adapter only registers .org
    "mangasushi.net": "mangasushi",
    // Weeb Central - cover any legacy capitalization / www variant
    "www.weebcentral.com": "weebcentral",
    // AsuraToon - early domain before asurascans.com settled
    "asuratoon.com": "asurascans",
    "www.asuratoon.com": "asurascans",
    // Tritinia Scans
    "www.tritinia.org": "tritinia",
    // MangaDex - old AMR stored numeric chapter IDs (pre-UUID era) which the adapter's
    // match() rejects; fall back via alias so the source is still recognised as mangadex.
    "mangadex.org": "mangadex",
    "www.mangadex.org": "mangadex",
    // ManhwaTop - still-registered Madara site
    "manhwatop.com": "manhwatop"
    // Removed 2026-07-16: manganato, mangapark, manhuaplus, mangabuddy, flamecomics,
    // aquascans, s2manga, and manhwahentai aliases used to live here but every one of
    // those adapter ids is retired/commented-out in the current registry (manganato +
    // mangapark in packages/sources/src/index.ts; manhuaplus, aquascans, s2manga,
    // manhwahentai in madara-sites.ts; mangabuddy in mangabuddy-sites.ts; flamecomics
    // removed entirely from mangastream-sites.ts, no replacement adapter exists under
    // any id) - verified against the live registry state, not just the audit's list.
    // Keeping those aliases pointed imports at a dead sourceId with no dot, which
    // App.svelte's `m.sourceId.includes(".")` reconcile check can never catch. Deleting
    // them lets those domains fall through to the hostname-based unknown-source path
    // instead, which IS reconcile-flagged.
    // Also removed 2026-07-19: aquamanga (aquamanga.com is retired in madara-sites.ts -
    // it now redirects to a parklogic ad-arbitrage lander, so its alias pointed imports
    // at a dead sourceId; dropping it lets aquamanga.com fall through to the same
    // reconcile-flagged hostname path).
}

export function isLegacyExport(raw: unknown): raw is LegacyExport {
    if (typeof raw !== "object" || raw === null) return false
    const obj = raw as Record<string, unknown>
    return Array.isArray(obj.mangas) && obj.format === undefined
}

function parseUrl(value: string | undefined): URL | undefined {
    if (!value) return undefined
    try {
        const u = new URL(value)
        return u.protocol === "http:" || u.protocol === "https:" ? u : undefined
    } catch {
        return undefined
    }
}

function adapterIdFor(url: URL): string | undefined {
    const adapter = sourceRegistry.match(url)
    if (adapter) return adapter.manifest.id
    return LEGACY_DOMAIN_ALIASES[url.hostname.toLowerCase()]
}

function deriveSlug(u: URL): string {
    const segments = u.pathname.split("/").filter(Boolean)
    const markerIndex = segments.findIndex(s => MANGA_PATH_MARKERS.includes(s.toLowerCase()))
    const afterMarker = markerIndex >= 0 ? segments[markerIndex + 1] : undefined
    if (afterMarker) return afterMarker
    const last = segments[segments.length - 1] ?? ""
    const readerStyle = last.match(/^(.*?)-chapter[-_]/i)
    if (readerStyle?.[1]) return readerStyle[1]
    return segments[0] ?? ""
}

function mangadexId(u: URL, kind: "title" | "chapter"): string | undefined {
    const segments = u.pathname.split("/").filter(Boolean)
    const i = segments.indexOf(kind)
    const id = i === -1 ? undefined : segments[i + 1]
    return id && UUID_PATTERN.test(id) ? id.toLowerCase() : undefined
}

function chapterNumberFrom(url: string): number | undefined {
    // "chapter-101", "chapter_101", "chapter 101.5", plus the "chapter-101-5" dash
    // convention meaning 101.5 (lhtranslation/asura) - the dash decimal is normalised.
    const chapter = url.match(/chapter[-_ ]?(\d+(?:[.-]\d+)?)/i)
    if (chapter?.[1] !== undefined) return Number(chapter[1].replace("-", "."))
    // fanfox / mangahere address chapters by a /cNNN/ path segment (e.g. /c112/, /c045/)
    const cPath = url.match(/\/c(\d+(?:\.\d+)?)(?:\/|$|\?)/i)
    if (cPath?.[1] !== undefined) return Number(cPath[1])
    // Webtoons uses episode_no=N query param instead of /chapter-N/ path segments
    const episode = url.match(/[?&]episode_no=(\d+)/i)
    if (episode?.[1] !== undefined) return Number(episode[1])
    return undefined
}

// Reads the chapter number from a human label such as "Chapter 185 - Dark Lord",
// "Ch.112", "Episode 185", "Chapter 23.7", or "85 - Message". Prefers an explicit
// chapter/episode marker, then falls back to the first number in the label. This is
// the only read-position signal for sources whose chapter URL carries no number
// (MangaDex uuid, Weeb Central ulid), via the legacy `cn.name` field.
function chapterNumberFromLabel(label: string | undefined): number | undefined {
    if (!label) return undefined
    const marked = label.match(/\b(?:chapter|chap|ch|episode|ep)\b\.?\s*#?\s*(\d+(?:\.\d+)?)/i)
    if (marked?.[1] !== undefined) return Number(marked[1])
    const first = label.match(/(\d+(?:\.\d+)?)/)
    return first?.[1] !== undefined ? Number(first[1]) : undefined
}

function sanitizeKey(u: URL): string {
    return `${u.hostname}${u.pathname}`.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || u.hostname
}

// Derives the canonical manga id (and source identity) from a manga URL + a chapter
// URL, exactly as a library entry is keyed. Shared by convertEntry and the bookmark
// converter so a bookmark attaches to the same manga id the import creates instead of
// being dropped as an orphan.
function deriveMangaIdentity(
    mangaUrl: string | undefined,
    chapterUrl: string | undefined
): {
    id: string
    resolvedSourceId: string
    known: boolean
    sourceMangaId: string | undefined
    mangaUrlParsed: URL | undefined
    chapterUrlParsed: URL | undefined
    primary: URL
} | null {
    const mangaUrlParsed = parseUrl(mangaUrl)
    const chapterUrlParsed = parseUrl(chapterUrl)
    const primary = mangaUrlParsed ?? chapterUrlParsed
    if (!primary) return null

    const sourceId = adapterIdFor(primary) ?? (chapterUrlParsed ? adapterIdFor(chapterUrlParsed) : undefined)
    const known = sourceId !== undefined
    const resolvedSourceId = sourceId ?? primary.hostname

    const isMangaDex = resolvedSourceId === "mangadex"
    const isWebtoons = resolvedSourceId === "webtoons"
    const sourceMangaId = isMangaDex
        ? mangaUrlParsed
            ? mangadexId(mangaUrlParsed, "title")
            : undefined
        : isWebtoons
          ? ((mangaUrlParsed ?? primary).searchParams.get("title_no") ?? undefined)
          : deriveSlug(mangaUrlParsed ?? primary) || undefined

    const idKey = sourceMangaId ?? sanitizeKey(mangaUrlParsed ?? primary)
    const id = `${resolvedSourceId}:manga:${idKey}`
    return { id, resolvedSourceId, known, sourceMangaId, mangaUrlParsed, chapterUrlParsed, primary }
}

function convertEntry(entry: LegacyManga): {
    manga: LibraryManga
    sourceLink?: SourceLinkRecord
    chapter?: ChapterRecord
    history?: HistoryEvent
} | null {
    const title = entry.n?.trim()
    if (!title) return null

    const identity = deriveMangaIdentity(entry.u, entry.l)
    if (!identity) return null
    const { id, resolvedSourceId, known, sourceMangaId, mangaUrlParsed, chapterUrlParsed, primary } = identity
    const isMangaDex = resolvedSourceId === "mangadex"
    const now = typeof entry.ut === "number" && Number.isInteger(entry.ut) && entry.ut >= 0 ? entry.ut : Date.now()
    const sourceUrl = (chapterUrlParsed ?? mangaUrlParsed ?? primary).toString()
    // Prefer the cn.name label (works for uuid/ulid sources), then cn.url, then fall
    // back to the last-read chapter URL. MangaDex is excluded only from the URL path
    // (its uuid carries no number and pre-UUID numeric ids must not be misread as one);
    // its cn.name still yields the number.
    const lastReadNumber =
        chapterNumberFromLabel(entry.cn?.name) ??
        (entry.cn?.url ? chapterNumberFrom(entry.cn.url) : undefined) ??
        (!isMangaDex && entry.l ? chapterNumberFrom(entry.l) : undefined)

    const manga: LibraryManga = {
        id,
        title,
        normalizedTitle: title.toLocaleLowerCase("en").replace(/\s+/g, " "),
        authors: [],
        status: "unknown",
        addedAt: now,
        updatedAt: now,
        sourceId: resolvedSourceId,
        sourceUrl,
        ...(sourceMangaId ? { sourceMangaId } : {}),
        ...(mangaUrlParsed ? { mangaUrl: mangaUrlParsed.toString() } : {}),
        ...(lastReadNumber !== undefined ? { lastReadChapterNumber: lastReadNumber } : {}),
        ...(known ? {} : { manualTracking: true })
    }

    const linkUrl = mangaUrlParsed ?? (known ? chapterUrlParsed : undefined)
    const sourceLink: SourceLinkRecord | undefined =
        known && linkUrl
            ? {
                  mangaId: id,
                  sourceId: resolvedSourceId,
                  url: linkUrl.toString(),
                  ...(sourceMangaId ? { sourceMangaId } : {}),
                  title,
                  ...(entry.g ? { language: entry.g } : {}),
                  addedAt: now,
                  updatedAt: now
              }
            : undefined

    let chapter: ChapterRecord | undefined
    let history: HistoryEvent | undefined
    if (chapterUrlParsed && lastReadNumber !== undefined) {
        const chapterId = `${id}:ext:ch-${lastReadNumber}`
        chapter = {
            id: chapterId,
            mangaId: id,
            sourceId: resolvedSourceId,
            title: entry.cn?.name?.trim() || `Chapter ${lastReadNumber}`,
            url: chapterUrlParsed.toString(),
            sortKey: lastReadNumber
        }
        manga.lastReadChapterId = chapterId
        manga.latestChapterId = chapterId
        manga.latestChapterNumber = lastReadNumber
        manga.lastReadAt = now
        history = { mangaId: id, chapterId, type: "completed", occurredAt: now }
    } else if (chapterUrlParsed && known && entry.l) {
        // Known source with a last-read chapter URL but no derivable number (e.g. a
        // MangaDex/Weeb Central export with no cn label - the uuid/ulid carries no
        // number). Preserve the URL so the title reads as "Read" not "Unread",
        // resume-from-last-read works, and a later same-source relink can recover the
        // number by matching this URL (see matchReadChapterByUrl). sortKey is
        // UNNUMBERED; latest is left unset for the first update check to fill in.
        const chapterId = `${id}:ext:lastread`
        chapter = {
            id: chapterId,
            mangaId: id,
            sourceId: resolvedSourceId,
            title: entry.cn?.name?.trim() || "Last read",
            url: chapterUrlParsed.toString(),
            sortKey: UNNUMBERED_SORT_KEY
        }
        manga.lastReadChapterId = chapterId
        manga.lastReadAt = now
        history = { mangaId: id, chapterId, type: "completed", occurredAt: now }
    }

    return {
        manga,
        ...(sourceLink ? { sourceLink } : {}),
        ...(chapter ? { chapter } : {}),
        ...(history ? { history } : {})
    }
}

// Converts a legacy page bookmark into a new-format PageBookmark. Keyed to the same
// manga id convertEntry produces (via deriveMangaIdentity) so it attaches to the
// imported title. The legacy page number `a` is 1-based (it matches the 1-based page
// image filename, e.g. "3-<hash>.jpg"); the reader's pageIndex is 0-based, so it maps
// to a - 1. The primary key follows the app's `${chapterId}:${pageIndex}` convention.
function convertBookmark(bm: LegacyBookmark): PageBookmark | null {
    const identity = deriveMangaIdentity(bm.u, bm.c)
    if (!identity || !identity.chapterUrlParsed) return null
    const { id: mangaId, chapterUrlParsed } = identity

    // Token derived from the full chapter URL path AND query. Using only the last path
    // segment collapsed every chapter of a query-addressed source to one id (Webtoons
    // paths all end in "viewer"; the episode lives in ?episode_no=N), so bookmarks in
    // different episodes shared a primary key and all but one were deduped away.
    const chapterToken =
        `${chapterUrlParsed.pathname}${chapterUrlParsed.search}`.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") ||
        chapterUrlParsed.hostname
    const chapterId = `${mangaId}:ext:${chapterToken}`

    const pageNumber = Number(bm.a)
    const pageIndex = Number.isFinite(pageNumber) && pageNumber > 1 ? Math.floor(pageNumber) - 1 : 0

    return {
        id: `${chapterId}:${pageIndex}`,
        mangaId,
        chapterId,
        pageIndex,
        mangaTitle: bm.n?.trim() ?? "",
        chapterTitle: bm.h?.trim() ?? "",
        chapterUrl: chapterUrlParsed.toString(),
        addedAt: Date.now()
    }
}

// A legacy file is hand-editable JSON, so one entry can be null, a string, or carry a number
// where a string belongs. That entry is skipped and counted rather than aborting the import.
function safeConvert<E, R>(entry: unknown, convert: (entry: E) => R | null): R | null {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null
    try {
        return convert(entry as E)
    } catch {
        return null
    }
}

export function migrateLegacyImport(raw: unknown): {
    envelope: unknown
    migrated: boolean
    converted: number
    skipped: number
    needsAttention: string[]
} {
    if (!isLegacyExport(raw)) {
        return { envelope: raw, migrated: false, converted: 0, skipped: 0, needsAttention: [] }
    }

    const manga: LibraryManga[] = []
    const sourceLinks: SourceLinkRecord[] = []
    const chapters: ChapterRecord[] = []
    const historyEvents: HistoryEvent[] = []
    const needsAttention: string[] = []
    const seen = new Set<string>()
    let skipped = 0

    for (const entry of raw.mangas) {
        const converted = safeConvert(entry, convertEntry)
        if (!converted) {
            skipped += 1
            continue
        }
        if (seen.has(converted.manga.id)) continue
        seen.add(converted.manga.id)
        manga.push(converted.manga)
        if (converted.manga.manualTracking) needsAttention.push(converted.manga.id)
        if (converted.sourceLink) sourceLinks.push(converted.sourceLink)
        if (converted.chapter) chapters.push(converted.chapter)
        if (converted.history) historyEvents.push(converted.history)
    }

    const pageBookmarks: PageBookmark[] = []
    const seenBookmarks = new Set<string>()
    const bookmarks: unknown[] = Array.isArray(raw.bookmarks) ? raw.bookmarks : []
    for (const bm of bookmarks) {
        const converted = safeConvert(bm, convertBookmark)
        if (!converted || seenBookmarks.has(converted.id)) continue
        seenBookmarks.add(converted.id)
        pageBookmarks.push(converted)
    }

    return {
        envelope: {
            format: "all-mangas-reader",
            version: 1,
            exportedAt: Date.now(),
            data: { manga, sourceLinks, chapters, progress: [], historyEvents, pageBookmarks }
        },
        migrated: true,
        converted: manga.length,
        skipped,
        needsAttention
    }
}
