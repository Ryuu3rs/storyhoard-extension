import { normalizeTitle } from "@amr/normalize"
import type { HandlerMap } from "../background/handler-types"
import { addImportedManga, db, type LibraryManga } from "../database"
import { getImportFormat, type ImportedManga } from "../import"
import { buildAdoptRequest, entryNeedsSource } from "../find-source"
import { resolveSource } from "../source-resolver"
import { libraryHandlers } from "./library"

// Upper bound on how many sourceless rows one auto-resolve pass will touch, so a huge
// imported library can't fire hundreds of live source searches in a single run. The
// remainder stay tracking rows the user can still resolve manually via "Find source",
// and a later pass picks them up.
const MAX_AUTO_RESOLVE = 100

function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
}

// Map a normalized imported entry to a library row. Tracking-first: we can't resolve another app's
// numeric source ids, so an entry with an AniList id is keyed as an AniList tracking row (same shape
// as library:quick-add) and one without is keyed by title. addImportedManga then dedups by anilistId
// and by normalized title, so nothing already in the library is duplicated.
function toCandidate(m: ImportedManga): LibraryManga {
    const now = Date.now()
    const normalizedTitle = normalizeTitle(m.title)
    const hasAniList = typeof m.anilistId === "number"
    const maxRead = m.maxReadChapter
    return {
        id: hasAniList ? `anilist:manga:${m.anilistId}` : `import:manga:${normalizedTitle}`,
        title: m.title,
        normalizedTitle,
        authors: [],
        status: m.status,
        sourceId: hasAniList ? "anilist.co" : "import",
        sourceUrl: hasAniList
            ? `https://anilist.co/manga/${m.anilistId}`
            : `amr:import:${encodeURIComponent(normalizedTitle)}`,
        manualTracking: true,
        addedAt: now,
        updatedAt: now,
        ...(hasAniList ? { anilistId: m.anilistId } : {}),
        ...(m.coverUrl ? { coverUrl: m.coverUrl } : {}),
        ...(m.genres.length > 0 ? { genres: m.genres } : {}),
        ...(m.categories.length > 0 ? { categories: m.categories } : {}),
        ...(m.notes ? { notes: m.notes } : {}),
        ...(typeof maxRead === "number" && maxRead > 0
            ? { lastReadChapterNumber: maxRead, latestChapterNumber: maxRead, lastReadAt: now }
            : {})
    }
}

export const importHandlers: HandlerMap = {
    // Import a library/list from another reader (Mihon/Tachiyomi etc). `format` selects the parser
    // from the registry (the UI dropdown); `dataB64` is the raw file. `preview` parses + counts
    // without writing, so the UI can confirm before merging. Additive/merge only - never wipes.
    "import:reader": async request => {
        const format = getImportFormat(request.format)
        if (!format) throw new Error(`Unknown import format: ${request.format}`)

        const parsed = await format.parse(base64ToBytes(request.dataB64))
        const withAniList = parsed.filter(m => typeof m.anilistId === "number").length
        const withProgress = parsed.filter(m => typeof m.maxReadChapter === "number").length

        if (request.preview) {
            return {
                preview: true,
                total: parsed.length,
                withAniList,
                trackingOnly: parsed.length - withAniList,
                withProgress
            }
        }

        const { imported, skipped } = await addImportedManga(parsed.map(toCandidate))
        return { preview: false, total: parsed.length, imported, skipped, withAniList, withProgress }
    },

    // Background auto-resolve pass (resolver slice 4): sweep the tracking-only rows an
    // import (or a Discover add) left behind and, for each, adopt a live reader source
    // ONLY on a high-confidence exact match - the same safety gate the reconcile
    // auto-link path uses. Anything ambiguous is left untouched for the user to resolve
    // manually via "Find source", so a wrong source is never attached automatically.
    // Owner ruling 2026-09-27: auto-adopt on exact only. Best-effort and idempotent -
    // re-running skips rows that now have a real source; per-row failures are swallowed
    // so one dead candidate never aborts the sweep. Reuses the validated library:switch
    // primitive (with allowTabFallback:false - the background never opens a tab), so an
    // adopted source is proven to have chapters and all progress/notes/workId is kept.
    "import:resolve": async (_request, ctx) => {
        const rows = await db.manga.toArray()
        const targets = rows.filter(m => entryNeedsSource(m)).slice(0, MAX_AUTO_RESOLVE)
        let resolved = 0
        for (const manga of targets) {
            try {
                const result = await resolveSource({
                    title: manga.title,
                    ...(manga.anilistId !== undefined ? { anilistId: manga.anilistId } : {})
                })
                if (result.confidence !== "high" || !result.best) continue
                await libraryHandlers["library:switch"]!(buildAdoptRequest(manga.id, result.best, false), ctx)
                resolved++
            } catch {
                // Leave this row as a tracking entry; auto-resolve is best-effort.
            }
        }
        return { scanned: targets.length, resolved }
    },

    // Deep-link from the weeb.ltd site ("Open in StoryHoard"): add the AniList title to
    // the library as a tracking row (deduped by the anilist-scoped id, same as an import),
    // auto-resolve a live reader source on a high-confidence exact match, then open the app
    // focused on that title. Reaches the background only through the weeb-bridge content
    // script, which is same-origin-gated and validates the id, so the payload here is
    // already trusted-shape. Opening the tab is what makes the button feel like "read".
    "site:open": async (request, ctx) => {
        const now = Date.now()
        const id = `anilist:manga:${request.anilistId}`
        const base: LibraryManga = {
            id,
            title: request.title,
            normalizedTitle: normalizeTitle(request.title),
            authors: [],
            status: "unknown",
            sourceId: "anilist.co",
            sourceUrl: `https://anilist.co/manga/${request.anilistId}`,
            manualTracking: true,
            addedAt: now,
            updatedAt: now,
            anilistId: request.anilistId,
            readingStatus: "planning",
            readingStatusUpdatedAt: now,
            ...(request.coverUrl ? { coverUrl: request.coverUrl } : {}),
            ...(request.genres && request.genres.length > 0 ? { genres: request.genres } : {})
        }
        await addImportedManga([base])
        let resolved = false
        try {
            const result = await resolveSource({ title: request.title, anilistId: request.anilistId })
            if (result.confidence === "high" && result.best) {
                await libraryHandlers["library:switch"]!(buildAdoptRequest(id, result.best, false), ctx)
                resolved = true
            }
        } catch {
            // Adopt is best-effort; the title is still added and openable.
        }
        await browser.tabs.create({ url: browser.runtime.getURL(`/app.html?open=${encodeURIComponent(id)}`) })
        return { added: true, resolved }
    }
}
