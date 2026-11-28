import { normalizeTitle } from "@amr/normalize"
import type { CatalogTitle } from "./catalog-search"
import { OFFICIAL_SITES_DEFAULT, isOfficialHost, type OfficialSite } from "./official-sources"

// Pure helpers for the search popover's "pick a title, then see where to read it" flow.

const MEDIA_LABEL: Record<string, string> = {
    manga: "Manga",
    manhwa: "Manhwa",
    manhua: "Manhua",
    webtoon: "Webtoon",
    novel: "Novel",
    book: "Book"
}
const STATUS_LABEL: Record<string, string> = {
    releasing: "Ongoing",
    finished: "Completed",
    hiatus: "On hiatus",
    cancelled: "Cancelled",
    upcoming: "Upcoming"
}

// The short facts under a title: type, year, publishing status.
export function titleFacts(title: CatalogTitle): string[] {
    return [
        title.mediaType ? MEDIA_LABEL[title.mediaType] : undefined,
        title.year ? String(title.year) : undefined,
        title.status ? STATUS_LABEL[title.status] : undefined
    ].filter((fact): fact is string => typeof fact === "string")
}

// Words a site adds around a title without making it another work: a leading article, and format or
// edition labels. Anything else ("Ragnarok", "2", ":re", "Novel") is treated as a different work.
const LEADING_NOISE = /^the /
const TRAILING_NOISE = /( (official|manga|manhwa|manhua|webtoon|comics?|colou?red|full colou?r|english|eng))+$/

// Accents on Latin, Greek and Cyrillic letters. In other scripts a mark is a vowel sign, a virama or a
// voicing mark (Hindi काला and कल, Japanese が and か are different words), so it stays.
const ACCENTED_LETTER = /([\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])\p{M}+/gu
// Anything but a letter, a digit or a mark on one, with any marks left hanging on it.
const SEPARATOR = /(?:^\p{M}+|[^\p{L}\p{M}\p{N}]\p{M}*)+/gu

