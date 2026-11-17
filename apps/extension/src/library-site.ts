// The site of a library source that has no stored profile. An install that went straight from a release
// before seed rows existed to the store build (which bundles no seed) has titles whose source id nothing in
// the build knows. Their own addresses still name the site, so the fix-it page can offer to turn it on and,
// once the user grants it, write a minimal recognition-only row under the existing source id. No hostname
// comes from the bundle.

import { draftProfileFromChapterPage, parseProfile, type SiteProfile } from "@amr/source-engine"
import { isProfileSource, narrowedSeedProfile } from "./arch-sources"
import { db, putArchProfile, type LibraryManga } from "./database"
import { OFFICIAL_SITES_DEFAULT, isOfficialHost } from "./official-sources"
import { isAddableUrl, isPublicSuffixHost } from "./source-scope"
import { getSourceById } from "./sources"

const MAX_ROWS_READ = 50

function addableUrl(value: string | undefined): URL | undefined {
    if (!value) return undefined
    try {
        const url = new URL(value)
        const bare = url.hostname.toLowerCase().replace(/^www\./, "")
        if (!isAddableUrl(url) || isPublicSuffixHost(bare) || isOfficialHost(bare, OFFICIAL_SITES_DEFAULT)) {
            return undefined
        }
        return url
    } catch {
        return undefined
    }
}

const bareHostOf = (url: URL): string => url.hostname.toLowerCase().replace(/^www\./, "")

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// "/manga/demo" -> match "^/manga/([^/]+)/?$", template "/manga/{slug}". Undefined for a bare "/x".
function seriesShape(mangaUrl: URL): { manga: string; urlTemplate: string } | undefined {
    const segments = mangaUrl.pathname.split("/").filter(Boolean)
    if (segments.length < 2) return undefined
    const prefix = segments.slice(0, -1).map(escapeRegExp)
    return {
        manga: `^/${prefix.join("/")}/([^/]+)/?$`,
        urlTemplate: `/${segments.slice(0, -1).join("/")}/{slug}`
    }
}

function recognitionProfile(sourceId: string, origin: string, fields: Record<string, unknown>): unknown {
    const host = new URL(origin).hostname
    return {
        profileFormat: 2,
        id: sourceId,
        name: host.replace(/^www\./, ""),
        engine: "generic",
        origin,
        domains: [host],
        languages: ["en"],
        capabilities: ["manga"],
        requestRateLimit: { requests: 3, intervalMs: 1000 },
        origins: [`https://${host}/*`],
        ...fields
    }
}

// Address patterns read from the row's own chapter address when it has a recognisable chapter shape,
// otherwise from its series address. No chapter list: the row stays recognition-only.
function profileFromRow(sourceId: string, manga: LibraryManga, host: string): SiteProfile | undefined {
    const candidates: unknown[] = []
    const chapterUrl = addableUrl(manga.sourceUrl)
    if (chapterUrl && bareHostOf(chapterUrl) === host) {
        const draft = draftProfileFromChapterPage({ url: chapterUrl.toString(), links: [], images: [] })
        const draftProfile = draft?.profile as
            | { match?: unknown; series?: { urlTemplate?: unknown; titlePattern?: unknown } }
            | undefined
        if (draftProfile?.match && draftProfile.series) {
            candidates.push(
                recognitionProfile(sourceId, chapterUrl.origin, {
                    match: draftProfile.match,
                    series: draftProfile.series
                })
            )
        }
    }
    const mangaUrl = addableUrl(manga.mangaUrl)
    const shape = mangaUrl && bareHostOf(mangaUrl) === host ? seriesShape(mangaUrl) : undefined
    if (mangaUrl && shape) {
        candidates.push(
            recognitionProfile(sourceId, mangaUrl.origin, {
                match: { manga: shape.manga },
                series: {
                    urlTemplate: shape.urlTemplate,
                    titlePattern: 'property="og:title" content="(?<title>[^"]+)"'
                }
            })
        )
    }
    for (const candidate of candidates) {
        const parsed = parseProfile(candidate)
        const narrowed = parsed.ok ? narrowedSeedProfile(parsed.profile) : undefined
        if (narrowed) return narrowed
    }
    return undefined
}

// The recognition-only profile a source's library rows describe, or undefined when the build already has
// the source, its rows are lab samples, or no row names an addable https site. The most recently updated
// row decides the host; only rows on that host are read.
export async function librarySiteProfile(sourceId: string): Promise<SiteProfile | undefined> {
    if (getSourceById(sourceId) !== undefined && !isProfileSource(sourceId)) return undefined
    const rows = (await db.manga.where("sourceId").equals(sourceId).limit(MAX_ROWS_READ).toArray())
        .filter(manga => !manga.id.startsWith("seed-"))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    let host: string | undefined
    for (const manga of rows) {
        const url = addableUrl(manga.mangaUrl) ?? addableUrl(manga.sourceUrl)
        if (url) {
            host = bareHostOf(url)
            break
        }
    }
    if (!host) return undefined
    for (const manga of rows) {
        const profile = profileFromRow(sourceId, manga, host)
        if (profile) return profile
    }
    return undefined
}

export function accessPatternsOf(profile: SiteProfile): string[] {
    return [...new Set([...profile.origins, ...(profile.imageOrigins ?? [])])].filter(pattern =>
        pattern.startsWith("https://")
    )
}

// Store the derived row, only when no row exists for the id: a profile the user added or restored meanwhile
// always wins.
export async function saveLibrarySiteProfile(profile: SiteProfile): Promise<void> {
    await db.transaction("rw", db.archProfiles, async () => {
        if (!(await db.archProfiles.get(profile.id))) await putArchProfile(profile.id, profile, "seed")
    })
}
