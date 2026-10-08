import { readingProgressSchema, sourceLinkRecordSchema } from "@amr/contracts"
import type { ChapterRecord, MangaRecord, ReadingProgress, SourceLinkRecord } from "@amr/contracts"
import { normalizeTitle } from "@amr/normalize"
import { isNumberedChapter } from "@amr/source-sdk"
import Dexie, { type EntityTable, type Table } from "dexie"
import { z } from "zod"
import {
    envelopeStructureSchema,
    historyEventSchema,
    importChapterSchema,
    libraryMangaSchema,
    pageBookmarkSchema
} from "./schema"

export interface CoverCacheRecord {
    mangaId: string
    blob: Blob
    cachedAt: number
}

export type LibraryManga = MangaRecord & {
    sourceId: string
    sourceUrl: string
    sourceMangaId?: string
    mangaUrl?: string
    latestChapterId?: string
    lastReadChapterId?: string
    // Domain-independent progress: the chapter *number* survives mirror/domain
    // changes that invalidate the URL-derived chapter IDs above.
    latestChapterNumber?: number
    lastReadChapterNumber?: number
    // When a genuinely new chapter was last detected for this title (for the "recently
    // updated" sort). Distinct from updatedAt, which also moves on tag/category/relink
    // edits, and from a bare id re-slug that isn't a real advance.
    latestChapterAt?: number
    // When the user last read a chapter of this title (for "recently read" sort),
    // distinct from updatedAt which also moves on source update checks.
    lastReadAt?: number
    // Manual / "Do Not Scan": skip automatic update checks; the user maintains the
    // available + read chapter numbers by hand (e.g. Asura-style domain-hoppers).
    manualTracking?: boolean
    // On Hold: skip automatic update checks like manualTracking, but also hide from
    // the "reading" filter/pool so a paused title doesn't nag with an unread badge.
    // Unlike manualTracking the source link stays live - un-holding resumes normal checks.
    onHold?: boolean
    // Explicit reading-status override for the states that CAN'T be derived from read
    // progress (reading/completed/unread are derived - see reading-status.ts). Cleared
    // automatically when the user reads a chapter (saveProgress un-pauses/un-drops).
    // Non-indexed, so no Dexie schema/version change is needed - same as onHold/manualTracking.
    readingStatus?: "paused" | "dropped" | "planning"
    // When readingStatus (or a status-changing local action) last changed, in epoch ms.
    // The last-writer tiebreak for bidirectional AniList status sync: compared against the
    // remote list entry's updatedAt so neither side clobbers a newer change. Non-indexed.
    readingStatusUpdatedAt?: number
    // User categories / labels for filtering the library.
    categories?: string[]
    // User-flagged adult content (covers blurred when the blur setting is on).
    nsfw?: boolean
    // Free-form per-manga notes the user keeps alongside the title.
    notes?: string
    // Genres fetched from the source (cached to avoid repeat network calls).
    genres?: string[]
    // Metadata-catalog cross-id (AniList media id), resolved once and reused for
    // status/cover/genre enrichment and personal-list sync. Not indexed - read off a
    // manga already fetched by id.
    anilistId?: number
    // When the metadata-enrichment pass last resolved this title, so it can skip
    // recently-checked titles and re-try stale/no-match ones.
    metadataUpdatedAt?: number
    // Per-series reading overrides - when set, the reader uses these instead of
    // the global reading settings for chapters of this title.
    readingDirection?: "ltr" | "rtl" | "vertical"
    pageFit?: "width" | "height" | "contain" | "original" | "actual"
    // Per-series override for the global "Page width" (Fit-width fill percent, 30-100).
    // undefined means "no override, use the global default".
    pageWidthPct?: number
    // Per-series override for the global "no gap continuous" reader setting -
    // undefined means "no override, use the global default".
    noGapContinuous?: boolean
    // Per-series override for the on-site reader's "Continuous scroll" layer and the
    // reading-view theme (Auto/Light/Dark). undefined means "no override, use the default".
    continuousScroll?: boolean
    readerTheme?: "auto" | "light" | "dark"
    // Set by library:switch when moving to a source whose chapter numbering can't be
    // assumed comparable to the previous source's (e.g. MangaHub numbers chapters by
    // its own internal sequential URL slug, which can diverge from the numbering other
    // sources use for the same manga) - a future UI can use this to warn instead of
    // silently comparing chapter counts that don't mean what they look like they mean.
    chapterNumberingUnreliable?: boolean
    // Canonical Work id (ecosystem contract C4). Server-authoritative: resolved by weeb.ltd
    // on sync and read back onto the row, never set by this client. undefined until the row
    // has synced through the Work-aware sync path. Preserved across merges like any stored field.
    workId?: string
}

export type HistoryEvent = {
    id?: number
    mangaId: string
    chapterId: string
    type: "started" | "completed"
    occurredAt: number
}

export type ChapterDownload = {
    chapterId: string
    mangaId: string
    pageBlobs: Blob[]
    pageCount: number
    downloadedAt: number
}

export type PageBookmark = {
    id: string
    mangaId: string
    chapterId: string
    pageIndex: number
    mangaTitle: string
    chapterTitle: string
    chapterUrl: string
    addedAt: number
}

export type AnalyticsEvent = {
    id?: number
    event:
        | "capture_ok" // chapter URL auto-captured from a tab
        | "capture_error" // capture failed (CF block, 404, etc.)
        | "reader_opened" // user opened chapter in AMR reader
        | "on_site_track" // marked read while reading on-site (via panel)
        | "panel_action" // any panel button click (detail: { action })
        | "resolve_direct" // chapter resolved via direct HTTP fetch
        | "resolve_tab" // chapter required the tab-fallback (CF-gated site)
    sourceId?: string
    ts: number
    detail?: string // JSON blob for event-specific fields
}

// A diagnostic log entry for the user-exportable log (see recordLog + the log:export
// handler). Bounded ring buffer (count-trimmed to LOG_MAX). detail is a JSON blob,
// redacted at export time (formatDiagnosticLog) - never carries a token.
export type LogEntry = {
    id?: number
    ts: number
    level: "debug" | "info" | "warn" | "error"
    scope: string
    message: string
    detail?: string
    sourceId?: string
}

// Full export envelope, snapshotted automatically before any import/sync-pull
// mutation so a bad import can be undone. See createBackup/listBackups/restoreBackup
// below and the data:backup:list / data:backup:restore handlers in
// handlers/data-sync-settings.ts.
export type LibraryBackup = {
    id?: number
    createdAt: number
    reason: "pre-import" | "pre-sync-pull" | "pre-clear" | "pre-cleanup" | "pre-merge" | "pre-update" | "auto"
    envelope: Awaited<ReturnType<typeof exportDatabase>>
}

// Response shape for the `data:backup:list` message: just enough to render a list
// and let the user pick one to restore - deliberately excludes `envelope` (the full
// library snapshot) to keep the response small. Call `data:backup:restore` with the
// chosen `id` to actually apply it.
export type BackupSummary = { id: number; createdAt: number; reason: LibraryBackup["reason"] }

// ARCH TRACK A (experimental): a stored user-imported source profile. `profile` is the raw
// (already-validated) Site Profile JSON; kept opaque here so the DB layer has no dependency on
// the engine's schema.
// `origin` records who wrote the row: "user" for a site the user added, "seed" for the one-time
// migration seed. Additive and optional (older rows have none); it lives in the row, not the schema,
// and is re-validated loosely wherever it is read.
export type ArchProfileOrigin = "seed" | "user"
export type StoredArchProfile = { id: string; profile: unknown; importedAt: number; origin?: ArchProfileOrigin }

// ARCH TRACK A: the best-version ranking system's version pool. A logical "work" (a title the user
// tracks) may exist as several source versions; the ranker needs them stored so it can rank
// offline. VersionRecord is one observed (source, series) pair. Device-local cache rebuildable from
// search/visits, so it is NOT synced across devices (privacy + cursor bloat) but it DOES flow
// through local backup/export/restore like any other table.
export type VersionNumberingKind = "chapter" | "volume" | "season" | "unreliable"
export type VersionHealth = "ok" | "degraded" | "dead" | "unknown"
export type VersionObservedVia = "own-source" | "search" | "mirror-check" | "detect-on-visit" | "sync"

export type VersionRecord = {
    // `${sourceId}:${sourceMangaId}` - stable, matches the manga-id convention.
    id: string
    // The grouping key at observation time (workKeyOf). Indexed for per-work lookups.
    workKey: string
    sourceId: string
    sourceMangaId: string
    url: string
    // From the source adapter manifest / profile. Drives the language tier gate in the ranker.
    languages: string[]
    // Finite only (a non-finite value is stripped on write, same discipline as db.manga).
    latestChapterNumber?: number
    // Raw label as seen (for display/debug), e.g. "Vol. 3 Ch. 100.5".
    latestChapterLabel?: string
    // When this version's latest chapter was released/detected (epoch ms), for the recency term
    // in the ranker. Distinct from lastSeenAt (when WE last observed the version).
    latestChapterAt?: number
    isOfficialAtObservation?: boolean
    health: VersionHealth
    // Permanent fix for volume/season-reset numbering (owner decision): the ranker reads this to
    // avoid treating a volume- or season-numbered source as if it were chapter-numbered.
    numberingKind: VersionNumberingKind
    lastSeenAt: number
    observedVia: VersionObservedVia
}

// A user merge/split decision, or a per-work preferred source. Derived grouping can't remember
// these, so they persist. Small and user-intent, so this table DOES sync (last-writer-wins by
// updatedAt).
export type WorkOverrideType = "merge" | "split"
export type WorkOverride = {
    id: string
    type: WorkOverrideType
    // merge: force these workKeys/version ids into one logical work. split: force a member out.
    members: string[]
    // "Always use this source for this title" - the ranker treats it as an absolute winner.
    preferredSourceId?: string
    updatedAt: number
}

// true for an http(s) URL only. The version pool's url is navigated to by the on-site panel, so a
// non-http scheme (javascript:, data:) must never be trusted from imported/observed data.
export function isHttpUrl(value: string): boolean {
    try {
        const p = new URL(value)
        return p.protocol === "http:" || p.protocol === "https:"
    } catch {
        return false
    }
}

const versionRecordImportSchema = z
    .object({
        id: z.string().min(1),
        workKey: z.string().min(1),
        sourceId: z.string().min(1),
        sourceMangaId: z.string().min(1),
        url: z.string().refine(isHttpUrl, "url must be http(s)"),
        languages: z.array(z.string()),
        latestChapterNumber: z.number().finite().optional(),
        latestChapterLabel: z.string().optional(),
        latestChapterAt: z.number().finite().optional(),
        isOfficialAtObservation: z.boolean().optional(),
        health: z.enum(["ok", "degraded", "dead", "unknown"]),
        numberingKind: z.enum(["chapter", "volume", "season", "unreliable"]),
        lastSeenAt: z.number().finite(),
        observedVia: z.enum(["own-source", "search", "mirror-check", "detect-on-visit", "sync"])
    })
    .strict()

const workOverrideImportSchema = z
    .object({
        id: z.string().min(1),
        type: z.enum(["merge", "split"]),
        members: z.array(z.string()),
        preferredSourceId: z.string().optional(),
        updatedAt: z.number().finite()
    })
    .strict()

export class AmrDatabase extends Dexie {
    manga!: EntityTable<LibraryManga, "id">
    sourceLinks!: EntityTable<SourceLinkRecord, "mangaId">
    chapters!: EntityTable<ChapterRecord, "id">
    progress!: EntityTable<ReadingProgress, "chapterId">
    historyEvents!: EntityTable<HistoryEvent, "id">
    downloads!: EntityTable<ChapterDownload, "chapterId">
    covers!: Table<CoverCacheRecord, string>
    pageBookmarks!: EntityTable<PageBookmark, "id">
    analyticsEvents!: EntityTable<AnalyticsEvent, "id">
    backups!: EntityTable<LibraryBackup, "id">
    logs!: EntityTable<LogEntry, "id">
    // ARCH TRACK A (experimental): user-imported source profiles. First-class storage so they
    // survive like real data and flow into backup/export (and later sync). Additive store only.
    archProfiles!: Table<StoredArchProfile, string>
    // ARCH TRACK A: best-version ranking. Additive stores; the version pool is a device-local
    // cache, the overrides are user intent. Both carried through backup/export/restore.
    versions!: Table<VersionRecord, string>
    workOverrides!: Table<WorkOverride, string>

    constructor() {
        super("all-mangas-reader")
        this.version(1).stores({
            manga: "id, normalizedTitle, sourceId, addedAt, updatedAt",
            chapters: "id, mangaId, sourceId, sortKey",
            progress: "chapterId, mangaId, updatedAt, completed"
        })
        this.version(2).stores({
            manga: "id, normalizedTitle, sourceId, addedAt, updatedAt",
            sourceLinks: "mangaId, sourceId, sourceMangaId, updatedAt",
            chapters: "id, mangaId, sourceId, sortKey",
            progress: "chapterId, mangaId, updatedAt, completed",
            historyEvents: "++id, mangaId, chapterId, type, occurredAt"
        })
        this.version(3).stores({
            manga: "id, normalizedTitle, sourceId, addedAt, updatedAt",
            sourceLinks: "mangaId, sourceId, sourceMangaId, updatedAt",
            chapters: "id, mangaId, sourceId, sortKey",
            progress: "chapterId, mangaId, updatedAt, completed",
            historyEvents: "++id, mangaId, chapterId, type, occurredAt",
            downloads: "chapterId, mangaId, downloadedAt"
        })
        this.version(4).stores({
            manga: "id, normalizedTitle, sourceId, addedAt, updatedAt",
            sourceLinks: "mangaId, sourceId, sourceMangaId, updatedAt",
            chapters: "id, mangaId, sourceId, sortKey",
            progress: "chapterId, mangaId, updatedAt, completed",
            historyEvents: "++id, mangaId, chapterId, type, occurredAt",
            downloads: "chapterId, mangaId, downloadedAt",
            covers: "mangaId"
        })
        this.version(5).stores({
            manga: "id, normalizedTitle, sourceId, addedAt, updatedAt",
            sourceLinks: "mangaId, sourceId, sourceMangaId, updatedAt",
            chapters: "id, mangaId, sourceId, sortKey",
            progress: "chapterId, mangaId, updatedAt, completed",
            historyEvents: "++id, mangaId, chapterId, type, occurredAt",
            downloads: "chapterId, mangaId, downloadedAt",
            covers: "mangaId",
            pageBookmarks: "id, mangaId, chapterId, addedAt"
        })
        this.version(6).stores({
            manga: "id, normalizedTitle, sourceId, addedAt, updatedAt",
            sourceLinks: "mangaId, sourceId, sourceMangaId, updatedAt",
            chapters: "id, mangaId, sourceId, sortKey",
            progress: "chapterId, mangaId, updatedAt, completed",
            historyEvents: "++id, mangaId, chapterId, type, occurredAt",
            downloads: "chapterId, mangaId, downloadedAt",
            covers: "mangaId",
            pageBookmarks: "id, mangaId, chapterId, addedAt",
            analyticsEvents: "++id, event, ts, sourceId"
        })
        this.version(7).stores({
            manga: "id, normalizedTitle, sourceId, addedAt, updatedAt",
            sourceLinks: "mangaId, sourceId, sourceMangaId, updatedAt",
            chapters: "id, mangaId, sourceId, sortKey",
            progress: "chapterId, mangaId, updatedAt, completed",
            historyEvents: "++id, mangaId, chapterId, type, occurredAt",
            downloads: "chapterId, mangaId, downloadedAt",
            covers: "mangaId",
            pageBookmarks: "id, mangaId, chapterId, addedAt",
            analyticsEvents: "++id, event, ts, sourceId",
            // Pre-import/pre-sync-pull safety-net snapshots - see LibraryBackup.
            backups: "++id, createdAt, reason"
        })
        // Covers used to be inlined as base64 data: URIs directly into
        // LibraryManga.coverUrl, which bloats every library:list response, every
        // export, and every retained backup (see MAX_BACKUPS). This migration moves
        // any already-inlined cover into the covers table (keyed by mangaId, same
        // shape cacheCover() writes) and clears the data: URI off the manga record -
        // the UI already prefers the covers-table blob (via coverSrcs) over raw
        // coverUrl at every render site. Also adds an index on chapters.url so
        // chapter:siblings can do an indexed lookup instead of a full table scan.
        this.version(8)
            .stores({
                manga: "id, normalizedTitle, sourceId, addedAt, updatedAt",
                sourceLinks: "mangaId, sourceId, sourceMangaId, updatedAt",
                chapters: "id, mangaId, sourceId, sortKey, url",
                progress: "chapterId, mangaId, updatedAt, completed",
                historyEvents: "++id, mangaId, chapterId, type, occurredAt",
                downloads: "chapterId, mangaId, downloadedAt",
                covers: "mangaId",
                pageBookmarks: "id, mangaId, chapterId, addedAt",
                analyticsEvents: "++id, event, ts, sourceId",
                backups: "++id, createdAt, reason"
            })
            .upgrade(async tx => {
                // Decode every cover BEFORE touching IndexedDB again. Firefox auto-commits
                // (inactivates) a versionchange transaction the moment the microtask queue
                // drains with no pending IDB request, so doing non-IDB async work - atob,
                // Blob construction - between two awaited IDB writes let the transaction
                // close mid-migration and the whole upgrade abort, leaving the DB stuck at
                // the old version and the library unreadable. Read once, transform
                // synchronously, then write in one uninterrupted batch so the only awaits
                // in this callback are back-to-back IDB requests.
                const now = Date.now()
                const allManga = await tx.table("manga").toArray()
                const coverRows: Array<{ mangaId: string; blob: Blob; cachedAt: number }> = []
                const clearedIds: string[] = []
                for (const m of allManga) {
                    if (typeof m.coverUrl !== "string" || !m.coverUrl.startsWith("data:")) continue
                    const match = /^data:([^;]+);base64,(.+)$/.exec(m.coverUrl)
                    const mime = match?.[1]
                    const b64 = match?.[2]
                    if (!mime || !b64) continue
                    try {
                        const binary = atob(b64)
                        const bytes = new Uint8Array(binary.length)
                        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
                        coverRows.push({ mangaId: m.id, blob: new Blob([bytes], { type: mime }), cachedAt: now })
                        clearedIds.push(m.id)
                    } catch {
                        // Malformed data: URI - skip this record, don't abort the migration.
                    }
                }
                if (coverRows.length > 0) await tx.table("covers").bulkPut(coverRows)
                for (const id of clearedIds) await tx.table("manga").update(id, { coverUrl: undefined })
            })
        // Repair migration for the UNNUMBERED_SORT_KEY (Infinity) leak class: pre-fix
        // aggregation bugs (a plain Math.max/reduce over sortKey with no finite filter)
        // could persist a non-finite latestChapterNumber. IndexedDB keeps Infinity
        // (structured clone), but JSON.stringify turns it into null on backup export,
        // and schema.ts's `z.number().finite()` then rejects the whole record on
        // restore - the title silently vanishes from a restored library. Delete the
        // poisoned field entirely (never zero it - 0 is a genuine Chapter 0) so it
        // self-heals via the next real update check instead of staying corrupt forever.
        this.version(9)
            .stores({
                manga: "id, normalizedTitle, sourceId, addedAt, updatedAt",
                sourceLinks: "mangaId, sourceId, sourceMangaId, updatedAt",
                chapters: "id, mangaId, sourceId, sortKey, url",
                progress: "chapterId, mangaId, updatedAt, completed",
                historyEvents: "++id, mangaId, chapterId, type, occurredAt",
                downloads: "chapterId, mangaId, downloadedAt",
                covers: "mangaId",
                pageBookmarks: "id, mangaId, chapterId, addedAt",
                analyticsEvents: "++id, event, ts, sourceId",
                backups: "++id, createdAt, reason"
            })
            .upgrade(async tx => {
                await tx
                    .table("manga")
                    .toCollection()
                    .modify(m => {
                        if (m.latestChapterNumber !== undefined && !Number.isFinite(m.latestChapterNumber)) {
                            delete m.latestChapterNumber
                        }
                    })
            })
        // v10: diagnostic log ring buffer (bounded, count-trimmed by recordLog) backing
        // the user-exportable diagnostic log. New table only - no data migration.
        this.version(10).stores({
            manga: "id, normalizedTitle, sourceId, addedAt, updatedAt",
            sourceLinks: "mangaId, sourceId, sourceMangaId, updatedAt",
            chapters: "id, mangaId, sourceId, sortKey, url",
            progress: "chapterId, mangaId, updatedAt, completed",
            historyEvents: "++id, mangaId, chapterId, type, occurredAt",
            downloads: "chapterId, mangaId, downloadedAt",
            covers: "mangaId",
            pageBookmarks: "id, mangaId, chapterId, addedAt",
            analyticsEvents: "++id, event, ts, sourceId",
            backups: "++id, createdAt, reason",
            logs: "++id, ts, level"
        })
        // v11: extend the v9 repair sweep to lastReadChapterNumber. v9 only deleted a
        // non-finite latestChapterNumber; a row that had persisted Infinity in
        // lastReadChapterNumber (from a pre-guard cross-source merge or a bad import)
        // never self-heals, because saveProgress's ratchet gates on
        // `reported >= lastReadChapterNumber` and `>= Infinity` is always false - the
        // read position freezes and the title counts as an inflated completedSeries.
        // Delete the poisoned field entirely (never zero it - 0 is a genuine Chapter 0)
        // so the next real read re-establishes a finite position. Re-sweep
        // latestChapterNumber too, defensively, in case a row slipped past v9.
        this.version(11)
            .stores({
                manga: "id, normalizedTitle, sourceId, addedAt, updatedAt",
                sourceLinks: "mangaId, sourceId, sourceMangaId, updatedAt",
                chapters: "id, mangaId, sourceId, sortKey, url",
                progress: "chapterId, mangaId, updatedAt, completed",
                historyEvents: "++id, mangaId, chapterId, type, occurredAt",
                downloads: "chapterId, mangaId, downloadedAt",
                covers: "mangaId",
                pageBookmarks: "id, mangaId, chapterId, addedAt",
                analyticsEvents: "++id, event, ts, sourceId",
                backups: "++id, createdAt, reason",
                logs: "++id, ts, level"
            })
            .upgrade(async tx => {
                await tx
                    .table("manga")
                    .toCollection()
                    .modify(m => {
                        if (m.lastReadChapterNumber !== undefined && !Number.isFinite(m.lastReadChapterNumber)) {
                            delete m.lastReadChapterNumber
                        }
                        if (m.latestChapterNumber !== undefined && !Number.isFinite(m.latestChapterNumber)) {
                            delete m.latestChapterNumber
                        }
                    })
            })
        // ARCH TRACK A (experimental): additive store for user-imported source profiles. No
        // upgrade callback (pure additive, per the migration-safety review); existing stores
        // carry forward unchanged. Frozen DB name is untouched.
        this.version(12).stores({
            archProfiles: "id, importedAt"
        })
        // ARCH TRACK A: best-version ranking stores. Pure additive, no upgrade callback (same
        // migration-safety decision as v12): existing stores carry forward unchanged, the frozen
        // DB name is untouched. `versions` indexed by workKey (per-work lookups) and lastSeenAt
        // (staleness); `workOverrides` by updatedAt (sync last-writer-wins).
        this.version(13).stores({
            versions: "id, workKey, sourceId, lastSeenAt",
            workOverrides: "id, updatedAt"
        })
        // Choke-point tripwire for the same leak class: a future unguarded aggregation
        // site now fails loudly (throws, so a unit test catches it) instead of silently
        // persisting a sentinel that corrupts backups. Deleting the field (undefined)
        // to heal a record - as the migration above and the repair sweep do - is still
        // allowed; only a genuinely non-finite VALUE is rejected.
        this.manga.hook("creating", (_primKey, obj) => {
            assertFiniteLatestChapterNumber(obj)
        })
        this.manga.hook("updating", modifications => {
            assertFiniteLatestChapterNumber(modifications as Partial<LibraryManga>)
        })
    }
}

