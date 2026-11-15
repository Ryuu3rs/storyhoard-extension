import { isNumberedChapter } from "@amr/source-sdk"

// How far a site has got with a title: how many chapters it lists, the newest chapter number and, when
// the site dates its chapters, when the newest one went up. Several uploads of one chapter (languages,
// groups) count once.
export type ChapterSummary = { count: number; latest?: number; latestAt?: number }

export function summarizeChapters(
    chapters: ReadonlyArray<{ sortKey: number; publishedAt?: number | undefined }>
): ChapterSummary {
    const numbers = new Set<number>()
    let latestAt: number | undefined
    for (const chapter of chapters) {
        if (isNumberedChapter(chapter.sortKey)) numbers.add(chapter.sortKey)
        if (chapter.publishedAt !== undefined && Number.isFinite(chapter.publishedAt)) {
            latestAt = latestAt === undefined ? chapter.publishedAt : Math.max(latestAt, chapter.publishedAt)
        }
    }
    const unnumbered = chapters.filter(chapter => !isNumberedChapter(chapter.sortKey)).length
    const latest = numbers.size > 0 ? Math.max(...numbers) : undefined
    return {
        count: numbers.size + unnumbered,
        ...(latest !== undefined ? { latest } : {}),
        ...(latestAt !== undefined ? { latestAt } : {})
    }
}
