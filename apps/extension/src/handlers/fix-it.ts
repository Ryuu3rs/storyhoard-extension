import { browser } from "wxt/browser"
import type { HandlerMap } from "../background/handler-types"
import { isSlugLikeTitle, refreshExternalMangaMetadata } from "../background/capture"
import { isProfileSource, lacksSiteAccess, registerStoredArchProfiles, storedRowAccessPatterns } from "../arch-sources"
import { db, type LibraryManga } from "../database"
import { buildAdoptRequest } from "../find-source"
import { isHostnameTitle } from "../fix-it-groups"
import { accessPatternsOf, librarySiteProfile, saveLibrarySiteProfile } from "../library-site"
import { approveSiteOrigins, holdsChosenAccess } from "../site-approvals"
import { getSourceById } from "../sources"
import { resolveSource } from "../source-resolver"
import { libraryHandlers } from "./library"

// The handlers behind the update-check fix-it page. Each one acts on a whole group the page shows, so
// the user fixes a problem with one click instead of opening titles one at a time.

const MAX_FIND_PER_CALL = 25
const MAX_NAMES_PER_CALL = 40

// The patterns a Turn on grants: the stored profile's, or for a source with no stored profile (an install
// that skipped the releases that wrote one), the site its own library rows name.
async function rowAccessPatterns(sourceId: string): Promise<string[]> {
    const row = await db.archProfiles.get(sourceId)
    if (row) return storedRowAccessPatterns(row)
    const derived = await librarySiteProfile(sourceId)
    return derived ? accessPatternsOf(derived) : []
}

const squash = (value: string): string => value.toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, "")

// A key rather than a name: a long number ("5656") or hex runs ("019c2921-c7b9", a uuid). A short number
// or a word slug ("86", "solo-leveling") is usually the title itself.
function isIdLikeSlug(sourceMangaId: string): boolean {
    const tokens = sourceMangaId
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
    return tokens.some(token => /\d/.test(token)) && tokens.every(token => /^[0-9a-f]{4,}$/.test(token))
}

function hostsOf(manga: LibraryManga): string[] {
    const hosts: string[] = []
    for (const url of [manga.sourceUrl, manga.mangaUrl]) {
        try {
            if (url) hosts.push(new URL(url).hostname.replace(/^www\./, ""))
        } catch {
            // An unparseable address names no host.
        }
    }
    return hosts
}

// Only a title that is still the raw placeholder a capture wrote: the slug itself, the humanized form of
// an id-like slug, an old "Title No:5656" name, or the title's own site host. A real name that merely
// matches its slug ("Solo Leveling" for solo-leveling) is not listed.
function hasPlaceholderName(manga: LibraryManga): boolean {
    if (isHostnameTitle(manga.title)) {
        const title = manga.title.trim().replace(/^www\./, "")
        return hostsOf(manga).some(host => host === title || host.endsWith(`.${title}`) || title.endsWith(`.${host}`))
    }
    const id = manga.sourceMangaId
    if (!id) return false
    if (isSlugLikeTitle(manga.title)) return true
    const title = squash(manga.title)
    const slug = squash(id)
    if (slug.length === 0) return false
    return title === `titleno${slug}` || (title === slug && isIdLikeSlug(id))
}

export const fixItHandlers: HandlerMap = {
    // For each site the page lists as not connected: whether the extension still knows the site (a stored
    // profile), so one host grant brings it back, and which patterns that grant needs. Plus the titles still
    // named after their address.
    "fixit:overview": async request => {
        const sites: Array<{ sourceId: string; canTurnOn: boolean; origins: string[] }> = []
        for (const sourceId of [...new Set(request.sourceIds)]) {
            const origins = await rowAccessPatterns(sourceId)
            const off = origins.length > 0 && (!isProfileSource(sourceId) || !(await holdsChosenAccess(origins)))
            sites.push({ sourceId, canTurnOn: off, origins })
        }
        const names = (await db.manga.toArray())
            .filter(manga => !manga.id.startsWith("seed-") && hasPlaceholderName(manga))
            .map(manga => ({ mangaId: manga.id, title: manga.title }))
        return { sites, names }
    },

    // Called after the page got the host grant: the stored profile registers again and its titles check.
    "fixit:enable-site": async request => {
        const patterns = await rowAccessPatterns(request.sourceId)
        const granted = patterns.length > 0 && (await browser.permissions.contains({ origins: patterns }))
        if (!granted) return { enabled: false }
        if (!(await db.archProfiles.get(request.sourceId))) {
            const derived = await librarySiteProfile(request.sourceId)
            if (!derived) return { enabled: false }
            await saveLibrarySiteProfile(derived)
        }
        // The user turned this site on from the fix-it page, which counts as choosing it.
        await approveSiteOrigins(patterns)
        await registerStoredArchProfiles({ onlyUnresolved: true })
        return { enabled: getSourceById(request.sourceId) !== undefined && !(await lacksSiteAccess(request.sourceId)) }
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
    // `after` is the last id the previous call tried, so each call takes the next batch: a title whose name
    // can never be read does not hold back the ones after it.
    "fixit:names": async request => {
        const targets = (await db.manga.toArray())
            .filter(
                manga =>
                    !manga.id.startsWith("seed-") && hasPlaceholderName(manga) && manga.sourceMangaId && manga.mangaUrl
            )
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        const pending = request.after === undefined ? targets : targets.filter(manga => manga.id > request.after!)
        const batch = pending.slice(0, MAX_NAMES_PER_CALL)
        for (const manga of batch) {
            await refreshExternalMangaMetadata(
                manga.sourceId,
                { sourceMangaId: manga.sourceMangaId!, mangaUrl: manga.mangaUrl! },
                manga.id
            )
        }
        const refreshed = await db.manga.bulkGet(targets.map(manga => manga.id))
        const remaining = refreshed.filter(
            (manga): manga is LibraryManga => !!manga && hasPlaceholderName(manga)
        ).length
        const next = pending.length > batch.length ? batch[batch.length - 1]!.id : undefined
        return { tried: batch.length, remaining, ...(next !== undefined ? { next } : {}) }
    }
}
