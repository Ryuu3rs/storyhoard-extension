// 0.32.2 shipped the "Load samples" button in its store build, so some users hold the sample library: manga
// rows with ids "seed-*" and covers at "/sample-covers/*", plus the seed profile rows 0.32.2 wrote for their
// sites. The store build ships neither the covers nor the button. On the first update to it, after the
// pre-update backup, the samples the user never touched are removed with their chapters and links, and so
// are the seed profile rows only those samples used. A sample the user did touch stays, with its sample
// cover cleared so the normal cover backfill finds it a real one, and from then on it is the user's title.
// A restore, file import or gist pull can bring samples back with their sample covers, so the same pass
// runs after each of those too. Store builds only.

import { recordTombstone } from "../account"
import { resyncStoredArchProfiles, rowOrigin } from "../arch-sources"
import { LAB_BUILD } from "../build-flavor"
import { createBackup, db, type LibraryManga } from "../database"
import { SAMPLE_ID_PREFIX, hasSampleCover, isStillSample } from "../sample-rows"
import { workKeyOf } from "../work-identity"

export const SAMPLE_CLEANUP_FLAG = "sampleCleanupV1"

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

// Every pass below leaves a sample either removed or without its sample cover (a kept sample), so in a store
// build no other sample row remains.
//
// Conservative: a sample counts as untouched only while it still has its sample cover, carries none of the
// fields above and no categories, has no reading progress, history, page bookmark or download, and no
// preferred source pinned for it. The available count is not a touch: a count pulled from another device's
// update check looks exactly like one typed by hand, and a sample whose only change is a count holds none of
// the user's reading.
export async function isUntouchedSample(manga: LibraryManga): Promise<boolean> {
    if (!isStillSample(manga)) return false
    if (TOUCH_FIELDS.some(field => manga[field] !== undefined)) return false
    if ((manga.categories ?? []).length > 0) return false
    const [progress, history, bookmarks, downloads, overrides] = await Promise.all([
        db.progress.where("mangaId").equals(manga.id).count(),
        db.historyEvents.where("mangaId").equals(manga.id).count(),
        db.pageBookmarks.where("mangaId").equals(manga.id).count(),
        db.downloads.where("mangaId").equals(manga.id).count(),
        db.workOverrides.toArray()
    ])
    if (progress + history + bookmarks + downloads > 0) return false
    const workKey = workKeyOf(manga, manga.id)
    return !overrides.some(o => o.preferredSourceId && (o.members.includes(workKey) || o.members.includes(manga.id)))
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
    const result = await cleanSampleRows()
    await browser.storage.local.set({
        [SAMPLE_CLEANUP_FLAG]: { at: Date.now(), removed: result.removed.length, kept: result.kept.length }
    })
    return result
}

// After a restore, file import or gist pull: the same pass for samples that came back with their sample
// covers. Rows with no sample cover are left alone, so a kept sample keeps everything the user gave it. The
// library just replaced was backed up before the import, and an untouched sample holds nothing of the user's.
export async function removeReturnedSamples(): Promise<SampleCleanupResult | undefined> {
    if (LAB_BUILD) return undefined
    const returned = await db.manga
        .where("id")
        .startsWith(SAMPLE_ID_PREFIX)
        .filter(manga => hasSampleCover(manga))
        .count()
    if (returned === 0) return undefined
    return cleanSampleRows()
}

async function cleanSampleRows(): Promise<SampleCleanupResult> {
    const result: SampleCleanupResult = { removed: [], kept: [], profilesRemoved: [] }
    const removedAt = new Map<string, number>()
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
            db.workOverrides,
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
                    removedAt.set(manga.id, manga.updatedAt)
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
    // A linked account keeps its copy of a removed sample unless the removal reaches it, and the sample would
    // come back on the next pull or a new device. The removal is stamped just after the removed copy's own last
    // change, not now: another device may hold a newer copy the user read there, and that copy must win.
    for (const id of result.removed) {
        await recordTombstone(id, undefined, (removedAt.get(id) ?? 0) + 1).catch(() => undefined)
    }
    if (result.profilesRemoved.length > 0) await resyncStoredArchProfiles()
    return result
}
