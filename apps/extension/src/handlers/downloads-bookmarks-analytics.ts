import { SourceError } from "@amr/source-sdk"
import {
    bookmarkedPagesForChapter,
    db,
    getAnalyticsSummary,
    getDownload,
    getLogs,
    listBookmarks,
    listDownloads,
    recordAnalyticsEvent,
    removeBookmark,
    removeDownload,
    saveDownload,
    toggleBookmark,
    type AnalyticsEvent
} from "../database"
import { resolveChapterUrl } from "../sources"
import { getAniListConfig } from "../anilist"
import { getSyncConfig } from "../sync"
import { getCommunityProfile } from "../community"
import { formatDiagnosticLog, type LibrarySnapshot } from "../diagnostic-log"
import { hasNewerChapters } from "../reading-status"
import { delay, type HandlerMap } from "../background/handler-types"

async function fetchPageBlob(url: string): Promise<Blob> {
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let res: Response
        try {
            res = await fetch(url)
        } catch (cause) {
            if (attempt < maxAttempts) {
                await delay(attempt * 300)
                continue
            }
            throw new SourceError("request-failed", "Failed to download a page", {
                url,
                cause: cause instanceof Error ? cause.message : String(cause)
            })
        }
        if (!res.ok) {
            const expired = res.status === 404 || res.status === 410
            if (!expired && attempt < maxAttempts) {
                await delay(attempt * 300)
                continue
            }
            throw new SourceError("request-failed", `Failed to download a page (${res.status})`, {
                url,
                status: res.status
            })
        }
        return res.blob()
    }
    throw new SourceError("request-failed", "Failed to download a page", { url })
}

// Cap on the per-title unread list embedded in the diagnostic log so a huge library
// can't bloat the export; the full count is still reported separately.
const SNAPSHOT_UNREAD_CAP = 200

// Assemble the library picture the diagnostic log embeds: total + per-source counts,
// the newest completed update-check counts, and the titles the app currently treats as
// having unread/new chapters (what "why is X still unread" needs to see).
async function buildLibrarySnapshot(): Promise<LibrarySnapshot> {
    const [allManga, stored] = await Promise.all([
        db.manga.toArray(),
        browser.storage.local.get("updateStatus") as Promise<{
            updateStatus?: { checkedAt: number; checked: number; updated: number; failed: number }
        }>
    ])
    const bySourceMap = new Map<string, number>()
    for (const m of allManga) bySourceMap.set(m.sourceId, (bySourceMap.get(m.sourceId) ?? 0) + 1)
    const bySource = [...bySourceMap.entries()]
        .map(([sourceId, count]) => ({ sourceId, count }))
        .sort((a, b) => b.count - a.count || a.sourceId.localeCompare(b.sourceId))

    const unreadAll = allManga
        .filter(m => hasNewerChapters(m))
        .sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.title.localeCompare(b.title))
    const unread = unreadAll.slice(0, SNAPSHOT_UNREAD_CAP).map(m => ({
        title: m.title,
        sourceId: m.sourceId,
        read: m.lastReadChapterNumber ?? null,
        latest: m.latestChapterNumber ?? null
    }))

    const st = stored.updateStatus
    return {
        total: allManga.length,
        ...(st
            ? { lastUpdateCheck: { at: st.checkedAt, checked: st.checked, updated: st.updated, failed: st.failed } }
            : {}),
        bySource,
        unread,
        unreadTotal: unreadAll.length
    }
}

// In-flight downloads keyed by chapter URL: two concurrent downloads of the same chapter
// (two reader tabs, or reader + a retry) otherwise both fetch every page and both saveDownload.
// Share the one promise so the work runs once. Mirrors capture.ts's capturingUrls dedup.
const inFlightDownloads = new Map<string, Promise<{ chapterId: string; pageCount: number }>>()

