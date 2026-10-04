import type { LiveScope } from "../live"
import type { RuntimeRequest } from "../runtime"

// One entry per RuntimeRequest type whose handler mutates data that a live-bus
// subscriber (App.svelte's library/reader tab, reader/App.svelte) cares about.
// The dispatcher (entrypoints/background.ts) looks this up after a handler
// resolves successfully and calls publishLive(scopes, ...) automatically - see
// that file for the exact call site.
//
// A type is deliberately absent from this map (and present in READ_ONLY_TYPES
// instead) when either:
//   - it doesn't mutate anything (a genuine read), or
//   - it mutates storage that no LiveScope-driven UI reads (e.g. sync config,
//     analytics events, community profile/rank - none of "library", "chapters",
//     "progress" cover them, and inventing a scope for them would just cause
//     spurious refreshes), or
//   - the mutation it causes is already published from elsewhere, so an entry
//     here would double-publish:
//       - "page:capture" and "chapter:open-in-reader" both funnel through
//         captureChapter(), which itself calls publishLive() on both success
//         paths (the scraped branch and the external-tracking fallback for
//         anti-scrape/spoiler/dead-CDN sources - see background/capture.ts) -
//         same for the auto-capture path in entrypoints/background.ts's
//         tabs.onUpdated listener, which doesn't go through the dispatcher at
//         all.
//       - "reader:chapters" self-publishes on every path that writes
//         db.chapters: the getChapterListUrl branch triggers
//         scheduleChapterListRefresh(), which publishes from
//         background/chapter-cache.ts once its bulkPut commits, and the
//         standard-fetch fallback (listChaptersBySource) publishes directly
//         after its own bulkPut in handlers/reader.ts.
//       - "reader:resolve"'s bot-blocked fallback branch mines sibling episodes
//         via mineAndCacheEpisodesFromHtml(), which publishes on its own once that
//         write commits (see background/chapter-cache.ts). Its own chapter put +
//         optional coverUrl backfill (saveReaderResolvedChapter) is published from
//         MUTATION_SCOPES below with ["chapters", "library"] - the "library" scope
//         is what covers the coverUrl backfill a chapters-only publish would miss.
//       - "chapter:adjacent"'s two stale-cache-refresh branches each publish
//         directly after their own db.chapters.bulkPut in handlers/library.ts.
//       - "updates:check" only kicks off checkUpdates() fire-and-forget; the
//         actual per-title mutations publish from inside that loop (see
//         handlers/updates-sources.ts).
//       - "library:link-url"'s synchronous part (linking the manga to a new
//         source/URL) is covered here with ["library"], but its fire-and-forget
//         background chapter fetch publishes manually from within the handler
//         (handlers/library.ts) since it completes after the response already
//         went out.
//   - "settings:update" specifically: settings already live under a single
//     "settings" key in storage.local, so pages watch storage.onChanged for
//     that key directly instead of going through the live bus (see
//     entrypoints/app/App.svelte and entrypoints/reader/App.svelte).
export const MUTATION_SCOPES: Partial<Record<RuntimeRequest["type"], LiveScope[]>> = {
    "library:remove": ["library"],
    "library:clear": ["all"],
    "library:clear-history": ["all"],
    "library:rate": ["library"],
    "library:manual": ["library"],
    "library:hold": ["library"],
    "library:status": ["library"],
    "library:nsfw": ["library"],
    "library:categories": ["library"],
    "library:numbers": ["library"],
    "library:dismiss": ["library"],
    "anilist:import": ["library"],
    "library:merge": ["library", "chapters", "progress"],
    "library:cleanup:apply": ["library", "chapters", "progress"],
    "library:relink": ["library", "chapters"],
    "library:link-url": ["library"],
    "library:switch": ["library", "chapters"],
    // Background auto-resolve sweep adopts sources via library:switch, so it writes the
    // same scopes; a library refresh after it runs picks up every adopted row at once.
    "import:resolve": ["library", "chapters"],
    // Site deep-link adds a title then adopts a source (same writes as import:resolve).
    "site:open": ["library", "chapters"],
    "library:add": ["library", "chapters"],
    "library:quick-add": ["library"],
    "library:covers:backfill": ["library"],
    "library:metadata:backfill": ["library"],
    "library:note": ["library"],
    "library:reading-prefs": ["library"],
    "data:import": ["all"],
    "import:reader": ["library"],
    "data:seed": ["all"],
    "data:backup:restore": ["all"],
    "sync:pull": ["all"],
    "reader:resolve": ["chapters", "library"],
    "reader:progress": ["progress"],
    "bookmark:toggle": ["progress"],
    "bookmark:remove": ["progress"],
    "chapter:download": ["library"],
    "chapter:download:remove": ["library"],
    "chapter:track": ["library", "chapters"],
    // Linking runs a first sync inline; a manual sync may create/update/remove titles.
    "account:link": ["library", "chapters"],
    "account:sync": ["library", "chapters"]
}

