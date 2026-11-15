import { browser } from "wxt/browser"
import type { HandlerMap } from "../background/handler-types"
import { isPlaceholderTitle, refreshExternalMangaMetadata } from "../background/capture"
import { isProfileSource, registerStoredArchProfiles } from "../arch-sources"
import { db, type LibraryManga } from "../database"
import { buildAdoptRequest } from "../find-source"
import { isHostnameTitle } from "../fix-it-groups"
import { getSourceById } from "../sources"
import { resolveSource } from "../source-resolver"
import { libraryHandlers } from "./library"

// The handlers behind the update-check fix-it page. Each one acts on a whole group the page shows, so
// the user fixes a problem with one click instead of opening titles one at a time.

const MAX_FIND_PER_CALL = 25
const MAX_NAMES_PER_CALL = 40

function httpsPatternsOf(profile: unknown): string[] {
    const origins = (profile as { origins?: unknown } | null)?.origins
    return Array.isArray(origins)
        ? origins.filter((pattern): pattern is string => typeof pattern === "string" && pattern.startsWith("https://"))
        : []
}

function hasPlaceholderName(manga: LibraryManga): boolean {
    if (isHostnameTitle(manga.title)) return true
    return manga.sourceMangaId !== undefined && isPlaceholderTitle(manga.title, manga.sourceMangaId)
}

export const fixItHandlers: HandlerMap = {
    // For each site the page lists as not connected: whether the extension still knows the site (a stored
    // profile), so one host grant brings it back, and which patterns that grant needs. Plus the titles still
    // named after their address.
    "fixit:overview": async request => {
        const sites: Array<{ sourceId: string; canTurnOn: boolean; origins: string[] }> = []
        for (const sourceId of [...new Set(request.sourceIds)]) {
            const row = await db.archProfiles.get(sourceId)
            const origins = row ? httpsPatternsOf(row.profile) : []
            sites.push({ sourceId, canTurnOn: !isProfileSource(sourceId) && origins.length > 0, origins })
        }
        const names = (await db.manga.toArray())
            .filter(manga => !manga.id.startsWith("seed-") && hasPlaceholderName(manga))
            .map(manga => ({ mangaId: manga.id, title: manga.title }))
        return { sites, names }
    },

    // Called after the page got the host grant: the stored profile registers again and its titles check.
    "fixit:enable-site": async request => {
        const row = await db.archProfiles.get(request.sourceId)
        if (!row) return { enabled: false }
        const patterns = httpsPatternsOf(row.profile)
        const granted = patterns.length > 0 && (await browser.permissions.contains({ origins: patterns }))
        if (!granted) return { enabled: false }
        await registerStoredArchProfiles({ onlyUnresolved: true })
        return { enabled: getSourceById(request.sourceId) !== undefined }
    },

    // Finds each title on the user's other sites and relinks it only on a sure match, the same rule the
    // import uses, so a wrong source is never attached. Progress, notes and the read chapter are kept.
    "fixit:find": async (request, ctx) => {
        const results: Array<{ mangaId: string; outcome: "relinked" | "pick" | "missing" }> = []
        for (const mangaId of request.mangaIds.slice(0, MAX_FIND_PER_CALL)) {
            const manga = await db.manga.get(mangaId)
            if (!manga) {
                results.push({ mangaId, outcome: "missing" })
                continue
            }
            try {
                const found = await resolveSource({
                    title: manga.title,
                    ...(manga.anilistId !== undefined ? { anilistId: manga.anilistId } : {})
                })
                if (found.confidence !== "high" || !found.best) {
                    results.push({ mangaId, outcome: "pick" })
                    continue
                }
                await libraryHandlers["library:switch"]!(buildAdoptRequest(mangaId, found.best, false), ctx)
                results.push({ mangaId, outcome: "relinked" })
            } catch {
                results.push({ mangaId, outcome: "pick" })
            }
        }
        return { results }
    },

    // Re-reads the real name of titles still named after their address ("019c2921 c7b9 …", a hostname).
    "fixit:names": async () => {
        const targets = (await db.manga.toArray()).filter(
            manga => !manga.id.startsWith("seed-") && hasPlaceholderName(manga) && manga.sourceMangaId && manga.mangaUrl
        )
        for (const manga of targets.slice(0, MAX_NAMES_PER_CALL)) {
            await refreshExternalMangaMetadata(
                manga.sourceId,
                { sourceMangaId: manga.sourceMangaId!, mangaUrl: manga.mangaUrl! },
                manga.id
            )
        }
        const after = await db.manga.bulkGet(targets.map(manga => manga.id))
        const remaining = after.filter((manga): manga is LibraryManga => !!manga && hasPlaceholderName(manga)).length
        return { tried: Math.min(targets.length, MAX_NAMES_PER_CALL), remaining }
    }
}