function assertFiniteLatestChapterNumber(candidate: Partial<LibraryManga>): void {
    for (const field of ["latestChapterNumber", "lastReadChapterNumber"] as const) {
        const value = candidate[field]
        if (value !== undefined && !Number.isFinite(value)) {
            throw new Error(
                `[AMR] Refusing to persist a non-finite ${field} (${value}) on db.manga - filter to a finite chapter (isNumberedChapter/latestNumberedChapter) before writing.`
            )
        }
    }
}

export const db = new AmrDatabase()

// ARCH TRACK A (experimental): CRUD for user-imported source profiles.
export async function putArchProfile(id: string, profile: unknown, origin: ArchProfileOrigin = "user"): Promise<void> {
    await db.archProfiles.put({ id, profile, importedAt: Date.now(), origin })
}

// An imported or pulled row must never replace a local one with less: a seed (recognition-only) row
// does not overwrite a source the user added, and a row without a chapter list does not overwrite one
// that has a list. Without this a pull from a device that only has the seed would silently downgrade
// a working added site to tracking-only.
function wouldDowngradeArchProfile(current: StoredArchProfile | undefined, incoming: StoredArchProfile): boolean {
    if (!current) return false
    if (current.origin === "user" && incoming.origin === "seed") return true
    const hasList = (profile: unknown): boolean =>
        typeof profile === "object" && profile !== null && (profile as { list?: unknown }).list != null
    return hasList(current.profile) && !hasList(incoming.profile)
}

export async function listArchProfiles(): Promise<unknown[]> {
    return (await db.archProfiles.toArray()).map(row => row.profile)
}

export async function listArchProfileRows(): Promise<StoredArchProfile[]> {
    return db.archProfiles.toArray()
}

export async function deleteArchProfile(id: string): Promise<void> {
    await db.archProfiles.delete(id)
}

// ARCH TRACK A: version-pool CRUD. latestChapterNumber is sanitized to finite-or-absent on write,
// so a non-finite value can never poison a comparison or a JSON round-trip (same discipline the
// db.manga tripwire enforces for that table).
function sanitizeVersion(v: VersionRecord): VersionRecord {
    if (v.latestChapterNumber !== undefined && !Number.isFinite(v.latestChapterNumber)) {
        const { latestChapterNumber: _drop, ...rest } = v
        return rest
    }
    return v
}

export async function putVersion(version: VersionRecord): Promise<void> {
    await db.versions.put(sanitizeVersion(version))
}

export async function putVersions(versions: VersionRecord[]): Promise<void> {
    if (versions.length > 0) await db.versions.bulkPut(versions.map(sanitizeVersion))
}

export async function listVersionsByWork(workKey: string): Promise<VersionRecord[]> {
    return db.versions.where("workKey").equals(workKey).toArray()
}

export async function listAllVersions(): Promise<VersionRecord[]> {
    return db.versions.toArray()
}

export async function deleteVersion(id: string): Promise<void> {
    await db.versions.delete(id)
}

// Drop every version row for a source - used when a user-imported source/profile is removed so the
// ranker stops surfacing a version that can no longer be opened.
export async function deleteVersionsForSource(sourceId: string): Promise<void> {
    await db.versions.where("sourceId").equals(sourceId).delete()
}

export async function putWorkOverride(override: WorkOverride): Promise<void> {
    await db.workOverrides.put(override)
}

export async function listWorkOverrides(): Promise<WorkOverride[]> {
    return db.workOverrides.toArray()
}

export async function deleteWorkOverride(id: string): Promise<void> {
    await db.workOverrides.delete(id)
}

// Merges two optional numbers, keeping the larger; returns undefined only when
// BOTH are undefined. Replaces the `Math.max(a ?? 0, b ?? 0) || undefined` idiom,
// which mapped two genuine chapter-0 values (Math.max(0, 0) === 0, then
// `0 || undefined`) to undefined, silently wiping real chapter-0 reading progress
// on relink/merge/import. Behavior-equivalent to that idiom for the lastReadAt
// TIMESTAMP merges too (a genuine 0 epoch never occurs), so those route through it
// as well - keeping the eslint guard that bans the old idiom carve-out-free.
function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
    if (a === undefined) return b
    if (b === undefined) return a
    return Math.max(a, b)
}

export async function cacheCover(mangaId: string, blob: Blob): Promise<void> {
    // Guard against orphaning a covers row for a manga removed between the (often
    // fire-and-forget, network-bound) cover fetch and this write - by now the title may
    // be gone. A bare put() would create a row keyed by a non-existent manga that nothing
    // reconciles, wasting space and able to resurface as a stale image if the id is reused.
    await db.transaction("rw", [db.manga, db.covers], async () => {
        if (!(await db.manga.get(mangaId))) return
        await db.covers.put({ mangaId, blob, cachedAt: Date.now() })
    })
}

export async function getCachedCover(mangaId: string): Promise<Blob | undefined> {
    return (await db.covers.get(mangaId))?.blob
}

// Batched lookup for loading a whole library's covers at once - one IndexedDB
// round-trip instead of one per manga, which matters once the library has
// hundreds of entries. Returns the full cover rows (blob + cachedAt) so the
// UI can tell a re-cached blob apart from an unchanged one (capture.ts
// re-caches the cover on every successful capture) without comparing bytes.
export async function getCachedCovers(mangaIds: readonly string[]): Promise<Map<string, CoverCacheRecord>> {
    const records = await db.covers.bulkGet([...mangaIds])
    const out = new Map<string, CoverCacheRecord>()
    records.forEach((record, i) => {
        if (record) out.set(mangaIds[i]!, record)
    })
    return out
}

export async function clearLibrary(): Promise<void> {
    await db.transaction(
        "rw",
        [
            db.manga,
            db.sourceLinks,
            db.chapters,
            db.progress,
            db.historyEvents,
            db.downloads,
            db.covers,
            db.pageBookmarks
        ],
        async () => {
            await Promise.all([
                db.manga.clear(),
                db.sourceLinks.clear(),
                db.chapters.clear(),
                db.progress.clear(),
                db.historyEvents.clear(),
                db.downloads.clear(),
                db.covers.clear(),
                db.pageBookmarks.clear()
            ])
        }
    )
}

export async function clearHistory(): Promise<void> {
    await db.transaction("rw", [db.historyEvents, db.progress], async () => {
        await Promise.all([db.historyEvents.clear(), db.progress.clear()])
    })
}

// Account-sync writes (handlers/account.ts). A pulled server copy is applied only after the
// caller has checked it is newer than the local row, so these are plain writes with no merge.
export async function applySyncedManga(mangaId: string, patch: Partial<LibraryManga>): Promise<void> {
    await db.manga.update(mangaId, patch)
}

// Atomic compare-and-write for a pulled sync item. The caller's outer updatedAt check is a fast
// path, but a user edit can land between that read and this write during a long paged pull; an rw
// transaction on the manga store serializes against updateManga, so re-checking inside it means a
// concurrent newer edit is seen and the pull does NOT regress its updatedAt (which would drop the
// edit from the next push). Stamps the incoming clientUpdatedAt. Returns whether it wrote.
export async function applySyncedMangaIfNewer(
    mangaId: string,
    patch: Partial<LibraryManga>,
    clientUpdatedAt: number
): Promise<boolean> {
    return db.transaction("rw", db.manga, async () => {
        const fresh = await db.manga.get(mangaId)
        if (!fresh || fresh.updatedAt >= clientUpdatedAt) return false
        await db.manga.update(mangaId, { ...patch, updatedAt: clientUpdatedAt })
        return true
    })
}

export async function addSyncedManga(record: LibraryManga): Promise<void> {
    await db.manga.put(record)
}

export async function removeManga(mangaId: string): Promise<void> {
    await db.transaction(
        "rw",
        [
            db.manga,
            db.sourceLinks,
            db.chapters,
            db.progress,
            db.historyEvents,
            db.downloads,
            db.pageBookmarks,
            db.covers
        ],
        async () => {
            await db.manga.delete(mangaId)
            await db.sourceLinks.delete(mangaId)
            await db.chapters.where("mangaId").equals(mangaId).delete()
            await db.progress.where("mangaId").equals(mangaId).delete()
            await db.historyEvents.where("mangaId").equals(mangaId).delete()
            await db.downloads.where("mangaId").equals(mangaId).delete()
            await db.pageBookmarks.where("mangaId").equals(mangaId).delete()
            await db.covers.delete(mangaId)
        }
    )
}

export async function rekeyManga(oldId: string, next: LibraryManga, newSourceLink: SourceLinkRecord): Promise<void> {
    await db.transaction(
        "rw",
        [
            db.manga,
            db.sourceLinks,
            db.chapters,
            db.progress,
            db.historyEvents,
            db.downloads,
            db.pageBookmarks,
            db.covers
        ],
        async () => {
            if (next.id === oldId) {
                // Same ID - plain update, no migration needed
                await db.manga.put(next)
                await db.sourceLinks.put(newSourceLink)
                return
            }
            // Check if canonical new ID already exists (duplicate created by a prior capture)
            const existing = await db.manga.get(next.id)
            if (existing) {
                // Merge preserved user fields from whichever record has them. Build with
                // conditional spreads so we never assign `undefined` to an optional field
                // (exactOptionalPropertyTypes is on).
                const mergedLastReadNumber = maxDefined(existing.lastReadChapterNumber, next.lastReadChapterNumber)
                const mergedLastReadAt = maxDefined(existing.lastReadAt, next.lastReadAt)
                const lastReadChapterId = next.lastReadChapterId ?? existing.lastReadChapterId
                const rating = next.rating ?? existing.rating
                // Categories are a list - union them instead of letting one side's tags
                // silently disappear just because the other record also had some set.
                const mergedCategories = [...new Set([...(existing.categories ?? []), ...(next.categories ?? [])])]
                const categories = mergedCategories.length > 0 ? mergedCategories : undefined
                const notes = next.notes ?? existing.notes
                const nsfw = next.nsfw ?? existing.nsfw
                const manualTracking = next.manualTracking ?? existing.manualTracking
                const onHold = next.onHold ?? existing.onHold
                const readingStatus = next.readingStatus ?? existing.readingStatus
                const readingDirection = next.readingDirection ?? existing.readingDirection
                const pageFit = next.pageFit ?? existing.pageFit
                const pageWidthPct = next.pageWidthPct ?? existing.pageWidthPct
                const noGapContinuous = next.noGapContinuous ?? existing.noGapContinuous
                const continuousScroll = next.continuousScroll ?? existing.continuousScroll
                const readerTheme = next.readerTheme ?? existing.readerTheme
                const workId = next.workId ?? existing.workId
                // Enrichment: adopt whichever side has it (see mergeMangaRecords) so a relink-merge
                // into a non-enriched row keeps AniList linkage + cached genres.
                const anilistId = next.anilistId ?? existing.anilistId
                const genres = next.genres ?? existing.genres
                const metadataUpdatedAt = next.metadataUpdatedAt ?? existing.metadataUpdatedAt
                next = {
                    ...next,
                    addedAt: Math.min(existing.addedAt, next.addedAt),
                    ...(mergedLastReadNumber !== undefined ? { lastReadChapterNumber: mergedLastReadNumber } : {}),
                    ...(lastReadChapterId !== undefined ? { lastReadChapterId } : {}),
                    ...(mergedLastReadAt !== undefined ? { lastReadAt: mergedLastReadAt } : {}),
                    ...(rating !== undefined ? { rating } : {}),
                    ...(categories !== undefined ? { categories } : {}),
                    ...(notes !== undefined ? { notes } : {}),
                    ...(nsfw !== undefined ? { nsfw } : {}),
                    ...(manualTracking !== undefined ? { manualTracking } : {}),
                    ...(onHold !== undefined ? { onHold } : {}),
                    ...(readingStatus !== undefined ? { readingStatus } : {}),
                    ...(readingDirection !== undefined ? { readingDirection } : {}),
                    ...(pageFit !== undefined ? { pageFit } : {}),
                    ...(pageWidthPct !== undefined ? { pageWidthPct } : {}),
                    ...(noGapContinuous !== undefined ? { noGapContinuous } : {}),
                    ...(continuousScroll !== undefined ? { continuousScroll } : {}),
                    ...(readerTheme !== undefined ? { readerTheme } : {}),
                    ...(anilistId !== undefined ? { anilistId } : {}),
                    ...(genres !== undefined ? { genres } : {}),
                    ...(metadataUpdatedAt !== undefined ? { metadataUpdatedAt } : {}),
                    ...(workId !== undefined ? { workId } : {})
                }
            }
            await db.manga.put(next)
            await db.manga.delete(oldId)
            // Delete old-source chapters - URLs are stale by definition after relink
            await db.chapters.where("mangaId").equals(oldId).delete()
            await db.sourceLinks.delete(oldId)
            await db.sourceLinks.put(newSourceLink)
            // Migrate history/progress/downloads/bookmarks to new id
            await db.progress.where("mangaId").equals(oldId).modify({ mangaId: next.id })
            await db.historyEvents.where("mangaId").equals(oldId).modify({ mangaId: next.id })
            await db.downloads.where("mangaId").equals(oldId).modify({ mangaId: next.id })
            await db.pageBookmarks.where("mangaId").equals(oldId).modify({ mangaId: next.id })
            const cover = await db.covers.get(oldId)
            if (cover && (await db.covers.get(next.id)) === undefined) {
                await db.covers.put({ ...cover, mangaId: next.id })
            }
            await db.covers.delete(oldId)
        }
    )
}

