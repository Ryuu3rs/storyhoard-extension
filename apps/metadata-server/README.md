# @amr/metadata-server

A self-hosted manga **metadata** catalog for StoryHoard. It serves catalog facts
about a title - name, publication status, cover URL, genres, tags, and format
(oneshot flag) - keyed by normalized title or AniList id.

It never stores or serves chapters or page content. Metadata only.

## What it does

The extension resolves a title's metadata through a provider chain (this service
first, AniList directly as a fallback). This server looks a title up once in
AniList, maps the response to the shared `MetadataResult` shape, and caches it in
SQLite so repeated lookups don't hit AniList again. Cached rows go stale after 30
days and are re-fetched on the next request. Confirmed no-matches are cached too
(as `source = 'none'`) so misses don't re-query AniList every time.

AniList is queried **server-side** with a conservative in-process rate limiter
(~1 request / 700ms, under AniList's 90/min budget) and a single retry that
honours a `429` `Retry-After` header.

## API

- `GET /` - service banner
- `GET /health` - `{ ok: true }`
- `GET /metadata/resolve?title=&sourceId=&sourceMangaId=` - resolve by title
  (cache first, then AniList). Returns a `MetadataResult`, or `{ result: null }`
  on a cached/confirmed no-match.
- `GET /metadata/by-anilist/:id` - resolve by AniList media id.
- `POST /metadata/link` `{ normalizedTitle, anilistId }` - pin a normalized title
  to a specific AniList id (`source = 'manual'`).

## Environment

- `DATA_DIR` - directory for `metadata.db` (default `./data`; `/data` in Docker).
- `PORT` - listen port (default `3000`).

## Deploying

Not currently deployed - the extension ships without `VITE_METADATA_API_ORIGIN` set and resolves metadata via AniList directly. To self-host: build from the `Dockerfile` (a `docker-compose.yml` with a persistent `/data` volume is included), put it behind TLS, then set `VITE_METADATA_API_ORIGIN` in `apps/extension/.env` so the extension queries it first.

## Development

```
npm install
npm run dev    # tsx watch
npm test       # node --test (normalize + db round-trip / staleness)
```