// Every RuntimeRequest type that either performs no mutation, or mutates data
// outside the live bus's scope (see the comment above MUTATION_SCOPES for why
// each of these is here rather than there). Kept as an explicit set (rather
// than "everything not in MUTATION_SCOPES") so mutation-scopes.test.ts can
// assert every type is accounted for exactly once with no gaps.
export const READ_ONLY_TYPES: ReadonlySet<RuntimeRequest["type"]> = new Set<RuntimeRequest["type"]>([
    "library:list",
    "library:get",
    "library:cleanup:scan",
    "stats:get",
    "history:list",
    "chapter:adjacent",
    "chapter:resume",
    "activity:get",
    "data:export",
    "data:import:preview",
    "data:backup:list",
    "sync:status",
    "sync:config",
    "sync:push",
    "anilist:status",
    "anilist:config",
    // anilist:sync is fire-and-forget and publishes ["library"] itself once the
    // background push finishes, so it belongs here rather than in MUTATION_SCOPES
    // (same pattern as updates:check).
    "anilist:sync",
    "log:export",
    "manga:search",
    "manga:chapters",
    "manga:genres",
    "source:permission:check",
    "sources:list",
    "sources:ping",
    "sources:health",
    "updates:check",
    "updates:get",
    "extension-update:check",
    "extension-update:download",
    "updates:new-chapters",
    "page:current",
    "page:capture",
    "chapter:siblings",
    "analytics:record",
    "analytics:summary",
    "reader:chapters",
    "reader:progress:get",
    "bookmark:pages",
    "bookmark:list",
    "chapter:open-in-reader",
    // ARCH TRACK A: both only open a tab / read the version pool - no DB write, no live-bus event
    // (same rationale as chapter:open-in-reader just above).
    "work:open-best",
    "work:best-for-url",
    "work:chapter-list",
    // Writes version-pool rows (a device-local ranking cache) but publishes no live event; the next
    // library:list / panel open reads the fresh pool.
    "work:record-mirrors",
    "chapter:download:get",
    "downloads:list",
    "community:status",
    "community:register",
    "community:toggle",
    "community:decline",
    "community:delete-data",
    "community:sync",
    "community:rate",
    "community:manga-stats",
    "community:announcements",
    "community:trending",
    // account profile reads/writes live in storage.local; no live-bus scope covers them.
    "account:status",
    "source:info",
    // source:resolve runs aggregate source search + scoring and returns candidates.
    // It writes nothing (adopting a result is a separate, later message), so no
    // live-bus scope applies.
    "source:resolve",
    "account:unlink",
    "suggestions:get",
    "suggestions:continue",
    // hide/unhide persist a small storage.local set the Discover tab re-reads on its own
    // suggestions:get; no live-bus scope covers Discover, so they belong here not in
    // MUTATION_SCOPES (same rationale as community profile writes).
    "suggestions:hide",
    "suggestions:unhide",
    "settings:get",
    "settings:update"
])
