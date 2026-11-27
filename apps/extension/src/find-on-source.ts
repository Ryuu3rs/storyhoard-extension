// "Find my titles here": after the user adds a site, look for the rest of their library on it. A site the user
// added has no search the app can read, so each title's likely address on the site is built from its names (and
// the address another site already uses for it) and the series page there is read. A page only counts when the
// series name it shows is one of the title's names, so a site that answers every address with a home page or a
// "not found" page never matches. Nothing is changed until the user picks what to add.

import { stripSlugHash } from "@amr/source-engine"
import { SourceError } from "@amr/source-sdk"
import { lacksSiteAccess, isProfileSource, isTabListSource, isTrackingOnlySource } from "./arch-sources"
import { db, listAllVersions, type LibraryManga } from "./database"
import { isDetectedSourceId } from "./detected-site"
import { diag } from "./diag-log"
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
    // The last title this run checked, when titles are left: the next run carries on after it. An id rather than a
    // position, so titles added between runs (which leave the list) never make the next run skip any.
    next?: string
    // Why the run stopped early: it checked a batch, used its time, was cancelled, the site refused a request,
    // or something else went wrong (logged to the diagnostic log).
    stopped?: "batch" | "time" | "cancelled" | "site-error" | "failed"
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
const cancelled = new Set<string>()

// Ask a run on this site to stop before its next request. The panel sends this when it is closed.
export function cancelFind(sourceId: string): void {
    if (running.has(sourceId)) cancelled.add(sourceId)
}

// A request the site refused or never answered, as opposed to a fault in the extension itself.
function isSiteFailure(error: unknown): boolean {
    if (error instanceof SourceError) return error.code === "request-failed" || error.code === "request-limit"
    return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
}

export async function findTitlesOnSource(
    sourceId: string,
    options: { after?: string; now?: () => number; pause?: (ms: number) => Promise<void> } = {}
): Promise<FindOnSourceResult> {
    if ((await findAvailability(sourceId)) !== "ok") throw new Error("This site can't be searched for your titles")
    if (running.has(sourceId)) throw new Error("Already looking on this site")
    running.add(sourceId)
    cancelled.delete(sourceId)
    const now = options.now ?? Date.now
    const pause = options.pause ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
    try {
        const adapter = getSourceById(sourceId)!
        const host = adapter.manifest.domains[0] ?? ""
        const { requests, intervalMs } = adapter.manifest.requestRateLimit
        const gap = Math.max(MIN_GAP_MS, Math.ceil(intervalMs / Math.max(1, requests)))
        const after = options.after
        const queue = (await titlesToCheck(sourceId)).filter(item => after === undefined || item.manga.id > after)
        const deadline = now() + RUN_BUDGET_MS
        const found: FoundTitle[] = []
        let checked = 0
        let lastChecked = after
        let stopped: FindOnSourceResult["stopped"]
        let first = true
        titles: for (const { manga, knownSlugs } of queue) {
            if (checked === MAX_TITLES_PER_RUN) {
                stopped = "batch"
                break
            }
            const names = namesOf(manga)
            let hit: FoundTitle | undefined
            for (const slug of slugGuesses(names, knownSlugs)) {
                if (!first) await pause(gap)
                first = false
                if (cancelled.has(sourceId)) {
                    stopped = "cancelled"
                    break titles
                }
                if (now() > deadline) {
                    stopped = "time"
                    break titles
                }
                let series: Awaited<ReturnType<typeof findSeriesOnSource>>
                try {
                    series = await findSeriesOnSource(sourceId, slug)
                } catch (error) {
                    if (isSiteFailure(error)) {
                        stopped = "site-error"
                    } else {
                        stopped = "failed"
                        diag.error("find-titles", "looking for a title on a site failed", { error })
                    }
                    break titles
                }
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
            if (hit) found.push(hit)
            checked += 1
            lastChecked = manga.id
        }
        const left = checked < queue.length
        return {
            sourceId,
            found,
            checked,
            total: queue.length,
            ...(left ? { next: lastChecked ?? "" } : {}),
            ...(stopped ? { stopped } : {})
        }
    } finally {
        running.delete(sourceId)
        cancelled.delete(sourceId)
    }
}