// Merges one or more "loser" duplicate manga records into a single surviving
// "primary" record. Modeled on rekeyManga's transaction shape and row
// re-pointing pattern (progress/historyEvents/downloads/pageBookmarks are
// re-pointed via modify(), not copied - safe because a loser's chapters have
// different chapter ids than the primary's, so there's no key collision on
// tables keyed by chapterId), but unlike rekeyManga this never deletes the
// primary's own chapters - only each loser's chapters/sourceLinks/manga rows,
// since a merge (unlike a relink) doesn't invalidate the surviving side.
export async function mergeMangaRecords(primaryId: string, loserIds: string[]): Promise<LibraryManga> {
    return db.transaction(
        "rw",
        [
            db.manga,
            db.sourceLinks,
            db.chapters,
            db.progress,
            db.historyEvents,
            db.downloads,
            db.pageBookmarks,
            db.covers
        ],
        async () => {
            const primary = await db.manga.get(primaryId)
            if (!primary) throw new Error(`Cannot merge duplicates: primary manga "${primaryId}" does not exist`)

            let merged: LibraryManga = primary

            // A stale/already-removed id (e.g. two merge calls racing on the same group)
            // shouldn't abort the whole merge - just skip it via the filter below.
            const loserRecords = (
                await Promise.all(loserIds.filter(id => id !== primaryId).map(id => db.manga.get(id)))
            ).filter((l): l is LibraryManga => l !== undefined)
            // Same-source losers must be processed before cross-source losers: `merged`
            // evolves per-iteration, so gating on `loser.sourceId === merged.sourceId` isn't
            // enough - if a cross-source loser fills an empty slot first, a later same-source
            // loser's legitimate max could carry that cross-source loser's inflated number
            // alongside a live id, since the id-carry fill condition would already be cleared.
            // Sorting relative to the PRIMARY's sourceId (which never changes) avoids that.
            loserRecords.sort(
                (a, b) => Number(b.sourceId === primary.sourceId) - Number(a.sourceId === primary.sourceId)
            )

            for (const loser of loserRecords) {
                const loserId = loser.id
                // Chapter numbers are only comparable within a single source: different
                // sources split/number the same manga's chapters differently (see the
                // chapterNumberingUnreliable comment on LibraryManga). Maxing across sources
                // let a loser's higher-but-differently-numbered count inflate the primary,
                // which the next update check then silently reverted while mis-reporting the
                // title as updated (its id-change branch always fires for a carried foreign
                // chapter id) - see checkUpdates's "advanced" gate for the other half of this
                // fix. So: max within the same source (a true re-added duplicate), but
                // across sources the primary's own number+id pairs win, and a loser's pair
                // is only adopted to fill a slot where the primary has neither a number nor
                // an id. Losers are processed same-source-first (see the sort above this
                // loop) so a later same-source loser's legitimate max can't reintroduce a
                // cross-source dangling id into a slot an earlier cross-source loser filled.
                // Note: lastReadChapterNumber inflated by a past cross-source merge before
                // this fix landed self-heals the next time the user reads any chapter of
                // the title (saveProgress overwrites both the number and id from real
                // progress) - no migration is attempted here.
                const sameSource = loser.sourceId === merged.sourceId
                const fillLastRead =
                    !sameSource && merged.lastReadChapterNumber === undefined && merged.lastReadChapterId === undefined
                const fillLatest =
                    !sameSource && merged.latestChapterNumber === undefined && merged.latestChapterId === undefined
                const mergedLastReadNumber = sameSource
                    ? maxDefined(merged.lastReadChapterNumber, loser.lastReadChapterNumber)
                    : fillLastRead
                      ? loser.lastReadChapterNumber
                      : merged.lastReadChapterNumber
                const mergedLatestNumber = sameSource
                    ? maxDefined(merged.latestChapterNumber, loser.latestChapterNumber)
                    : fillLatest
                      ? loser.latestChapterNumber
                      : merged.latestChapterNumber
                const loserLatestWins = sameSource
                    ? loser.latestChapterId !== undefined &&
                      ((loser.latestChapterNumber ?? 0) > (merged.latestChapterNumber ?? 0) ||
                          merged.latestChapterId === undefined)
                    : fillLatest && loser.latestChapterId !== undefined
                const loserLastReadWins = sameSource
                    ? loser.lastReadChapterId !== undefined &&
                      ((loser.lastReadChapterNumber ?? 0) > (merged.lastReadChapterNumber ?? 0) ||
                          merged.lastReadChapterId === undefined)
                    : fillLastRead && loser.lastReadChapterId !== undefined
                // Same-source: if the number advanced to the loser's higher value but the
                // loser carried no id to bring along, the primary's old id now points at a
                // LOWER chapter than the number claims - clear it (self-heals on next read)
                // rather than leave number and id desynced.
                const clearLatestId =
                    sameSource && !loserLatestWins && mergedLatestNumber !== merged.latestChapterNumber
                const clearLastReadId =
                    sameSource && !loserLastReadWins && mergedLastReadNumber !== merged.lastReadChapterNumber
                const mergedLastReadAt = maxDefined(merged.lastReadAt, loser.lastReadAt)
                const mergedCategories = [...new Set([...(merged.categories ?? []), ...(loser.categories ?? [])])]
                const categories = mergedCategories.length > 0 ? mergedCategories : undefined
                // Notes: if both sides have non-empty notes, concatenate them (never
                // silently drop one side's notes just because the other also had some);
                // otherwise whichever side has notes wins.
                const notes =
                    merged.notes && loser.notes ? `${merged.notes}\n\n${loser.notes}` : (merged.notes ?? loser.notes)
                const rating = merged.rating ?? loser.rating
                const nsfw = merged.nsfw ?? loser.nsfw
                const manualTracking = merged.manualTracking ?? loser.manualTracking
                const onHold = merged.onHold ?? loser.onHold
                const readingStatus = merged.readingStatus ?? loser.readingStatus
                const readingDirection = merged.readingDirection ?? loser.readingDirection
                const pageFit = merged.pageFit ?? loser.pageFit
                const pageWidthPct = merged.pageWidthPct ?? loser.pageWidthPct
                const noGapContinuous = merged.noGapContinuous ?? loser.noGapContinuous
                const continuousScroll = merged.continuousScroll ?? loser.continuousScroll
                const readerTheme = merged.readerTheme ?? loser.readerTheme
                const workId = merged.workId ?? loser.workId
                // Enrichment fields: adopt the loser's when the primary lacks them, matching
                // mergeManga + saveResolvedChapter - otherwise merging a duplicate into a
                // non-enriched primary loses AniList linkage + cached genres (Discover seeds off them).
                const anilistId = merged.anilistId ?? loser.anilistId
                const genres = merged.genres ?? loser.genres
                const metadataUpdatedAt = merged.metadataUpdatedAt ?? loser.metadataUpdatedAt

                merged = {
                    ...merged,
                    addedAt: Math.min(merged.addedAt, loser.addedAt),
                    ...(mergedLastReadNumber !== undefined ? { lastReadChapterNumber: mergedLastReadNumber } : {}),
                    ...(mergedLatestNumber !== undefined ? { latestChapterNumber: mergedLatestNumber } : {}),
                    ...(loserLatestWins
                        ? { latestChapterId: loser.latestChapterId }
                        : clearLatestId
                          ? { latestChapterId: undefined }
                          : {}),
                    ...(loserLastReadWins
                        ? { lastReadChapterId: loser.lastReadChapterId }
                        : clearLastReadId
                          ? { lastReadChapterId: undefined }
                          : {}),
                    ...(mergedLastReadAt !== undefined ? { lastReadAt: mergedLastReadAt } : {}),
                    ...(categories !== undefined ? { categories } : {}),
                    ...(notes !== undefined ? { notes } : {}),
                    ...(rating !== undefined ? { rating } : {}),
                    ...(nsfw !== undefined ? { nsfw } : {}),
                    ...(manualTracking !== undefined ? { manualTracking } : {}),
                    ...(onHold !== undefined ? { onHold } : {}),
                    ...(readingStatus !== undefined ? { readingStatus } : {}),
                    ...(readingDirection !== undefined ? { readingDirection } : {}),
                    ...(pageFit !== undefined ? { pageFit } : {}),
                    ...(pageWidthPct !== undefined ? { pageWidthPct } : {}),
                    ...(noGapContinuous !== undefined ? { noGapContinuous } : {}),
                    ...(continuousScroll !== undefined ? { continuousScroll } : {}),
                    ...(readerTheme !== undefined ? { readerTheme } : {}),
                    ...(anilistId !== undefined ? { anilistId } : {}),
                    ...(genres !== undefined ? { genres } : {}),
                    ...(metadataUpdatedAt !== undefined ? { metadataUpdatedAt } : {}),
                    ...(workId !== undefined ? { workId } : {})
                }

                // Re-point (not copy) dependent rows onto the primary's id.
                await db.progress.where("mangaId").equals(loserId).modify({ mangaId: primaryId })
                await db.historyEvents.where("mangaId").equals(loserId).modify({ mangaId: primaryId })
                await db.downloads.where("mangaId").equals(loserId).modify({ mangaId: primaryId })
                await db.pageBookmarks.where("mangaId").equals(loserId).modify({ mangaId: primaryId })

                // Covers are keyed by mangaId and never re-resolved for ids that already have
                // one (see the backfill handler's skip condition) - carry the loser's blob when
                // the primary has none, then drop the loser's row so merge doesn't orphan blobs
                // (removeManga now cleans these up too, on plain removal).
                const loserCover = await db.covers.get(loserId)
                if (loserCover && (await db.covers.get(primaryId)) === undefined) {
                    await db.covers.put({ ...loserCover, mangaId: primaryId })
                }
                await db.covers.delete(loserId)

                // Loser chapters are stale by definition once its progress/history
                // point at the primary - same reasoning rekeyManga uses for the old
                // source's chapters after a relink.
                await db.chapters.where("mangaId").equals(loserId).delete()
                await db.sourceLinks.delete(loserId)
                await db.manga.delete(loserId)
            }

            // The position-adoption above can leave latestChapterId/lastReadChapterId
            // pointing at a loser's chapter row that this same transaction just deleted.
            // library:merge calls mergeMangaRecords directly (no fixupDanglingChapterIds
            // afterwards, unlike applyCleanupGroup), so repair dangling ids here against
            // the surviving chapter set: prefer the survivor matching the stored number,
            // else the highest-numbered survivor. Only repoint when a replacement exists,
            // so a merge of records with no persisted chapter rows keeps its ids as-is.
            const survivingChapters = await db.chapters.where("mangaId").equals(primaryId).toArray()
            if (survivingChapters.length > 0) {
                const survivingIds = new Set(survivingChapters.map(c => c.id))
                const highestNumbered = survivingChapters
                    .filter(c => isNumberedChapter(c.sortKey))
                    .reduce<
                        ChapterRecord | undefined
                    >((max, c) => (!max || c.sortKey > max.sortKey ? c : max), undefined)
                const repoint = (id: string, number: number | undefined): string => {
                    if (survivingIds.has(id)) return id
                    const byNumber =
                        number !== undefined ? survivingChapters.find(c => c.sortKey === number) : undefined
                    return (byNumber ?? highestNumbered)?.id ?? id
                }
                merged = {
                    ...merged,
                    ...(merged.latestChapterId !== undefined
                        ? { latestChapterId: repoint(merged.latestChapterId, merged.latestChapterNumber) }
                        : {}),
                    ...(merged.lastReadChapterId !== undefined
                        ? { lastReadChapterId: repoint(merged.lastReadChapterId, merged.lastReadChapterNumber) }
                        : {})
                }
            }

            await db.manga.put(merged)
            return merged
        }
    )
}

// Re-points one fallback-created "loser" manga's read progress/history onto the
// canonical chapter list, per CHAPTER rather than blindly re-pointing everything to a
// single chapter id - trackExternalChapter can attach a SECOND (or later) external
// chapter read to an already-fallback-created manga record (see its direct-id-lookup
// and slug-match branches), so a loser can carry more than one tracked chapter. Used
// by the library cleanup tool (handlers/library.ts) as part of applyCleanupGroup,
// always inside that function's own transaction - never call this outside a
// transaction that also covers db.progress/db.historyEvents.
// Returns the canonical chapters this loser's ext chapters were actually translated
// onto (may repeat across losers/chapters) - fixupDanglingChapterIds uses this as a
// conservative fallback pool instead of the whole source's back catalogue.
export async function remapExternalChapterProgress(
    loserId: string,
    canonicalChapters: ChapterRecord[]
): Promise<ChapterRecord[]> {
    const pathnameOf = (url: string): string | null => {
        try {
            return new URL(url).pathname
        } catch {
            return null
        }
    }
    const translated: ChapterRecord[] = []
    const loserChapters = await db.chapters.where("mangaId").equals(loserId).toArray()
    for (const extChapter of loserChapters) {
        const extPathname = pathnameOf(extChapter.url)
        // isNumberedChapter (not a bare `> 0`) - Infinity > 0 is true, and
        // Infinity === Infinity is true, so an unguarded comparison here matches an
        // unnumbered loser chapter to the FIRST unnumbered canonical chapter -
        // unrelated chapters get their read progress/history transplanted onto them.
        // Unnumbered rows fall through to the pathname match below instead, which is
        // the correct identity check for them.
        const canonical =
            (isNumberedChapter(extChapter.sortKey)
                ? canonicalChapters.find(c => c.sortKey === extChapter.sortKey)
                : undefined) ??
            (extPathname ? canonicalChapters.find(c => pathnameOf(c.url) === extPathname) : undefined)
        // No canonical match for this specific ext chapter - leave its progress/history
        // alone. mergeMangaRecords's own by-mangaId re-point still runs afterwards, so
        // the row survives (re-pointed to the primary's mangaId) but keeps pointing at
        // a chapter id that mergeMangaRecords is about to delete - an accepted, already-
        // documented gap (dangling chapterId), not something this remap solves.
        if (!canonical) continue
        translated.push(canonical)

        const extProgress = await db.progress.get(extChapter.id)
        if (extProgress) {
            // progress is keyed by chapterId alone, so re-pointing to the canonical
            // chapter's id is a delete-then-put, not a modify() - and two different
            // losers in the same group can both map onto the SAME canonical chapter
            // (e.g. two garbage records that both tracked "chapter 5"), so a row may
            // already exist there from an earlier loser processed this same call.
            const existingCanonical = await db.progress.get(canonical.id)
            if (existingCanonical) {
                const newer = extProgress.updatedAt >= existingCanonical.updatedAt ? extProgress : existingCanonical
                await db.progress.put({
                    ...newer,
                    chapterId: canonical.id,
                    mangaId: existingCanonical.mangaId,
                    completed: existingCanonical.completed || extProgress.completed
                })
            } else {
                await db.progress.put({ ...extProgress, chapterId: canonical.id })
            }
            await db.progress.delete(extChapter.id)
        }

        // historyEvents aren't uniquely keyed by chapterId, so every matching row is
        // simply re-pointed - scoped to THIS specific ext chapter id, not the whole loser.
        await db.historyEvents.where("chapterId").equals(extChapter.id).modify({ chapterId: canonical.id })

        // Two losers mapping onto the SAME canonical chapter each re-point their own
        // completed/started row here, leaving duplicate history rows for one logical chapter.
        // getLocalStats counts completed history rows for readingDays/streaks/chaptersToday
        // (unlike completedChapters, which dedups), so those duplicates inflate the stats and
        // can manufacture a phantom active day. Collapse to the earliest row per (chapterId,
        // type); the earliest occurredAt is the true first read.
        const canonHistory = await db.historyEvents.where("chapterId").equals(canonical.id).toArray()
        const keepByType = new Map<string, (typeof canonHistory)[number]>()
        for (const ev of canonHistory) {
            const cur = keepByType.get(ev.type)
            if (!cur || ev.occurredAt < cur.occurredAt) keepByType.set(ev.type, ev)
        }
        const keepIds = new Set([...keepByType.values()].map(e => e.id))
        const dupeIds = canonHistory.filter(e => e.id !== undefined && !keepIds.has(e.id)).map(e => e.id as number)
        if (dupeIds.length > 0) await db.historyEvents.bulkDelete(dupeIds)
    }
    return translated
}

// After a merge, a manga's lastReadChapterId/latestChapterId may point at a chapter row
// that no longer exists - e.g. mergeMangaRecords's same-source-max logic adopted a
// loser's dangling ext-chapter id (deleted along with the rest of that loser's chapters).
// Checked unconditionally (by actual row existence), not gated on "did the chapter
// number increase" - a review of an earlier draft rejected that heuristic because it
// misses the exact case this exists to fix: an id-only carry with no number change.
// `translatedChapters` is the (possibly empty, possibly repeat-containing) set of
// canonical chapters remapExternalChapterProgress actually translated ext chapters
// onto for this group - used as the fallback pool when no exact chapter-number match
// exists, deliberately narrower than the full canonicalChapters catalogue so a title
// with no matchable number doesn't get pointed at some arbitrary, possibly very
// recent, chapter it was never actually confirmed to have reached.
export async function fixupDanglingChapterIds(
    mangaId: string,
    canonicalChapters: ChapterRecord[],
    translatedChapters: ChapterRecord[]
): Promise<void> {
    const merged = await db.manga.get(mangaId)
    if (!merged) return
    // Only a NUMBERED chapter can stand in for "the furthest chapter reached" - an
    // unnumbered chapter has sortKey Infinity, which would otherwise win this reduce and
    // repoint a dangling id at a random special instead of the highest real chapter.
    const maxTranslated = translatedChapters
        .filter(c => isNumberedChapter(c.sortKey))
        .reduce<ChapterRecord | undefined>((max, c) => (!max || c.sortKey > max.sortKey ? c : max), undefined)
    const patch: { lastReadChapterId?: string | undefined; latestChapterId?: string | undefined } = {}
    if (merged.lastReadChapterId !== undefined && (await db.chapters.get(merged.lastReadChapterId)) === undefined) {
        const match = canonicalChapters.find(c => c.sortKey === merged.lastReadChapterNumber) ?? maxTranslated
        // Explicit undefined clears a dangling id with no replacement available -
        // lastReadChapterNumber (the domain-independent source of truth per the
        // LibraryManga field comments) is deliberately left untouched either way.
        patch.lastReadChapterId = match?.id
    }
    if (merged.latestChapterId !== undefined && (await db.chapters.get(merged.latestChapterId)) === undefined) {
        const match = canonicalChapters.find(c => c.sortKey === merged.latestChapterNumber) ?? maxTranslated
        patch.latestChapterId = match?.id
    }
    if (Object.keys(patch).length > 0) {
        await db.manga.update(mangaId, patch as Partial<LibraryManga>)
    }
}

// Applies one cleanup group: remaps each loser's external-chapter progress/history
// onto the freshly-resolved canonical chapter list, merges the losers into the
// canonical manga record, then fixes up any dangling chapter-id left by the merge -
// all inside ONE parent transaction, so a concurrent capture/track for a
// soon-to-be-deleted loser can't slip data in between steps and get silently dropped.
//
// mergeMangaRecords opens its own db.transaction("rw", [...]) internally using the
// exact same 8 tables (in the same "rw" mode) as the outer transaction below. Dexie
// tracks the "current transaction" via an ambient zone (PSD), so a nested
// db.transaction() call whose tables/mode are a subset of the already-open outer
// transaction joins it instead of opening a second, independent one - see Dexie's
// transaction-scope docs. database.test.ts's cleanup-apply tests exercise this nesting
// directly against fake-indexeddb to confirm it doesn't throw in practice.
export async function applyCleanupGroup(
    canonicalId: string,
    loserIds: string[],
    canonicalChapters: ChapterRecord[]
): Promise<LibraryManga> {
    return db.transaction(
        "rw",
        [
            db.manga,
            db.sourceLinks,
            db.chapters,
            db.progress,
            db.historyEvents,
            db.downloads,
            db.pageBookmarks,
            db.covers
        ],
        async () => {
            const translatedChapters: ChapterRecord[] = []
            for (const loserId of loserIds) {
                translatedChapters.push(...(await remapExternalChapterProgress(loserId, canonicalChapters)))
            }
            const merged = await mergeMangaRecords(canonicalId, loserIds)
            await fixupDanglingChapterIds(merged.id, canonicalChapters, translatedChapters)
            return (await db.manga.get(merged.id)) ?? merged
        }
    )
}

// A title that is really just a chapter label ("<Series> Chapter 129", "Ch. 5", "Episode 12")
// leaked from a chapter page - used to stop such a string overwriting a real series name.
export function looksLikeChapterTitle(title: string | undefined): boolean {
    return typeof title === "string" && /\b(?:chapter|chap|ch|episode|ep)\.?\s*\d+(?:[.-]\d+)?\s*$/i.test(title)
}

export async function saveResolvedChapter(input: {
    manga: MangaRecord
    chapter: ChapterRecord
    sourceLink: SourceLinkRecord
    chapters?: ChapterRecord[]
}): Promise<void> {
    await db.transaction("rw", db.manga, db.sourceLinks, db.chapters, async () => {
        const existing = await db.manga.get(input.manga.id)
        const manga: LibraryManga = {
            ...input.manga,
            sourceId: input.chapter.sourceId,
            sourceUrl: input.chapter.url,
            ...(input.sourceLink.sourceMangaId ? { sourceMangaId: input.sourceLink.sourceMangaId } : {}),
            mangaUrl: input.sourceLink.url,
            latestChapterId: input.chapter.id,
            ...(Number.isFinite(input.chapter.sortKey) ? { latestChapterNumber: input.chapter.sortKey } : {}),
            // Never let a chapter-page-derived "<Series> Chapter N" title overwrite a good
            // stored series name (Asura's chapter pages leak a chapter-suffixed title past the
            // adapter strip). Asymmetric: when the STORED title is clean and the incoming one is
            // chapter-shaped, keep the stored name; when the stored one is itself chapter-shaped
            // and the incoming is clean, the incoming wins (default), self-healing an already-
            // renamed entry on its next capture.
            ...(existing?.title && looksLikeChapterTitle(input.manga.title) && !looksLikeChapterTitle(existing.title)
                ? { title: existing.title }
                : {}),
            // Preserve user-controlled and read-progress fields from the existing record
            // so a re-capture never silently clears ratings, categories, notes, or history.
            ...(existing?.lastReadChapterId ? { lastReadChapterId: existing.lastReadChapterId } : {}),
            ...(existing?.lastReadChapterNumber !== undefined
                ? { lastReadChapterNumber: existing.lastReadChapterNumber }
                : {}),
            ...(existing?.lastReadAt !== undefined ? { lastReadAt: existing.lastReadAt } : {}),
            ...(existing?.manualTracking !== undefined ? { manualTracking: existing.manualTracking } : {}),
            ...(existing?.onHold !== undefined ? { onHold: existing.onHold } : {}),
            ...(existing?.readingStatus !== undefined ? { readingStatus: existing.readingStatus } : {}),
            ...(existing?.categories !== undefined ? { categories: existing.categories } : {}),
            ...(existing?.nsfw !== undefined ? { nsfw: existing.nsfw } : {}),
            ...(existing?.notes !== undefined ? { notes: existing.notes } : {}),
            ...(existing?.readingDirection !== undefined ? { readingDirection: existing.readingDirection } : {}),
            ...(existing?.pageFit !== undefined ? { pageFit: existing.pageFit } : {}),
            ...(existing?.pageWidthPct !== undefined ? { pageWidthPct: existing.pageWidthPct } : {}),
            ...(existing?.noGapContinuous !== undefined ? { noGapContinuous: existing.noGapContinuous } : {}),
            ...(existing?.continuousScroll !== undefined ? { continuousScroll: existing.continuousScroll } : {}),
            ...(existing?.readerTheme !== undefined ? { readerTheme: existing.readerTheme } : {}),
            // Enrichment / sort fields that live only on LibraryManga (the incoming source
            // MangaRecord can't carry them): preserve them so a re-capture doesn't break
            // AniList linkage, re-trigger metadata enrichment, or lose the recently-updated
            // sort timestamp.
            ...(existing?.anilistId !== undefined ? { anilistId: existing.anilistId } : {}),
            ...(existing?.genres !== undefined ? { genres: existing.genres } : {}),
            ...(existing?.metadataUpdatedAt !== undefined ? { metadataUpdatedAt: existing.metadataUpdatedAt } : {}),
            ...(existing?.latestChapterAt !== undefined ? { latestChapterAt: existing.latestChapterAt } : {}),
            ...(existing?.chapterNumberingUnreliable !== undefined
                ? { chapterNumberingUnreliable: existing.chapterNumberingUnreliable }
                : {}),
            ...(existing?.workId !== undefined ? { workId: existing.workId } : {}),
            // rating lives in MangaRecord - prefer existing if the source didn't supply one
            ...(!input.manga.rating && existing?.rating !== undefined ? { rating: existing.rating } : {})
        }
        await db.manga.put(manga)
        await db.sourceLinks.put(input.sourceLink)
        await db.chapters.bulkPut(input.chapters ?? [input.chapter])
    })
}

