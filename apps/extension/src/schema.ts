// Validation schema for the import/export envelope as the extension actually
// stores it. This mirrors the runtime Dexie shape (LibraryManga + historyEvents +
// pageBookmarks), which is leaner than the aspirational contracts ImportExportEnvelope
// (no preferences/sourceHealth tables here). Built from the contract record schemas
// so record-level rules stay shared.
import { chapterRecordSchema, mangaRecordSchema, readingProgressSchema, sourceLinkRecordSchema } from "@amr/contracts"
import { UNNUMBERED_SORT_KEY } from "@amr/source-sdk"
import { z } from "zod"

export const libraryMangaSchema = mangaRecordSchema
    .extend({
        sourceId: z.string().trim().min(1),
        sourceUrl: z.string(),
        sourceMangaId: z.string().trim().min(1).optional(),
        mangaUrl: z.string().optional(),
        latestChapterId: z.string().optional(),
        lastReadChapterId: z.string().optional(),
        latestChapterNumber: z.number().finite().optional(),
        lastReadChapterNumber: z.number().finite().optional(),
        latestChapterAt: z.number().int().nonnegative().optional(),
        lastReadAt: z.number().int().nonnegative().optional(),
        manualTracking: z.boolean().optional(),
        categories: z.array(z.string().trim().min(1)).optional(),
        nsfw: z.boolean().optional(),
        notes: z.string().optional(),
        genres: z.array(z.string()).optional(),
        anilistId: z.number().int().positive().optional(),
        metadataUpdatedAt: z.number().int().nonnegative().optional(),
        noGapContinuous: z.boolean().optional(),
        onHold: z.boolean().optional(),
        readingStatus: z.enum(["paused", "dropped", "planning"]).optional(),
        readingStatusUpdatedAt: z.number().int().nonnegative().optional(),
        readingDirection: z.enum(["ltr", "rtl", "vertical"]).optional(),
        pageFit: z.enum(["width", "height", "contain", "original", "actual"]).optional(),
        // Set by library:switch when moving to a source whose chapter numbering can't be
        // assumed comparable to the previous source's (e.g. MangaHub's internal sequential
        // slug numbering vs. another site's true chapter numbers). See LibraryManga in
        // database.ts.
        chapterNumberingUnreliable: z.boolean().optional()
    })
    // mangaRecordSchema is .strict(), so the extend inherits strict mode: an unrecognized key
    // rejected the WHOLE manga record on import, and the import path then cascade-drops that
    // title's chapters/progress/history/bookmarks. LibraryManga carries 24 non-indexed fields
    // whose only tie to this schema is manual - the next field added to the runtime type but
    // not mirrored here would silently vaporize every affected title on restore. Passthrough
    // keeps unknown keys instead of rejecting, so a forward/backward field mismatch preserves
    // the row (and even round-trips the stray field) rather than destroying data.
    .passthrough()

// Every real chapter-write path stores `SourceChapter` (packages/source-sdk), which is
// `ChapterRecord & { sourceChapterId: string; language: string }` - a superset of the
// bare, `.strict()` contract schema. Importing real library data through the raw
// `chapterRecordSchema` therefore rejected virtually every chapter on the extra
// `sourceChapterId` field. Mirrors the `libraryMangaSchema` pattern above: extend the
// contract schema at the import/export boundary instead of loosening the contract
// schema itself (which other, stricter consumers rely on).
export const importChapterSchema = chapterRecordSchema.extend({
    sourceChapterId: z.string().optional(),
    // An unnumbered chapter stores sortKey = UNNUMBERED_SORT_KEY
    // (Number.POSITIVE_INFINITY) at runtime. IndexedDB keeps that, but a backup
    // file is JSON, and JSON.stringify turns Infinity into null. The bare contract
    // schema's `sortKey: z.number().finite()` would then reject the whole chapter on
    // restore - cascade-skipping its progress and page bookmarks too. Round-trip it
    // at the import boundary only (the runtime write schema intentionally still
    // allows Infinity): accept null - and defensively any non-finite value - and map
    // it back to the sentinel. A genuine finite sortKey passes through unchanged.
    sortKey: z
        .union([z.number(), z.null()])
        .transform(value => (value === null || !Number.isFinite(value) ? UNNUMBERED_SORT_KEY : value))
})

