import { SourceRequestError, type SourceManga } from "@amr/source-sdk"
import type { SourceLinkRecord } from "@amr/contracts"
import { recordTombstone } from "../account"
import { db, moveMangaToNewAddress, type LibraryManga } from "../database"
import { diag } from "../diag-log"
import { findMovedSeriesFor, listMangaChapters } from "../sources"

const CHAPTERS_TO_ASK = 3

export function isSeriesGone(error: unknown): boolean {
    return error instanceof SourceRequestError && error.status === 404
}

async function moveTitle(
    item: LibraryManga,
    link: SourceLinkRecord,
    series: { sourceMangaId: string; mangaUrl: string; title?: string | undefined }
): Promise<{ item: LibraryManga; link: SourceLinkRecord }> {
    const id = `${link.sourceId}:manga:${series.sourceMangaId}`
    const title = series.title ?? item.title
    const nextItem: LibraryManga = {
        ...item,
        id,
        title,
        normalizedTitle: title.toLocaleLowerCase("en"),
        sourceMangaId: series.sourceMangaId,
        mangaUrl: series.mangaUrl,
        // Account sync pushes rows by this. The old id goes out as a tombstone, so without it the title would
        // disappear from the account until something else changed it.
        updatedAt: Date.now()
    }
    const nextLink: SourceLinkRecord = {
        ...link,
        mangaId: id,
        sourceMangaId: series.sourceMangaId,
        url: series.mangaUrl,
        title,
        updatedAt: Date.now()
    }
    await moveMangaToNewAddress(item.id, nextItem, nextLink)
    // Without this the next account sync would bring the old address back as its own title.
    void recordTombstone(item.id)
    diag.info("update-check", "series moved to a new address", {
        source: link.sourceId,
        from: link.sourceMangaId ?? null,
        to: series.sourceMangaId
    })
    return { item: nextItem, link: nextLink }
}

// A title whose series address answers 404. Ask its own chapter pages where the series is now, and move the
// title only once the new address has given a real list, so a wrong answer costs nothing.
export async function followMovedSeries(item: LibraryManga, link: SourceLinkRecord, language: string) {
    const rows = await db.chapters.where("mangaId").equals(item.id).toArray()
    const chapterUrls = rows
        .filter(row => Number.isFinite(row.sortKey))
        .sort((a, b) => b.sortKey - a.sortKey)
        .slice(0, CHAPTERS_TO_ASK)
        .flatMap(row => {
            try {
                return [new URL(row.url)]
            } catch {
                return []
            }
        })
    const series = await findMovedSeriesFor(item, link, chapterUrls)
    const current = link.sourceMangaId ?? item.sourceMangaId
    if (!series || series.sourceMangaId === current) return undefined
    const candidate = { ...link, sourceMangaId: series.sourceMangaId, url: series.mangaUrl }
    const chapters = await listMangaChapters(item, candidate, language)
    if (chapters.length === 0) return undefined
    return { ...(await moveTitle(item, link, series)), chapters }
}

// A chapter page named a series other than the one its address suggests, so an older entry may sit under
// that guess. Move it across, or the next visit would start a second entry for the same series.
export async function adoptFormerSeriesEntries(resolved: SourceManga): Promise<void> {
    for (const former of resolved.formerSourceMangaIds ?? []) {
        const oldId = `${resolved.sourceId}:manga:${former}`
        const item = await db.manga.get(oldId)
        const link = await db.sourceLinks.get(oldId)
        if (!item || !link) continue
        await moveTitle(item, link, {
            sourceMangaId: resolved.sourceMangaId,
            mangaUrl: resolved.url,
            title: resolved.manga.title
        })
    }
}
