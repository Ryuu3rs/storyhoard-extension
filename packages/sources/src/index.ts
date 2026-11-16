import { SourceRegistry, type SourceAdapter } from "@amr/source-sdk"
import { mangadexAdapter } from "./mangadex"
import { webtoonsAdapter } from "./webtoons"
import { siteAdapters } from "./sites"
import { buildScope, selectAdaptersInScope } from "./build-scope"

export {
    OFFICIAL_SOURCE_IDS,
    buildScope,
    isScopeActive,
    isSourceInScope,
    parseBuildScope,
    selectAdaptersInScope,
    type BuildScope
} from "./build-scope"
export { mangadexAdapter } from "./mangadex"
export { webtoonsAdapter } from "./webtoons"
export { siteAdapters, siteExtraHosts, siteOrigins } from "./sites"

export const sourceAdapters: readonly SourceAdapter[] = [mangadexAdapter, webtoonsAdapter, ...siteAdapters]
export const sourceRegistry = new SourceRegistry(selectAdaptersInScope(sourceAdapters, buildScope))
