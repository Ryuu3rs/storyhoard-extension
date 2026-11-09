import { SITE_BASE } from "../account"
import { fetchOfficialOffer, searchCatalog } from "../catalog-search"
import { aniListQuery, findOtherNames } from "../metadata/anilist"
import { resolveSource, type ResolveSourceInput } from "../source-resolver"
import type { HandlerMap } from "../background/handler-types"

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

    "source:resolve": async request => {
        const input: ResolveSourceInput = {
            title: request.title,
            ...(request.anilistId !== undefined ? { anilistId: request.anilistId } : {}),
            ...(request.searchTitles !== undefined ? { searchTitles: request.searchTitles } : {})
        }
        return await resolveSource(input)
    }
}
