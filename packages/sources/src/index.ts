import { SourceRegistry, type SourceAdapter } from "@amr/source-sdk"
import { mangadexAdapter } from "./mangadex"
import { webtoonsAdapter } from "./webtoons"
import { bundledAdapters } from "./sites"
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
export { siteExtraHosts, siteOrigins } from "./sites"

// The shipped build swaps ./sites for an empty module, which leaves the official sources alone.
export const sourceAdapters: readonly SourceAdapter[] =
    bundledAdapters.length > 0 ? bundledAdapters : [mangadexAdapter, webtoonsAdapter]
export const sourceRegistry = new SourceRegistry(selectAdaptersInScope(sourceAdapters, buildScope))
