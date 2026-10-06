import type { ChapterRecord, MangaRecord, SourceLinkRecord } from "@amr/contracts"
import { SourceError, UNNUMBERED_SORT_KEY, latestNumberedChapter } from "@amr/source-sdk"
import { sourceRegistry } from "@amr/sources"
import { normalizeTitle } from "@amr/normalize"
import { recordTombstone } from "../account"
import { backfillMangaGenres } from "./updates-sources"
import {
    db,
    addImportedManga,
    applyCleanupGroup,
    cacheCover,
    clearHistory,
    clearLibrary,
    createBackup,
    getActivityCalendar,
    getLocalStats,
    humanizeSlug,
    linkMangaToUrl,
    mergeMangaRecords,
    putChapters,
    relinkMangaWithChapter,
    removeManga,
    saveLinkedChapters,
    saveResolvedChapter,
    switchMangaSource,
    updateManga,
    type LibraryManga
} from "../database"
import {
    chaptersForLanguage,
    findSource,
    listChaptersBySource,
    listChaptersForSource,
    listChaptersFromSourceHtml,
    resolveChapterUrl,
    resolveCoverFor,
    resolveMangaUrl
} from "../sources"
import { getSettings } from "../settings"
import { isBotBlocked } from "../background/capture"
import { ensureOwnSourceVersions } from "../work-versions"
import { scheduleChapterListRefresh } from "../background/chapter-cache"
import { fetchCoverBlob } from "../background/covers"
import { resolveMetadata } from "../metadata"
import { diag } from "../diag-log"
import { fetchChapterHtmlViaTab } from "../background/tab-fetch"
import { matchReadChapterId, matchReadChapterByUrl } from "../reconcile-match"
import { removeFromAniList } from "./anilist"
import type { HandlerMap } from "../background/handler-types"
import { publishLive } from "../live"

const COVER_BACKFILL_BATCH = 20

// IDs attempted this session so a cover that keeps failing to resolve/fetch
// doesn't loop forever. Cleared when a full backfill pass completes (remaining
// hits 0).
const coverBackfillAttempted = new Set<string>()

// --- library:cleanup:scan / library:cleanup:apply -------------------------------
//
// Repairs library entries created by trackExternalChapter's fallback path (used
// when a chapter capture can't resolve via the proper source adapter): those
// records never set sourceMangaId, and get a throwaway deriveSlug(chapterUrl)
// title. This tool finds them, re-resolves the real manga via a MANGA-LEVEL
// lookup (adapter.parseMangaUrl - zero network - or, failing that, a chapter-page
// scrape), groups duplicates of the same underlying title together, and merges
// them into one properly-linked record.

type CleanupMatchedBy = "adapter" | "pathname" | "scrape"

type CleanupCandidateRecord = {
    mangaId: string
    title: string
    sourceUrl: string
    matchedChapterNumbers: number[]
    matchedBy: CleanupMatchedBy
}

type CleanupGroup = {
    canonicalId: string
    canonicalTitle: string
    canonicalCoverUrl?: string
    sourceId: string
    sourceMangaId: string
    mangaUrl: string
    representativeChapterUrl: string
    inLibrary: boolean
    // true when canonicalId === the sole candidate's own id: an already-correctly-
    // keyed record that's only missing sourceMangaId, not a real duplicate group.
    selfHeal: boolean
    records: CleanupCandidateRecord[]
    // Set when this group had more than GROUP_RECORDS_CAP members - the remainder
    // isn't dropped, it simply still fails the fallback predicate and gets picked
    // up on a later re-scan.
    overflowCount?: number
}

type CleanupUnresolved = { mangaId: string; title: string; sourceId: string; sourceUrl: string; reason: string }

type CleanupScanResult = { groups: CleanupGroup[]; unresolved: CleanupUnresolved[]; candidateCount: number }

type CleanupApplyResponse = {
    merged: number
    groups: number
    enriched: number
    skippedStale: number
    skippedUnverified: number
    failed: Array<{ canonicalId: string; reason: string }>
    backupId: number
}

// Identifies a fallback-created record: missing sourceMangaId (every real
// adapter-resolved record sets it via saveResolvedChapter), not a bundled seed
// entry, not something the user deliberately set to manual tracking, and whose
// source is currently registered (an unregistered source can't be re-resolved at
// all, so it doesn't qualify as a candidate FOR MERGING even though the scan's
// broader unresolved-listing predicate still surfaces it to the user).
export function isFallbackCreated(m: LibraryManga): boolean {
    if (m.sourceMangaId !== undefined) return false
    if (m.id.startsWith("seed-")) return false
    if (m.manualTracking) return false
    return sourceRegistry.get(m.sourceId) !== undefined
}

function pathnameOf(url: string): string | null {
    try {
        return new URL(url).pathname
    } catch {
        return null
    }
}

async function matchedChapterNumbersFor(mangaId: string): Promise<number[]> {
    const chapters = await db.chapters.where("mangaId").equals(mangaId).sortBy("sortKey")
    return chapters.map(c => c.sortKey).filter(n => Number.isFinite(n))
}

const CLEANUP_GROUP_RECORDS_CAP = 200

// Resolves ONE candidate as a new group's representative, then greedily folds in
// every other same-source, not-yet-grouped sibling whose own stored chapter URL's
// pathname appears in the representative's freshly-resolved canonical chapter list
// (the "50-to-1" grouping optimization - avoids a network round trip per duplicate).
// Mutates `grouped` to mark every sibling absorbed this way. Returns undefined when
// this candidate itself can't be resolved at all (network/parse failure) - the
// caller reports it as unresolved rather than silently dropping it.
async function resolveGroupFor(
    m: LibraryManga,
    siblings: readonly LibraryManga[],
    grouped: Set<string>,
    sourceId: string
): Promise<CleanupGroup | undefined> {
    const adapter = sourceRegistry.get(sourceId)
    if (!adapter) return undefined
    let repUrl: URL
    try {
        repUrl = new URL(m.sourceUrl)
    } catch {
        return undefined
    }

    let sourceMangaId: string | undefined
    let mangaUrl: string | undefined
    let matchedBy: "adapter" | "scrape" = "adapter"
    let scrapeResolved: Awaited<ReturnType<typeof resolveChapterUrl>> | undefined

    const parsed = adapter.parseMangaUrl?.(repUrl) ?? null
    if (parsed) {
        sourceMangaId = parsed.sourceMangaId
        mangaUrl = parsed.mangaUrl
    } else {
        // No zero-network path available for this adapter - fall back to the full
        // page-scrape resolveChapterUrl uses. This is exactly the call that already
        // failed once at capture time for many of these records, so it may fail
        // again; that's fine, it just lands this candidate in `unresolved`.
        try {
            scrapeResolved = await resolveChapterUrl(m.sourceUrl)
            sourceMangaId = scrapeResolved.manga.sourceMangaId
            mangaUrl = scrapeResolved.manga.url
            matchedBy = "scrape"
        } catch {
            return undefined
        }
    }

    const canonicalId = `${sourceId}:manga:${sourceMangaId}`
    let canonicalChapters: ChapterRecord[] = []
    try {
        canonicalChapters = await listChaptersBySource(sourceId, sourceMangaId, mangaUrl)
    } catch {
        canonicalChapters = []
    }
    if (canonicalChapters.length === 0 && scrapeResolved) canonicalChapters = [scrapeResolved.chapter]

    let canonicalTitle: string
    let canonicalCoverUrl: string | undefined
    if (scrapeResolved) {
        // A successful scrape already carries the real title/cover - use them.
        canonicalTitle = scrapeResolved.manga.manga.title
        canonicalCoverUrl = scrapeResolved.manga.manga.coverUrl
    } else {
        // parseMangaUrl gives no title/cover (by design - it's network-free), so
        // derive a readable placeholder the same way trackExternalChapter's own
        // from-scratch manga creation does, and best-effort fetch a real cover.
        canonicalTitle = humanizeSlug(sourceMangaId) || sourceMangaId
        canonicalCoverUrl = await resolveCoverFor({ sourceId, sourceMangaId, mangaUrl }).catch(() => undefined)
    }

    const records: CleanupCandidateRecord[] = [
        {
            mangaId: m.id,
            title: m.title,
            sourceUrl: m.sourceUrl,
            matchedChapterNumbers: await matchedChapterNumbersFor(m.id),
            matchedBy
        }
    ]

    for (const o of siblings) {
        if (grouped.has(o.id)) continue
        const oPathname = pathnameOf(o.sourceUrl)
        // Reject trivial/empty pathnames so e.g. two candidates that both stored "/"
        // never spuriously match each other.
        if (!oPathname || oPathname.length <= 2) continue
        const hit = canonicalChapters.some(c => pathnameOf(c.url) === oPathname)
        if (!hit) continue
        grouped.add(o.id)
        records.push({
            mangaId: o.id,
            title: o.title,
            sourceUrl: o.sourceUrl,
            matchedChapterNumbers: await matchedChapterNumbersFor(o.id),
            matchedBy: "pathname"
        })
    }

    const overflowCount = Math.max(0, records.length - CLEANUP_GROUP_RECORDS_CAP)
    const cappedRecords = records.slice(0, CLEANUP_GROUP_RECORDS_CAP)
    const inLibrary = (await db.manga.get(canonicalId)) !== undefined

    return {
        canonicalId,
        canonicalTitle,
        ...(canonicalCoverUrl ? { canonicalCoverUrl } : {}),
        sourceId,
        sourceMangaId,
        mangaUrl,
        representativeChapterUrl: m.sourceUrl,
        inLibrary,
        selfHeal: records.length === 1 && records[0]!.mangaId === canonicalId,
        records: cappedRecords,
        ...(overflowCount > 0 ? { overflowCount } : {})
    }
}