async function runChapterDownload(url: string): Promise<{ chapterId: string; pageCount: number }> {
    const resolved = await resolveChapterUrl(url)
    // Anti-orphan invariant (mirrors saveProgress/saveReaderResolvedChapter): never persist
    // a manga-scoped download for a title that isn't in the library. The reader resolves any
    // URL, so downloading from a non-library chapter would otherwise leave up to 200 full-res
    // page blobs stranded under a mangaId no removeManga/GC can ever reclaim.
    if (!(await db.manga.get(resolved.manga.manga.id))) {
        throw new SourceError(
            "invalid-input",
            "Add this title to your library before downloading it for offline reading."
        )
    }
    let pages = resolved.pages.slice(0, 200)
    const pageBlobs: Blob[] = []
    let reResolved = false
    for (let index = 0; index < pages.length; index += 1) {
        const page = pages[index]
        if (!page) continue
        let blob: Blob
        try {
            blob = await fetchPageBlob(page.url)
        } catch (error) {
            const expired =
                error instanceof SourceError && (error.details?.["status"] === 404 || error.details?.["status"] === 410)
            if (expired && !reResolved) {
                reResolved = true
                const refreshed = await resolveChapterUrl(url)
                pages = refreshed.pages.slice(0, 200)
                // The refreshed resolution can differ in page count or order, so
                // blobs already fetched from the stale list cannot be interleaved
                // with it - discard them and re-download the whole chapter from the
                // fresh list to keep the saved pages consistent.
                pageBlobs.length = 0
                index = -1
                continue
            }
            throw error
        }
        pageBlobs.push(blob)
    }
    // A soft-failed / anti-scrape resolution can yield zero pages. Don't persist an
    // empty download - the offline reader would show a "downloaded" chapter with no
    // pages. Surface it as an error instead.
    if (pageBlobs.length === 0) {
        throw new SourceError("invalid-response", "That chapter resolved to no pages - nothing to download")
    }
    await saveDownload({
        chapterId: resolved.chapter.id,
        mangaId: resolved.manga.manga.id,
        pageBlobs,
        pageCount: pageBlobs.length,
        downloadedAt: Date.now()
    })
    return { chapterId: resolved.chapter.id, pageCount: pageBlobs.length }
}

export const downloadsBookmarksAnalyticsHandlers: HandlerMap = {
    "chapter:download": request => {
        const existing = inFlightDownloads.get(request.url)
        if (existing) return existing
        const run = runChapterDownload(request.url)
        inFlightDownloads.set(request.url, run)
        return run.finally(() => inFlightDownloads.delete(request.url))
    },

    "chapter:download:get": async request => {
        return (await getDownload(request.chapterId)) ?? null
    },

    "chapter:download:remove": async request => {
        await removeDownload(request.chapterId)
        return null
    },

    "downloads:list": async () => {
        return listDownloads()
    },

    "bookmark:toggle": async request => {
        return toggleBookmark({
            mangaId: request.mangaId,
            chapterId: request.chapterId,
            pageIndex: request.pageIndex,
            mangaTitle: request.mangaTitle,
            chapterTitle: request.chapterTitle,
            chapterUrl: request.chapterUrl
        })
    },

    "bookmark:pages": async request => {
        return bookmarkedPagesForChapter(request.chapterId)
    },

    "bookmark:list": async () => {
        return listBookmarks()
    },

    "bookmark:remove": async request => {
        await removeBookmark(request.id)
        return null
    },

    "analytics:record": async request => {
        void recordAnalyticsEvent({
            event: request.event as AnalyticsEvent["event"],
            ...(request.sourceId ? { sourceId: request.sourceId } : {}),
            ...(request.detail ? { detail: request.detail } : {}),
            ts: Date.now()
        })
        return null
    },

    "analytics:summary": async request => {
        return getAnalyticsSummary(request.days)
    },
    "log:export": async () => {
        // Gather the known secret values so the formatter can redact them literally (in
        // addition to its token-pattern backstop). Each config read is best-effort: a
        // failed read must NOT deny the user their log - it's exactly the artifact they
        // need when something is already broken. A missing secret still can't leak
        // because the token-pattern backstop runs regardless.
        const safe = async <T>(p: Promise<T>): Promise<T | undefined> => p.catch(() => undefined)
        const [logs, anilist, sync, community, snapshot] = await Promise.all([
            getLogs(),
            safe(getAniListConfig()),
            safe(getSyncConfig()),
            safe(getCommunityProfile()),
            safe(buildLibrarySnapshot())
        ])
        // userId is the community bearer credential and MUST be redacted; the tokens/gistId too.
        // username is NOT redacted: it is public (shown on leaderboards) and is often a short
        // dictionary word, so redacting it as a literal substring blanked real manga titles in
        // the library snapshot (a title containing the word) - degrading the very log it's in.
        const secrets = [anilist?.token, sync?.token, sync?.gistId, community?.userId, community?.secret].filter(
            (s): s is string => typeof s === "string" && s.length > 0
        )
        const text = formatDiagnosticLog(logs, {
            version: browser.runtime.getManifest().version,
            browser: import.meta.env.BROWSER,
            secrets,
            ...(snapshot ? { snapshot } : {})
        })
        return { text }
    }
}
