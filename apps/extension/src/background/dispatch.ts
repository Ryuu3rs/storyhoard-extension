import { libraryHandlers } from "../handlers/library"
import { updatesSourcesHandlers } from "../handlers/updates-sources"
import { communityHandlers } from "../handlers/community"
import { anilistHandlers } from "../handlers/anilist"
import { dataSyncSettingsHandlers } from "../handlers/data-sync-settings"
import { readerHandlers } from "../handlers/reader"
import { downloadsBookmarksAnalyticsHandlers } from "../handlers/downloads-bookmarks-analytics"
import { suggestionsHandlers } from "../handlers/suggestions"
import { accountHandlers } from "../handlers/account"
import { importHandlers } from "../handlers/import"
import { resolveSourcesHandlers } from "../handlers/resolve-sources"
import { addSourceHandlers } from "../handlers/add-source"
import type { HandlerMap } from "./handler-types"

// Merged dispatch table for every RuntimeRequest variant. TypeScript's structural
// typing can't prove a spread of six Partial<HandlerMap> objects is jointly
// exhaustive even when it genuinely is, so exhaustiveness (every message type has
// exactly one handler, no gaps, no duplicates) is verified at runtime instead -
// see dispatch.test.ts, which checks this against the live runtimeRequestSchema
// discriminated union and each individual group's key count.
export const handlers: HandlerMap = {
    ...libraryHandlers,
    ...updatesSourcesHandlers,
    ...communityHandlers,
    ...anilistHandlers,
    ...dataSyncSettingsHandlers,
    ...readerHandlers,
    ...downloadsBookmarksAnalyticsHandlers,
    ...suggestionsHandlers,
    ...accountHandlers,
    ...importHandlers,
    ...resolveSourcesHandlers,
    ...addSourceHandlers
}

// Exposed only for the exhaustiveness/duplicate-key test - not used by the dispatcher.
export const handlerGroups = {
    libraryHandlers,
    updatesSourcesHandlers,
    communityHandlers,
    anilistHandlers,
    dataSyncSettingsHandlers,
    readerHandlers,
    downloadsBookmarksAnalyticsHandlers,
    suggestionsHandlers,
    accountHandlers,
    importHandlers,
    resolveSourcesHandlers,
    addSourceHandlers
}