// Persists the reader's freshly-resolved chapter, and (only if the library entry
// exists and has no cover yet) backfills its coverUrl - both in ONE transaction so
// an SW restart between the two writes can't leave the manga pointing at a chapter
// row that was never written, or vice versa. Unlike saveResolvedChapter above this
// never creates or overwrites the manga record itself - reader:resolve must not
// resurrect a title the user removed while reading.
export async function saveReaderResolvedChapter(input: {
    chapter: ChapterRecord
    mangaId: string
    coverUrl?: string
}): Promise<void> {
    await db.transaction("rw", [db.chapters, db.manga], async () => {
        // Re-check inside the transaction: reader:resolve runs a network fetch first, so the
        // user may have removed the title (or it was never in the library) by now. Writing the
        // chapter row anyway would orphan it under a mangaId with no parent - the same guard
        // saveProgress/applyUpdateCheckResult use. No manga row -> nothing to track, skip.
        const existing = await db.manga.get(input.mangaId)
        if (existing === undefined) return
        await db.chapters.put(input.chapter)
        if (input.coverUrl && !existing.coverUrl) {
            await db.manga.update(input.mangaId, { coverUrl: input.coverUrl })
        }
    })
}

// Thin wrapper so handlers never call db.manga.update directly (see the
// no-restricted-syntax guard scoped to handlers/** in eslint.config.js). Passing
// `undefined` for a field clears it, matching Dexie's update() semantics.
export async function updateManga(mangaId: string, patch: Partial<LibraryManga>): Promise<void> {
    await db.manga.update(mangaId, patch)
}

// Bulk-adds imported library entries (e.g. an AniList list pull), skipping any that
// duplicate a title already in the library so a re-import never clobbers a live entry.
// Title dedup recomputes normalizeTitle(title) on both sides: several write paths store
// normalizedTitle under weaker rules (no trim/collapse/locale), so keying off the stored
// field would miss a "Solo Leveling " vs "Solo Leveling" match and duplicate it. Against
// the EXISTING library a title collision skips; within a single batch only identity
// (anilistId / id) dedups, so two DISTINCT media that happen to share a normalized title
// both import. When a candidate carries an anilistId but the colliding existing entry has
// none, the id is backfilled onto that entry rather than dropped. Runs in one transaction
// so the existence check and the writes can't interleave with a concurrent import.
export async function addImportedManga(candidates: LibraryManga[]): Promise<{ imported: number; skipped: number }> {
    return db.transaction("rw", db.manga, async () => {
        const existing = await db.manga.toArray()
        const existingAnilistIds = new Set(
            existing.map(m => m.anilistId).filter((id): id is number => id !== undefined)
        )
        const existingIds = new Set(existing.map(m => m.id))
        const existingByTitle = new Map<string, LibraryManga>()
        for (const m of existing) {
            const key = normalizeTitle(m.title)
            if (!existingByTitle.has(key)) existingByTitle.set(key, m)
        }
        const batchAnilistIds = new Set<number>()
        const batchIds = new Set<string>()
        const toWrite: LibraryManga[] = []
        const backfills: Array<{ id: string; anilistId: number }> = []
        let skipped = 0
        for (const candidate of candidates) {
            const anilistDuplicate =
                candidate.anilistId !== undefined &&
                (existingAnilistIds.has(candidate.anilistId) || batchAnilistIds.has(candidate.anilistId))
            const idDuplicate = existingIds.has(candidate.id) || batchIds.has(candidate.id)
            if (anilistDuplicate || idDuplicate) {
                skipped++
                continue
            }
            const titleMatch = existingByTitle.get(normalizeTitle(candidate.title))
            if (titleMatch) {
                if (candidate.anilistId !== undefined && titleMatch.anilistId === undefined) {
                    backfills.push({ id: titleMatch.id, anilistId: candidate.anilistId })
                    existingAnilistIds.add(candidate.anilistId)
                }
                skipped++
                continue
            }
            toWrite.push(candidate)
            if (candidate.anilistId !== undefined) batchAnilistIds.add(candidate.anilistId)
            batchIds.add(candidate.id)
        }
        for (const backfill of backfills) {
            await db.manga.update(backfill.id, { anilistId: backfill.anilistId } as Partial<LibraryManga>)
        }
        if (toWrite.length > 0) await db.manga.bulkPut(toWrite)
        return { imported: toWrite.length, skipped }
    })
}

// Thin wrapper so handlers never call db.chapters.bulkPut directly.
export async function putChapters(chapters: ChapterRecord[]): Promise<void> {
    if (chapters.length === 0) return
    await db.transaction("rw", db.chapters, db.manga, async () => {
        // Every caller fetches the chapter list over the network first, then caches it here.
        // If the user removed the title in that window, writing its chapters would orphan them
        // under a parentless mangaId. Only persist rows whose manga still exists (checked in
        // the transaction, per distinct mangaId so a mixed batch is filtered, not all-or-nothing).
        const ids = [...new Set(chapters.map(c => c.mangaId))]
        const present = await Promise.all(ids.map(id => db.manga.get(id)))
        const live = new Set(present.filter((m): m is LibraryManga => m !== undefined).map(m => m.id))
        const rows = chapters.filter(c => live.has(c.mangaId))
        if (rows.length > 0) await db.chapters.bulkPut(rows)
    })
}

// library:relink - rekey the manga and write the resolved chapter in ONE
// transaction (rekeyManga declares exactly this 8-table set, so this is a
// same-set join, not a superset that would break Dexie's nested-transaction
// rule). Without it, an SW restart between the two could leave the manga
// pointing at a chapter row that was never written.
export async function relinkMangaWithChapter(
    oldId: string,
    next: LibraryManga,
    newSourceLink: SourceLinkRecord,
    chapter: ChapterRecord
): Promise<void> {
    await db.transaction(
        "rw",
        [
            db.manga,
            db.sourceLinks,
            db.chapters,
            db.progress,
            db.historyEvents,
            db.downloads,
            db.pageBookmarks,
            db.covers
        ],
        async () => {
            await rekeyManga(oldId, next, newSourceLink)
            await db.chapters.put(chapter)
        }
    )
}

// library:link-url synchronous part - update the manga's source fields and write
// its source link in one transaction.
export async function linkMangaToUrl(
    mangaId: string,
    mangaPatch: Partial<LibraryManga>,
    sourceLink: SourceLinkRecord
): Promise<void> {
    await db.transaction("rw", db.manga, db.sourceLinks, async () => {
        await db.manga.update(mangaId, mangaPatch)
        await db.sourceLinks.put(sourceLink)
    })
}

// library:link-url background chapter fetch - store the fetched chapters and,
// when a latest patch is supplied, the manga's latest-chapter fields, atomically.
export async function saveLinkedChapters(
    mangaId: string,
    chapters: ChapterRecord[],
    latestPatch: Partial<LibraryManga> | undefined
): Promise<void> {
    await db.transaction("rw", db.chapters, db.manga, async () => {
        // The chapter list is fetched over the network first; if the user removed the title in
        // the meantime, writing its chapters now would orphan them (no parent manga row). Skip.
        if ((await db.manga.get(mangaId)) === undefined) return
        await db.chapters.bulkPut(chapters)
        if (latestPatch) await db.manga.update(mangaId, latestPatch)
    })
}

// library:switch - swap a title's source: drop the old mirror's now-stale chapter
// rows, write the new mirror's, and update the manga's source/latest fields plus
// its source link, all in one transaction.
export async function switchMangaSource(input: {
    mangaId: string
    sourceId: string
    chapters: ChapterRecord[]
    mangaPatch: Partial<LibraryManga>
    numberingUnreliable: boolean
    sourceLink: SourceLinkRecord
}): Promise<void> {
    await db.transaction("rw", db.manga, db.sourceLinks, db.chapters, async () => {
        // library:switch fetches the new mirror's list over the network before this write, so
        // re-check: a concurrent library:remove would otherwise leave orphan chapters AND an
        // orphan source link (the latter silently drops the title from update checks).
        if ((await db.manga.get(input.mangaId)) === undefined) return
        await db.chapters
            .where("mangaId")
            .equals(input.mangaId)
            .and(c => c.sourceId !== input.sourceId)
            .delete()
        await db.chapters.bulkPut(input.chapters)
        await db.manga.update(input.mangaId, input.mangaPatch)
        await db.manga.update(input.mangaId, {
            manualTracking: undefined
        } as unknown as Partial<LibraryManga>)
        await db.manga.update(input.mangaId, {
            chapterNumberingUnreliable: input.numberingUnreliable ? true : undefined
        } as Partial<LibraryManga>)
        await db.sourceLinks.put(input.sourceLink)
    })
}

// updates:check per-title write - store the freshly-listed chapters (optionally
// purging stale MangaHub rows), and re-point the manga's latest-chapter fields on
// an id change. Returns whether the latest chapter genuinely ADVANCED (a higher
// number, or an unnumberable chapter) - the caller uses that to count the title as
// updated and publish a live event. An id change with a same-or-lower number is a
// re-slug / post-merge correction, still written, but not reported as an update.
// purgeStaleMangahub is injected (not imported) to keep database.ts free of a
// circular import on background/chapter-cache; it runs inside this transaction.
export async function applyUpdateCheckResult(input: {
    mangaId: string
    chapters: ChapterRecord[]
    latest: ChapterRecord | undefined
    previousLatestChapterId: string | undefined
    previousLatestChapterNumber: number | undefined
    purgeStaleMangahub?: (freshChapterIds: Set<string>) => Promise<void>
}): Promise<{ advanced: boolean }> {
    let advanced = false
    await db.transaction("rw", db.chapters, db.manga, async () => {
        // If the user removed (or merged away) this title during the multi-hundred-ms
        // chapter-list fetch, its chapter rows were deleted with it - writing the freshly
        // fetched chapters back would leave orphan rows with no parent manga. Gate on the
        // manga still existing, same as repairMangahubChapters.
        if ((await db.manga.get(input.mangaId)) === undefined) return
        await db.chapters.bulkPut(input.chapters)
        if (input.purgeStaleMangahub) {
            await input.purgeStaleMangahub(new Set(input.chapters.map(c => c.id)))
        }
        const latest = input.latest
        if (latest && latest.id !== input.previousLatestChapterId) {
            advanced = !Number.isFinite(latest.sortKey) || latest.sortKey > (input.previousLatestChapterNumber ?? -1)
            await db.manga.update(input.mangaId, {
                latestChapterId: latest.id,
                sourceUrl: latest.url,
                ...(Number.isFinite(latest.sortKey) ? { latestChapterNumber: latest.sortKey } : {}),
                // Stamp the new-chapter time only on a genuine advance, not on a re-slug
                // (id change with a same-or-lower number), so "recently updated" reflects
                // real releases.
                ...(advanced ? { latestChapterAt: Date.now() } : {}),
                updatedAt: Date.now()
            })
        }
    })
    return { advanced }
}

// MangaHub stale-chapter repair - like applyUpdateCheckResult but gated on the
// manga still existing (a concurrent remove/merge during the network fetch must
// stick). Returns false when the manga was gone, so the caller skips its
// publishLive. purgeStaleMangahub is injected for the same circular-import reason.
// MangaHub chapter URLs are /chapter/{slug}/chapter-{N} where N is frequently an internal
// id at or above this floor, not the real chapter number. The adapter derives the true
// number from the page's visible span (see INTERNAL_ID_MIN in packages/sources/src/mangahub.ts);
// trackExternalChapter and the repair sweep use this to reject an internal-id-sized number.
const MANGAHUB_INTERNAL_ID_MIN = 100_000

export async function repairMangahubChapters(input: {
    mangaId: string
    chapters: ChapterRecord[]
    latest: ChapterRecord | undefined
    purgeStaleMangahub: (freshChapterIds: Set<string>) => Promise<void>
}): Promise<boolean> {
    return db.transaction("rw", db.chapters, db.manga, async () => {
        const existing = await db.manga.get(input.mangaId)
        if (existing === undefined) return false
        await db.chapters.bulkPut(input.chapters)
        await input.purgeStaleMangahub(new Set(input.chapters.map(c => c.id)))
        // A pre-fix trackExternalChapter stored an internal id (>= floor) as
        // lastReadChapterNumber - it can't be a real read position (real chapters never
        // reach the floor), and left as-is it freezes the ratchet and shows a garbage
        // number on the Updates page. Clear it (and the ext id it points at) so the
        // position re-derives from the next real read.
        if (input.latest) {
            await db.manga.update(input.mangaId, {
                latestChapterId: input.latest.id,
                sourceUrl: input.latest.url,
                ...(Number.isFinite(input.latest.sortKey) ? { latestChapterNumber: input.latest.sortKey } : {}),
                updatedAt: Date.now()
            })
        }
        // Clear a poisoned lastReadChapterNumber (an internal id the pre-fix trackExternalChapter
        // stored) so the ratchet unfreezes and the Updates page stops showing a garbage number;
        // the position re-derives from the next real read. Uses the untyped table so `undefined`
        // clears the field (the typed db.manga.update rejects undefined under
        // exactOptionalPropertyTypes) - same idiom as the coverUrl clear in the v-migration above.
        if ((existing.lastReadChapterNumber ?? 0) >= MANGAHUB_INTERNAL_ID_MIN) {
            await db.table("manga").update(input.mangaId, {
                lastReadChapterNumber: undefined,
                lastReadChapterId: undefined,
                updatedAt: Date.now()
            })
        }
        return true
    })
}

// Purely-LOCAL heal for a MangaHub title poisoned with internal-id chapter numbers (a
// pre-dedupe artifact: rows / latestChapterNumber holding a site-wide internal id >= floor
// instead of a real chapter number). repairMangahubChapters only heals via a fresh fetch,
// which MangaHub's Cloudflare gate blocks, so the poison survived forever. This needs no
// network: it deletes the internal-id chapter rows (provably never real) and recomputes the
// badge from the highest remaining real row (or clears it), so the Updates page shows a sane
// number and the reader stops seeing a phantom "next" chapter. Returns true when it changed
// anything.
export async function clampPoisonedMangahubLocally(mangaId: string): Promise<boolean> {
    return db.transaction("rw", db.chapters, db.manga, db.progress, db.historyEvents, async () => {
        const existing = await db.manga.get(mangaId)
        if (existing === undefined || existing.sourceId !== "mangahub") return false
        const rows = await db.chapters.where("mangaId").equals(mangaId).toArray()
        const poisoned = rows.filter(
            c => c.sourceId === "mangahub" && Number.isFinite(c.sortKey) && c.sortKey >= MANGAHUB_INTERNAL_ID_MIN
        )
        const latestPoisoned = (existing.latestChapterNumber ?? 0) >= MANGAHUB_INTERNAL_ID_MIN
        const lastReadPoisoned = (existing.lastReadChapterNumber ?? 0) >= MANGAHUB_INTERNAL_ID_MIN
        if (poisoned.length === 0 && !latestPoisoned && !lastReadPoisoned) return false
        if (poisoned.length > 0) {
            const poisonedIds = poisoned.map(c => c.id)
            await db.chapters.bulkDelete(poisonedIds)
            // Cascade: the progress/history rows keyed to those phantom chapters would
            // otherwise be orphaned - left to re-inflate the completed-chapter stat via
            // getLocalStats' url-fallback key, and to accumulate across repeated sweeps.
            await db.progress.bulkDelete(poisonedIds)
            await db.historyEvents.where("chapterId").anyOf(poisonedIds).delete()
        }
        if (latestPoisoned) {
            const best = rows
                .filter(c => Number.isFinite(c.sortKey) && c.sortKey < MANGAHUB_INTERNAL_ID_MIN)
                .reduce<ChapterRecord | undefined>((acc, c) => (!acc || c.sortKey > acc.sortKey ? c : acc), undefined)
            if (best) {
                await db.manga.update(mangaId, {
                    latestChapterId: best.id,
                    latestChapterNumber: best.sortKey,
                    sourceUrl: best.url,
                    updatedAt: Date.now()
                })
            } else {
                await db.table("manga").update(mangaId, {
                    latestChapterId: undefined,
                    latestChapterNumber: undefined,
                    updatedAt: Date.now()
                })
            }
        }
        if (lastReadPoisoned) {
            await db.table("manga").update(mangaId, {
                lastReadChapterNumber: undefined,
                lastReadChapterId: undefined,
                updatedAt: Date.now()
            })
        }
        return true
    })
}

const MANGA_PATH_MARKERS = ["manga", "comic", "comics", "series", "manhwa", "manhua", "title", "read"]
// First path segments that name a chapter/reading context, never a title. Sites like
// MangaDex address chapters as /chapter/<opaque-id> with no series slug anywhere in the
// path, so the segments[0] fallback below would hand back "chapter" as the "slug" for
// EVERY title on the source - collapsing them all onto one record via sameHostSlug. Treat
// these as "no reliable slug" (null) instead.
const NON_TITLE_SEGMENTS = new Set(["chapter", "chapters", "chap", "viewer", "episode", "episodes", "reader"])
const WEBTOONS_HOSTNAMES = new Set(["www.webtoons.com", "webtoons.com"])

// Returns null when no reliable per-title slug can be derived - callers must treat
// null as "unknown", never as a value that can match another null (see sameHostSlug).
function deriveSlug(u: URL): string | null {
    const segments = u.pathname.split("/").filter(Boolean)
    const markerIndex = segments.findIndex(s => MANGA_PATH_MARKERS.includes(s.toLowerCase()))
    const afterMarker = markerIndex >= 0 ? segments[markerIndex + 1] : undefined
    if (afterMarker) return afterMarker
    const last = segments[segments.length - 1] ?? ""
    const readerStyle = last.match(/^(.*?)-chapter[-_]/i)
    if (readerStyle?.[1]) return readerStyle[1]
    // Webtoons paths are always /<locale>/<genre>/<slug>/... with no MANGA_PATH_MARKERS
    // segment, so falling back to segments[0] degenerates to the locale token ("en") for
    // EVERY Webtoons URL - making sameHostSlug() spuriously match any two Webtoons titles.
    // Use the title_no query param (unique per series, present on both the .../list?title_no=X
    // and .../<series>/episode-N/viewer?title_no=X shapes) instead, and return null - never a
    // spuriously-matchable value - when even that's absent.
    if (WEBTOONS_HOSTNAMES.has(u.hostname)) {
        const titleNo = u.searchParams.get("title_no")
        return titleNo ? `title_no:${titleNo}` : null
    }
    const first = segments[0]
    return first && !NON_TITLE_SEGMENTS.has(first.toLowerCase()) ? first : null
}

// The adapter-normalized (rotation-stable) slug of a URL, or null when no slug can be
// derived or parsing fails. Used only for the rotation-tolerant external-track match.
function normalizedSlugOf(url: string, normalize: (slug: string) => string): string | null {
    try {
        const slug = deriveSlug(new URL(url))
        return slug ? normalize(slug) : null
    } catch {
        return null
    }
}

function deriveMangaUrl(u: URL, slug: string | null): string {
    const segments = u.pathname.split("/").filter(Boolean)
    const markerIndex = segments.findIndex(s => MANGA_PATH_MARKERS.includes(s.toLowerCase()))
    const marker = markerIndex >= 0 ? segments[markerIndex] : undefined
    if (marker && segments[markerIndex + 1]) return `${u.origin}/${marker.toLowerCase()}/${segments[markerIndex + 1]}/`
    return slug ? `${u.origin}/manga/${slug}/` : u.origin
}

