# Source Adapter Authoring Guide

How to add a new manga source (a single site, or a whole template family) to
StoryHoard. Read this before writing any adapter code - most new sources are a
**config row**, not new code.

Key files referenced throughout:

- Contract: `packages/source-sdk/src/types.ts`, errors in `packages/source-sdk/src/errors.ts`
- Config-driven factories: `packages/sources/src/madara.ts`, `mangastream.ts`, `mangabuddy.ts`, `fanfox.ts`
- Their config registries: `packages/sources/src/madara-sites.ts`, `mangastream-sites.ts`, `mangabuddy-sites.ts`, `fanfox-sites.ts`
- Bespoke example: `packages/sources/src/mangadex.ts`
- Registration: `packages/sources/src/index.ts`
- Extension wiring: `apps/extension/src/permissions.ts`, `apps/extension/src/sources.ts`
- Build gate: `tooling/browser-tests/src/manifest-policy.test.js`
- Triage tool: `tooling/source-probe/probe.mjs`, `candidates.json`, `REPORT.md`

---

## 1. The `SourceAdapter` contract

Defined in `packages/source-sdk/src/types.ts`. An adapter is an object with a
`manifest`, a synchronous `match`, and three async resolvers. Two methods are
optional.

| Member                       | Sync? | Job                                                                                                                                                                                                                                                 |
| ---------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest`                   | -     | Static `SourceManifest`: `id`, `name`, `domains[]`, `languages[]`, `capabilities[]` (`"chapters"` / `"manga"` / `"pages"`), `requestRateLimit`, `fixtureVersion`.                                                                                   |
| `match(url)`                 | yes   | Classify a URL as `"chapter"`, `"manga"`, or `"none"`. Must be cheap and pure (regex over `url.pathname` after a domain check). Drives source detection in the popup and `findSource`.                                                              |
| `resolveManga(input, ctx)`   | no    | Given `{ url? , sourceMangaId? }`, return a `SourceManga` (the `MangaRecord` plus `sourceId`, `sourceMangaId`, canonical `url`).                                                                                                                    |
| `listChapters(input, ctx)`   | no    | Given `{ manga, languages?, limit? }`, return `SourceChapter[]` sorted ascending by `sortKey`. Honor `limit` (take the last N).                                                                                                                     |
| `resolveChapter(input, ctx)` | no    | Given `{ url? , sourceChapterId? }`, fetch the chapter page and return `ResolvedChapter` = `{ manga, chapter, pages }`, where `pages` is `{ id, url }[]` of image URLs in reading order.                                                            |
| `resolveCover?(input, ctx)`  | no    | Optional. Return just the cover image URL for a series (by `sourceMangaId` and/or `url`). Used to backfill covers for library entries added by reading a chapter. Should **return `undefined`** on failure, never throw.                            |
| `search?(query, ctx)`        | no    | Optional. Return `SourceSearchResult[]`. Adapters that can't search omit it entirely. Aggregated across all sources by `searchManga` - must **swallow errors and return `[]`**, since sources without granted host permission are expected to fail. |

### Identity and shape conventions

IDs are colon-namespaced and stable across runs:

- manga id: `${sourceId}:manga:${slug}`
- chapter id: `${sourceId}:chapter:${...}`
- page id: `${chapterId}:page:${i + 1}`

`SourceChapter` carries `sortKey` (numeric, for ordering), `language`, and a
`sourceChapterId`. `SourceSearchResult` carries an optional `latestChapter`
label so the UI can show which mirrors are actively updated.

### `SourceContext` and the request client

Every async method receives a `SourceContext`:

```ts
type SourceContext = {
    request: SourceRequestClient // getJson(url, schema, opts) / getText(url, opts) / postForm(url, params, opts) / postJson(url, body, schema, opts)
    now(): number
    logger: { debug; warn }
}
```

`request` is a **bounded** client (`createBoundedRequestClient`): it enforces an
origin allowlist, a max request count, a response-byte cap, and a timeout. You
**cannot** fetch an origin that isn't wired into the allowlist (see §3) - the
request throws. `getJson` validates against a Zod schema; use it for JSON APIs
(see the JSON API adapter). For HTML sources use `getText` / `postForm` and parse with
regex. `postJson` sends a real `application/json` request body (validated
against a Zod schema on the way back) - use it instead of `postForm` when an
API rejects form-urlencoded bodies (see Kagane's integrity/manifest handshake).

---

## 2. Two ways to add a source

### (a) Config row over an existing factory - the default

If the probe (`§4`) detects a known template, you add **one object** to the
relevant `*-sites.ts` file. No new code, no new tests beyond an optional
fixture.

The four factories and their config shapes:

| Template                     | Factory                     | Config type          | Default URL scheme                                                                                           |
| ---------------------------- | --------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------ |
| Madara (WP `wp-manga` theme) | `createMadaraAdapter`       | `MadaraConfig`       | `/manga/<slug>/chapter-N/`                                                                                   |
| MangaStream / `ts` theme     | `createMangaStreamAdapter`  | `MangaStreamConfig`  | `/manga/<slug>/`, chapters at root: `/<...chapter...>/`                                                      |
| MangaBuddy reader            | `createMangaBuddyAdapter`   | `MangaBuddyConfig`   | `/<slug>` (or `/manga/<slug>`), chapter `/<slug>/chapter-N`                                                  |
| FanFox / MangaHere family    | `createFanfoxFamilyAdapter` | `FanfoxFamilyConfig` | `/manga/<slug>/` - images are JS-loaded, so `resolveChapter` returns empty pages (tracking + prev/next only) |

A Madara row, added to the `SITES` array in
`packages/sources/src/madara-sites.ts`:

```ts
{ id: "freakscans", name: "Freak Scans", origin: "https://freakscans.com", domains: ["freakscans.com"] }
```

Config knobs (all four share `id`, `name`, `origin`, `domains`, optional
`language`, optional `rateLimit`):

- **Madara** adds `mangaPath` (URL base segment, default `"manga"`), `chapterPrefix` (default `"chapter"` -> `chapter-12`; Tritinia uses `"ch"`), `volumePath` (accept a `/volume-x/` segment between slug and chapter, used by GD Scans), `preferSrcAttribute` (read `src` before `data-src` for anti-scrape sites), and `capabilities` (set `["chapters"]` for ad-gated sites - tracking works, the reader shows open-on-site).
- **MangaStream** adds `mangaPath` (default `"manga"`).
- **MangaBuddy** adds `mangaPath` (default `"manga"`).
- All families accept `imageOrigins` - extra origin patterns for a cover/page-image CDN on a different host (e.g. `*://*.manhwatop.com/*`). The `*-sites.ts` `*Origins` exports fold these in automatically, so the CDN host gets a host permission without touching `permissions.ts`.

