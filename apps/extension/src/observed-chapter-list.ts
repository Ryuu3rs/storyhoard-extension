// A chapter list the on-site panel read from the user's own rendered page, for a source the extension
// cannot list in the background (a list built in the browser, behind a login, or by a script), or for
// a reader site the user has not followed (a detected page, which has no registered source at all).
// The page is untrusted, so nothing it reports is stored as given: every link must be a chapter of this
// site on one of its own origins, the number is the one its address spells out (the link's visible text
// only when the address names none), one address is one chapter, the batch is bounded, and a lone link
// far past everything else cannot move the latest chapter.

import type { ChapterRecord } from "@amr/contracts"
import {
    OPAQUE_ID_MIN,
    createOriginAllowlist,
    latestNumberedChapter,
    parseChapterLabel,
    sanitizeScrapedText,
    type SourceAdapter,
    type SourcePageMatch
} from "@amr/source-sdk"
import { MAX_GAP, db, foldVisitRows, isVisitRow } from "./database"
import { publishLive } from "./live"
import { notifyNewChapters } from "./notifications"
import { sanitizePageText } from "./page-text"

export const MAX_OBSERVED_ITEMS = 2000
const MAX_TITLE_LENGTH = 120
// A group of fewer than MIN_SUPPORTING_RUN chapters more than MAX_GAP past everything else the title knows is one
// stray link, not new chapters.
export const MIN_SUPPORTING_RUN = 3

export type ObservedItem = { url: string; text: string }

