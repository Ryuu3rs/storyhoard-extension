import { SITE_BASE } from "../account"
import { summarizeChapters } from "../chapter-summary"
import { getSettings } from "../settings"
import { chaptersForLanguage, listChaptersBySource } from "../sources"
import { fetchOfficialOffer, searchCatalog } from "../catalog-search"
import { createWeebDiscoverSource } from "../weeb-discover"
import { aniListQuery, findOtherNames } from "../metadata/anilist"
import { resolveSource, type ResolveSourceInput } from "../source-resolver"
import type { HandlerMap } from "../background/handler-types"

const DISCOVER_CACHE_KEY = "weebDiscoverCache"

const weebDiscover = createWeebDiscoverSource({
    siteBase: SITE_BASE,
    fetch: (...args) => fetch(...args),
    now: () => Date.now(),
    store: {
        read: async () => (await browser.storage.local.get(DISCOVER_CACHE_KEY))[DISCOVER_CACHE_KEY],
        write: async entry => browser.storage.local.set({ [DISCOVER_CACHE_KEY]: entry })
    }
})

// Read-only tracker-first source resolution: given a title (and optionally an
// AniList id and/or explicit search-title variants), returns ranked live-source
// candidates and a confidence, writing nothing. Adopting a candidate into the
// library is a separate, later message.
export const resolveSourcesHandlers: HandlerMap = {
    "search:other-names": async request => findOtherNames(request.term),

    // Which title the user means: the shared catalog, with AniList standing in when it can't answer.
    // Adult titles are never returned.
    "catalog:search": async request =>
        searchCatalog({ siteBase: SITE_BASE, fetch: (...args) => fetch(...args), aniList: aniListQuery }, request.term),

    // The best legal place to read or buy that title, for the "Where to read" list.
    "catalog:offer": async request =>
        (await fetchOfficialOffer({ siteBase: SITE_BASE, fetch: (...args) => fetch(...args) }, request.id)) ?? null,

    // weeb.ltd's public Discover rails, for a library too small to recommend from. Cached for ten minutes.
    "discover:weeb": async request => weebDiscover.get(request.force === true),

    // How far one of the user's sites has got with a title found in search, so a behind or stalled site
    // shows before the title is tracked. Reads the site's chapter list once and stores nothing.
    "catalog:site-chapters": async request => {
        const { language } = await getSettings()
        const chapters = await listChaptersBySource(request.sourceId, request.sourceMangaId, request.url)
        return summarizeChapters(chaptersForLanguage(chapters, language))
    },

    "source:resolve": async request => {
        const input: ResolveSourceInput = {
            title: request.title,
            ...(request.anilistId !== undefined ? { anilistId: request.anilistId } : {}),
            ...(request.searchTitles !== undefined ? { searchTitles: request.searchTitles } : {})
        }
        return await resolveSource(input)
    }
}
