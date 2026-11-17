import type { CatalogMediaType } from "./catalog-search"
import { sanitizePageText } from "./page-text"

// "Search the web" hands a title's name to the browser's own default search engine, in a new tab. The
// extension never picks the engine and never sees the results. It needs the optional "search" permission,
// which the click asks for. Firefox for Android has no search API, so the button is not shown there.

export const WEB_SEARCH_PERMISSION: { permissions: "search"[] } = { permissions: ["search"] }

const MEDIA_WORD: Partial<Record<CatalogMediaType, string>> = {
    manga: "manga",
    manhwa: "manhwa",
    manhua: "manhua",
    webtoon: "webtoon",
    novel: "novel"
}

// The title's name, plus its media type word when known ("Solo Leveling manhwa"). Nothing else.
export function webSearchText(title: { title: string; mediaType: CatalogMediaType | null }): string {
    const name = sanitizePageText(title.title, 150)
    if (!name) return ""
    const word = title.mediaType ? MEDIA_WORD[title.mediaType] : undefined
    return word && !name.toLocaleLowerCase("en").includes(word) ? `${name} ${word}` : name
}

type SearchApi = {
    query?: (options: { text: string; disposition?: string }) => Promise<void> | void
    search?: (options: { query: string; disposition?: string }) => Promise<void> | void
}

// Chrome's search.query and Firefox's search.search both use the default engine.
export async function runWebSearch(
    api: SearchApi | undefined,
    text: string,
    browserName: string | undefined
): Promise<boolean> {
    if (!api || !text) return false
    try {
        if (browserName === "firefox" && typeof api.search === "function") {
            await api.search({ query: text, disposition: "NEW_TAB" })
            return true
        }
        if (typeof api.query === "function") {
            await api.query({ text, disposition: "NEW_TAB" })
            return true
        }
        return false
    } catch {
        return false
    }
}

export const webSearchAvailable = (os: string | undefined): boolean => os !== "android"