// Only one apply run at a time - mirrors updates-sources.ts's updateCheckRunning /
// genreBackfillRunning module-scope guard pattern. This mutates and deletes real
// library rows, so two overlapping applies racing on the same groups is worth
// blocking outright rather than trying to make them safely interleave.
let cleanupApplyRunning = false

export const libraryHandlers: HandlerMap = {
    "library:list": async () => {
        const rows = await db.manga.orderBy("updatedAt").reverse().toArray()
        // ARCH TRACK A: keep the best-version pool's own-source rows in step with the library.
        // Fire-and-forget so the list response is never blocked; the pool is a cache the ranker
        // reads later, and a first-call miss is a tolerated cold-start gap.
        void ensureOwnSourceVersions(rows).catch(() => {})
        return rows
    },

    "library:get": async request => {
        return (await db.manga.get(request.mangaId)) ?? null
    },

    // Quick-add a Discover suggestion straight into the library without a source, so the user
    // can log what they've already read / plan to read. This feeds the recommendation engine
    // (owned titles are excluded from future suggestions and their genres shape the profile).
    // "read" marks it completed (synthetic 1/1 so reading-status derives "completed" - same
    // shape as an AniList completed import); "planning" sets the planning override. Manual
    // (no scanning); deduped by the anilist-scoped id via addImportedManga.
    "library:quick-add": async request => {
        const now = Date.now()
        const base: LibraryManga = {
            id: `anilist:manga:${request.anilistId}`,
            title: request.title,
            normalizedTitle: normalizeTitle(request.title),
            authors: [],
            status: request.mode === "read" ? "completed" : "unknown",
            addedAt: now,
            updatedAt: now,
            anilistId: request.anilistId,
            sourceId: "anilist.co",
            sourceUrl: `https://anilist.co/manga/${request.anilistId}`,
            manualTracking: true,
            ...(request.coverUrl ? { coverUrl: request.coverUrl } : {}),
            ...(request.genres && request.genres.length > 0 ? { genres: request.genres } : {}),
            ...(request.mode === "read"
                ? { latestChapterNumber: 1, lastReadChapterNumber: 1, latestChapterAt: now, lastReadAt: now }
                : { readingStatus: "planning", readingStatusUpdatedAt: now })
        }
        const { imported } = await addImportedManga([base])
        return { added: imported > 0 }
    },

    // Add a series to the library in an UNREAD state from a search result's series-level
    // info. Works for every source (unlike page:capture, which needs a capturable CHAPTER
    // URL a search result doesn't carry). Deduped by the stable source-scoped id; a title
    // already present is a no-op that reports added:false rather than a duplicate.
    "library:add": async request => {
        const mangaId = `${request.sourceId}:manga:${request.sourceMangaId}`
        if (await db.manga.get(mangaId)) return { added: false, mangaId }

        const now = Date.now()
        const manga: MangaRecord = {
            id: mangaId,
            title: request.title,
            normalizedTitle: request.title.toLocaleLowerCase("en"),
            ...(request.coverUrl ? { coverUrl: request.coverUrl } : {}),
            authors: [],
            status: "unknown",
            addedAt: now,
            updatedAt: now
        }
        const sourceLink: SourceLinkRecord = {
            mangaId,
            sourceId: request.sourceId,
            sourceMangaId: request.sourceMangaId,
            url: request.mangaUrl,
            title: request.title,
            addedAt: now,
            updatedAt: now
        }

        // Best-effort: pull the series' chapter list so the unread count is right the moment
        // the title lands. A failure (offline / anti-scrape / CF-gated source) must NOT fail
        // the add - the record is still created and the background update check backfills
        // chapters + latestChapterNumber later.
        let chapters: ChapterRecord[] = []
        try {
            chapters = await listChaptersBySource(request.sourceId, request.sourceMangaId, request.mangaUrl)
        } catch {
            chapters = []
        }

        if (chapters.length > 0) {
            // saveResolvedChapter is the DB layer's manga + link + chapters writer. The
            // representative (latest numbered chapter, else the first) only sets the manga's
            // latest-chapter fields - it writes NO progress row, so the title lands unread,
            // and latestChapterNumber is set from the max finite sortKey.
            const numbered = chapters.filter(c => Number.isFinite(c.sortKey))
            const representative =
                numbered.length > 0 ? numbered.reduce((max, c) => (c.sortKey > max.sortKey ? c : max)) : chapters[0]!
            await saveResolvedChapter({ manga, chapter: representative, sourceLink, chapters })
        } else {
            // No chapters resolved - still create the record (manga + link) unread. No DB
            // primitive writes a manga+link with no chapter, so drive saveResolvedChapter
            // with a throwaway representative and an empty chapters list (nothing is written
            // to db.chapters), then clear the dangling latest-chapter id it stamps from that
            // placeholder. An UNNUMBERED sortKey keeps latestChapterNumber unset.
            const placeholder: ChapterRecord = {
                id: `${mangaId}:pending`,
                mangaId,
                sourceId: request.sourceId,
                title: request.title,
                url: request.mangaUrl,
                sortKey: UNNUMBERED_SORT_KEY
            }
            await saveResolvedChapter({ manga, chapter: placeholder, sourceLink, chapters: [] })
            await updateManga(mangaId, {
                latestChapterId: undefined,
                sourceUrl: request.mangaUrl
            } as unknown as Partial<LibraryManga>)
        }

        // Best-effort cover cache so the cover renders from the extension origin (some CDNs
        // refuse a service-worker fetch of a hotlinked <img>). Never fails the add.
        if (request.coverUrl) {
            try {
                const blob = await fetchCoverBlob(request.coverUrl)
                if (blob) await cacheCover(mangaId, blob)
            } catch {
                // best-effort; covers:backfill retries later
            }
        }

        return { added: true, mangaId }
    },

    "library:remove": async request => {
        // Capture the AniList id before the record is gone, then mirror the removal to
        // AniList (no-op unless membership sync is on). Fire-and-forget so a slow/failed
        // AniList call never blocks or fails the local removal.
        const existing = await db.manga.get(request.mangaId)
        await removeManga(request.mangaId)
        void removeFromAniList(existing?.anilistId)
        // Parked until the next account sync pushes it as a tombstone (no-op when unlinked).
        void recordTombstone(request.mangaId)
        return null
    },

    "library:clear": async () => {
        // Safety-net snapshot before the fully destructive wipe - matches the
        // data:import / sync:pull pattern (see handlers/data-sync-settings.ts) so a
        // library clear is undoable via data:backup:restore like any other
        // destructive path.
        await createBackup("pre-clear")
        await clearLibrary()
        return null
    },

    "library:clear-history": async () => {
        await clearHistory()
        return null
    },

    "library:rate": async request => {
        const rating = request.rating === 0 ? undefined : request.rating
        // Stamp updatedAt so this edit is picked up by the account-sync push (it selects rows
        // by updatedAt > lastPushAt); without it a rating set on one device never crosses.
        await updateManga(request.mangaId, { rating, updatedAt: Date.now() } as Partial<LibraryManga>)
        return null
    },

    "library:manual": async request => {
        await updateManga(request.mangaId, {
            manualTracking: request.manual ? true : undefined,
            updatedAt: Date.now()
        } as Partial<LibraryManga>)
        return null
    },

    "library:hold": async request => {
        await updateManga(request.mangaId, {
            onHold: request.onHold ? true : undefined,
            updatedAt: Date.now()
        } as Partial<LibraryManga>)
        return null
    },

    // Manual reading-status override for the non-derivable states (paused/dropped/
    // planning). null clears it, restoring the derived reading/completed/unread status.
    "library:status": async request => {
        // Stamp the change time so bidirectional AniList status sync can last-writer-wins
        // against the remote entry's updatedAt, and so the account-sync push selects the row.
        const now = Date.now()
        await updateManga(request.mangaId, {
            readingStatus: request.status ?? undefined,
            readingStatusUpdatedAt: now,
            updatedAt: now
        } as Partial<LibraryManga>)
        return null
    },

    "library:dismiss": async request => {
        // Clear the hostname-style sourceId that flags this as a broken import
        // so it no longer appears in the reconcile panel.
        const target = await db.manga.get(request.mangaId)
        if (target && target.sourceId.includes(".")) {
            await updateManga(request.mangaId, {
                sourceId: "manual",
                manualTracking: true
            } as Partial<LibraryManga>)
        }
        return null
    },

    "library:merge": async request => {
        // Merge deletes the loser titles' manga rows, source links and chapters with no undo,
        // and the duplicate grouping can union two DISTINCT series that share a title. Snapshot
        // first (like library:clear / cleanup:apply) so a wrong merge is recoverable from Data.
        await createBackup("pre-merge")
        return mergeMangaRecords(request.primaryId, request.loserIds)
    },

    // Read-only: no db.manga/db.chapters/etc writes, only reads plus network GETs for
    // resolution (adapter.parseMangaUrl is network-free; the scrape fallback and
    // listChaptersBySource are network reads that never persist anything here).
    "library:cleanup:scan": async () => {
        const allManga = await db.manga.toArray()
        // Broadest possible candidate set first (per the spec's grouping-optimization
        // note): missing sourceMangaId, not a seed, not manually tracked. This is
        // wider than isFallbackCreated (which also requires a currently-registered
        // source) so a candidate whose source is retired/unregistered still gets
        // listed under `unresolved` instead of silently vanishing from the scan.
        const broadCandidates = allManga.filter(
            m => m.sourceMangaId === undefined && !m.id.startsWith("seed-") && !m.manualTracking
        )

        const unresolved: CleanupUnresolved[] = []
        const resolvable: LibraryManga[] = []
        for (const m of broadCandidates) {
            const adapter = sourceRegistry.get(m.sourceId)
            if (!adapter) {
                unresolved.push({
                    mangaId: m.id,
                    title: m.title,
                    sourceId: m.sourceId,
                    sourceUrl: m.sourceUrl,
                    reason: "Source is not currently registered"
                })
                continue
            }
            let url: URL
            try {
                url = new URL(m.sourceUrl)
            } catch {
                unresolved.push({
                    mangaId: m.id,
                    title: m.title,
                    sourceId: m.sourceId,
                    sourceUrl: m.sourceUrl,
                    reason: "Stored URL is invalid"
                })
                continue
            }
            if (adapter.match(url) !== "chapter") {
                unresolved.push({
                    mangaId: m.id,
                    title: m.title,
                    sourceId: m.sourceId,
                    sourceUrl: m.sourceUrl,
                    reason: "URL is no longer recognized as a chapter by this source"
                })
                continue
            }
            resolvable.push(m)
        }

        // Per-sourceId strictly serial, up to 4 different sources resolving
        // concurrently - same worker-pool shape as library:covers:backfill above.
        const groups: CleanupGroup[] = []
        const bySource = Map.groupBy(resolvable, m => m.sourceId)
        const queue = [...bySource.entries()]
        await Promise.all(
            Array.from({ length: Math.min(4, queue.length) }, async () => {
                for (let entry = queue.shift(); entry; entry = queue.shift()) {
                    const [sourceId, mangas] = entry
                    const grouped = new Set<string>()
                    for (const m of mangas) {
                        if (grouped.has(m.id)) continue
                        grouped.add(m.id)
                        const group = await resolveGroupFor(m, mangas, grouped, sourceId)
                        if (group) {
                            groups.push(group)
                        } else {
                            unresolved.push({
                                mangaId: m.id,
                                title: m.title,
                                sourceId,
                                sourceUrl: m.sourceUrl,
                                reason: "Could not resolve this manga (network or parsing failure)"
                            })
                        }
                    }
                }
            })
        )

        return { groups, unresolved, candidateCount: resolvable.length } satisfies CleanupScanResult
    },

    "library:cleanup:apply": async request => {
        if (cleanupApplyRunning) {
            throw new SourceError("invalid-input", "A cleanup apply is already running")
        }
        cleanupApplyRunning = true
        try {
            // Backup first, once per apply call (not per group) - required, not
            // best-effort: if this throws, nothing below runs.
            const backupId = await createBackup("pre-cleanup")

            let merged = 0
            let groupsApplied = 0
            let enriched = 0
            let skippedStale = 0
            let skippedUnverified = 0
            const failed: Array<{ canonicalId: string; reason: string }> = []

            for (const group of request.groups) {
                try {
                    // 0. Snapshot whether the canonical record exists before this group's
                    // (possibly slow) network resolution phase starts below - the request
                    // wire shape (see the library:cleanup:apply zod schema in runtime.ts)
                    // doesn't carry the scan-time CleanupGroup.inLibrary flag, so this is
                    // the earliest available signal for telling a concurrent library:remove
                    // during that phase apart from the normal "no canonical yet, this
                    // group creates it" case. Re-checked fresh inside the write transaction
                    // below, since a check done out here is still racy on its own.
                    const existedAtStart = (await db.manga.get(group.canonicalId)) !== undefined

                    // 1. Re-validate every loser still exists and still qualifies -
                    // someone may have fixed it manually, or a concurrent operation
                    // touched it, since the scan ran.
                    const validated: Array<{ mangaId: string; matchedBy: CleanupMatchedBy }> = []
                    for (const loser of group.losers) {
                        if (loser.mangaId === group.canonicalId) continue
                        const rec = await db.manga.get(loser.mangaId)
                        if (!rec || !isFallbackCreated(rec)) {
                            skippedStale += 1
                            continue
                        }
                        validated.push(loser)
                    }

                    // 2. Re-resolve the representative via the SAME adapter the record
                    // claims (sourceRegistry.get(group.sourceId), never a registry-wide
                    // match() lookup, which could silently pick a different adapter).
                    const adapter = sourceRegistry.get(group.sourceId)
                    if (!adapter) {
                        failed.push({ canonicalId: group.canonicalId, reason: "Source is not currently registered" })
                        continue
                    }
                    let repUrl: URL
                    try {
                        repUrl = new URL(group.representativeChapterUrl)
                    } catch {
                        failed.push({ canonicalId: group.canonicalId, reason: "stale-resolution" })
                        continue
                    }

                    let sourceMangaId: string
                    let mangaUrl: string
                    let scrapeResolved: Awaited<ReturnType<typeof resolveChapterUrl>> | undefined
                    const parsed = adapter.parseMangaUrl?.(repUrl) ?? null
                    if (parsed) {
                        sourceMangaId = parsed.sourceMangaId
                        mangaUrl = parsed.mangaUrl
                    } else {
                        try {
                            scrapeResolved = await resolveChapterUrl(group.representativeChapterUrl)
                            sourceMangaId = scrapeResolved.manga.sourceMangaId
                            mangaUrl = scrapeResolved.manga.url
                        } catch (error) {
                            failed.push({
                                canonicalId: group.canonicalId,
                                reason: error instanceof Error ? error.message : "Could not re-resolve this manga"
                            })
                            continue
                        }
                    }

                    // Cross-check: a slug drift between scan and apply (or an adapter
                    // whose match()/id scheme changed) means the whole group is stale -
                    // skip it entirely rather than partially applying it.
                    const freshCanonicalId = `${group.sourceId}:manga:${sourceMangaId}`
                    if (freshCanonicalId !== group.canonicalId) {
                        failed.push({ canonicalId: group.canonicalId, reason: "stale-resolution" })
                        continue
                    }

                    // 4. Fetch the canonical chapter list fresh (manga-page-only, never
                    // bulkPut here - saveResolvedChapter's own transaction does that).
                    let canonicalChapters: ChapterRecord[] = []
                    try {
                        canonicalChapters = await listChaptersBySource(group.sourceId, sourceMangaId, mangaUrl)
                    } catch {
                        canonicalChapters = []
                    }
                    if (canonicalChapters.length === 0 && scrapeResolved) canonicalChapters = [scrapeResolved.chapter]
                    const representativeChapter = canonicalChapters.reduce<ChapterRecord | undefined>(
                        (max, c) => (!max || c.sortKey > max.sortKey ? c : max),
                        undefined
                    )
                    if (!representativeChapter) {
                        failed.push({
                            canonicalId: group.canonicalId,
                            reason: "No chapters could be resolved for this manga"
                        })
                        continue
                    }

                    // 5. Verify pathname/scrape-tagged losers against the fresh list -
                    // "adapter"-tagged losers are a deterministic, network-free parse of
                    // their own stored URL and are trusted without re-verification.
                    const verifiedLoserIds: string[] = []
                    for (const loser of validated) {
                        if (loser.matchedBy === "pathname") {
                            const rec = await db.manga.get(loser.mangaId)
                            const p = rec ? pathnameOf(rec.sourceUrl) : null
                            const ok = p !== null && canonicalChapters.some(c => pathnameOf(c.url) === p)
                            if (!ok) {
                                skippedUnverified += 1
                                continue
                            }
                            verifiedLoserIds.push(loser.mangaId)
                        } else if (loser.matchedBy === "scrape") {
                            // Scrape-resolved losers were each individually resolved, not
                            // group-inferred - re-run their OWN resolution rather than
                            // trusting stale scan data, since scrape resolution can be
                            // flaky/inconsistent between runs.
                            const rec = await db.manga.get(loser.mangaId)
                            if (!rec) {
                                skippedUnverified += 1
                                continue
                            }
                            try {
                                const reconfirmed = await resolveChapterUrl(rec.sourceUrl)
                                if (reconfirmed.manga.manga.id !== group.canonicalId) {
                                    skippedUnverified += 1
                                    continue
                                }
                            } catch {
                                skippedUnverified += 1
                                continue
                            }
                            verifiedLoserIds.push(loser.mangaId)
                        } else {
                            verifiedLoserIds.push(loser.mangaId)
                        }
                    }

                    // 3. Build the canonical manga record - create or enrich-in-place.
                    // saveResolvedChapter's existing merge-safe field behavior makes the
                    // same call correct for both cases. The actual create/enrich write
                    // happens below, inside the transaction, with a fresh existence
                    // re-check - not here.
                    let title: string
                    let coverUrl: string | undefined
                    if (scrapeResolved) {
                        title = scrapeResolved.manga.manga.title
                        coverUrl = scrapeResolved.manga.manga.coverUrl
                    } else {
                        title = humanizeSlug(sourceMangaId) || sourceMangaId
                        coverUrl = await resolveCoverFor({
                            sourceId: group.sourceId,
                            sourceMangaId,
                            mangaUrl
                        }).catch(() => undefined)
                    }
                    const now = Date.now()
                    const mangaRecord: MangaRecord = {
                        id: group.canonicalId,
                        title,
                        normalizedTitle: title.toLocaleLowerCase("en"),
                        ...(coverUrl ? { coverUrl } : {}),
                        authors: [],
                        status: "unknown",
                        addedAt: now,
                        updatedAt: now
                    }

                    // 6+7+8: create/enrich the canonical record, then remap + merge + the
                    // dangling-id fixup, all inside ONE transaction - with existence
                    // re-checks done FRESH inside it, which is what actually closes the
                    // create/enrich resurrection race (a re-check outside a transaction is
                    // still racy): a concurrent library:remove on the canonical id (or on a
                    // loser) during the network phase above must stick, not get silently
                    // undone by saveResolvedChapter's unconditional put or by the merge.
                    // saveResolvedChapter and applyCleanupGroup are both pure-IDB, safe to
                    // run inside a Dexie transaction.
                    const applied = await db.transaction(
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
                            const canonicalExists = (await db.manga.get(group.canonicalId)) !== undefined
                            // The canonical existed when this group's resolution started but
                            // is gone now - a concurrent library:remove raced the network
                            // phase above. Respect it; don't resurrect the record
                            // saveResolvedChapter would otherwise unconditionally recreate.
                            if (existedAtStart && !canonicalExists) return null
                            // Re-check losers inside the transaction too - a concurrent
                            // removal during the network phase above must stick.
                            const liveLoserIds: string[] = []
                            for (const id of verifiedLoserIds) {
                                if (await db.manga.get(id)) liveLoserIds.push(id)
                            }
                            // Nothing left of this group at all - creating the canonical now
                            // would resurrect a removal rather than legitimately create a new
                            // record from scratch.
                            if (!canonicalExists && liveLoserIds.length === 0) return null
                            await saveResolvedChapter({
                                manga: mangaRecord,
                                chapter: representativeChapter,
                                sourceLink: {
                                    mangaId: group.canonicalId,
                                    sourceId: group.sourceId,
                                    sourceMangaId,
                                    url: mangaUrl,
                                    title,
                                    addedAt: now,
                                    updatedAt: now
                                },
                                chapters: canonicalChapters
                            })
                            let mergedCount = 0
                            if (liveLoserIds.length > 0) {
                                await applyCleanupGroup(group.canonicalId, liveLoserIds, canonicalChapters)
                                mergedCount = liveLoserIds.length
                            }
                            return { mergedCount, existedBefore: canonicalExists }
                        }
                    )
                    if (applied === null) {
                        skippedStale += 1
                        continue
                    }
                    merged += applied.mergedCount
                    groupsApplied += 1
                    if (applied.existedBefore) enriched += 1

                    // Best-effort cover cache, mirroring capture.ts's successful-capture
                    // path - a cover failure must never fail the whole group. Network call,
                    // so it must run outside the Dexie transaction above.
                    if (coverUrl) {
                        try {
                            const blob = await fetchCoverBlob(coverUrl)
                            if (blob) await cacheCover(group.canonicalId, blob)
                        } catch (error) {
                            console.warn("[AMR] Cleanup cover cache failed", {
                                canonicalId: group.canonicalId,
                                error
                            })
                        }
                    }
                } catch (error) {
                    failed.push({
                        canonicalId: group.canonicalId,
                        reason: error instanceof Error ? error.message : "Unknown error"
                    })
                }
            }

            return {
                merged,
                groups: groupsApplied,
                enriched,
                skippedStale,
                skippedUnverified,
                failed,
                backupId
            } satisfies CleanupApplyResponse
        } finally {
            cleanupApplyRunning = false
        }
    },

    "library:numbers": async request => {
        const patch: Record<string, number | string | undefined> = {}
        if (request.latestChapterNumber !== undefined)
            patch["latestChapterNumber"] = request.latestChapterNumber ?? undefined
        if (request.lastReadChapterNumber !== undefined)
            patch["lastReadChapterNumber"] = request.lastReadChapterNumber ?? undefined
        if (request.lastReadChapterId !== undefined) patch["lastReadChapterId"] = request.lastReadChapterId ?? undefined
        // Advancing the read position (e.g. bulk "Mark caught up") must behave like actually
        // reading: refresh lastReadAt so the inactivity auto-pause clock resets, and clear a
        // stored paused/dropped override so a caught-up title doesn't stay stuck On Hold. Mirrors
        // saveProgress's clearOverride/lastReadAt on a forward read.
        const advancingRead = request.lastReadChapterId !== undefined || request.lastReadChapterNumber !== undefined
        if (advancingRead) {
            patch["lastReadAt"] = Date.now()
            const existing = await db.manga.get(request.mangaId)
            if (existing?.readingStatus === "paused" || existing?.readingStatus === "dropped") {
                patch["readingStatus"] = undefined
            }
        }
        if (Object.keys(patch).length > 0) {
            patch["updatedAt"] = Date.now()
            await updateManga(request.mangaId, patch as Partial<LibraryManga>)
        }
        return null
    },

    "library:categories": async request => {
        const categories = [...new Set(request.categories.map(c => c.trim()).filter(Boolean))]
        await updateManga(request.mangaId, {
            categories: categories.length > 0 ? categories : undefined,
            updatedAt: Date.now()
        } as Partial<LibraryManga>)
        return null
    },

    "library:relink": async request => {
        const resolved = await resolveChapterUrl(request.url)
        const existing = await db.manga.get(request.mangaId)
        if (!existing) throw new SourceError("not-found", "That title is not in your library")
        const newId = resolved.manga.manga.id
        const now = Date.now()
        const relinkCover = existing.coverUrl ?? resolved.manga.manga.coverUrl
        const next: LibraryManga = {
            // Start from resolved manga (correct source fields)
            ...resolved.manga.manga,
            id: newId,
            sourceId: resolved.manga.sourceId,
            ...(resolved.manga.sourceMangaId ? { sourceMangaId: resolved.manga.sourceMangaId } : {}),
            sourceUrl: resolved.chapter.url,
            mangaUrl: resolved.manga.url,
            // Preserve user data from the existing record
            title: existing.title || resolved.manga.manga.title,
            ...(relinkCover ? { coverUrl: relinkCover } : {}),
            addedAt: existing.addedAt,
            ...(existing.lastReadChapterId ? { lastReadChapterId: existing.lastReadChapterId } : {}),
            ...(existing.lastReadChapterNumber !== undefined
                ? { lastReadChapterNumber: existing.lastReadChapterNumber }
                : {}),
            ...(existing.lastReadAt !== undefined ? { lastReadAt: existing.lastReadAt } : {}),
            ...(existing.rating !== undefined ? { rating: existing.rating } : {}),
            ...(existing.categories !== undefined ? { categories: existing.categories } : {}),
            ...(existing.notes !== undefined ? { notes: existing.notes } : {}),
            ...(existing.nsfw !== undefined ? { nsfw: existing.nsfw } : {}),
            ...(existing.manualTracking !== undefined ? { manualTracking: existing.manualTracking } : {}),
            ...(existing.onHold !== undefined ? { onHold: existing.onHold } : {}),
            ...(existing.readingDirection !== undefined ? { readingDirection: existing.readingDirection } : {}),
            ...(existing.pageFit !== undefined ? { pageFit: existing.pageFit } : {}),
            ...(existing.noGapContinuous !== undefined ? { noGapContinuous: existing.noGapContinuous } : {}),
            ...(existing.continuousScroll !== undefined ? { continuousScroll: existing.continuousScroll } : {}),
            ...(existing.readerTheme !== undefined ? { readerTheme: existing.readerTheme } : {}),
            // pageWidthPct is a per-series reader override like pageFit/noGapContinuous above and must
            // survive relink too; anilistId/genres/metadataUpdatedAt keep AniList linkage + Discover
            // seeding (the resolved source record can't carry them, same as saveResolvedChapter);
            // readingStatus(+UpdatedAt) and workId are user/server state that must not reset.
            ...(existing.pageWidthPct !== undefined ? { pageWidthPct: existing.pageWidthPct } : {}),
            ...(existing.anilistId !== undefined ? { anilistId: existing.anilistId } : {}),
            ...(existing.genres !== undefined ? { genres: existing.genres } : {}),
            ...(existing.metadataUpdatedAt !== undefined ? { metadataUpdatedAt: existing.metadataUpdatedAt } : {}),
            ...(existing.readingStatus !== undefined ? { readingStatus: existing.readingStatus } : {}),
            ...(existing.readingStatusUpdatedAt !== undefined
                ? { readingStatusUpdatedAt: existing.readingStatusUpdatedAt }
                : {}),
            ...(existing.workId !== undefined ? { workId: existing.workId } : {}),
            updatedAt: now
        }
        const newSourceLink: SourceLinkRecord = {
            mangaId: newId,
            sourceId: resolved.manga.sourceId,
            ...(resolved.manga.sourceMangaId ? { sourceMangaId: resolved.manga.sourceMangaId } : {}),
            url: resolved.manga.url,
            title: next.title,
            addedAt: now,
            updatedAt: now
        }
        await relinkMangaWithChapter(request.mangaId, next, newSourceLink, resolved.chapter)
        // Fire-and-forget: populate the chapter list for the new source
        const relinkSource = findSource(new URL(request.url))
        scheduleChapterListRefresh(relinkSource, resolved.manga.sourceMangaId, resolved.manga.url, newId)
        return { sourceId: resolved.manga.sourceId, mangaId: newId }
    },

    "library:link-url": async request => {
        // Link a library entry to a manga page URL without fetching it.
        // Used for CF-gated sources that can't appear in reconcile search
        // but whose chapters work via the tab-render fallback.
        const existing = await db.manga.get(request.mangaId)
        if (!existing) throw new SourceError("not-found", "That title is not in your library")
        const url = new URL(request.mangaUrl)
        const adapter = findSource(url)
        if (!adapter || adapter.match(url) !== "manga")
            throw new SourceError(
                "unsupported-url",
                "That URL is not a recognized manga page - make sure it's the series page, not a chapter"
            )
        // Delegate ID extraction to the adapter - handles MangaDex-style URLs
        // where the last segment is an SEO slug, not the internal ID.
        // Fallback to last path segment for CF-gated adapters that reject direct fetches.
        let sourceMangaId: string
        try {
            sourceMangaId = await resolveMangaUrl(url)
        } catch {
            const segs = url.pathname.split("/").filter(Boolean)
            sourceMangaId = segs[segs.length - 1] ?? ""
        }
        if (!sourceMangaId) throw new SourceError("invalid-input", "Could not extract manga ID from that URL")
        const sourceId = adapter.manifest.id
        await linkMangaToUrl(
            request.mangaId,
            {
                sourceId,
                sourceMangaId,
                mangaUrl: request.mangaUrl,
                manualTracking: false,
                updatedAt: Date.now()
            } as Partial<LibraryManga>,
            {
                mangaId: request.mangaId,
                sourceId,
                sourceMangaId,
                url: request.mangaUrl,
                title: existing.title,
                addedAt: existing.addedAt,
                updatedAt: Date.now()
            }
        )
        // Fire-and-forget chapter fetch so chapters appear immediately
        // after linking rather than waiting for the next update alarm.
        void (async () => {
            try {
                const linked = await db.manga.get(request.mangaId)
                if (!linked) return
                const chapters = await listChaptersForSource(linked, sourceId, sourceMangaId, request.mangaUrl)
                if (chapters.length === 0) return
                // Prefer the highest NUMBERED chapter so an unnumbered chapter
                // (sortKey === UNNUMBERED_SORT_KEY / Infinity) can't win the pick and
                // leave latestChapterId/sourceUrl pointing at it while the finite-guarded
                // latestChapterNumber stays unset. Fall back to the raw reduce only when
                // nothing is numbered.
                const latest =
                    latestNumberedChapter(chapters) ??
                    chapters.reduce((cur, ch) => (ch.sortKey > (cur?.sortKey ?? -1) ? ch : cur), chapters[0])
                await saveLinkedChapters(
                    request.mangaId,
                    chapters,
                    latest
                        ? ({
                              latestChapterId: latest.id,
                              sourceUrl: latest.url,
                              ...(Number.isFinite(latest.sortKey) ? { latestChapterNumber: latest.sortKey } : {}),
                              updatedAt: Date.now()
                          } as Partial<LibraryManga>)
                        : undefined
                )
                publishLive(["chapters", "library"], [request.mangaId])
            } catch {
                // best-effort; update alarm will retry
            }
        })()
        return { sourceId }
    },

    "library:switch": async request => {
        const existing = await db.manga.get(request.mangaId)
        if (!existing) throw new SourceError("not-found", "That title is not in your library")
        // Bounded tighter than the default (~15s timeout x 2 retries, ~46s worst
        // case) because the reconcile "Search all" sweep can try up to 3 candidates
        // sequentially per title with no outer race - one hanging candidate at the
        // default budget would blow the whole sweep's time estimate by itself.
        // Worst case here: ~10s + one retry with ~300-600ms backoff.
        let chapters: ChapterRecord[]
        try {
            chapters = await listChaptersForSource(
                existing,
                request.sourceId,
                request.sourceMangaId,
                request.mangaUrl,
                {
                    timeoutMs: 10_000,
                    maxRetries: 1
                }
            )
        } catch (cause) {
            // Only the manual per-mirror Switch button opts into the tab-render
            // fallback (allowTabFallback) - the auto-link sweep never opens a tab, it
            // just fails this candidate and moves to the next ranked one. And only a
            // bot-block-shaped rejection (e.g. kagane's Cloudflare-gated series page)
            // is worth the ~25s tab cost; any other failure (timeout, invalid-response,
            // etc.) rethrows exactly as before.
            if (!request.allowTabFallback || !isBotBlocked(cause)) throw cause
            const html = await fetchChapterHtmlViaTab(request.mangaUrl)
            chapters = await listChaptersFromSourceHtml(
                existing,
                request.sourceId,
                request.sourceMangaId,
                request.mangaUrl,
                html
            )
        }
        const switchAdapter = sourceRegistry.get(request.sourceId)
        const hasPages = switchAdapter?.manifest.capabilities.includes("pages") ?? true
        if (chapters.length === 0 && hasPages) throw new SourceError("invalid-response", "No chapters on that mirror")
        // Prefer the highest NUMBERED chapter so an unnumbered chapter (sortKey ===
        // UNNUMBERED_SORT_KEY / Infinity) can't win the pick and leave latestChapterId/
        // sourceUrl pointing at it while the finite-guarded latestChapterNumber stays
        // unset. Fall back to the raw reduce only when nothing is numbered.
        const latest =
            latestNumberedChapter(chapters) ??
            chapters.reduce(
                (current, chapter) => (chapter.sortKey > (current?.sortKey ?? -1) ? chapter : current),
                chapters[0]
            )
        // MangaHub numbers chapters by its own internal sequential URL slug
        // (chapter-N), which can diverge from the numbering other sources use for
        // the same manga. This handler never touches the existing
        // lastReadChapterNumber, so after switching TO mangahub from a different
        // source it sits next to mangahub's latestChapterNumber with nothing
        // indicating the two may not be directly comparable. Flag it so a future
        // UI can warn instead of silently comparing chapter counts that don't mean
        // what they look like they mean.
        const numberingMayMismatch =
            request.sourceId === "mangahub" &&
            existing.sourceId !== "mangahub" &&
            existing.lastReadChapterNumber !== undefined
        // The old lastReadChapterId points at a chapter row that switchMangaSource is
        // about to delete. Re-point it at the equivalent chapter in the new mirror by
        // the source-independent read number, so a caught-up title stays caught up
        // instead of resetting to unread. Skipped when the numbering may not be
        // comparable across the two mirrors (mangahub).
        const remappedReadChapterId = numberingMayMismatch
            ? undefined
            : matchReadChapterId(chapters, existing.lastReadChapterNumber)
        // When the read number was never known (a numberless import that preserved only
        // the last-read chapter URL), recover position by matching that URL against the
        // new mirror's chapters - the trailing chapter id (uuid/ulid/numeric) is stable
        // across a same-source re-fetch. Recovers both the id and, when the matched
        // chapter is numbered, the read number itself.
        const recoveredReadChapter =
            !remappedReadChapterId && existing.lastReadChapterNumber === undefined && existing.lastReadChapterId
                ? matchReadChapterByUrl(chapters, (await db.chapters.get(existing.lastReadChapterId))?.url)
                : undefined
        // The old lastReadChapterId points at a row switchMangaSource is about to delete.
        // When we couldn't remap OR recover it onto the new mirror (e.g. the new mirror's
        // lowest chapter is above the read position, or a mangahub switch skips the remap),
        // leaving it in place would dangle the id at a deleted row and break chapter:resume.
        // Explicitly clear it so it never points at a dead row - lastReadChapterNumber (the
        // source-independent read position) is deliberately left untouched.
        const clearDanglingReadId =
            existing.lastReadChapterId !== undefined && !remappedReadChapterId && !recoveredReadChapter
        // Old mirror's chapters are stale by definition after switching source -
        // switchMangaSource drops them (any row whose sourceId isn't the new one)
        // before writing the new mirror's, so chapter:siblings never interleaves
        // dead and live URLs in prev/next.
        await switchMangaSource({
            mangaId: request.mangaId,
            sourceId: request.sourceId,
            chapters,
            mangaPatch: {
                sourceId: request.sourceId,
                sourceMangaId: request.sourceMangaId,
                mangaUrl: request.mangaUrl,
                ...(remappedReadChapterId ? { lastReadChapterId: remappedReadChapterId } : {}),
                ...(recoveredReadChapter
                    ? {
                          lastReadChapterId: recoveredReadChapter.id,
                          ...(Number.isFinite(recoveredReadChapter.sortKey)
                              ? { lastReadChapterNumber: recoveredReadChapter.sortKey }
                              : {})
                      }
                    : {}),
                ...(clearDanglingReadId ? { lastReadChapterId: undefined } : {}),
                ...(latest
                    ? {
                          sourceUrl: latest.url,
                          latestChapterId: latest.id,
                          ...(Number.isFinite(latest.sortKey) ? { latestChapterNumber: latest.sortKey } : {})
                      }
                    : {}),
                updatedAt: Date.now()
            } as Partial<LibraryManga>,
            numberingUnreliable: numberingMayMismatch,
            sourceLink: {
                mangaId: request.mangaId,
                sourceId: request.sourceId,
                sourceMangaId: request.sourceMangaId,
                url: request.mangaUrl,
                title: existing.title,
                addedAt: existing.addedAt,
                updatedAt: Date.now()
            }
        })
        return { sourceId: request.sourceId, latest: latest?.sortKey ?? null }
    },

    "library:nsfw": async request => {
        await updateManga(request.mangaId, {
            nsfw: request.nsfw ? true : undefined,
            updatedAt: Date.now()
        } as Partial<LibraryManga>)
        return null
    },

    // Manual trigger for the metadata enrichment pass (genres, cover, publication status) over
    // every title that's missing them. Additive - only fills empty fields, never removes a title
    // or a user's own tags. Fire-and-forget: the pass is a long rate-limited loop, so we start it
    // and return rather than blocking the message.
    "library:metadata:backfill": async () => {
        void backfillMangaGenres()
        return { started: true }
    },

    "library:covers:backfill": async request => {
        // A targeted call (right after a relink) forces a retry of exactly one
        // manga id, bypassing the session-wide attempted-tracking exclusion below -
        // that's the whole point of the targeted path.
        const targeted = request.mangaId !== undefined
        let targets: LibraryManga[]
        if (targeted) {
            const target = await db.manga.get(request.mangaId as string)
            targets = target ? [target] : []
        } else {
            const all = await db.manga.toArray()
            // Candidates: titles with no cover, plus titles whose cover is still a
            // remote URL (which can fail to render from the extension origin, and may
            // not have a cached blob yet). seed- ids and already-attempted (this
            // session) ids are excluded so a failed fetch doesn't loop forever.
            const candidates = all.filter(
                m =>
                    !m.id.startsWith("seed-") &&
                    !coverBackfillAttempted.has(m.id) &&
                    (!m.coverUrl || /^https?:\/\//.test(m.coverUrl))
            )
            // One bulk lookup instead of a per-record covers.get - a remote coverUrl
            // that already has a cached blob doesn't need to be re-fetched.
            const cachedRows = await db.covers.bulkGet(candidates.map(m => m.id))
            const alreadyCachedIds = new Set(candidates.filter((_, i) => cachedRows[i] !== undefined).map(m => m.id))
            targets = candidates.filter(m => !(m.coverUrl && alreadyCachedIds.has(m.id)))
        }

        // Titles on different sources have no reason to block each other - each
        // source operation gets its own fresh rate-limited client, so cross-title
        // throttling isn't the bottleneck. Group by source and run up to 4 groups
        // concurrently, while keeping each group's own titles strictly serial (the
        // only per-source politeness mechanism that currently exists).
        const batch = targets.slice(0, COVER_BACKFILL_BATCH)
        const groups = Map.groupBy(batch, m => m.sourceId)
        const queue = [...groups.values()]
        let updated = 0
        await Promise.all(
            Array.from({ length: Math.min(4, queue.length) }, async () => {
                for (let group = queue.shift(); group; group = queue.shift()) {
                    for (const m of group) {
                        coverBackfillAttempted.add(m.id)
                        try {
                            const storedRemoteCover =
                                m.coverUrl && /^https?:\/\//.test(m.coverUrl) ? m.coverUrl : undefined

                            // Try cover sources in order of trust: the stored remote URL, then a
                            // fresh scrape from the source adapter, then the metadata catalog
                            // (AniList -> Jikan, by title). Stop at the first whose blob actually
                            // fetches. The metadata fallback is what recovers covers for dead or
                            // moved sources that can no longer be scraped - the previous version
                            // only ever tried the source, so those stayed blank forever.
                            let firstResolved: string | undefined
                            let chosen: string | undefined
                            let blob: Blob | undefined
                            let via = ""
                            const tryUrl = async (url: string | undefined, from: string) => {
                                if (!url || blob) return
                                firstResolved ??= url
                                const b = await fetchCoverBlob(url)
                                if (b) {
                                    chosen = url
                                    blob = b
                                    via = from
                                }
                            }

                            await tryUrl(storedRemoteCover, "stored")
                            if (!blob) await tryUrl(await resolveCoverFor(m).catch(() => undefined), "source")
                            if (!blob) {
                                const meta = await resolveMetadata({
                                    title: m.title,
                                    sourceId: m.sourceId,
                                    ...(m.sourceMangaId ? { sourceMangaId: m.sourceMangaId } : {})
                                }).catch(() => null)
                                await tryUrl(meta?.coverUrl, "metadata")
                            }

                            // Fall back to the first URL that at least resolved, so a hotlink can
                            // still render even when no blob was cacheable (e.g. a CDN that serves
                            // <img> but refuses a service-worker fetch).
                            const url = chosen ?? firstResolved
                            if (!url) {
                                diag.warn("cover-backfill", `no cover found for ${m.sourceId}`, { mangaId: m.id })
                                continue
                            }
                            let touched = false
                            if (m.coverUrl !== url) {
                                await updateManga(m.id, { coverUrl: url })
                                touched = true
                            }
                            if (blob) {
                                await cacheCover(m.id, blob)
                                touched = true
                            }
                            if (touched) {
                                updated += 1
                                diag.info("cover-backfill", `cover via ${via || "hotlink"} for ${m.sourceId}`, {
                                    mangaId: m.id
                                })
                            }
                        } catch (error) {
                            const message = error instanceof Error ? error.message : "cover backfill failed"
                            diag.warn("cover-backfill", `failed for ${m.sourceId}`, { mangaId: m.id, message })
                        }
                    }
                }
            })
        )
        const remaining = Math.max(0, targets.length - COVER_BACKFILL_BATCH)
        // A targeted call naturally has remaining: 0 after processing its one
        // target - don't let that trigger the full-pass "clear the attempted set"
        // logic below, or the same title could be retried forever within a session
        // via repeated targeted calls (exactly what that tracking exists to prevent).
        if (!targeted && remaining === 0) coverBackfillAttempted.clear()
        return { updated, remaining, total: targets.length }
    },

    "stats:get": async () => {
        return getLocalStats()
    },

    "history:list": async () => {
        const events = await db.historyEvents.orderBy("occurredAt").reverse().limit(60).toArray()
        const ids = [...new Set(events.map(e => e.mangaId))]
        const mangas = await db.manga.bulkGet(ids)
        const titleById = new Map(ids.map((id, i) => [id, mangas[i]?.title ?? id]))
        const chapterIds = [...new Set(events.map(e => e.chapterId).filter((c): c is string => Boolean(c)))]
        const chapters = await db.chapters.bulkGet(chapterIds)
        const chapterById = new Map(chapterIds.map((id, i) => [id, chapters[i]]))
        return events.map(e => {
            const chapter = e.chapterId ? chapterById.get(e.chapterId) : undefined
            return {
                mangaId: e.mangaId,
                title: titleById.get(e.mangaId) ?? e.mangaId,
                type: e.type,
                occurredAt: e.occurredAt,
                chapterNumber: chapter && Number.isFinite(chapter.sortKey) ? chapter.sortKey : null,
                chapterTitle: chapter?.title ?? null,
                chapterUrl: chapter?.url ?? null
            }
        })
    },

    "activity:get": async request => {
        return getActivityCalendar(request.days ?? 120)
    },

    // Which chapter to open when a title is launched from the library: resume at the
    // last-read chapter, else start at the first (lowest-numbered) chapter. Falls back to
    // sourceUrl (the latest chapter) only when nothing else is known - previously EVERY
    // open used sourceUrl, so "Continue reading" always jumped to the newest chapter.
    "chapter:resume": async request => {
        const manga = await db.manga.get(request.mangaId)
        if (!manga) return { url: undefined }
        if (manga.lastReadChapterId) {
            const ch = await db.chapters.get(manga.lastReadChapterId)
            if (ch?.url) return { url: ch.url }
        }
        const chapters = await db.chapters.where("mangaId").equals(request.mangaId).sortBy("sortKey")
        const numbered = chapters.filter(c => Number.isFinite(c.sortKey))
        const first = (numbered.length > 0 ? numbered : chapters)[0]
        return { url: first?.url ?? manga.sourceUrl }
    },

    "chapter:adjacent": async request => {
        const manga = await db.manga.get(request.mangaId)
        if (!manga) return { current: null, next: null, prev: null }
        const current = manga.lastReadChapterNumber ?? null

        // Prev/Next steps within the user's preferred language on a multi-language source
        // (chaptersForLanguage keeps untagged chapters and falls back to the full list
        // when none match - see its doc in sources.ts).
        const { language } = await getSettings()
        const pickAdjacent = (chapters: ChapterRecord[]) => {
            let next: ChapterRecord | null = null
            let prev: ChapterRecord | null = null
            let maxSortKey = -Infinity
            for (const chapter of chaptersForLanguage(chapters, language)) {
                // Skip unnumbered chapters (sortKey === UNNUMBERED_SORT_KEY === +Infinity): they have
                // no position, so they can't be a by-number prev/next, and letting Infinity into
                // maxSortKey would make the stale-cache check (maxSortKey <= current) always false
                // (never re-checking the network) and pick the extra as "next" with number Infinity
                // (which serializes to null over the message boundary).
                if (!Number.isFinite(chapter.sortKey)) continue
                if (chapter.sortKey > maxSortKey) maxSortKey = chapter.sortKey
                if (current === null) {
                    if (!next || chapter.sortKey < next.sortKey) next = chapter
                } else {
                    if (chapter.sortKey > current && (!next || chapter.sortKey < next.sortKey)) next = chapter
                    if (chapter.sortKey < current && (!prev || chapter.sortKey > prev.sortKey)) prev = chapter
                }
            }
            return { next, prev, maxSortKey }
        }

        const toResponse = (next: ChapterRecord | null, prev: ChapterRecord | null) => ({
            current,
            next: next ? { url: next.url, title: next.title, number: next.sortKey } : null,
            prev: prev ? { url: prev.url, title: prev.title, number: prev.sortKey } : null
        })

        // Cache-first: db.chapters is already populated by capture, update checks and
        // scheduleChapterListRefresh for almost every title, so most Prev/Next clicks can be
        // served without a network round trip (a full listChaptersForSource fetch, which is
        // slow on throttled sources and a total failure on Cloudflare-gated ones).
        const cached = await db.chapters.where("mangaId").equals(request.mangaId).sortBy("sortKey")
        if (cached.length > 0) {
            const { next, prev, maxSortKey } = pickAdjacent(cached)
            // The cache might just be stale rather than genuinely exhaustive when it has
            // nothing past the currently-read chapter - a new chapter may have been published
            // since the list was last cached. Double-check the network in that case; otherwise
            // trust the cache and skip the fetch entirely.
            const cacheMightBeStaleForNext = current !== null && maxSortKey <= current
            if (!cacheMightBeStaleForNext) {
                // Skip when there's no sourceMangaId - an empty id would share a
                // cooldown/dedup key across every such title for this source, and for
                // tab-crawl sources (Webtoons) getChapterListUrl("", ...) builds a URL
                // whose mined links can never pass the title_no guard, so it's a wasted
                // tab load that can never produce useful data.
                if (manga.sourceMangaId) {
                    const source = sourceRegistry.get(manga.sourceId)
                    if (source) {
                        scheduleChapterListRefresh(
                            source,
                            manga.sourceMangaId,
                            manga.mangaUrl ?? manga.sourceUrl,
                            manga.id
                        )
                    }
                }
                return toResponse(next, prev)
            }
            try {
                const chapters = await listChaptersForSource(
                    manga,
                    manga.sourceId,
                    manga.sourceMangaId ?? "",
                    manga.mangaUrl ?? manga.sourceUrl,
                    undefined,
                    language ? [language] : undefined
                )
                if (chapters.length > 0) {
                    await putChapters(chapters)
                    publishLive(["chapters"], [request.mangaId])
                }
                const fresh = pickAdjacent(chapters.length > 0 ? chapters : cached)
                return toResponse(fresh.next, fresh.prev)
            } catch {
                // Network unavailable (e.g. Cloudflare-gated source) - the stale cache's
                // answer is still better than nothing.
                return toResponse(next, prev)
            }
        }

        try {
            const chapters = await listChaptersForSource(
                manga,
                manga.sourceId,
                manga.sourceMangaId ?? "",
                manga.mangaUrl ?? manga.sourceUrl
            )
            if (chapters.length > 0) {
                await putChapters(chapters)
                publishLive(["chapters"], [request.mangaId])
            }
            const { next, prev } = pickAdjacent(chapters)
            return toResponse(next, prev)
        } catch {
            return { current: null, next: null, prev: null }
        }
    },

    "library:note": async request => {
        await updateManga(request.mangaId, {
            notes: request.note.trim() || undefined,
            updatedAt: Date.now()
        } as Partial<LibraryManga>)
        return null
    },

    "library:reading-prefs": async request => {
        const patch: {
            readingDirection?: LibraryManga["readingDirection"] | undefined
            pageFit?: LibraryManga["pageFit"] | undefined
            pageWidthPct?: number | undefined
            noGapContinuous?: boolean | undefined
            continuousScroll?: boolean | undefined
            readerTheme?: LibraryManga["readerTheme"] | undefined
        } = {}
        if (request.readingDirection !== undefined) patch.readingDirection = request.readingDirection ?? undefined
        if (request.pageFit !== undefined) patch.pageFit = request.pageFit ?? undefined
        if (request.pageWidthPct !== undefined) patch.pageWidthPct = request.pageWidthPct ?? undefined
        if (request.noGapContinuous !== undefined) patch.noGapContinuous = request.noGapContinuous ?? undefined
        if (request.continuousScroll !== undefined) patch.continuousScroll = request.continuousScroll ?? undefined
        if (request.readerTheme !== undefined) patch.readerTheme = request.readerTheme ?? undefined
        if (Object.keys(patch).length > 0) {
            await updateManga(request.mangaId, { ...patch, updatedAt: Date.now() } as Partial<LibraryManga>)
        }
        return null
    }
}