// A name reduced to the letters and digits a site cannot get wrong: "Level-Up" and "Level Up",
// "Reader's" and "Readers", "Pokémon" and "Pokemon" all compare equal.
function nameKey(name: string): string {
    return (
        normalizeTitle(name)
            .normalize("NFKD")
            .replace(/['’`]/g, "")
            .replace(ACCENTED_LETTER, "$1")
            // Put back together what the split above took apart (Hangul, kana with a voicing mark).
            .normalize("NFC")
            .replace(SEPARATOR, " ")
            .trim()
            .replace(LEADING_NOISE, "")
            .replace(TRAILING_NOISE, "")
    )
}

// Short names match too much in Latin script ("Re", "86"), but two characters is a whole title in
// Chinese, Japanese or Korean.
function longEnough(key: string): boolean {
    return /[^\p{Script=Latin}\p{N} ]/u.test(key) ? key.length >= 2 : key.length >= 3
}

// Every name a title goes by, as match keys.
export function matchNames(title: CatalogTitle): string[] {
    return [...new Set([title.title, ...title.altTitles].map(nameKey))].filter(longEnough)
}

// Whether a site's search hit is this title: it must be one of the title's names, give or take
// punctuation, accents, a leading "The" and format labels. A sequel or spin-off ("Tokyo Ghoul:re",
// "Overgeared 2", "Solo Leveling: Ragnarok") is another work, so containing the name is not enough.
export function resultIsTitle(resultTitle: string, names: readonly string[]): boolean {
    const hit = nameKey(resultTitle)
    return hit.length > 0 && names.includes(hit)
}

// Whether a name is long enough to tie two rows together on its own.
export function isDistinctiveName(name: string): boolean {
    return longEnough(nameKey(name))
}

type IndexedEntry = {
    title: string
    anilistId?: number | undefined
    workId?: string | undefined
    altTitles?: readonly string[] | undefined
}

export type LibraryIndex<T> = { byWorkId: Map<string, T>; byAnilistId: Map<number, T>; byName: Map<string, T> }

// The library keyed once by Work id, AniList id and every name, so checking many titles against it stays cheap.
export function indexLibrary<T extends IndexedEntry>(library: readonly T[]): LibraryIndex<T> {
    const byWorkId = new Map<string, T>()
    const byAnilistId = new Map<number, T>()
    const byName = new Map<string, T>()
    for (const entry of library) {
        if (entry.workId && !byWorkId.has(entry.workId)) byWorkId.set(entry.workId, entry)
        if (entry.anilistId !== undefined && !byAnilistId.has(entry.anilistId)) byAnilistId.set(entry.anilistId, entry)
        for (const name of [entry.title, ...(entry.altTitles ?? [])]) {
            const key = nameKey(name)
            if (key && !byName.has(key)) byName.set(key, entry)
        }
    }
    return { byWorkId, byAnilistId, byName }
}

// The library entry for a catalog title: same Work id, same AniList id, or a whole name in common. Owning a title is an
// exact match on a full name, so a short one ("86") counts here, unlike for a site's search hit.
export function ownedEntry<T>(title: CatalogTitle, index: LibraryIndex<T>): T | undefined {
    if (title.workId !== null) {
        const hit = index.byWorkId.get(title.workId)
        if (hit) return hit
    }
    if (title.anilistId !== null) {
        const hit = index.byAnilistId.get(title.anilistId)
        if (hit) return hit
    }
    for (const name of [title.title, ...title.altTitles]) {
        const key = nameKey(name)
        const hit = key ? index.byName.get(key) : undefined
        if (hit) return hit
    }
    return undefined
}

export function libraryEntryFor<T extends IndexedEntry>(title: CatalogTitle, library: readonly T[]): T | undefined {
    return ownedEntry(title, indexLibrary(library))
}

// The sites the user reads on most, by how many library titles each holds, for "search a site yourself".
export function topReadingHosts(urls: readonly (string | undefined)[], limit = 8): string[] {
    const counts = new Map<string, number>()
    for (const raw of urls) {
        if (!raw) continue
        try {
            const url = new URL(raw)
            if (url.protocol !== "https:" && url.protocol !== "http:") continue
            const host = url.hostname.replace(/^www\./, "")
            counts.set(host, (counts.get(host) ?? 0) + 1)
        } catch {
            // not a link
        }
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit)
        .map(([host]) => host)
}

// The sites offered under "Search a site yourself": the ones the user reads on most, then every listed source
// the title search cannot read itself, so a site the Sources page says to search on the site always has its link
// here, even before any title is filed under it.
// An official site is never named in the app (D6), so it is never one of these chips.
export function siteSearchHosts(
    libraryUrls: readonly (string | undefined)[],
    sourceDomains: readonly string[],
    officialSites: readonly OfficialSite[] = OFFICIAL_SITES_DEFAULT
): string[] {
    const hosts = topReadingHosts(libraryUrls.filter(url => !isOfficialUrl(url, officialSites)))
    for (const domain of sourceDomains) {
        const host = topReadingHosts([`https://${domain}/`])[0]
        if (host && !hosts.includes(host) && !isOfficialHost(host, officialSites)) hosts.push(host)
    }
    return hosts
}

function isOfficialUrl(url: string | undefined, sites: readonly OfficialSite[]): boolean {
    if (!url) return false
    try {
        return isOfficialHost(new URL(url).hostname, sites)
    } catch {
        return false
    }
}

// A site's own search for a title. Most reader sites run on WordPress, whose search is `?s=`; on any
// other site the parameter is ignored and the user lands on the home page, which is no worse.
export function siteSearchUrl(host: string, title: string): string {
    // A lone surrogate (half an emoji, from a title cut short) would make encodeURIComponent throw.
    const wellFormed = title.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    return `https://${host}/?s=${encodeURIComponent(wellFormed)}`
}