`id` must be unique across the whole registry. `domains` is the host
allowlist that `match` checks via `matchesSourceDomain`; include `www.` and any
apex/sub variants the site actually serves (see Phoenix Scans, which lists both
`phoenixscans.com` and `www.phoenixscans.com`).

Each `*-sites.ts` file maps its `SITES` array into both the adapter list and the
origin list it exports - `madaraAdapters` / `madaraOrigins`,
`mangaStreamAdapters` / `mangaStreamOrigins`,
`mangaBuddyAdapters` / `mangaBuddyOrigins`. Adding the row automatically extends
both, so the origin wiring in §3 picks it up with no extra edit **except** the
manifest-policy test.

### (b) Bespoke adapter - when no template fits

If the site has a JSON API, a non-WordPress structure, or anti-scrape that needs
bespoke handling, write a standalone adapter mirroring
`packages/sources/src/mangadex.ts`. Steps:

1. Create `packages/sources/src/<source>.ts` exporting a `SourceAdapter`
   (a const object or a factory if you expect mirrors).
2. Define constants: `SOURCE_ID`, origins, a URL/ID pattern (for example a
   UUID regex), `MAX_CHAPTERS`, page size.
3. For JSON APIs, declare **Zod schemas** for every response and fetch with
   `context.request.getJson(url, schema)`. Schema validation gives you the
   `invalid-response` error path for free.