function sameHostSlug(a: string, b: string): boolean {
    try {
        const ua = new URL(a)
        const ub = new URL(b)
        if (ua.hostname !== ub.hostname) return false
        const sa = deriveSlug(ua)
        // Boolean(sa) rejects null (and "") so two undeterminable slugs never match.
        return Boolean(sa) && sa === deriveSlug(ub)
    } catch {
        return false
    }
}

// Prefix match with a word-boundary check: the character immediately after the
// matched prefix must be "/" or end-of-string. A raw `url.startsWith(prefix)` treats
// ".../manga/solo-leveling" as a prefix of ".../manga/solo-leveling-ragnarok/chapter-3"
// since the substring matches with no boundary check - this rejects that false match
// while still accepting ".../manga/solo-leveling/chapter-3".
function startsWithUrlPrefix(url: string, prefix: string): boolean {
    const trimmed = prefix.replace(/\/$/, "")
    if (!url.startsWith(trimmed)) return false
    const boundary = url[trimmed.length]
    return boundary === undefined || boundary === "/"
}

// Exported for handlers/library.ts's cleanup tool, which uses this to derive a
// readable placeholder title for a canonical manga record when the resolution
// ladder only has a bare sourceMangaId slug (no scraped title) - see
// resolveGroupFor in handlers/library.ts.
export function humanizeSlug(slug: string): string {
    return slug
        .replace(/[-_]+/g, " ")
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim()
}

// Query params that vary per-visit/per-session without identifying a distinct
// chapter - excluded from the fallback chapter-key's stable-params string below so
// e.g. two visits to the same chapter with different tracking params never get
// treated as different chapters.
const VOLATILE_PARAMS = /^(utm_\w+|fbclid|gclid|ref|referrer|page|p|pg|token|sid|session(_id)?|t|ts)$/i

// Track a chapter the user is reading on the source site directly (used when the
// in-app reader can't load a site's images). Records progress + history by chapter
// number without scraping pages, matching an existing library title when possible.
//
// The whole body runs inside one transaction - an SW restart between the
// conditional manga/sourceLinks creation and the final chapter/progress writes used
// to be able to leave a manga record with no sourceLinks row (silently excluded from
// update-checks forever). saveProgress opens its own db.transaction over a strict
// subset of the table list below (same "rw" mode), so it joins this one instead of
// committing independently (Dexie's subset-join rule - see applyCleanupGroup's doc
// comment for the same pattern already proven elsewhere in this file). Every await
// in this function is IDB-only, so there's no network/non-Dexie work holding the
// transaction open.
export async function trackExternalChapter(input: {
    url: string
    sourceId: string
    completed?: boolean
    // When the source adapter can parse series-level info from the chapter URL, pass it
    // here so we use a stable, correct ID and series prefix URL instead of deriveSlug/deriveMangaUrl.
    // Important for sites like Webtoons where the path alone carries no per-title slug.
    mangaInfo?: { sourceMangaId: string; mangaUrl: string }
    // Optional per-adapter slug normalizer (SourceAdapter.normalizeSourceMangaId). Lets the
    // matcher recognise the same series across a rotated slug hash (Asura) so a rotated
    // chapter URL attaches to the existing entry instead of forking a duplicate.
    normalizeSlug?: (slug: string) => string
    // When false, only mark read if the title already exists in the library; never create a
    // new entry. Used by the mark-read-on-visit path when auto-add is off, so browsing a source
    // still advances progress on titles you already track without adding everything you glance at.
    createIfMissing?: boolean
}): Promise<{ tracked: boolean; title: string; chapterNumber: number | null; mangaId: string; created: boolean }> {
    return db.transaction("rw", [db.manga, db.sourceLinks, db.chapters, db.progress, db.historyEvents], async () => {
        const now = Date.now()
        const u = new URL(input.url)
        // Some sites (e.g. Webtoons) never put the literal word "chapter" in the URL -
        // they use an episode_no query param instead - so also match that generic shape.
        // Also accepts a bare ch/chapter/ep/episode param with no "no=" suffix (e.g.
        // ?ch=7), routing that case into the well-supported ch-N key shape below instead
        // of the fallback path.
        const numberMatch =
            // Accept "/" between the word and the number too (Asura's /comics/<slug>/chapter/129
            // shape), matching CHAPTER_NUM_IN_PATH in handlers/reader.ts - without it every Asura
            // external track parsed no number, minting an "External chapter" row with an Infinity
            // sortKey that froze lastReadChapterNumber and flooded History.
            input.url.match(/chapter[-_/ ]?(\d+(?:\.\d+)?)/i) ??
            input.url.match(/[?&](?:episode|chapter|ep|ch)(?:[-_]?no)?=(\d+(?:\.\d+)?)/i)
        const parsedNumber = numberMatch?.[1] !== undefined ? Number(numberMatch[1]) : undefined
        // MangaHub chapter URLs are /chapter/{slug}/chapter-{N} where N is frequently an
        // internal id (>= 100_000), not the real chapter number. Parsing it verbatim here
        // poisoned the chapter row's title/sortKey AND (via saveProgress) lastReadChapterNumber -
        // the "Updates page shows wrong chapter numbers for MangaHub" bug. Now that the regex
        // also parses a bare /chapter/<numericId> shape, ANY source addressing chapters by a
        // large numeric id would mint the same poisoned row - so apply the INTERNAL_ID_MIN
        // floor to every source (no real series reaches 100_000 chapters), dropping an
        // internal-id-sized number so the row stays unnumbered until the update-check fills
        // the real one.
        const number = parsedNumber !== undefined && parsedNumber >= MANGAHUB_INTERNAL_ID_MIN ? undefined : parsedNumber

        // When caller supplies series-level info, try direct ID lookup first - finds the manga
        // even if it was previously added via resolveChapter (which uses a different code path).
        let manga: LibraryManga | undefined
        if (input.mangaInfo) {
            manga = await db.manga.get(`${input.sourceId}:manga:${input.mangaInfo.sourceMangaId}`)
        }

        if (!manga) {
            // Run an indexed same-source query first and check it against the two source-scoped
            // slug matchers before falling back to a full table scan for the cross-source prefix
            // matcher, since this fallback runs on every navigation on tracked/anti-scrape sites
            // and scales with library size. This means precedence flips only in the rare case
            // where a same-source slug match and a cross-source prefix match would both apply to
            // the same navigation - the indexed same-source match now wins instead of the
            // cross-source prefix match. Hostname-as-sourceId legacy rows are unaffected, since a
            // source-scoped query on a fake hostname sourceId never matches and they always fall
            // through to the full-scan cross-source pass below.
            const sameSource = await db.manga.where("sourceId").equals(input.sourceId).toArray()
            manga =
                sameSource.find(m => m.mangaUrl && sameHostSlug(m.mangaUrl, input.url)) ??
                sameSource.find(m => m.sourceUrl && sameHostSlug(m.sourceUrl, input.url))

            // Rotation-tolerant rung: when the raw slug matchers miss and the adapter can
            // normalize its slug (Asura rotates a per-series hash), compare the hash-stripped
            // base slug so a rotated chapter URL matches the existing entry instead of forking
            // a duplicate. Host knowledge stays in the adapter (input.normalizeSlug).
            if (!manga && input.normalizeSlug) {
                const inputBase = normalizedSlugOf(input.url, input.normalizeSlug)
                if (inputBase) {
                    manga = sameSource.find(m => {
                        const candidateUrl = m.mangaUrl ?? m.sourceUrl
                        return candidateUrl ? normalizedSlugOf(candidateUrl, input.normalizeSlug!) === inputBase : false
                    })
                }
            }

            if (!manga) {
                const all = await db.manga.toArray()
                manga = all.find(m => m.mangaUrl && startsWithUrlPrefix(input.url, m.mangaUrl))
            }
        }

        const created = !manga
        if (!manga && input.createIfMissing === false) {
            // Mark-read-on-visit with auto-add off: the title isn't tracked, so record nothing.
            return { tracked: false, title: "", chapterNumber: null, mangaId: "", created: false }
        }
        if (!manga) {
            const slug = deriveSlug(u)
            const title = humanizeSlug(slug ?? "") || u.hostname
            const mangaId = input.mangaInfo
                ? `${input.sourceId}:manga:${input.mangaInfo.sourceMangaId}`
                : `${input.sourceId}:manga:${slug || u.pathname}`
            const mangaUrl = input.mangaInfo?.mangaUrl ?? deriveMangaUrl(u, slug)
            manga = {
                id: mangaId,
                title,
                normalizedTitle: title.toLocaleLowerCase("en"),
                sourceId: input.sourceId,
                sourceUrl: input.url,
                mangaUrl,
                ...(input.mangaInfo ? { sourceMangaId: input.mangaInfo.sourceMangaId } : {}),
                authors: [],
                status: "unknown",
                addedAt: now,
                updatedAt: now
            }
            await db.manga.put(manga)
            // Persist sourceMangaId on the link too - listMangaChapters (sources.ts)
            // refuses to refresh a link without it ("The source link cannot be
            // refreshed"), so an external-tracked title added while scraping was blocked
            // could never pick up new chapters through the background update check.
            await db.sourceLinks.put({
                mangaId: manga.id,
                sourceId: input.sourceId,
                url: mangaUrl,
                ...(input.mangaInfo ? { sourceMangaId: input.mangaInfo.sourceMangaId } : {}),
                title: manga.title,
                addedAt: now,
                updatedAt: now
            })
        } else if (input.mangaInfo && manga.sourceMangaId !== input.mangaInfo.sourceMangaId) {
            // Backfill a corrected/rotated source id (and series URL) onto a matched record.
            // Two cases: (1) a legacy/fallback record that never stored a sourceMangaId, so the
            // genre/cover resolvers' fast-path can start working; (2) a slug ROTATION (Asura) -
            // the entry was matched by its stable base slug but the live slug moved, so update it
            // to the live slug/URL and the background update-check keeps fetching the right page.
            // The manga id is left unchanged so progress/history/bookmarks keyed to it survive.
            const sourceMangaId = input.mangaInfo.sourceMangaId
            const nextMangaUrl =
                input.mangaInfo.mangaUrl && input.mangaInfo.mangaUrl !== manga.mangaUrl
                    ? input.mangaInfo.mangaUrl
                    : undefined
            await db.manga.update(manga.id, {
                sourceMangaId,
                ...(nextMangaUrl ? { mangaUrl: nextMangaUrl } : {}),
                updatedAt: now
            } as Partial<LibraryManga>)
            manga.sourceMangaId = sourceMangaId
            const link = await db.sourceLinks.get(manga.id)
            if (link) {
                await db.sourceLinks.put({
                    ...link,
                    sourceMangaId,
                    ...(nextMangaUrl ? { url: nextMangaUrl } : {}),
                    updatedAt: now
                })
            }
        }

        const lastSegment = u.pathname.split("/").filter(Boolean).pop() ?? "ext"
        let chapterKey: string
        if (number !== undefined) {
            chapterKey = `ch-${number}`
        } else {
            // No parseable chapter number - two genuinely different chapters whose
            // number lives only in a query string the regex above doesn't recognize
            // (e.g. an opaque ?id=N param) would otherwise collide onto the same bare-
            // pathname key. Fold in non-volatile query params to disambiguate that case,
            // while a URL with no query string (or only volatile params like utm_source)
            // keeps the exact key it always has - no migration, no existing tracked
            // chapter loses its id.
            const stableParams = [...u.searchParams.entries()]
                .filter(([k]) => !VOLATILE_PARAMS.test(k))
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([k, v]) => `${k}=${v}`)
                .join("&")
            chapterKey = stableParams ? `${lastSegment}?${stableParams}`.slice(0, 200) : lastSegment
        }
        const chapterId = `${manga.id}:ext:${chapterKey}`
        await db.chapters.put({
            id: chapterId,
            mangaId: manga.id,
            sourceId: input.sourceId,
            title: number !== undefined ? `Chapter ${number}` : "External chapter",
            url: input.url,
            sortKey: number ?? Number.POSITIVE_INFINITY
        })
        await saveProgress({
            mangaId: manga.id,
            chapterId,
            pageIndex: 0,
            pageCount: 1,
            completed: input.completed ?? true,
            updatedAt: now
        })
        return { tracked: true, title: manga.title, chapterNumber: number ?? null, mangaId: manga.id, created }
    })
}

export async function saveProgress(progress: ReadingProgress): Promise<void> {
    await db.transaction("rw", db.progress, db.manga, db.chapters, db.historyEvents, async () => {
        // Don't write progress/history for a title that isn't in the library: the reader's
        // autosave can fire just after the user removed the title, and db.manga.update on a
        // missing key is a silent no-op, which would leave orphan progress + history rows
        // (inflating stats) with no parent manga. Same anti-resurrection stance as
        // saveReaderResolvedChapter.
        const mangaRecord = await db.manga.get(progress.mangaId)
        if (mangaRecord === undefined) return
        const existing = await db.progress.get(progress.chapterId)
        // completed is a one-way ratchet: once a chapter has been completed, a later
        // report from an earlier page (paging back after finishing, or re-reading from
        // page 1 in a fresh reader session, since the progress reporter is recreated
        // per chapter-load) must not flip it back to false. pageIndex/updatedAt still
        // track the newest report. Mirrors the same regression guard the import path
        // applies to a stale imported completed:false (see importDatabase's progress
        // merge). This also keeps the "completed" historyEvent unique per chapter -
        // without the ratchet, regress-then-recomplete would insert a duplicate event.
        const next = existing?.completed && !progress.completed ? { ...progress, completed: true } : progress
        await db.progress.put(next)
        const chapter = await db.chapters.get(progress.chapterId)
        const reportedNumber = chapter && Number.isFinite(chapter.sortKey) ? chapter.sortKey : undefined
        // Ratchet the furthest-read position: re-reading an earlier chapter (paging back,
        // re-reading an old chapter) must not regress lastReadChapterNumber and its paired
        // id/time, which drive completed/unread/resume/stats. Advance the trio only when the
        // reported chapter is at or beyond the stored furthest number, or none is stored yet.
        // The per-chapter progress row and history above still record every read regardless.
        const advancePosition =
            mangaRecord.lastReadChapterNumber === undefined ||
            (reportedNumber !== undefined && reportedNumber >= mangaRecord.lastReadChapterNumber)
        // Local activity wins: any recorded read un-pauses / un-drops the title, so a
        // stored paused/dropped override never sticks once the user is reading again.
        // (planning is left alone - it's a "not started" tag the derivation already
        // ignores once hasRead is true.) lastReadAt stays tied to the forward-advance
        // path above so re-reading an earlier chapter can't reset the auto-pause clock.
        const clearOverride = mangaRecord.readingStatus === "paused" || mangaRecord.readingStatus === "dropped"
        await db.manga.update(progress.mangaId, {
            ...(advancePosition
                ? {
                      lastReadChapterId: progress.chapterId,
                      ...(reportedNumber !== undefined ? { lastReadChapterNumber: reportedNumber } : {}),
                      lastReadAt: progress.updatedAt
                  }
                : {}),
            ...(clearOverride ? { readingStatus: undefined } : {}),
            updatedAt: progress.updatedAt
        } as unknown as Partial<LibraryManga>)
        if (!existing) {
            await db.historyEvents.add({
                mangaId: progress.mangaId,
                chapterId: progress.chapterId,
                type: "started",
                occurredAt: progress.updatedAt
            })
        }
        if (next.completed && !existing?.completed) {
            await db.historyEvents.add({
                mangaId: progress.mangaId,
                chapterId: progress.chapterId,
                type: "completed",
                occurredAt: progress.updatedAt
            })
        }
    })
}

export async function saveDownload(d: ChapterDownload): Promise<void> {
    await db.downloads.put(d)
}

export async function getDownload(chapterId: string): Promise<ChapterDownload | undefined> {
    return db.downloads.get(chapterId)
}

export async function removeDownload(chapterId: string): Promise<void> {
    await db.downloads.delete(chapterId)
}

export async function listDownloads(): Promise<
    Array<{ chapterId: string; mangaId: string; pageCount: number; downloadedAt: number }>
> {
    const all = await db.downloads.orderBy("downloadedAt").reverse().toArray()
    return all.map(({ chapterId, mangaId, pageCount, downloadedAt }) => ({
        chapterId,
        mangaId,
        pageCount,
        downloadedAt
    }))
}

export async function downloadsCount(): Promise<number> {
    return db.downloads.count()
}

// Explicit return type for exportDatabase - LibraryBackup.envelope below is typed
// as `Awaited<ReturnType<typeof exportDatabase>>`, and exportDatabase itself now
// calls db.transaction(), a method whose signature is generic over the WHOLE
// AmrDatabase instance (including db.backups: EntityTable<LibraryBackup, ...>).
// Left inferred, that makes the return type depend on LibraryBackup which depends
// on the return type - a genuine circular type. An explicit annotation breaks the
// cycle without changing the runtime shape at all.
export type LibraryExportEnvelope = {
    format: "all-mangas-reader"
    version: 1
    exportedAt: number
    data: {
        manga: LibraryManga[]
        sourceLinks: SourceLinkRecord[]
        chapters: ChapterRecord[]
        progress: ReadingProgress[]
        historyEvents: HistoryEvent[]
        pageBookmarks: PageBookmark[]
        // ARCH TRACK A (experimental): user-imported source profiles. Optional so older
        // backups (and non-arch builds) restore unchanged.
        archProfiles?: StoredArchProfile[]
        // ARCH TRACK A: best-version ranking pool + user overrides. Optional for the same reason.
        versions?: VersionRecord[]
        workOverrides?: WorkOverride[]
    }
}

// One "r" (read-only) transaction across all 6 tables so the snapshot is a true
// point-in-time view - 6 independent toArray() calls could interleave with a
// concurrent "rw" write and produce a torn export (e.g. a chapter that references a
// manga id added moments after the manga array was already read).
export async function exportDatabase(): Promise<LibraryExportEnvelope> {
    const exportedAt = Date.now()
    const [
        manga,
        sourceLinks,
        chapters,
        progress,
        historyEvents,
        pageBookmarks,
        archProfiles,
        versions,
        workOverrides
    ] = await db.transaction(
        "r",
        [
            db.manga,
            db.sourceLinks,
            db.chapters,
            db.progress,
            db.historyEvents,
            db.pageBookmarks,
            db.archProfiles,
            db.versions,
            db.workOverrides
        ],
        async () =>
            [
                await db.manga.toArray(),
                await db.sourceLinks.toArray(),
                await db.chapters.toArray(),
                await db.progress.toArray(),
                await db.historyEvents.toArray(),
                // pageBookmarks round-trip through export/import (previously silently
                // dropped - see schema.ts's pageBookmarkSchema comment). db.downloads is
                // intentionally NOT exported here: it holds full-page Blobs and would bloat
                // a backup file enormously. db.covers is intentionally NOT exported either:
                // covers are re-fetchable from the source on demand, and are also Blobs.
                await db.pageBookmarks.toArray(),
                await db.archProfiles.toArray(),
                await db.versions.toArray(),
                await db.workOverrides.toArray()
            ] as const
    )
    return {
        format: "all-mangas-reader",
        version: 1,
        exportedAt,
        data: {
            manga: manga.map(stripNonFiniteLatestChapterNumber),
            sourceLinks,
            chapters,
            progress,
            historyEvents,
            pageBookmarks,
            archProfiles,
            versions,
            workOverrides
        }
    } as const
}

// The tripwire hook keeps a non-finite latestChapterNumber from ever being written to
// db.manga going forward, and the version(9) migration heals already-corrupt rows on
// open - but this is a last line of defense on the export path itself: a sentinel that
// somehow survives to here must never round-trip through JSON.stringify (which turns
// Infinity into null) into a backup file, where schema.ts's `z.number().finite()` would
// then reject the whole record on restore.
function stripNonFiniteLatestChapterNumber(m: LibraryManga): LibraryManga {
    // JSON.stringify turns Infinity into null, which libraryMangaSchema's finite() then
    // rejects on import - dropping the WHOLE title. Strip a non-finite number from either
    // chapter-number field so the record round-trips (the field just heals on next read).
    let out = m
    if (out.latestChapterNumber !== undefined && !Number.isFinite(out.latestChapterNumber)) {
        const { latestChapterNumber: _drop, ...rest } = out
        out = rest
    }
    if (out.lastReadChapterNumber !== undefined && !Number.isFinite(out.lastReadChapterNumber)) {
        const { lastReadChapterNumber: _drop, ...rest } = out
        out = rest
    }
    return out
}

export type ImportResolution = "overwrite" | "skip" | "merge"

