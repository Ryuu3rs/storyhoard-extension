// "Find my titles here": after the user adds a site, look for the rest of their library on it. A site the user
// added has no search the app can read, so each title's likely address on the site is built from its names (and
// the address another site already uses for it) and the series page there is read. A page only counts when the
// series name it shows is one of the title's names, so a site that answers every address with a home page or a
// "not found" page never matches. Nothing is changed until the user picks what to add.

import { stripSlugHash } from "@amr/source-engine"
import { lacksSiteAccess, isProfileSource, isTabListSource, isTrackingOnlySource } from "./arch-sources"
import { db, listAllVersions, type LibraryManga } from "./database"
import { isDetectedSourceId } from "./detected-site"
import { hasNoSite } from "./find-source"
import { isStillSample } from "./sample-rows"
import { seriesNameFromTitle } from "./series-name"
import { findSeriesOnSource, getSourceById } from "./sources"
import { titleKey, workKeyOf } from "./work-identity"

export type FoundTitle = {
    mangaId: string
    title: string
    sourceMangaId: string
    url: string
    // True when the title is not on any site yet, so adding makes this its site instead of another source.
    noSiteYet: boolean
}

export type FindOnSourceResult = {
    sourceId: string
    found: FoundTitle[]
    checked: number
    total: number
    // Where the next run carries on, when this one stopped before the end of the list.
    next?: number
    // Why the run stopped early: it checked a batch, used its time, or the site refused a request.
    stopped?: "batch" | "time" | "site-error"
}

export type FindAvailability = "ok" | "no-address" | "on-visit" | "no-access" | "unknown"

const MAX_TITLES_PER_RUN = 40
const RUN_BUDGET_MS = 45_000
const MAX_GUESSES_PER_TITLE = 3
const MIN_GAP_MS = 350

// "Solo Leveling: Ragnarok!" -> "solo-leveling-ragnarok". Accents are dropped and apostrophes vanish rather than
// split a word, which is how reader sites build their addresses. Letters of any script are kept.
export function slugFromName(name: string): string {
    return name
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "")
        .toLocaleLowerCase("en")
        .replace(/['’]/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "")
}

const SLUG_SHAPE = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,119}$/u

// The addresses worth trying for one title, most likely first: its own name, the address another site already
// files it under, then its other names. Ids that are only digits are another site's internal number, not a name.
export function slugGuesses(names: readonly string[], knownSlugs: readonly string[]): string[] {
    const [main, ...others] = names
    const candidates = [
        ...(main ? [slugFromName(main)] : []),
        ...knownSlugs.map(slug => stripSlugHash(slug).toLocaleLowerCase("en")),
        ...others.map(slugFromName)
    ]
    const out: string[] = []
    for (const slug of candidates) {
        if (slug.length < 2 || !SLUG_SHAPE.test(slug) || !/\p{L}/u.test(slug) || out.includes(slug)) continue
        out.push(slug)
        if (out.length === MAX_GUESSES_PER_TITLE) break
    }
    return out
}

// True when the series name a page shows is one of the title's names. The site's own name and any "Read ...
// online" wording are taken off the page title first.
export function pageNamesTitle(pageTitle: string, context: { slug: string; host: string }, names: readonly string[]) {
    const shown = seriesNameFromTitle(pageTitle, context) ?? pageTitle
    const key = titleKey(shown)
    return key !== "" && names.some(name => titleKey(name) === key)
}

export async function findAvailability(sourceId: string): Promise<FindAvailability> {
    const adapter = getSourceById(sourceId)
    if (!adapter || !isProfileSource(sourceId)) return "unknown"
    if (!adapter.findSeriesBySlug) return "no-address"
    if (isTrackingOnlySource(sourceId) || isTabListSource(sourceId)) return "on-visit"
    if (await lacksSiteAccess(sourceId)) return "no-access"
    return "ok"
}

function namesOf(manga: LibraryManga): string[] {
    return [manga.title, ...(manga.altTitles ?? [])].map(name => name.trim()).filter(Boolean)
}

// Library titles not on this site yet, in a fixed order so a run can carry on where the last one stopped.
async function titlesToCheck(sourceId: string): Promise<Array<{ manga: LibraryManga; knownSlugs: string[] }>> {
    const versions = await listAllVersions()
    const onThisSite = new Set(versions.filter(v => v.sourceId === sourceId).map(v => v.workKey))
    const slugsByWork = new Map<string, string[]>()
    for (const version of versions) {
        if (version.sourceId === sourceId || isDetectedSourceId(version.sourceId)) continue
        const list = slugsByWork.get(version.workKey) ?? []
        list.push(version.sourceMangaId)
        slugsByWork.set(version.workKey, list)
    }
    const library = await db.manga.toArray()
    return library
        .filter(manga => manga.sourceId !== sourceId && !isStillSample(manga))
        .filter(manga => !onThisSite.has(workKeyOf(manga, manga.id)))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map(manga => {
            const own = !hasNoSite(manga) && manga.sourceMangaId ? [manga.sourceMangaId] : []
            return { manga, knownSlugs: [...own, ...(slugsByWork.get(workKeyOf(manga, manga.id)) ?? [])] }
        })
}

const running = new Set<string>()

export async function findTitlesOnSource(
    sourceId: string,
    options: { offset?: number; now?: () => number; pause?: (ms: number) => Promise<void> } = {}
): Promise<FindOnSourceResult> {
    if ((await findAvailability(sourceId)) !== "ok") throw new Error("This site can't be searched for your titles")
    if (running.has(sourceId)) throw new Error("Already looking on this site")
    running.add(sourceId)
    const now = options.now ?? Date.now
    const pause = options.pause ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
    try {
        const adapter = getSourceById(sourceId)!
        const host = adapter.manifest.domains[0] ?? ""
        const { requests, intervalMs } = adapter.manifest.requestRateLimit
        const gap = Math.max(MIN_GAP_MS, Math.ceil(intervalMs / Math.max(1, requests)))
        const queue = await titlesToCheck(sourceId)
        const start = Math.min(Math.max(0, options.offset ?? 0), queue.length)
        const deadline = now() + RUN_BUDGET_MS
        const found: FoundTitle[] = []
        let index = start
        let stopped: FindOnSourceResult["stopped"]
        let first = true
        while (index < queue.length && index - start < MAX_TITLES_PER_RUN) {
            if (now() > deadline) {
                stopped = "time"
                break
            }
            const { manga, knownSlugs } = queue[index]!
            const names = namesOf(manga)
            let hit: FoundTitle | undefined
            try {
                for (const slug of slugGuesses(names, knownSlugs)) {
                    if (!first) await pause(gap)
                    first = false
                    const series = await findSeriesOnSource(sourceId, slug)
                    if (series && pageNamesTitle(series.title, { slug, host }, names)) {
                        hit = {
                            mangaId: manga.id,
                            title: manga.title,
                            sourceMangaId: series.sourceMangaId,
                            url: series.url,
                            noSiteYet: hasNoSite(manga)
                        }
                        break
                    }
                }
            } catch {
                stopped = "site-error"
                break
            }
            if (hit) found.push(hit)
            index += 1
        }
        if (!stopped && index < queue.length) stopped = "batch"
        return {
            sourceId,
            found,
            checked: index - start,
            total: queue.length - start,
            ...(index < queue.length ? { next: index } : {}),
            ...(stopped ? { stopped } : {})
        }
    } finally {
        running.delete(sourceId)
    }
}