export const historyEventSchema = z.object({
    id: z.number().int().nonnegative().optional(),
    mangaId: z.string().trim().min(1),
    chapterId: z.string().trim().min(1),
    type: z.enum(["started", "completed"]),
    occurredAt: z.number().int().nonnegative()
})

// Matches database.ts's PageBookmark Dexie record. Previously not exported/imported
// at all - db.pageBookmarks was silently excluded from export/import, and
// clearLibrary() wipes it, so an export -> fresh install -> import cycle used to
// permanently destroy bookmarks with no way to recover them.
export const pageBookmarkSchema = z.object({
    id: z.string().trim().min(1),
    mangaId: z.string().trim().min(1),
    chapterId: z.string().trim().min(1),
    pageIndex: z.number().int().nonnegative(),
    mangaTitle: z.string(),
    chapterTitle: z.string(),
    chapterUrl: z.string(),
    addedAt: z.number().int().nonnegative()
})

// ARCH TRACK A (experimental): an imported source profile record. `profile` is opaque here
// (re-validated against the engine schema on re-register), so this is intentionally lenient.
export const archProfileSchema = z
    .object({
        id: z.string().trim().min(1),
        profile: z.unknown(),
        importedAt: z.number().int().nonnegative().optional()
    })
    .passthrough()

// Envelope is intentionally non-strict on the data object so a future export with
// extra tables still imports (unknown keys are dropped, known tables validated).
// Accepts both strict v1 format and legacy loose format for backward compatibility.
//
// NOTE: this schema validates a *whole array* per table in one shot - if any single
// record in `data.chapters` (etc.) fails, the whole array (and therefore the whole
// envelope) fails to parse. That's intentional for these "is this a well-formed
// envelope shape" tests, but the real import path (database.ts's parseImportData)
// does NOT use this schema to decide what to write: it validates records one at a
// time via the per-record schemas above so a single malformed record is skipped and
// reported instead of aborting the entire import. See envelopeStructureSchema below
// for the lenient structural check that path uses instead.
export const exportEnvelopeSchema = z
    .object({
        format: z.literal("all-mangas-reader"),
        version: z.literal(1),
        exportedAt: z.number().int().nonnegative().optional(),
        data: z.object({
            manga: z.array(libraryMangaSchema).optional(),
            sourceLinks: z.array(sourceLinkRecordSchema).optional(),
            chapters: z.array(importChapterSchema).optional(),
            progress: z.array(readingProgressSchema).optional(),
            historyEvents: z.array(historyEventSchema).optional(),
            pageBookmarks: z.array(pageBookmarkSchema).optional(),
            archProfiles: z.array(archProfileSchema).optional()
        })
    })
    .passthrough()
    .transform(envelope => ({
        ...envelope,
        data: {
            manga: envelope.data.manga ?? [],
            sourceLinks: envelope.data.sourceLinks ?? [],
            chapters: envelope.data.chapters ?? [],
            progress: envelope.data.progress ?? [],
            historyEvents: envelope.data.historyEvents ?? [],
            pageBookmarks: envelope.data.pageBookmarks ?? [],
            archProfiles: envelope.data.archProfiles ?? []
        }
    }))

export type ExportEnvelope = z.infer<typeof exportEnvelopeSchema>

// Lenient structural check used by the real import path (database.ts's
// parseImportData): only confirms this is genuinely an AMR envelope (right format
// marker, right version, `data` is an object) and hard-fails on anything else - a
// JSON file from some other tool, or a future version this build doesn't understand.
// It deliberately does NOT validate the shape of the arrays inside `data`; that is
// done per-record so one bad row never takes down the whole import (see Bug 3 in the
// batch notes: "make it a weak link no more").
export const envelopeStructureSchema = z
    .object({
        format: z.literal("all-mangas-reader"),
        version: z.literal(1),
        exportedAt: z.number().int().nonnegative().optional(),
        data: z.object({}).passthrough()
    })
    .passthrough()
