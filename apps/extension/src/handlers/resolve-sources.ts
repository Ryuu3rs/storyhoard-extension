import { findOtherNames } from "../metadata/anilist"
import { resolveSource, type ResolveSourceInput } from "../source-resolver"
import type { HandlerMap } from "../background/handler-types"

// Read-only tracker-first source resolution: given a title (and optionally an
// AniList id and/or explicit search-title variants), returns ranked live-source
// candidates and a confidence, writing nothing. Adopting a candidate into the
// library is a separate, later message.
export const resolveSourcesHandlers: HandlerMap = {
    "search:other-names": async request => findOtherNames(request.term),

    "source:resolve": async request => {
        const input: ResolveSourceInput = {
            title: request.title,
            ...(request.anilistId !== undefined ? { anilistId: request.anilistId } : {}),
            ...(request.searchTitles !== undefined ? { searchTitles: request.searchTitles } : {})
        }
        return await resolveSource(input)
    }
}
