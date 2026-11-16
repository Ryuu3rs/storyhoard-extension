# StoryHoard Technical Architecture

Last updated: 2026-08-09

## Scope

This architecture covers the Firefox and Chromium extension plus two workspace Node services: `apps/community-server` (opt-in community stats API, self-hosted) and `apps/metadata-server` (metadata catalog, built but not currently deployed). All reading data stays local to the browser.

## Entry Points

WXT generates browser-specific manifests and bundles:

- background worker
- popup
- full application page
- reader page

There are no declared content scripts; supported-site detection runs in the background over the tabs API, and the on-page chapter prompt is injected on demand with `browser.scripting.executeScript`.

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
- settings
- reader

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
6. Reader opens as an extension-owned page.

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

Handlers are organised by colon-namespaced prefixes (e.g. `chapter:download`, `downloads:list`, `manga:search`, `community:register`, `extension-update:download`). Each handler receives a typed, validated payload and sender, and returns a typed success or error response.

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

## Reader Pipeline

- adapter returns final page descriptors
- current page is prioritized
- continuous mode loads viewport plus lookahead
- default concurrency is four
- errors retry independently
- object URLs are revoked
- decoded images outside the retention window are released
- progress uses intersection observation

Custom image headers require reviewed declarative network rules or a controlled
extension fetch path.

## Update Scheduler

- browser alarm starts a bounded update window
- work is grouped by source
- source rate limits apply
- recently checked records are skipped
- failures back off
- each run has manga and duration budgets
- unfinished work resumes on a later alarm

There is no permanent background loop.

## Community (opt-in)

Off by default. When enabled, the extension syncs anonymous reading events to the community API which computes achievements, a weekly leaderboard, star ratings, recommendations, and trending. Nothing is uploaded unless the user opts in - the username is anonymous and auto-registered, and no personal data or email is collected.

## GitHub Release Check

The extension may request the latest GitHub Release metadata:

- tag
- release URL
- publication date
- release notes summary

The response is validated and cached. The extension may notify the user and open the
release page. It never downloads, installs, or executes release code. An in-app Download update action saves the browser-matching release zip to the Downloads folder via `browser.downloads`; installation stays manual.

## Boundaries

- Svelte components do not fetch source sites.
- source adapters do not call extension APIs.
- repositories do not contain UI state.
- background code does not contain parsing logic.
- archive code is never imported by active packages.