export type ImportConflict = {
    mangaId: string
    existingTitle: string
    importedTitle: string
    existingUpdatedAt: number
    importedUpdatedAt: number
}

export type ImportTable = "manga" | "sourceLinks" | "chapters" | "progress" | "historyEvents" | "pageBookmarks"

// Machine-readable reason a single record was left out of an import, so a UI can
// build a human-readable message ("Chapter 3 of 'Witch Hunter' had an invalid URL -
// skipped") without needing to parse raw zod error text itself.
export type ImportSkipCode = "RECORD_INVALID" | "MISSING_REQUIRED_FIELD" | "PARENT_SKIPPED"

export type ImportSkip = {
    table: ImportTable
    index: number
    id?: string
    code: ImportSkipCode
    issue: string
}

function extractId(raw: unknown, ...keys: string[]): string | undefined {
    if (!raw || typeof raw !== "object") return undefined
    const obj = raw as Record<string, unknown>
    for (const key of keys) {
        const value = obj[key]
        if (typeof value === "string" && value.length > 0) return value
    }
    return undefined
}

function classifyIssue(issue: { code?: string; message: string } | undefined): ImportSkipCode {
    // zod v4 issues don't carry a separate "received" field for invalid_type - the
    // fact of "field absent" only shows up in the message text ("received undefined").
    if (issue?.code === "invalid_type" && /received undefined/i.test(issue.message)) {
        return "MISSING_REQUIRED_FIELD"
    }
    return "RECORD_INVALID"
}

type ParsedRecord<T> = { index: number; value: T }

// Parses one table's array record-by-record instead of through a single z.array(...)
// schema, so one malformed row (future schema drift, a hand-edited file, an old
// export format quirk) is skipped and reported instead of aborting the whole import -
// see the batch notes' Bug 3 ("make it a weak link no more"). `items` may be missing
// or not an array at all (e.g. a legacy export, or a corrupt file); both are treated
// as "no records for this table" rather than a hard failure, matching the previous
// lenient-envelope behavior for missing optional tables.
function parseTable<T>(
    table: ImportTable,
    items: unknown,
    recordSchema: z.ZodType<T>,
    idKeys: string[],
    skipped: ImportSkip[]
): ParsedRecord<T>[] {
    if (!Array.isArray(items)) return []
    const out: ParsedRecord<T>[] = []
    items.forEach((raw, index) => {
        const result = recordSchema.safeParse(raw)
        if (result.success) {
            out.push({ index, value: result.data })
        } else {
            const issue = result.error.issues[0]
            const id = extractId(raw, ...idKeys)
            skipped.push({
                table,
                index,
                ...(id ? { id } : {}),
                code: classifyIssue(issue),
                issue: issue?.message ?? "Invalid record"
            })
        }
    })
    return out
}

function parseImportData(value: unknown): {
    manga: LibraryManga[]
    sourceLinks: SourceLinkRecord[]
    chapters: ChapterRecord[]
    progress: ReadingProgress[]
    historyEvents: HistoryEvent[]
    pageBookmarks: PageBookmark[]
    archProfiles: StoredArchProfile[]
    versions: VersionRecord[]
    workOverrides: WorkOverride[]
    skipped: ImportSkip[]
} {
    // Structure-only check: right format marker, right version, `data` is an object.
    // This is the only thing allowed to hard-fail the whole import - genuinely wrong
    // files (some other tool's export, a future version this build doesn't know about)
    // should still be rejected outright.
    const structure = envelopeStructureSchema.safeParse(value)
    if (!structure.success) {
        const issue = structure.error.issues[0]
        const where = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""
        throw new Error(`Import file is invalid${where}: ${issue?.message ?? "unrecognized format"}`)
    }
    const data = structure.data.data as Record<string, unknown>
    const skipped: ImportSkip[] = []

    const mangaParsed = parseTable("manga", data["manga"], libraryMangaSchema, ["id"], skipped)
    const sourceLinksParsed = parseTable(
        "sourceLinks",
        data["sourceLinks"],
        sourceLinkRecordSchema,
        ["mangaId"],
        skipped
    )
    const chaptersParsed = parseTable("chapters", data["chapters"], importChapterSchema, ["id"], skipped)
    const progressParsed = parseTable("progress", data["progress"], readingProgressSchema, ["chapterId"], skipped)
    const historyEventsParsed = parseTable(
        "historyEvents",
        data["historyEvents"],
        historyEventSchema,
        ["chapterId"],
        skipped
    )
    const pageBookmarksParsed = parseTable("pageBookmarks", data["pageBookmarks"], pageBookmarkSchema, ["id"], skipped)

    // Referential integrity: a manga record that failed validation can still have
    // dependent chapters/sourceLinks/progress/history/bookmarks elsewhere in the
    // envelope that reference its id. Importing those would create orphaned rows
    // with no parent manga, so drop them too and record why - this is the same
    // "skippedIds" idea importDatabase already applies below for user-chosen "skip"
    // resolutions, just triggered by a validation failure instead of a user choice.
    const invalidMangaIds = new Set(
        skipped
            .filter((s): s is ImportSkip & { id: string } => s.table === "manga" && s.id !== undefined)
            .map(s => s.id)
    )

    function dropOrphans<T extends { mangaId: string }>(table: ImportTable, parsed: ParsedRecord<T>[]): T[] {
        if (invalidMangaIds.size === 0) return parsed.map(p => p.value)
        const kept: T[] = []
        for (const { index, value } of parsed) {
            if (invalidMangaIds.has(value.mangaId)) {
                skipped.push({
                    table,
                    index,
                    id: value.mangaId,
                    code: "PARENT_SKIPPED",
                    issue: `Referenced manga "${value.mangaId}" was skipped (invalid record), so this row was skipped too`
                })
            } else {
                kept.push(value)
            }
        }
        return kept
    }

    // ARCH TRACK A (experimental): imported source profiles are opaque {id, profile, importedAt}
    // records with no manga foreign key, so they skip the orphan logic. Kept leniently; each is
    // re-validated against the engine schema when re-registered.
    const archProfilesRaw = Array.isArray(data["archProfiles"]) ? (data["archProfiles"] as unknown[]) : []
    const archProfilesParsed = archProfilesRaw
        .filter(
            (p): p is StoredArchProfile =>
                !!p && typeof p === "object" && typeof (p as { id?: unknown }).id === "string"
        )
        .map(({ origin, ...row }): StoredArchProfile => {
            return origin === "seed" || origin === "user" ? { ...row, origin } : row
        })

    // ARCH TRACK A: version pool + overrides. No manga foreign key, so they skip the orphan logic.
    // Fully zod-validated (not a lenient shape check): a crafted or corrupt backup must not be able
    // to inject a row with a missing languages array (would crash the ranker), a non-finite
    // lastSeenAt (NaN sorts/merges), or a non-http url (the panel's "Open best" navigates to it, so
    // a javascript: url would execute on click). A hard count cap bounds a bloated file; invalid
    // rows are dropped (the pool is a rebuildable cache).
    const MAX_VERSIONS = 50_000
    const MAX_OVERRIDES = 50_000
    const versionsRaw = Array.isArray(data["versions"]) ? (data["versions"] as unknown[]).slice(0, MAX_VERSIONS) : []
    const versionsParsed = versionsRaw
        .map(v => versionRecordImportSchema.safeParse(v))
        .filter((r): r is { success: true; data: VersionRecord } => r.success)
        .map(r => r.data)
    const overridesRaw = Array.isArray(data["workOverrides"])
        ? (data["workOverrides"] as unknown[]).slice(0, MAX_OVERRIDES)
        : []
    const overridesParsed = overridesRaw
        .map(o => workOverrideImportSchema.safeParse(o))
        .filter((r): r is { success: true; data: WorkOverride } => r.success)
        .map(r => r.data)

    return {
        manga: mangaParsed.map(p => p.value) as LibraryManga[],
        sourceLinks: dropOrphans("sourceLinks", sourceLinksParsed) as SourceLinkRecord[],
        chapters: dropOrphans("chapters", chaptersParsed) as ChapterRecord[],
        progress: dropOrphans("progress", progressParsed) as ReadingProgress[],
        historyEvents: dropOrphans("historyEvents", historyEventsParsed) as HistoryEvent[],
        pageBookmarks: dropOrphans("pageBookmarks", pageBookmarksParsed) as PageBookmark[],
        archProfiles: archProfilesParsed,
        versions: versionsParsed,
        workOverrides: overridesParsed,
        skipped
    }
}

// Picks the further-along chapter position (number + id) as a UNIT from the two
// records, so a merge never keeps one record's chapter NUMBER next to the other's
// chapter ID (which desynced "continue reading" from the displayed progress). When
// only one side has a number, that side's id is used; when neither does, the imported
// id is kept.
function furtherPosition(
    existing: LibraryManga,
    imported: LibraryManga,
    numberKey: "lastReadChapterNumber" | "latestChapterNumber",
    idKey: "lastReadChapterId" | "latestChapterId"
): { number: number | undefined; id: string | undefined } {
    const en = existing[numberKey]
    const im = imported[numberKey]
    if (en !== undefined && im !== undefined) {
        return en >= im ? { number: en, id: existing[idKey] } : { number: im, id: imported[idKey] }
    }
    if (en !== undefined) return { number: en, id: existing[idKey] }
    if (im !== undefined) return { number: im, id: imported[idKey] }
    return { number: undefined, id: imported[idKey] ?? existing[idKey] }
}

// Merges an imported record onto the live one. EXISTING wins by default (spread last),
// so an older backup can never revert live identity (sourceId/sourceUrl/mangaUrl/
// sourceMangaId set by a relink) or drop live enrichment (anilistId/genres/
// metadataUpdatedAt) - the old `{ ...imported, <allowlist> }` shape did exactly that,
// letting every non-allowlisted field take the imported value. Only the fields that
// genuinely move forward are imported-wins: the furthest chapter position (via
// furtherPosition), max(updatedAt), max(lastReadAt/latestChapterAt), min(addedAt), and
// enrichment gaps filled from the import when the live record has none.
function mergeManga(existing: LibraryManga, imported: LibraryManga): LibraryManga {
    // Categories are a list - union them instead of letting one side's tags silently
    // disappear just because the other record also had some set.
    const mergedCategories = [...new Set([...(existing.categories ?? []), ...(imported.categories ?? [])])]
    const categories = mergedCategories.length > 0 ? mergedCategories : undefined
    const read = furtherPosition(existing, imported, "lastReadChapterNumber", "lastReadChapterId")
    const latest = furtherPosition(existing, imported, "latestChapterNumber", "latestChapterId")
    const lastReadAt = maxDefined(existing.lastReadAt, imported.lastReadAt)
    const latestChapterAt = maxDefined(existing.latestChapterAt, imported.latestChapterAt)
    return {
        ...imported,
        ...existing,
        // Fill enrichment gaps from the import only when the live record lacks them.
        ...(existing.anilistId === undefined && imported.anilistId !== undefined
            ? { anilistId: imported.anilistId }
            : {}),
        ...(existing.genres === undefined && imported.genres !== undefined ? { genres: imported.genres } : {}),
        ...(existing.metadataUpdatedAt === undefined && imported.metadataUpdatedAt !== undefined
            ? { metadataUpdatedAt: imported.metadataUpdatedAt }
            : {}),
        ...(existing.coverUrl === undefined && imported.coverUrl !== undefined ? { coverUrl: imported.coverUrl } : {}),
        ...(categories !== undefined ? { categories } : {}),
        // Chapter positions move forward (furthest wins), number+id kept in lockstep.
        ...(read.number !== undefined ? { lastReadChapterNumber: read.number } : {}),
        ...(latest.number !== undefined ? { latestChapterNumber: latest.number } : {}),
        ...(read.id !== undefined ? { lastReadChapterId: read.id } : {}),
        ...(latest.id !== undefined ? { latestChapterId: latest.id } : {}),
        ...(lastReadAt !== undefined ? { lastReadAt } : {}),
        ...(latestChapterAt !== undefined ? { latestChapterAt } : {}),
        addedAt: Math.min(existing.addedAt, imported.addedAt),
        updatedAt: Math.max(existing.updatedAt, imported.updatedAt)
    }
}

export async function previewImport(value: unknown): Promise<ImportConflict[]> {
    const data = parseImportData(value)
    if (data.manga.length === 0) return []
    const ids = data.manga.map(m => m.id)
    const existing = await db.manga.bulkGet(ids)
    const conflicts: ImportConflict[] = []
    for (let i = 0; i < data.manga.length; i++) {
        const ex = existing[i]
        const im = data.manga[i]!
        if (ex) {
            conflicts.push({
                mangaId: im.id,
                existingTitle: ex.title,
                importedTitle: im.title,
                existingUpdatedAt: ex.updatedAt,
                importedUpdatedAt: im.updatedAt
            })
        }
    }
    return conflicts
}

export async function importDatabase(
    value: unknown,
    resolutions: Record<string, ImportResolution> = {}
): Promise<{ manga: number; chapters: number; skipped: ImportSkip[] }> {
    const data = parseImportData(value)

    const skippedIds = new Set<string>()
    const mangaToWrite: LibraryManga[] = []

    if (data.manga.length > 0) {
        const ids = data.manga.map(m => m.id)
        const existing = await db.manga.bulkGet(ids)
        for (let i = 0; i < data.manga.length; i++) {
            const im = data.manga[i]!
            const ex = existing[i]
            // Default to merge (not overwrite) so read progress is never silently lost
            // when no explicit resolution is chosen. Merge takes Math.max of the manga
            // record's own chapter-number fields; the progress table below is merged
            // separately by updatedAt recency, since it isn't covered by mergeManga.
            const resolution = ex ? (resolutions[im.id] ?? "merge") : "overwrite"
            if (resolution === "skip") {
                skippedIds.add(im.id)
            } else if (resolution === "merge" && ex) {
                mangaToWrite.push(mergeManga(ex, im))
            } else {
                mangaToWrite.push(im)
            }
        }
    }

    // parseImportData only drops dependent rows whose parent manga was PRESENT-but-invalid.
    // A dependent row whose mangaId is absent from the envelope entirely AND not in the
    // local library would otherwise be written as an orphan with no parent manga. Gate every
    // dependent write on the final valid manga set: existing local manga ids UNION the manga
    // this import writes (skipped manga stay valid - they already exist locally).
    const validMangaIds = new Set((await db.manga.toCollection().primaryKeys()) as string[])
    for (const m of mangaToWrite) validMangaIds.add(m.id)
    const isValidParent = (mangaId: string): boolean => !skippedIds.has(mangaId) && validMangaIds.has(mangaId)

    const sourceLinksToWrite = data.sourceLinks.filter(sl => isValidParent(sl.mangaId))
    const chaptersToWrite = data.chapters.filter(ch => isValidParent(ch.mangaId))
    const candidateProgress = data.progress.filter(p => isValidParent(p.mangaId))
    // Drop the auto-increment id from imported history events - a backup from a
    // different profile has its own id sequence starting at 1, so bulkPut-ing those
    // ids raw would silently overwrite unrelated local history at the same keys.
    // historyEvents.id isn't referenced as a foreign key anywhere else, so letting
    // Dexie assign fresh ids on insert is safe.
    const historyToWrite = data.historyEvents.filter(h => isValidParent(h.mangaId)).map(({ id: _id, ...rest }) => rest)
    // pageBookmarks use a string primary key (`${chapterId}:${pageIndex}`, see
    // toggleBookmark), which is semantically stable across profiles - unlike
    // historyEvents' arbitrary auto-increment id, the same key really does mean "the
    // same bookmark", so bulkPut-ing it raw (last-write-wins) is correct here.
    const bookmarksToWrite = data.pageBookmarks.filter(b => isValidParent(b.mangaId))

    await db.transaction(
        "rw",
        [
            db.manga,
            db.sourceLinks,
            db.chapters,
            db.progress,
            db.historyEvents,
            db.pageBookmarks,
            db.archProfiles,
            db.versions,
            db.workOverrides
        ],
        async () => {
            if (mangaToWrite.length > 0) await db.manga.bulkPut(mangaToWrite)
            if (sourceLinksToWrite.length > 0) await db.sourceLinks.bulkPut(sourceLinksToWrite)
            if (chaptersToWrite.length > 0) await db.chapters.bulkPut(chaptersToWrite)
            if (candidateProgress.length > 0) {
                // Progress isn't covered by mergeManga's Math.max logic. Take the fresher
                // record by updatedAt, but ratchet `completed` one-way: a chapter marked
                // completed locally must never regress to incomplete from an import (matching
                // saveProgress's own ratchet), even if the imported record is newer.
                const existingProgress = await db.progress.bulkGet(candidateProgress.map(p => p.chapterId))
                const progressToWrite: ReadingProgress[] = []
                candidateProgress.forEach((p, i) => {
                    const existing = existingProgress[i]
                    if (!existing) {
                        progressToWrite.push(p)
                        return
                    }
                    const base = p.updatedAt >= existing.updatedAt ? p : existing
                    const completed = existing.completed || p.completed
                    if (base === existing && completed === existing.completed) return // no change
                    progressToWrite.push({ ...base, completed })
                })
                if (progressToWrite.length > 0) await db.progress.bulkPut(progressToWrite)
            }
            if (historyToWrite.length > 0) {
                // History carries no stable natural key, so re-importing the same backup or a
                // routine sync:pull (both merge without clearing) would multiply events and
                // inflate stats. Dedup against existing rows by their natural identity.
                const key = (h: Omit<HistoryEvent, "id">) => `${h.mangaId}|${h.chapterId}|${h.type}|${h.occurredAt}`
                const seenHistory = new Set((await db.historyEvents.toArray()).map(key))
                const historyDeduped = historyToWrite.filter(h => {
                    const k = key(h)
                    if (seenHistory.has(k)) return false
                    seenHistory.add(k)
                    return true
                })
                if (historyDeduped.length > 0) await db.historyEvents.bulkAdd(historyDeduped)
            }
            if (bookmarksToWrite.length > 0) await db.pageBookmarks.bulkPut(bookmarksToWrite)
            // ARCH TRACK A (experimental): imported source profiles round-trip through backup.
            // last-write-wins on id (a profile id is stable), same as bookmarks.
            if (data.archProfiles.length > 0) {
                const stored = await db.archProfiles.bulkGet(data.archProfiles.map(row => row.id))
                const toWrite = data.archProfiles.filter((row, i) => !wouldDowngradeArchProfile(stored[i], row))
                if (toWrite.length > 0) await db.archProfiles.bulkPut(toWrite)
            }
            // ARCH TRACK A: version pool merges by the fresher lastSeenAt (the pool is a cache,
            // so a newer observation always wins); overrides merge by the fresher updatedAt
            // (user intent, last-writer-wins - same rule the device sync uses).
            if (data.versions.length > 0) {
                const existing = await db.versions.bulkGet(data.versions.map(v => v.id))
                const toWrite = data.versions.filter((v, i) => {
                    const ex = existing[i]
                    return !ex || v.lastSeenAt >= ex.lastSeenAt
                })
                if (toWrite.length > 0) await db.versions.bulkPut(toWrite.map(sanitizeVersion))
            }
            if (data.workOverrides.length > 0) {
                const existing = await db.workOverrides.bulkGet(data.workOverrides.map(o => o.id))
                const toWrite = data.workOverrides.filter((o, i) => {
                    const ex = existing[i]
                    return !ex || o.updatedAt >= ex.updatedAt
                })
                if (toWrite.length > 0) await db.workOverrides.bulkPut(toWrite)
            }
        }
    )
    return { manga: mangaToWrite.length, chapters: chaptersToWrite.length, skipped: data.skipped }
}

// Retention is partitioned by kind so the two backup populations never evict each
// other: the daily "auto" snapshots and the pre-operation safety snapshots are
// pruned independently. Keep the newest AUTO_MAX autos AND the newest SAFETY_MAX
// pre-op snapshots; without the split a burst of daily autos would silently push the
// pre-import/pre-sync-pull safety net out of the pool (and vice versa).
const AUTO_MAX = 7
const SAFETY_MAX = 5

// Automatic, silent safety-net snapshot. Taken before any import/sync-pull mutation
// (see the data:import and sync:pull handlers in handlers/data-sync-settings.ts) and,
// with reason "auto", once a day by the daily backup alarm. No user prompt - zero
// friction by design.
export async function createBackup(reason: LibraryBackup["reason"]): Promise<number> {
    const envelope = await exportDatabase()
    const id = await db.backups.add({ createdAt: Date.now(), reason, envelope })
    const all = await db.backups.orderBy("createdAt").reverse().toArray()
    const autos = all.filter(b => b.reason === "auto")
    const safety = all.filter(b => b.reason !== "auto")
    const stale = [...autos.slice(AUTO_MAX), ...safety.slice(SAFETY_MAX)]
    if (stale.length > 0) {
        await db.backups.bulkDelete(stale.map(b => b.id!))
    }
    return id!
}

