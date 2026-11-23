# StoryHoard Technical Architecture

Last updated: 2026-11-23

## Scope

This architecture covers the Firefox and Chromium extension plus two workspace Node services: `apps/community-server` (opt-in community stats API, self-hosted) and `apps/metadata-server` (metadata catalog, built but not currently deployed). The library stays local to the browser. Anonymous usage stats are on by default and turned off in Settings; community and sync features send nothing until the user turns them on. `apps/extension/src/privacy-policy.ts` (shown in Settings) and weeb.ltd/legal/privacy list every network request.

## Entry Points

WXT generates browser-specific manifests and bundles:

- background worker
- popup
- full application page
- `weeb-bridge` content script, on weeb.ltd only

The shipped build has no in-app reader: reading happens on the source's own page. The reader entrypoint stays in the tree for the development build (`VITE_ARCH_TRACK=A`) only. Supported-site detection runs in the background over the tabs API, and the on-page chapter prompt is injected on demand with `browser.scripting.executeScript`.

The extension uses Manifest V3. Firefox-specific manifest values are generated only for
Firefox builds.

## Modules

### Domain

- manga
- source links
- chapters
- pages
- progress
- bookmarks
- history
- reading status
- source health

Domain code imports no browser or Svelte APIs.

### Application Services

Background logic is organised as typed message handler maps in `apps/extension/src/handlers/` (library, reader, updates-sources, anilist, community, suggestions, downloads-bookmarks-analytics), dispatched by `src/background/dispatch.ts`.

### Platform

- browser API wrapper
- permissions
- alarms
- tabs
- runtime messages
- content script registration
- declarative network rules
- notifications
- GitHub release check

### UI

- popup
- application shell
- library
- search
- updates
- achievements
- sources
- discover
- settings

Svelte components call application services. They do not call IndexedDB or third-party
sites directly.

## Source SDK

An adapter has a `manifest`, a synchronous `match(url)` that returns `"chapter" | "manga" | "none"`, optional `search` and `resolveCover` methods, and three required async methods: `resolveManga`, `listChapters`, `resolveChapter`. `SourceContext` provides the bounded request client, `now()`, and a logger. See `packages/source-sdk/src/types.ts` for the full contract.

Adapters cannot access storage, Svelte state, runtime messages, or arbitrary browser APIs.

## Generic Source Templates

Generic templates are declarative:

- domains
- CSS selectors
- text or allowed attribute extraction
- URL resolution
- chapter ordering
- pagination selector
- language

Templates cannot include JavaScript, executable expressions, unrestricted headers,
cookie access, or remote code.

## Page Detection

1. Background receives a tab URL.
2. Source registry checks domain and URL patterns.
3. Unmatched tabs get nothing; matched tabs get a one-shot injected chapter prompt (no persistent content script).
4. Confirmed manga or chapter metadata is resolved.
5. Chapter visits upsert the local library when auto-add is enabled.
6. Reading stays on the site's own page.

The original website DOM remains intact.

## Storage

Dexie tables (v11):

- `manga`
- `sourceLinks`
- `chapters`
- `progress`
- `historyEvents`
- `downloads`
- `covers`
- `pageBookmarks`
- `analyticsEvents`
- `backups`
- `logs`

Preferences use `browser.storage.local`.

Rules:

- normalized records only
- no framework proxies
- no image DOM objects
- no raw HTML persistence
- no full chapter list embedded inside a manga record
- versioned migrations
- versioned import and export envelopes

## Reading Status

`unread`, `reading`, `paused`, `dropped`, `planning`, `completed`. Completed is derived (series finished and read to the latest known chapter); paused, dropped, and planning are explicit user overrides; an optional auto-pause window pauses titles with no reads for N days. Local activity wins: reading a chapter clears an override.

## AniList Sync

Token-based connect. Imports the user's AniList list (per-status opt-outs), pushes local progress without ever lowering the remote count, reconciles statuses in both directions, and optionally mirrors list membership (adding unread titles as planning, removing deleted ones).

## Runtime Messages

Handlers are organised by colon-namespaced prefixes (e.g. `manga:search`, `community:status`, `extension-update:download`). Each handler receives a typed, validated payload and sender, and returns a typed success or error response.

There is no generic dispatcher that executes arbitrary method names.

## Request Client

Features:

- abort signal
- timeout
- source rate limit
- bounded retry with jitter
- response size limit
- MIME validation
- redirect limit
- structured timing
- redacted diagnostics

Default limits:

- metadata timeout: 15 seconds
- image resolution timeout: 20 seconds
- transient retries: two
- HTML response: 5 MB
- JSON response: 10 MB

## Update Scheduler

- browser alarm starts a bounded update window
- work is grouped by source
- source rate limits apply
- recently checked records are skipped
- failures back off
- each run has manga and duration budgets
- unfinished work resumes on a later alarm

There is no permanent background loop.

## weeb.ltd Services

Title search (`/api/public/search`, AniList as fallback), Discover rails (`/api/public/discover`, `/api/public/picks`), cover lookup, the official-sites list and anonymous usage stats go to weeb.ltd. Discover rails lead for a library under five titles and sit below the personal rails otherwise. Account sync runs only after the user links an account.

## Usage Stats

On by default. The first app open shows the one-line notice ("We collect anonymous usage stats. Turn them on or off in Settings.") with OK and Off; nothing is sent before it has been shown. On Firefox the browser's own data permission must also allow it.

## Community

Off until the user accepts the community consent card, shown on Stats and Settings (never on the same page as the usage notice). Turn on stamps the consent version and registers an anonymous auto-generated username; No thanks records the choice, sends nothing and hides the card for good. An opt-in from before the current card version reads as off until the card is accepted again. On Firefox, turning community on also asks for the matching data permission. The community API computes achievements, a weekly leaderboard, star ratings, recommendations and trending; no email is collected.

## GitHub Release Check

The extension may request the latest GitHub Release metadata:

- tag
- release URL
- publication date
- release notes summary

Only a Chromium copy loaded unpacked checks: Firefox updates through AMO, and a copy with an `update_url` (a store install) through its store (`src/self-update.ts`). The response is validated and cached. The app can show the release page and a Download update action, which asks for the optional `downloads` permission in that click and saves the matching release zip to the Downloads folder. It never installs or executes release code.

## Boundaries

- Svelte components do not fetch source sites.
- source adapters do not call extension APIs.
- repositories do not contain UI state.
- background code does not contain parsing logic.