// "/chapter-12", "/ch/12.5", "/chapter-10-5", "/issue-9", "?chapter=7": a number the URL itself spells out.
// It wins over the visible text, which the page can set to anything, and agrees with how a visit to the
// same address is numbered. It reads what the detected matcher reads (the same keywords, a
// dot, dash or underscore as the decimal point), so a visit and a list give one chapter the same number.
// The scan takes the LAST keyword match, because the chapter segment sits at the end of the address while a
// slug ("catch-22") or an ancestor directory ("/ch-5/..") can carry an earlier keyword-plus-digit that is
// not the chapter number. A detected page threads its own position-anchored reader instead (see numberOf).
const URL_NUMBER = /(?:chapter|chap|ch|episode|ep|issue)[-_./=]*(\d{1,6}(?:[._-]\d{1,6})?)(?:[/?#&_-]|$)/gi

function numberInUrl(url: URL): number | undefined {
    const haystack = url.pathname + url.search
    let last: string | undefined
    URL_NUMBER.lastIndex = 0
    for (let matched = URL_NUMBER.exec(haystack); matched !== null; matched = URL_NUMBER.exec(haystack)) {
        last = matched[1]
        if (matched.index === URL_NUMBER.lastIndex) URL_NUMBER.lastIndex += 1
    }
    return last === undefined ? undefined : Number(last.replace(/[_-]/, "."))
}

function usableNumber(value: number | undefined): value is number {
    return value !== undefined && Number.isFinite(value) && value >= 0 && value < OPAQUE_ID_MIN
}

// What a list is validated against: the id its rows are filed under, the chapter-URL test, which
// title a chapter URL belongs to, and the origins its links may sit on. A registered source supplies
// these from its adapter; a detected page supplies them from the shape of the chapter URL itself.
export type ObservedListTarget = {
    sourceId: string
    language?: string | undefined
    match: (url: URL) => SourcePageMatch
    ownerOf?: ((url: URL) => string | undefined) | undefined
    // A position-anchored number reader, when the target has one (a detected page derived from the chapter
    // URL shape). Preferred over the generic last-keyword scan, so the list agrees with the visit exactly.
    numberOf?: ((url: URL) => number | undefined) | undefined
    allowedOrigins: readonly string[]
}

export function observedTargetOf(source: SourceAdapter, allowedOrigins: readonly string[]): ObservedListTarget {
    return {
        sourceId: source.manifest.id,
        language: source.manifest.languages[0],
        match: url => source.match(url),
        ownerOf: url => source.parseMangaUrl?.(url)?.sourceMangaId,
        allowedOrigins
    }
}

// The chapter rows an observed list yields for one tracked title, first entry winning per number and
// per address. Drops, without error: a link that is not a chapter of this site on its own origins, a
// link that belongs to a different title (a "latest updates" widget), an entry naming no chapter
// number, and anything past the item cap, a duplicate number or a duplicate address.
export function chaptersFromObservedList(
    input: ObservedListTarget & {
        sourceMangaId: string
        mangaId: string
        // False for a source whose URLs hold only an internal chapter id: the visible text is then the only
        // place a number can come from, and a number found in the URL would be that id.
        numberFromUrl: boolean
        items: readonly ObservedItem[]
    }
): ChapterRecord[] {
    const { sourceMangaId, mangaId, sourceId, language } = input
    const isOwnOrigin = createOriginAllowlist(input.allowedOrigins)
    const byNumber = new Map<number, ChapterRecord>()
    const seenUrls = new Set<string>()
    for (const item of input.items.slice(0, MAX_OBSERVED_ITEMS)) {
        let url: URL
        try {
            url = new URL(item.url)
        } catch {
            continue
        }
        if ((url.protocol !== "https:" && url.protocol !== "http:") || !isOwnOrigin(url.origin)) continue
        if (input.match(url) !== "chapter") continue
        const owner = input.ownerOf?.(url)
        if (owner !== undefined && owner !== sourceMangaId) continue
        const address = url.toString()
        if (seenUrls.has(address)) continue
        seenUrls.add(address)
        const label = sanitizePageText(sanitizeScrapedText(item.text), MAX_TITLE_LENGTH)
        const fromUrl = input.numberFromUrl ? (input.numberOf ? input.numberOf(url) : numberInUrl(url)) : undefined
        const number = usableNumber(fromUrl) ? fromUrl : parseChapterLabel(label).number
        if (!usableNumber(number) || byNumber.has(number)) continue
        byNumber.set(number, {
            id: `${sourceId}:chapter:${sourceMangaId}:${number}`,
            mangaId,
            sourceId,
            title: label || `Ch.${number}`,
            url: address,
            sortKey: number,
            ...(language ? { language } : {})
        })
    }
    return [...byNumber.values()]
}

// The numbered chapters of a list grouped into runs of small steps, lowest first. A run is kept when it starts
// near what is already known (the title's latest chapter, its stored chapters including the chapters the
// user visited, the runs kept before it) or is long enough to be a real stretch of chapters; anything else
// is dropped. With nothing known, a real stretch in the list itself is the anchor; a list with neither
// (a new title's "first / latest" pair) is kept whole, because there is nothing to measure a gap from.
function plausibleChapters(chapters: readonly ChapterRecord[], known: readonly number[]): ChapterRecord[] {
    const numbered = chapters.filter(chapter => Number.isFinite(chapter.sortKey))
    const others = chapters.filter(chapter => !Number.isFinite(chapter.sortKey))
    const sorted = [...numbered].sort((a, b) => a.sortKey - b.sortKey)
    const runs: ChapterRecord[][] = []
    for (let start = 0; start < sorted.length; ) {
        let end = start
        while (end + 1 < sorted.length && sorted[end + 1]!.sortKey - sorted[end]!.sortKey <= MAX_GAP) end++
        runs.push(sorted.slice(start, end + 1))
        start = end + 1
    }
    const anchors =
        known.length > 0
            ? known
            : runs.filter(run => run.length >= MIN_SUPPORTING_RUN).map(run => run[run.length - 1]!.sortKey)
    if (anchors.length === 0) return [...sorted, ...others]
    let top = Math.max(...anchors)
    const kept: ChapterRecord[] = []
    for (const run of runs) {
        if (run[0]!.sortKey <= top + MAX_GAP || run.length >= MIN_SUPPORTING_RUN) {
            kept.push(...run)
            top = Math.max(top, run[run.length - 1]!.sortKey)
        }
    }
    return [...kept, ...others]
}

// Store an observed list for a tracked title and move its latest chapter FORWARD only: a list the page
// shows may be partial (one page of a paginated dropdown), so it can raise the latest chapter but
// never lower it. Returns how many chapters were new to the title and whether the latest chapter advanced.
// A title with no earlier latest chapter takes the list as its baseline without announcing it: the
// first list a user's tab shows is everything that already existed, not new releases.
export async function recordObservedChapters(input: {
    mangaId: string
    chapters: ChapterRecord[]
}): Promise<{ recorded: number; advanced: boolean }> {
    if (input.chapters.length === 0) return { recorded: 0, advanced: false }
    let result = { recorded: 0, advanced: false }
    let announce: string | undefined
    await db.transaction("rw", [db.chapters, db.manga, db.progress, db.historyEvents], async () => {
        const manga = await db.manga.get(input.mangaId)
        // The title may have been removed while the page was being read; never orphan chapter rows.
        if (!manga) return
        const stored = await db.chapters.where("mangaId").equals(input.mangaId).toArray()
        const existing = new Set(stored.map(chapter => chapter.id))
        // One address is one chapter across reports too: a page that relabels the same link cannot add a
        // second row for it.
        const listedAt = new Map(stored.filter(c => !isVisitRow(c.id)).map(chapter => [chapter.url, chapter.id]))
        const known = stored.map(chapter => chapter.sortKey).filter(n => Number.isFinite(n))
        if (manga.latestChapterNumber !== undefined && Number.isFinite(manga.latestChapterNumber)) {
            known.push(manga.latestChapterNumber)
        }
        const chapters = plausibleChapters(
            input.chapters.filter(chapter => (listedAt.get(chapter.url) ?? chapter.id) === chapter.id),
            known
        )
        if (chapters.length === 0) return
        await db.chapters.bulkPut(chapters)
        await foldVisitRows(manga, stored, chapters)
        const latest = latestNumberedChapter(chapters)
        const advanced = latest !== undefined && latest.sortKey > (manga.latestChapterNumber ?? -1)
        if (advanced) {
            await db.manga.update(input.mangaId, {
                latestChapterId: latest.id,
                latestChapterNumber: latest.sortKey,
                latestChapterAt: Date.now(),
                sourceUrl: latest.url,
                updatedAt: Date.now()
            })
            if (manga.latestChapterNumber !== undefined) announce = manga.title
        }
        result = { recorded: chapters.filter(chapter => !existing.has(chapter.id)).length, advanced }
    })
    if (result.recorded > 0 || result.advanced) publishLive(["chapters", "library"], [input.mangaId])
    if (announce !== undefined) void notifyNewChapters([announce])
    return result
}
