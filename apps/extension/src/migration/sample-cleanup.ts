// 0.32.2 shipped the "Load samples" button in its store build, so some users hold the sample library: manga
// rows with ids "seed-*" and covers at "/sample-covers/*", plus the seed profile rows 0.32.2 wrote for their
// sites. The store build ships neither the covers nor the button. On the first update to it, after the
// pre-update backup, the samples the user never touched are removed with their chapters and links, and so
// are the seed profile rows only those samples used. A sample the user did touch stays, with its sample
// cover cleared so the normal cover backfill finds it a real one. Store builds only, once.

import { resyncStoredArchProfiles, rowOrigin } from "../arch-sources"
import { LAB_BUILD } from "../build-flavor"
import { createBackup, db, type LibraryManga } from "../database"

export const SAMPLE_CLEANUP_FLAG = "sampleCleanupV1"
export const SAMPLE_ID_PREFIX = "seed-"
export const SAMPLE_COVER_PREFIX = "/sample-covers/"

export const isSampleRow = (manga: Pick<LibraryManga, "id">): boolean => manga.id.startsWith(SAMPLE_ID_PREFIX)

export const hasSampleCover = (manga: Pick<LibraryManga, "coverUrl">): boolean =>
    manga.coverUrl?.startsWith(SAMPLE_COVER_PREFIX) === true

// Fields that only reading or a user action sets. A sample carrying any of them was touched.
const TOUCH_FIELDS = [
    "lastReadChapterId",
    "lastReadChapterNumber",
    "lastReadAt",
    "readingStatus",
    "readingStatusUpdatedAt",
    "rating",
    "notes",
    "manualTracking",
    "onHold",
    "nsfw",
    "readingDirection",
    "pageFit",
    "pageWidthPct",
    "noGapContinuous",
    "continuousScroll",
    "readerTheme",
    "sourceRestoredAt"
] as const satisfies ReadonlyArray<keyof LibraryManga>

// Conservative: a sample counts as untouched only while it still has its sample cover, carries none of the
// fields above and no categories, and has no reading progress, history, page bookmark or download.
async function isUntouchedSample(manga: LibraryManga): Promise<boolean> {
    if (!isSampleRow(manga) || !hasSampleCover(manga)) return false
    if (TOUCH_FIELDS.some(field => manga[field] !== undefined)) return false
    if ((manga.categories ?? []).length > 0) return false
    const [progress, history, bookmarks, downloads] = await Promise.all([
        db.progress.where("mangaId").equals(manga.id).count(),
        db.historyEvents.where("mangaId").equals(manga.id).count(),
        db.pageBookmarks.where("mangaId").equals(manga.id).count(),
        db.downloads.where("mangaId").equals(manga.id).count()
    ])
    return progress + history + bookmarks + downloads === 0
}

async function sourceStillUsed(sourceId: string): Promise<boolean> {
    const [manga, links] = await Promise.all([
        db.manga.where("sourceId").equals(sourceId).count(),
        db.sourceLinks.where("sourceId").equals(sourceId).count()
    ])
    return manga + links > 0
}

export type SampleCleanupResult = { removed: string[]; kept: string[]; profilesRemoved: string[] }

// backedUp: whether the pre-update backup of this upgrade succeeded. Without it one is taken first, and
// nothing is removed (or stamped) when that fails too, so the next update tries again.
export async function removeUntouchedSamples(options: {
    backedUp: boolean
    backup?: () => Promise<unknown>
}): Promise<SampleCleanupResult | undefined> {
    if (LAB_BUILD) return undefined
    const stamp = await browser.storage.local.get(SAMPLE_CLEANUP_FLAG)
    if (stamp[SAMPLE_CLEANUP_FLAG]) return undefined
    const samples = await db.manga.where("id").startsWith(SAMPLE_ID_PREFIX).toArray()
    if (samples.length > 0 && !options.backedUp) {
        try {
            await (options.backup ?? (() => createBackup("pre-update")))()
        } catch {
            return undefined
        }
    }

    const result: SampleCleanupResult = { removed: [], kept: [], profilesRemoved: [] }
    await db.transaction(
        "rw",
        [
            db.manga,
            db.sourceLinks,
            db.chapters,
            db.covers,
            db.progress,
            db.historyEvents,
            db.pageBookmarks,
            db.downloads,
            db.archProfiles
        ],
        async () => {
            const sampleSources = new Set<string>()
            for (const manga of await db.manga.where("id").startsWith(SAMPLE_ID_PREFIX).toArray()) {
                if (await isUntouchedSample(manga)) {
                    const link = await db.sourceLinks.get(manga.id)
                    sampleSources.add(manga.sourceId)
                    if (link) sampleSources.add(link.sourceId)
                    await db.chapters.where("mangaId").equals(manga.id).delete()
                    await db.sourceLinks.delete(manga.id)
                    await db.covers.delete(manga.id)
                    await db.manga.delete(manga.id)
                    result.removed.push(manga.id)
                    continue
                }
                result.kept.push(manga.id)
                if (hasSampleCover(manga)) await db.manga.update(manga.id, { coverUrl: undefined })
            }
            for (const sourceId of sampleSources) {
                if (await sourceStillUsed(sourceId)) continue
                const row = await db.archProfiles.get(sourceId)
                if (!row || rowOrigin(row) !== "seed") continue
                await db.archProfiles.delete(sourceId)
                result.profilesRemoved.push(sourceId)
            }
        }
    )
    await browser.storage.local.set({
        [SAMPLE_CLEANUP_FLAG]: { at: Date.now(), removed: result.removed.length, kept: result.kept.length }
    })
    if (result.profilesRemoved.length > 0) await resyncStoredArchProfiles()
    return result
}
