// A chapter list the on-site panel read from the user's own rendered page, for a source the extension
// cannot list in the background (a list built in the browser, behind a login, or by a script), or for
// a reader site the user has not followed (a detected page, which has no registered source at all).
// The page is untrusted, so nothing it reports is stored as given: every link must be a chapter of this
// site on one of its own origins, the number is parsed here from the link's visible text, and the
// batch is bounded.

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
import { db } from "./database"
import { publishLive } from "./live"
import { notifyNewChapters } from "./notifications"

export const MAX_OBSERVED_ITEMS = 2000
const MAX_TITLE_LENGTH = 120

export type ObservedItem = { url: string; text: string }

// "/chapter-12", "/ch/12.5", "?chapter=7": a number the URL itself spells out, used only when the
// visible text names none.
const URL_NUMBER = /(?:chapter|chap|ch|episode|ep)[-_/=]?(\d{1,6}(?:\.\d{1,4})?)(?:[/?#&_-]|$)/i

function numberInUrl(url: URL): number | undefined {
    const matched = URL_NUMBER.exec(url.pathname + url.search)
    return matched?.[1] === undefined ? undefined : Number(matched[1])
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

// The chapter rows an observed list yields for one tracked title, newest information winning per
// number. Drops, without error: a link that is not a chapter of this site on its own origins, a
// link that belongs to a different title (a "latest updates" widget), an entry naming no chapter
// number, and anything past the item cap or a duplicate number.
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
        const label = sanitizeScrapedText(item.text).slice(0, MAX_TITLE_LENGTH)
        const number = parseChapterLabel(label).number ?? (input.numberFromUrl ? numberInUrl(url) : undefined)
        if (!usableNumber(number) || byNumber.has(number)) continue
        byNumber.set(number, {
            id: `${sourceId}:chapter:${sourceMangaId}:${number}`,
            mangaId,
            sourceId,
            title: label || `Ch.${number}`,
            url: url.toString(),
            sortKey: number,
            ...(language ? { language } : {})
        })
    }
    return [...byNumber.values()]
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
    await db.transaction("rw", db.chapters, db.manga, async () => {
        const manga = await db.manga.get(input.mangaId)
        // The title may have been removed while the page was being read; never orphan chapter rows.
        if (!manga) return
        const existing = new Set((await db.chapters.where("mangaId").equals(input.mangaId).primaryKeys()) as string[])
        await db.chapters.bulkPut(input.chapters)
        const latest = latestNumberedChapter(input.chapters)
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
        result = { recorded: input.chapters.filter(chapter => !existing.has(chapter.id)).length, advanced }
    })
    if (result.recorded > 0 || result.advanced) publishLive(["chapters", "library"], [input.mangaId])
    if (announce !== undefined) void notifyNewChapters([announce])
    return result
}
