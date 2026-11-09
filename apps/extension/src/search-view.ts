import { normalizeTitle } from "@amr/normalize"
import type { CatalogTitle } from "./catalog-search"

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

// A name reduced to the letters and digits a site cannot get wrong: "Level-Up" and "Level Up",
// "Reader's" and "Readers", "Pokémon" and "Pokemon" all compare equal.
function nameKey(name: string): string {
    return (
        normalizeTitle(name)
            .normalize("NFKD")
            .replace(/\p{M}+/gu, "")
            // Put Hangul (decomposed into its letters above) back together, so names compare as stored.
            .normalize("NFC")
            .replace(/['’`]/g, "")
            .replace(/[^\p{L}\p{N}]+/gu, " ")
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

// The library entry for a catalog title: same AniList id, or the same name.
export function libraryEntryFor<T extends { title: string; anilistId?: number | undefined }>(
    title: CatalogTitle,
    library: readonly T[]
): T | undefined {
    const names = new Set(matchNames(title))
    return library.find(
        entry => (title.anilistId !== null && entry.anilistId === title.anilistId) || names.has(nameKey(entry.title))
    )
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

// A site's own search for a title. Most reader sites run on WordPress, whose search is `?s=`; on any
// other site the parameter is ignored and the user lands on the home page, which is no worse.
export function siteSearchUrl(host: string, title: string): string {
    // A lone surrogate (half an emoji, from a title cut short) would make encodeURIComponent throw.
    const wellFormed = title.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    return `https://${host}/?s=${encodeURIComponent(wellFormed)}`
}