4. Implement `match` (pure regex over the path, after `matchesSourceDomain`),
   then `resolveManga`, `listChapters` (paginate up to a cap), `resolveChapter`
   (build `pages` from the API/HTML), and optionally `resolveCover` / `search`.
5. Map provider fields into the contract shapes with stable IDs.
6. Register it (§3) and add a fixture test (`<source>.test.ts`).

---

## 3. End-to-end wiring checklist

When adding a site or family, touch these in order. **The manifest-policy test
is a hard build gate - skipping it fails CI.**

1. **Register the adapter** in `packages/sources/src/index.ts`.
    - Config row: nothing to do - it flows in via `madaraAdapters` /
      `mangaStreamAdapters` / `mangaBuddyAdapters`, already spread into
      `sourceAdapters`.
    - Bespoke: `import` it, add to the `sourceAdapters` array, and re-`export` it.

2. **Export origins.** Config rows: the `*-sites.ts` `*Origins` export updates
   automatically. Bespoke: add the origin(s) to `BASE_SOURCE_ORIGINS` in
   `apps/extension/src/permissions.ts`.

3. **Host permissions / `SOURCE_ORIGINS`** in
   `apps/extension/src/permissions.ts`. `SOURCE_ORIGINS` already concatenates
   `madaraOrigins` / `mangaStreamOrigins` / `mangaBuddyOrigins`, so config rows
   need no edit here. Bespoke origins go in `BASE_SOURCE_ORIGINS`. Origins are
   `https://<host>/*` (or `*://*.<host>/*` for CDN wildcards).

4. **Bounded-client allowlist** in `apps/extension/src/sources.ts`
   (`createSourceContext` → `allowedOrigins`). The three families are spread in
   already (with the trailing `/*` stripped). Bespoke sources need their origin
   added here too, or every request will be rejected by the bounded client.

5. **Manifest-policy gate (REQUIRED).** Add the new origin(s) to
   `allowedOptionalHosts` in
   `tooling/browser-tests/src/manifest-policy.test.js`. This array is asserted
   `deepEqual` against the built manifest's `optional_host_permissions`, **after
   a `.sort()`** - so insert each origin in its correct sorted position and keep
   the array alphabetically sorted. Any added origin not listed here (or any
   stale entry) **fails the build**. Add the same `https://<host>/*` strings you
   put in `SOURCE_ORIGINS`, including every `domains` variant (e.g. both
   `phoenixscans.com` and `www.phoenixscans.com`). This includes any `imageOrigins` patterns - every origin the config contributes must appear in `allowedOptionalHosts`.

6. **Fixture tests.** Add `packages/sources/src/<source>.test.ts` mirroring the
   existing ones. The pattern (see `madara.test.ts`): instantiate the adapter,
   build a `SourceContext` whose `fetch` returns canned HTML keyed by pathname,
   and assert `match`, `resolveChapter` page URLs, `sortKey`, title, and cover.
   For a config row, add a config entry to the factory's existing test (or a new
   synthetic-site test) proving any non-default `mangaPath` / `chapterPrefix`
   parses correctly.

---

## 4. Triage a candidate first (`source-probe`)

Before wiring anything, run the probe to classify anti-scrape posture and CMS
template:

```bash
npm run probe -w @amr/source-probe
```

It reads `tooling/source-probe/candidates.json` (add your candidate as a row:
`{ url, name, priority, cmsGuess }`), fetches each site once with a browser UA,
and writes `output/report.{json,md}`. See `tooling/source-probe/probe.mjs` for
the signature regexes and `REPORT.md` for a sample run.

**Verdict policy** (score 0-5, starts at 5 and subtracts for friction):

- **green (≥4)** - reachable, no/weak anti-scrape. If it also matches a known
  template (`madara` / `mangastream` / `mangabuddy` in `cmsDetected`), it's a
  **config row**. Add it to the matching `*-sites.ts`.