// Cheap fingerprint of the library used by the daily backup job to skip snapshotting
// on idle days (nothing added, updated, or removed since the last auto backup). The
// manga count catches additions/removals; the max updatedAt catches in-place edits
// and update-check advances. Returns "0:0" for an empty library.
export async function libraryChangeSignature(): Promise<string> {
    const all = await db.manga.toArray()
    if (all.length === 0) return "0:0"
    let maxUpdatedAt = 0
    let maxMetadataUpdatedAt = 0
    let hash = 0
    for (const m of all) {
        if (m.updatedAt > maxUpdatedAt) maxUpdatedAt = m.updatedAt
        if (m.metadataUpdatedAt !== undefined && m.metadataUpdatedAt > maxMetadataUpdatedAt) {
            maxMetadataUpdatedAt = m.metadataUpdatedAt
        }
        // Fold a cheap rolling hash of the enrichable metadata so a metadata-only change
        // (genres/covers/status/title/nsfw via updateManga, which deliberately does NOT
        // bump updatedAt - the library:list sort keys off updatedAt) still flips the
        // signature and earns a fresh auto restore-point.
        const meta = `${m.id} ${m.title} ${m.status ?? ""} ${m.coverUrl ?? ""} ${(m.genres ?? []).join(",")} ${(
            m.categories ?? []
        ).join(",")} ${m.nsfw ? 1 : 0}`
        for (let i = 0; i < meta.length; i++) {
            hash = (Math.imul(31, hash) + meta.charCodeAt(i)) | 0
        }
    }
    return `${all.length}:${maxUpdatedAt}:${maxMetadataUpdatedAt}:${hash >>> 0}`
}

export async function listBackups(): Promise<BackupSummary[]> {
    const all = await db.backups.orderBy("createdAt").reverse().toArray()
    return all.map(b => ({ id: b.id!, createdAt: b.createdAt, reason: b.reason }))
}

// Clears exactly the tables covered by the export/import envelope - unlike
// clearLibrary(), this deliberately leaves db.downloads and db.covers untouched
// (neither is part of a backup/import envelope, so wiping them on restore would
// destroy data the restore has no way to bring back) and leaves db.backups untouched
// (restoring must not delete the very backups list it's operating on).
async function clearImportableTables(): Promise<void> {
    await db.transaction(
        "rw",
        [
            db.manga,
            db.sourceLinks,
            db.chapters,
            db.progress,
            db.historyEvents,
            db.pageBookmarks,
            db.archProfiles,
            db.versions,
            db.workOverrides
        ],
        async () => {
            await Promise.all([
                db.manga.clear(),
                db.sourceLinks.clear(),
                db.chapters.clear(),
                db.progress.clear(),
                db.historyEvents.clear(),
                db.pageBookmarks.clear(),
                db.archProfiles.clear(),
                db.versions.clear(),
                db.workOverrides.clear()
            ])
        }
    )
}

export async function restoreBackup(id: number): Promise<{ manga: number; chapters: number; skipped: ImportSkip[] }> {
    const backup = await db.backups.get(id)
    if (!backup) throw new Error(`No backup found with id ${id}`)
    // Read the envelope out into a local variable before taking the pre-restore
    // snapshot below. createBackup() prunes to MAX_BACKUPS, which could delete this
    // very backup row (if the user has done 3+ restore cycles) - reading it first
    // means that pruning can never invalidate the data we're about to restore.
    const envelope = backup.envelope
    // Restoring must actually undo, not merge - snapshot current state first (so the
    // restore itself is undoable), then replace current state with the backup's
    // snapshot wholesale instead of importDatabase's default merge-mode resolution
    // (existing-wins on most fields, Math.max on chapter numbers), which would leave
    // a bad import's junk data and clobbered values sitting alongside the restore.
    // createBackup writes db.backups, a table deliberately outside the transaction
    // below - its own completion is safe/idempotent on its own. clearImportableTables
    // and importDatabase are wrapped TOGETHER in one transaction so an SW restart
    // between them can never leave an emptied library with no way back: both
    // functions' own internal transactions already declare exactly this table set,
    // so they join this one instead of committing independently (Dexie's subset-join
    // rule). importDatabase's own parsing/validation (parseImportData's zod
    // safeParse loop) is fully synchronous - no awaits that would hold this
    // transaction open idle.
    await createBackup("pre-import")
    // db.covers/db.downloads are added to the table set purely for the post-restore orphan
    // sweep below; clearImportableTables/importDatabase declare a strict subset (the 6
    // envelope tables) so they still join this transaction rather than open their own.
    return await db.transaction(
        "rw",
        [
            db.manga,
            db.sourceLinks,
            db.chapters,
            db.progress,
            db.historyEvents,
            db.pageBookmarks,
            db.archProfiles,
            db.versions,
            db.workOverrides,
            db.covers,
            db.downloads
        ],
        async () => {
            await clearImportableTables()
            const result = await importDatabase(envelope)
            // Covers/downloads are deliberately outside the backup envelope (see
            // clearImportableTables), so a title present locally but absent from the backup
            // keeps its cover/download rows after the wholesale replace - orphans whose
            // parent manga/chapter is now gone, and which a later same-slug re-add would
            // wrongly reuse. Drop any cover/download whose parent no longer exists.
            const validMangaIds = new Set(await db.manga.toCollection().primaryKeys())
            const validChapterIds = new Set(await db.chapters.toCollection().primaryKeys())
            const orphanCoverIds = (await db.covers.toArray())
                .filter(c => !validMangaIds.has(c.mangaId))
                .map(c => c.mangaId)
            if (orphanCoverIds.length > 0) await db.covers.bulkDelete(orphanCoverIds)
            const orphanDownloadIds = (await db.downloads.toArray())
                .filter(d => !validMangaIds.has(d.mangaId) || !validChapterIds.has(d.chapterId))
                .map(d => d.chapterId)
            if (orphanDownloadIds.length > 0) await db.downloads.bulkDelete(orphanDownloadIds)
            return result
        }
    )
}

export async function seedDatabase(): Promise<void> {
    const now = Date.now()
    const seedEntries: Array<{
        manga: LibraryManga
        chapterUrl: string
        sourceId: string
        chapterTitle: string
        sortKey: number
    }> = [
        {
            manga: {
                id: "seed-md-001",
                title: "Buried Injustice",
                normalizedTitle: "buried injustice",
                coverUrl: "/sample-covers/buried-injustice.jpg",
                authors: [],
                status: "ongoing",
                // Real AniList id so the sample library actually drives the Discover tab
                // (suggestions seed from library titles that carry an anilistId).
                anilistId: 194902,
                sourceId: "mangadex",
                sourceUrl: "https://mangadex.org/chapter/3dff8b5f-844e-4964-abd7-641c34f1f091",
                sourceMangaId: "62994137-014f-4499-b88a-c219b115fd64",
                mangaUrl: "https://mangadex.org/title/62994137-014f-4499-b88a-c219b115fd64",
                addedAt: now - 86400000 * 7,
                updatedAt: now - 3600000 * 2,
                latestChapterId: "seed-md-001-ch"
            },
            chapterUrl: "https://mangadex.org/chapter/3dff8b5f-844e-4964-abd7-641c34f1f091",
            sourceId: "mangadex",
            chapterTitle: "Chapter 1",
            sortKey: 1
        },
        {
            manga: {
                id: "seed-mr-001",
                title: "Entomologist In Sichuan Tang Clan",
                normalizedTitle: "entomologist in sichuan tang clan",
                coverUrl: "/sample-covers/entomologist.jpg",
                authors: [],
                status: "ongoing",
                anilistId: 185452,
                sourceId: "mangaread",
                sourceUrl: "https://www.mangaread.org/manga/entomologist-in-sichuan-tang-clan/chapter-79/?style=list",
                sourceMangaId: "entomologist-in-sichuan-tang-clan",
                mangaUrl: "https://www.mangaread.org/manga/entomologist-in-sichuan-tang-clan/",
                addedAt: now - 86400000 * 5,
                updatedAt: now - 3600000 * 5,
                latestChapterId: "seed-mr-001-ch"
            },
            chapterUrl: "https://www.mangaread.org/manga/entomologist-in-sichuan-tang-clan/chapter-79/?style=list",
            sourceId: "mangaread",
            chapterTitle: "Chapter 79",
            sortKey: 79
        },
        {
            manga: {
                id: "seed-mr-002",
                title: "Legendary Youngest Son Of The Marquis House",
                normalizedTitle: "legendary youngest son of the marquis house",
                coverUrl: "/sample-covers/legendary-marquis.jpg",
                authors: [],
                status: "ongoing",
                sourceId: "mangaread",
                sourceUrl:
                    "https://www.mangaread.org/manga/legendary-youngest-son-of-the-marquis-house/chapter-161/?style=list",
                sourceMangaId: "legendary-youngest-son-of-the-marquis-house",
                mangaUrl: "https://www.mangaread.org/manga/legendary-youngest-son-of-the-marquis-house/",
                addedAt: now - 86400000 * 3,
                updatedAt: now - 3600000 * 8,
                latestChapterId: "seed-mr-002-ch"
            },
            chapterUrl:
                "https://www.mangaread.org/manga/legendary-youngest-son-of-the-marquis-house/chapter-161/?style=list",
            sourceId: "mangaread",
            chapterTitle: "Chapter 161",
            sortKey: 161
        },
        {
            manga: {
                id: "seed-mgk-001",
                title: "Barbarian's Adventure In A Fantasy World",
                normalizedTitle: "barbarian's adventure in a fantasy world",
                coverUrl: "/sample-covers/barbarian-fantasy.jpg",
                authors: [],
                status: "ongoing",
                sourceId: "mgeko",
                sourceUrl: "https://www.mgeko.cc/reader/en/barbarians-adventure-in-a-fantasy-world-chapter-52-eng-li/",
                sourceMangaId: "barbarians-adventure-in-a-fantasy-world",
                mangaUrl: "https://www.mgeko.cc/comic/barbarians-adventure-in-a-fantasy-world/",
                addedAt: now - 86400000 * 2,
                updatedAt: now - 3600000 * 12,
                latestChapterId: "seed-mgk-001-ch"
            },
            chapterUrl: "https://www.mgeko.cc/reader/en/barbarians-adventure-in-a-fantasy-world-chapter-52-eng-li/",
            sourceId: "mgeko",
            chapterTitle: "Chapter 52",
            sortKey: 52
        },
        {
            manga: {
                id: "seed-wc-001",
                title: "Jujutsu Kaisen",
                normalizedTitle: "jujutsu kaisen",
                coverUrl: "/sample-covers/jujutsu-kaisen.jpg",
                authors: ["Gege Akutami"],
                status: "ongoing",
                anilistId: 101517,
                sourceId: "weebcentral",
                sourceUrl: "https://weebcentral.com/chapters/01KWX62ZXF6VQDFEM1ADY98TFD/",
                sourceMangaId: "01KWX62ZXF6VQDFEM1ADY98TFD",
                mangaUrl: "https://weebcentral.com/chapters/01KWX62ZXF6VQDFEM1ADY98TFD/",
                addedAt: now - 86400000 * 10,
                updatedAt: now - 3600000 * 1,
                latestChapterId: "seed-wc-001-ch"
            },
            chapterUrl: "https://weebcentral.com/chapters/01KWX62ZXF6VQDFEM1ADY98TFD/",
            sourceId: "weebcentral",
            chapterTitle: "Chapter 1",
            sortKey: 1
        },
        {
            manga: {
                id: "seed-dyn-001",
                title: "Bloom Into You",
                normalizedTitle: "bloom into you",
                coverUrl: "/sample-covers/bloom-into-you.jpg",
                authors: ["Nio Nakatani"],
                status: "completed",
                sourceId: "dynasty-scans",
                sourceUrl: "https://dynasty-scans.com/chapters/bloom_into_you_ch1",
                sourceMangaId: "bloom_into_you",
                mangaUrl: "https://dynasty-scans.com/series/bloom_into_you",
                addedAt: now - 86400000 * 9,
                updatedAt: now - 3600000 * 6,
                latestChapterId: "seed-dyn-001-ch"
            },
            chapterUrl: "https://dynasty-scans.com/chapters/bloom_into_you_ch1",
            sourceId: "dynasty-scans",
            chapterTitle: "Chapter 1",
            sortKey: 1
        },
        {
            manga: {
                id: "seed-ac-001",
                title: "Return of the Disaster-Class Hero",
                normalizedTitle: "return of the disaster-class hero",
                coverUrl: "/sample-covers/disaster-class-hero.jpg",
                authors: [],
                status: "ongoing",
                sourceId: "asuracomic",
                sourceUrl: "https://asuracomic.net/series/return-of-the-disaster-class-hero-4dbc9a3a/1",
                sourceMangaId: "return-of-the-disaster-class-hero-4dbc9a3a",
                mangaUrl: "https://asuracomic.net/series/return-of-the-disaster-class-hero-4dbc9a3a",
                addedAt: now - 86400000 * 8,
                updatedAt: now - 3600000 * 3,
                latestChapterId: "seed-ac-001-ch"
            },
            chapterUrl: "https://asuracomic.net/series/return-of-the-disaster-class-hero-4dbc9a3a/1",
            sourceId: "asuracomic",
            chapterTitle: "Chapter 1",
            sortKey: 1
        },
        {
            manga: {
                id: "seed-as-001",
                title: "Omniscient Reader's Viewpoint",
                normalizedTitle: "omniscient reader's viewpoint",
                coverUrl: "/sample-covers/omniscient-reader.jpg",
                authors: [],
                status: "ongoing",
                sourceId: "asurascans",
                sourceUrl: "https://asurascans.com/comics/omniscient-readers-viewpoint-9182bca3/chapter/1",
                sourceMangaId: "omniscient-readers-viewpoint-9182bca3",
                mangaUrl: "https://asurascans.com/comics/omniscient-readers-viewpoint-9182bca3",
                addedAt: now - 86400000 * 6,
                updatedAt: now - 3600000 * 4,
                latestChapterId: "seed-as-001-ch"
            },
            chapterUrl: "https://asurascans.com/comics/omniscient-readers-viewpoint-9182bca3/chapter/1",
            sourceId: "asurascans",
            chapterTitle: "Chapter 1",
            sortKey: 1
        },
        {
            manga: {
                id: "seed-oms-001",
                title: "The Beginning After The End",
                normalizedTitle: "the beginning after the end",
                coverUrl: "/sample-covers/beginning-after-end.jpg",
                authors: ["TurtleMe"],
                status: "ongoing",
                sourceId: "asuracomic",
                sourceUrl: "https://asuracomic.net/series/the-beginning-after-the-end/chapter-1",
                sourceMangaId: "the-beginning-after-the-end",
                mangaUrl: "https://asuracomic.net/series/the-beginning-after-the-end",
                addedAt: now - 86400000 * 14,
                updatedAt: now - 3600000 * 9,
                latestChapterId: "seed-oms-001-ch"
            },
            chapterUrl: "https://asuracomic.net/series/the-beginning-after-the-end/chapter-1",
            sourceId: "asuracomic",
            chapterTitle: "Chapter 1",
            sortKey: 1
        },
        {
            manga: {
                id: "seed-ts-001",
                title: "Kukuku! He is the Weakest of the Four Heavenly Kings",
                normalizedTitle: "kukuku! he is the weakest of the four heavenly kings",
                coverUrl: "/sample-covers/nano-machine.jpg",
                authors: [],
                status: "ongoing",
                sourceId: "thunderscans",
                sourceUrl:
                    "https://en-thunderscans.com/kukuku-he-is-the-weakest-of-the-four-heavenly-kings-i-was-dismissed-from-my-job-but-somehow-i-became-the-master-of-a-hero-and-a-holy-maiden-chapter-1/",
                sourceMangaId:
                    "kukuku-he-is-the-weakest-of-the-four-heavenly-kings-i-was-dismissed-from-my-job-but-somehow-i-became-the-master-of-a-hero-and-a-holy-maiden",
                mangaUrl:
                    "https://en-thunderscans.com/manga/kukuku-he-is-the-weakest-of-the-four-heavenly-kings-i-was-dismissed-from-my-job-but-somehow-i-became-the-master-of-a-hero-and-a-holy-maiden/",
                addedAt: now - 86400000 * 13,
                updatedAt: now - 3600000 * 7,
                latestChapterId: "seed-ts-001-ch"
            },
            chapterUrl:
                "https://en-thunderscans.com/kukuku-he-is-the-weakest-of-the-four-heavenly-kings-i-was-dismissed-from-my-job-but-somehow-i-became-the-master-of-a-hero-and-a-holy-maiden-chapter-1/",
            sourceId: "thunderscans",
            chapterTitle: "Chapter 1",
            sortKey: 1
        },
        {
            manga: {
                id: "seed-wt-001",
                title: "Daisy: How to Become the Duke's Fiancée",
                normalizedTitle: "daisy: how to become the duke's fiancée",
                coverUrl: "/sample-covers/tower-of-god.jpg",
                authors: [],
                status: "ongoing",
                sourceId: "webtoons",
                sourceUrl:
                    "https://www.webtoons.com/en/romance/daisy-how-to-become-the-dukes-fiancee/episode-1/viewer?title_no=8579&episode_no=1",
                sourceMangaId: "8579",
                mangaUrl:
                    "https://www.webtoons.com/en/romance/daisy-how-to-become-the-dukes-fiancee/list?title_no=8579",
                addedAt: now - 86400000 * 12,
                updatedAt: now - 3600000 * 2,
                latestChapterId: "seed-wt-001-ch"
            },
            chapterUrl:
                "https://www.webtoons.com/en/romance/daisy-how-to-become-the-dukes-fiancee/episode-1/viewer?title_no=8579&episode_no=1",
            sourceId: "webtoons",
            chapterTitle: "Episode 1",
            sortKey: 1
        },
        {
            manga: {
                id: "seed-mh-001",
                title: "Attack on Titan",
                normalizedTitle: "attack on titan",
                coverUrl: "/sample-covers/attack-on-titan.jpg",
                authors: ["Hajime Isayama"],
                status: "completed",
                sourceId: "mangahub",
                sourceUrl: "https://mangahub.io/chapter/shingeki-no-kyojin/chapter-1",
                sourceMangaId: "shingeki-no-kyojin",
                mangaUrl: "https://mangahub.io/manga/shingeki-no-kyojin",
                addedAt: now - 86400000 * 11,
                updatedAt: now - 3600000 * 15,
                latestChapterId: "seed-mh-001-ch"
            },
            chapterUrl: "https://mangahub.io/chapter/shingeki-no-kyojin/chapter-1",
            sourceId: "mangahub",
            chapterTitle: "Chapter 1",
            sortKey: 1
        },
        {
            manga: {
                id: "seed-ff-001",
                title: "Ogami Tsumiki to Kinichijou",
                normalizedTitle: "ogami tsumiki to kinichijou",
                coverUrl: "/sample-covers/ghost-story.jpg",
                authors: [],
                status: "ongoing",
                sourceId: "fanfox",
                sourceUrl: "https://fanfox.net/manga/ogami_tsumiki_to_kinichijou/c106/1.html",
                sourceMangaId: "ogami_tsumiki_to_kinichijou",
                mangaUrl: "https://fanfox.net/manga/ogami_tsumiki_to_kinichijou/",
                addedAt: now - 86400000 * 20,
                updatedAt: now - 86400000 * 1,
                latestChapterId: "seed-ff-001-ch"
            },
            chapterUrl: "https://fanfox.net/manga/ogami_tsumiki_to_kinichijou/c106/1.html",
            sourceId: "fanfox",
            chapterTitle: "Ch.106",
            sortKey: 106
        },
        {
            manga: {
                id: "seed-ops-001",
                title: "Eleceed",
                normalizedTitle: "eleceed",
                coverUrl: "/sample-covers/eleceed.jpg",
                authors: [],
                status: "ongoing",
                sourceId: "olympustaff",
                sourceUrl: "https://olympustaff.com/series/eleceed/1",
                sourceMangaId: "eleceed",
                mangaUrl: "https://olympustaff.com/series/eleceed",
                addedAt: now - 86400000 * 4,
                updatedAt: now - 3600000 * 10,
                latestChapterId: "seed-ops-001-ch"
            },
            chapterUrl: "https://olympustaff.com/series/eleceed/1",
            sourceId: "olympustaff",
            chapterTitle: "Chapter 1",
            sortKey: 1
        },
        {
            manga: {
                id: "seed-mf-001",
                title: "One Punch Man",
                normalizedTitle: "one punch man",
                coverUrl: "/sample-covers/one-punch-man.jpg",
                authors: ["ONE", "Yusuke Murata"],
                status: "ongoing",
                sourceId: "mangafreak",
                sourceUrl: "https://ww2.mangafreak.me/Read1_One_Punch_Man_1",
                sourceMangaId: "One_Punch_Man",
                mangaUrl: "https://ww2.mangafreak.me/Manga/One_Punch_Man",
                addedAt: now - 86400000 * 16,
                updatedAt: now - 3600000 * 18,
                latestChapterId: "seed-mf-001-ch"
            },
            chapterUrl: "https://ww2.mangafreak.me/Read1_One_Punch_Man_1",
            sourceId: "mangafreak",
            chapterTitle: "Chapter 1",
            sortKey: 1
        },
        {
            manga: {
                id: "seed-cx-001",
                title: "My Possession Became a Ghost Story",
                normalizedTitle: "my possession became a ghost story",
                coverUrl: "/sample-covers/ghost-story.jpg",
                authors: [],
                status: "ongoing",
                sourceId: "comix",
                sourceUrl: "https://comix.to/title/80d0m-my-possession-became-a-ghost-story/10251750-chapter-0",
                sourceMangaId: "80d0m-my-possession-became-a-ghost-story",
                mangaUrl: "https://comix.to/title/80d0m-my-possession-became-a-ghost-story",
                addedAt: now - 86400000 * 1,
                updatedAt: now - 3600000 * 20,
                latestChapterId: "seed-cx-001-ch"
            },
            chapterUrl: "https://comix.to/title/80d0m-my-possession-became-a-ghost-story/10251750-chapter-0",
            sourceId: "comix",
            chapterTitle: "Chapter 0",
            sortKey: 0
        }
    ]

    const seedManga = seedEntries.map(e => e.manga)
    const seedChapters: import("@amr/contracts").ChapterRecord[] = seedEntries.map(e => ({
        id: e.manga.latestChapterId!,
        mangaId: e.manga.id,
        sourceId: e.sourceId,
        title: e.chapterTitle,
        sortKey: e.sortKey,
        url: e.chapterUrl
    }))
    const seedLinks: import("@amr/contracts").SourceLinkRecord[] = seedEntries.map(e => ({
        mangaId: e.manga.id,
        sourceId: e.sourceId,
        ...(e.manga.sourceMangaId ? { sourceMangaId: e.manga.sourceMangaId } : {}),
        url: e.manga.mangaUrl ?? e.chapterUrl,
        title: e.manga.title,
        addedAt: e.manga.addedAt,
        updatedAt: e.manga.updatedAt
    }))
    await db.transaction("rw", db.manga, db.sourceLinks, db.chapters, async () => {
        const staleIds = (await db.manga.where("id").startsWith("seed-").primaryKeys()) as string[]
        if (staleIds.length > 0) {
            await db.manga.bulkDelete(staleIds)
            await db.sourceLinks.bulkDelete(staleIds)
            await db.chapters.where("mangaId").anyOf(staleIds).delete()
        }
        await db.manga.bulkPut(seedManga)
        await db.sourceLinks.bulkPut(seedLinks)
        await db.chapters.bulkPut(seedChapters)
    })
}