- **yellow (2-3)** - soft Cloudflare, captcha, or DDoS-Guard. Revisit later with
  a content-script / cookie strategy; do not add a plain config row.
- **red (≤1)** - hard Cloudflare/Turnstile challenge, 4xx, or unreachable.
  **Skip.** A server-side `fetch` adapter cannot pass the challenge; prefer
  Suwayomi-style handling instead of an adapter.

Cloudflare/Turnstile/captcha each cost −3, DDoS-Guard −2; a matched template or
image hints each add +1. The probe is a hint, not a guarantee - always confirm a
live chapter resolves before relying on a green site.

---

## 5. Image-extraction lessons learned

These are encoded in the factories; match them when writing bespoke code.

- **Madara - read `src` before `data-src`.** Anti-scrape Madara sites put the
  _real_ URL in `src` and junk (a data-URI or thumbnail) in `data-src`. The
  `id="image-N"` strategy in `extractImagesFromHtml`
  (`madara.ts`) reads `src` first. Other Madara strategies (`wp-manga-chapter-img`,
  `page-break` divs) read `data-src` first because those are the lazy-load
  attribute. The factory also tries an **AJAX path first**
  (`admin-ajax.php?action=manga_get_chapter_img_list`, using a scraped
  `chapter_id` + nonce) to bypass the static-HTML data-src traps, then falls back
  to HTML. Reject WordPress thumbnail suffixes (`-150x150.`).
- **MangaStream - the `ts_reader` blob.** `extractStreamImages` (`mangastream.ts`)
  parses the `ts_reader.run({ ... sources:[{ images:[] }] })` JSON first, then
  falls back to `<img>` tags inside `#readerarea`.
- **MangaBuddy / mgeko - JS var arrays.** `extractBuddyImages`
  (`mangabuddy.ts`) reads a JS variable (`chapImages` / `chapterImages` /
  `images`) holding a JSON array or comma-separated string, then falls back to
  `#chapter-images` / `.chapter-content` containers, then to any CDN-pattern
  `<img>`. mgeko (`mgeko.ts`) likewise parses a JS array, tolerating
  single-quoted strings by swapping quotes before `JSON.parse`.
- **Scope to the reading container.** Always narrow the HTML to the reading
  region before scanning `<img>` tags - Madara scopes to `.reading-content`
  (gallery-dl-confirmed to exclude sidebar/header junk), MangaStream to
  `#readerarea`, MangaBuddy to `#chapter-images` / `.chapter-content`. Unscoped
  scans pull in ads and UI chrome.

---

## 6. Coding conventions

- **`captureGroup` helper.** The repo runs `noUncheckedIndexedAccess`, so
  `match[i]` is `string | undefined`. Every adapter defines a `captureGroup`
  helper that narrows a regex capture to `string | undefined`; use it instead of
  indexing match arrays directly.
- **Attribute-order-safe regex.** Don't assume HTML attribute order. The
  `getImgAttr` helper tries each attribute name with both quote styles, and the
  cover/`og:image` extractors list both `property="..." content="..."` and the
  reversed `content="..." property="..."` orderings. Mirror this when you scrape
  meta tags or tag attributes.
- **`matchesSourceDomain` before any path regex.** Every `match`/slug helper
  domain-checks the hostname first so foreign URLs classify as `"none"`.
- **Graceful throws with a short diagnostic.** When extraction yields nothing,
  throw `new SourceError("invalid-response", ...)` with a compact diagnostic -
  the factories include the body length and a Cloudflare flag, e.g.
  `No images found [html:1234b cf=false]`. Use `"invalid-input"` for a missing/
  bad input and `"unsupported-url"` when a URL doesn't match this source. Error
  codes live in `packages/source-sdk/src/errors.ts`.
- **Optional methods fail soft.** `resolveCover` returns `undefined` and
  `search` returns `[]` on any error - they must never reject, because both are
  called best-effort across many sources (cover backfill, aggregate search).
- **Rate limits.** Default `{ requests: 3, intervalMs: 1000 }` for the
  HTML factories, higher for JSON APIs (for example 5/1000). Tune per site via
  the config `rateLimit`.