export async function getLocalStats() {
    const [manga, progress, history, downloadedChapters, chapters] = await Promise.all([
        db.manga.toArray(),
        db.progress.toArray(),
        db.historyEvents.orderBy("occurredAt").toArray(),
        db.downloads.count(),
        db.chapters.toArray()
    ])
    const mangaCount = manga.length
    // Count DISTINCT completed chapters, not raw progress rows: a leftover placeholder row
    // or a duplicate library entry (both from the Asura slug-rotation class) otherwise
    // inflates the total. Key by (mangaId, chapter number) when the number is known, else the
    // chapter URL, so the same logical chapter counts once across ext-rows and re-slugs.
    const chapterById = new Map(chapters.map(c => [c.id, c]))
    const completedKeys = new Set<string>()
    for (const item of progress) {
        if (!item.completed) continue
        const ch = chapterById.get(item.chapterId)
        const key =
            ch && Number.isFinite(ch.sortKey) ? `${item.mangaId}:${ch.sortKey}` : `url:${ch?.url ?? item.chapterId}`
        completedKeys.add(key)
    }
    const completedChapters = completedKeys.size

    const ratedCount = manga.filter(m => m.rating !== undefined).length
    const categoriesCount = new Set(manga.flatMap(m => m.categories ?? [])).size
    const sourcesUsed = new Set(manga.map(m => m.sourceId)).size
    const manualCount = manga.filter(m => m.manualTracking === true).length
    const completedSeries = manga.filter(
        m =>
            m.latestChapterNumber !== undefined &&
            m.lastReadChapterNumber !== undefined &&
            m.lastReadChapterNumber >= m.latestChapterNumber
    ).length
    // Count only COMPLETED reads toward reading-days and streaks, matching the activity
    // calendar and pace metrics (which already filter to "completed"). A bare "started"
    // event from merely opening a chapter must not manufacture a streak day the heatmap
    // shows as empty.
    const dayKeys = [
        ...new Set(
            history.filter(event => event.type === "completed").map(event => localDayKey(new Date(event.occurredAt)))
        )
    ].sort()
    const readingDays = dayKeys.length

    const dayMs = 86_400_000
    const asDay = (key: string) => Date.parse(`${key}T00:00:00Z`)
    let longestStreak = 0
    let run = 0
    let prev: number | null = null
    for (const key of dayKeys) {
        const t = asDay(key)
        run = prev !== null && t - prev === dayMs ? run + 1 : 1
        longestStreak = Math.max(longestStreak, run)
        prev = t
    }
    // Current streak: consecutive days ending today or yesterday.
    let currentStreak = 0
    const todayKey = localDayKey(new Date())
    let cursor = asDay(todayKey)
    const daySet = new Set(dayKeys.map(asDay))
    if (!daySet.has(cursor) && daySet.has(cursor - dayMs)) cursor -= dayMs
    while (daySet.has(cursor)) {
        currentStreak += 1
        cursor -= dayMs
    }
    const weekAgo = Date.now() - 7 * dayMs
    const chaptersThisWeek = history.filter(e => e.type === "completed" && e.occurredAt >= weekAgo).length
    const chaptersToday = history.filter(
        e => e.type === "completed" && localDayKey(new Date(e.occurredAt)) === todayKey
    ).length

    const ACHIEVEMENT_DEFS: Array<{
        id: string
        title: string
        description: string
        category: string
        metric: number
        target: number
    }> = [
        {
            id: "first-chapter",
            title: "First Chapter",
            description: "Complete one chapter",
            category: "Chapters",
            metric: completedChapters,
            target: 1
        },
        {
            id: "chapters-10",
            title: "Just Warming Up",
            description: "Complete ten chapters",
            category: "Chapters",
            metric: completedChapters,
            target: 10
        },
        {
            id: "chapters-50",
            title: "Bookworm",
            description: "Complete 50 chapters",
            category: "Chapters",
            metric: completedChapters,
            target: 50
        },
        {
            id: "chapters-100",
            title: "Page Turner",
            description: "Complete 100 chapters",
            category: "Chapters",
            metric: completedChapters,
            target: 100
        },
        {
            id: "chapters-250",
            title: "Voracious",
            description: "Complete 250 chapters",
            category: "Chapters",
            metric: completedChapters,
            target: 250
        },
        {
            id: "chapters-500",
            title: "Marathon",
            description: "Complete 500 chapters",
            category: "Chapters",
            metric: completedChapters,
            target: 500
        },
        {
            id: "chapters-1000",
            title: "Living Library",
            description: "Complete 1000 chapters",
            category: "Chapters",
            metric: completedChapters,
            target: 1000
        },
        {
            id: "manga-1",
            title: "First Title",
            description: "Save your first manga",
            category: "Library",
            metric: mangaCount,
            target: 1
        },
        {
            id: "manga-5",
            title: "Shelf Starter",
            description: "Save five manga",
            category: "Library",
            metric: mangaCount,
            target: 5
        },
        {
            id: "manga-10",
            title: "Collector",
            description: "Save ten manga",
            category: "Library",
            metric: mangaCount,
            target: 10
        },
        {
            id: "manga-25",
            title: "Curator",
            description: "Save 25 manga",
            category: "Library",
            metric: mangaCount,
            target: 25
        },
        {
            id: "manga-50",
            title: "Archivist",
            description: "Save 50 manga",
            category: "Library",
            metric: mangaCount,
            target: 50
        },
        {
            id: "manga-100",
            title: "Hoarder",
            description: "Save 100 manga",
            category: "Library",
            metric: mangaCount,
            target: 100
        },
        {
            id: "streak-3",
            title: "Consistent",
            description: "Keep a three-day reading streak",
            category: "Streaks",
            metric: longestStreak,
            target: 3
        },
        {
            id: "streak-7",
            title: "Dedicated",
            description: "Reach a seven-day reading streak",
            category: "Streaks",
            metric: longestStreak,
            target: 7
        },
        {
            id: "streak-14",
            title: "Committed",
            description: "Reach a fourteen-day reading streak",
            category: "Streaks",
            metric: longestStreak,
            target: 14
        },
        {
            id: "streak-30",
            title: "Unstoppable",
            description: "Reach a thirty-day reading streak",
            category: "Streaks",
            metric: longestStreak,
            target: 30
        },
        {
            id: "streak-60",
            title: "Relentless",
            description: "Reach a sixty-day reading streak",
            category: "Streaks",
            metric: longestStreak,
            target: 60
        },
        {
            id: "streak-100",
            title: "Centurion",
            description: "Reach a hundred-day reading streak",
            category: "Streaks",
            metric: longestStreak,
            target: 100
        },
        {
            id: "active-days-7",
            title: "Explorer",
            description: "Read on seven different days",
            category: "Activity",
            metric: readingDays,
            target: 7
        },
        {
            id: "active-days-30",
            title: "Regular",
            description: "Read on 30 different days",
            category: "Activity",
            metric: readingDays,
            target: 30
        },
        {
            id: "active-days-100",
            title: "Veteran",
            description: "Read on 100 different days",
            category: "Activity",
            metric: readingDays,
            target: 100
        },
        {
            id: "weekly-reader",
            title: "Weekly Reader",
            description: "Complete ten chapters in a week",
            category: "Pace",
            metric: chaptersThisWeek,
            target: 10
        },
        {
            id: "binge-week",
            title: "Binge Week",
            description: "Complete 30 chapters in a week",
            category: "Pace",
            metric: chaptersThisWeek,
            target: 30
        },
        {
            id: "day-blitz",
            title: "Day Blitz",
            description: "Complete ten chapters in a single day",
            category: "Pace",
            metric: chaptersToday,
            target: 10
        },
        {
            id: "rate-5",
            title: "Critic",
            description: "Rate five titles",
            category: "Curation",
            metric: ratedCount,
            target: 5
        },
        {
            id: "rate-25",
            title: "Reviewer",
            description: "Rate 25 titles",
            category: "Curation",
            metric: ratedCount,
            target: 25
        },
        {
            id: "categories-3",
            title: "Organizer",
            description: "Create three categories",
            category: "Curation",
            metric: categoriesCount,
            target: 3
        },
        {
            id: "manual-1",
            title: "Hands On",
            description: "Mark a title for manual tracking",
            category: "Curation",
            metric: manualCount,
            target: 1
        },
        {
            id: "complete-series-1",
            title: "The End",
            description: "Catch up to the latest chapter of a series",
            category: "Curation",
            metric: completedSeries,
            target: 1
        },
        {
            id: "complete-series-5",
            title: "Caught Up",
            description: "Catch up on five full series",
            category: "Curation",
            metric: completedSeries,
            target: 5
        },
        {
            id: "offline-5",
            title: "Going Offline",
            description: "Download five chapters for offline reading",
            category: "Offline",
            metric: downloadedChapters,
            target: 5
        },
        {
            id: "offline-25",
            title: "Stocked Up",
            description: "Download 25 chapters for offline reading",
            category: "Offline",
            metric: downloadedChapters,
            target: 25
        },
        {
            id: "sources-3",
            title: "Source Hopper",
            description: "Read from three distinct sources",
            category: "Sources",
            metric: sourcesUsed,
            target: 3
        },
        {
            id: "sources-5",
            title: "Source Connoisseur",
            description: "Read from five distinct sources",
            category: "Sources",
            metric: sourcesUsed,
            target: 5
        }
    ]

    return {
        mangaCount,
        completedChapters,
        readingDays,
        currentStreak,
        longestStreak,
        chaptersThisWeek,
        chaptersToday,
        ratedCount,
        categoriesCount,
        downloadedChapters,
        sourcesUsed,
        completedSeries,
        estimatedMinutes: completedChapters * 5,
        minutesThisWeek: chaptersThisWeek * 5,
        achievements: ACHIEVEMENT_DEFS.map(def => ({
            id: def.id,
            title: def.title,
            description: def.description,
            category: def.category,
            target: def.target,
            progress: Math.min(def.metric, def.target),
            unlocked: def.metric >= def.target
        }))
    }
}

function localDayKey(d: Date): string {
    const year = d.getFullYear()
    const month = `${d.getMonth() + 1}`.padStart(2, "0")
    const day = `${d.getDate()}`.padStart(2, "0")
    return `${year}-${month}-${day}`
}

export async function getActivityCalendar(days = 120): Promise<Array<{ date: string; count: number }>> {
    const events = await db.historyEvents.where("type").equals("completed").toArray()
    const perDay = new Map<string, Set<string>>()
    for (const event of events) {
        const key = localDayKey(new Date(event.occurredAt))
        const seen = perDay.get(key)
        if (seen) seen.add(event.chapterId)
        else perDay.set(key, new Set([event.chapterId]))
    }
    const result: Array<{ date: string; count: number }> = []
    const cursor = new Date()
    cursor.setHours(0, 0, 0, 0)
    cursor.setDate(cursor.getDate() - (days - 1))
    for (let i = 0; i < days; i += 1) {
        const key = localDayKey(cursor)
        result.push({ date: key, count: perDay.get(key)?.size ?? 0 })
        cursor.setDate(cursor.getDate() + 1)
    }
    return result
}

export async function recordAnalyticsEvent(event: Omit<AnalyticsEvent, "id">): Promise<void> {
    await db.analyticsEvents.add(event)
    // Keep last 90 days only - prune inline to avoid a separate cleanup job.
    const cutoff = Date.now() - 90 * 86_400_000
    void db.analyticsEvents.where("ts").below(cutoff).delete()
}

// Bounded diagnostic-log ring buffer. Appends then count-trims to the newest LOG_MAX
// entries (by insertion id) - same append-then-prune shape as recordAnalyticsEvent but
// count- rather than age-bounded. Backs the user-exportable log (log:export).
export const LOG_MAX = 1000

export async function recordLog(entry: Omit<LogEntry, "id">): Promise<void> {
    await db.logs.add(entry)
    const count = await db.logs.count()
    if (count > LOG_MAX) {
        const excess = await db.logs
            .orderBy("id")
            .limit(count - LOG_MAX)
            .primaryKeys()
        if (excess.length > 0) await db.logs.bulkDelete(excess)
    }
}

// All log entries, newest-first, for the export.
export async function getLogs(): Promise<LogEntry[]> {
    return (await db.logs.orderBy("id").toArray()).reverse()
}

export async function getAnalyticsSummary(days = 30) {
    const since = Date.now() - days * 86_400_000
    const [events, allManga] = await Promise.all([
        db.analyticsEvents.where("ts").above(since).toArray(),
        db.manga.toArray()
    ])

    const sourceErrors = new Map<string, number>()
    const sourceCaptures = new Map<string, number>()
    const panelActions = new Map<string, number>()
    const errorTypeCount = new Map<string, number>()
    let captureOk = 0,
        captureErrors = 0,
        readerOpened = 0,
        onSiteTrack = 0,
        directResolves = 0,
        tabResolves = 0

    for (const ev of events) {
        if (ev.event === "capture_ok") {
            captureOk++
            if (ev.sourceId) sourceCaptures.set(ev.sourceId, (sourceCaptures.get(ev.sourceId) ?? 0) + 1)
        } else if (ev.event === "capture_error") {
            captureErrors++
            if (ev.sourceId) sourceErrors.set(ev.sourceId, (sourceErrors.get(ev.sourceId) ?? 0) + 1)
            try {
                const d = ev.detail ? (JSON.parse(ev.detail) as { errorType?: string }) : null
                const type = d?.errorType ?? "unknown"
                errorTypeCount.set(type, (errorTypeCount.get(type) ?? 0) + 1)
            } catch {
                errorTypeCount.set("unknown", (errorTypeCount.get("unknown") ?? 0) + 1)
            }
        } else if (ev.event === "reader_opened") {
            readerOpened++
        } else if (ev.event === "on_site_track") {
            onSiteTrack++
        } else if (ev.event === "resolve_direct") {
            directResolves++
        } else if (ev.event === "resolve_tab") {
            tabResolves++
        } else if (ev.event === "panel_action" && ev.detail) {
            try {
                const d = JSON.parse(ev.detail) as { action?: string }
                const a = d.action ?? "unknown"
                panelActions.set(a, (panelActions.get(a) ?? 0) + 1)
            } catch {
                // ignore malformed detail
            }
        }
    }

    const readerRate = captureOk > 0 ? Math.round((readerOpened / captureOk) * 100) : 0
    const errorRate =
        captureOk + captureErrors > 0 ? Math.round((captureErrors / (captureOk + captureErrors)) * 100) : 0

    // Aggregate genre, author, and status distributions from the full library.
    // Genres are only counted for manga that have had their genres fetched and cached.
    const genreCounts = new Map<string, number>()
    const authorCounts = new Map<string, number>()
    const statusCounts = new Map<string, number>()

    for (const m of allManga) {
        for (const g of m.genres ?? []) {
            genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1)
        }
        for (const a of m.authors ?? []) {
            authorCounts.set(a, (authorCounts.get(a) ?? 0) + 1)
        }
        const st = m.status ?? "unknown"
        statusCounts.set(st, (statusCounts.get(st) ?? 0) + 1)
    }

    return {
        days,
        captureOk,
        captureErrors,
        readerOpened,
        onSiteTrack,
        directResolves,
        tabResolves,
        readerRate,
        errorRate,
        topSources: [...sourceCaptures.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([sourceId, count]) => ({ sourceId, count })),
        topErrors: [...sourceErrors.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([sourceId, count]) => ({ sourceId, count })),
        panelActions: [...panelActions.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([action, count]) => ({ action, count })),
        topGenres: [...genreCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([genre, count]) => ({ genre, count })),
        topAuthors: [...authorCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([author, count]) => ({ author, count })),
        statusBreakdown: [...statusCounts.entries()].map(([status, count]) => ({ status, count })),
        errorTypes: [...errorTypeCount.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count }))
    }
}

export async function toggleBookmark(data: Omit<PageBookmark, "id" | "addedAt">): Promise<boolean> {
    const id = `${data.chapterId}:${data.pageIndex}`
    // One transaction so the get-then-put/delete is atomic: two concurrent toggles (two reader
    // tabs on the same page, a duplicate message) must alternate, not both "add". Also enforce
    // the anti-orphan invariant (mirrors runChapterDownload/saveProgress) - the reader resolves
    // any URL, so a bookmark for a title not in the library would strand a pageBookmarks row no
    // removeManga/cascade can ever reclaim.
    return db.transaction("rw", db.pageBookmarks, db.manga, async () => {
        const existing = await db.pageBookmarks.get(id)
        if (existing) {
            await db.pageBookmarks.delete(id)
            return false
        }
        if ((await db.manga.get(data.mangaId)) === undefined) return false
        await db.pageBookmarks.put({ ...data, id, addedAt: Date.now() })
        return true
    })
}

export async function bookmarkedPagesForChapter(chapterId: string): Promise<number[]> {
    const records = await db.pageBookmarks.where("chapterId").equals(chapterId).toArray()
    return records.map(r => r.pageIndex)
}

export async function listBookmarks(): Promise<PageBookmark[]> {
    return db.pageBookmarks.orderBy("addedAt").reverse().toArray()
}

export async function removeBookmark(id: string): Promise<void> {
    await db.pageBookmarks.delete(id)
}
