# Development Guide

Last updated: 2026-08-09

## Requirements

- Node.js 22 or newer
- npm 11 or newer
- Firefox
- Chromium

## Install

```powershell
npm install
```

## Environment

Copy `apps/extension/.env.example` to `apps/extension/.env` and set `VITE_COMMUNITY_API_ORIGIN` (builds need it; CI injects the same value from a repository variable). `VITE_METADATA_API_ORIGIN` is optional - when unset the extension resolves metadata via AniList directly.

## Run

```powershell
npm run dev
npm run dev:firefox
```

## Build

```powershell
npm run build
npm run build:firefox
```

## Validate

```powershell
npm run check        # format:check + lint + typecheck + both builds + tests (the CI gate)
npm run typecheck
npm run test
```

## Structure

- `apps/extension`: extension entrypoints and application code
- `apps/community-server`: opt-in community stats API (Hono + SQLite)
- `apps/metadata-server`: metadata catalog service (optional, not currently deployed)
- `packages/contracts`: domain contracts
- `packages/normalize`: shared title normalization
- `packages/source-sdk`: adapter interfaces and parsing support
- `packages/sources`: the official source adapters (the extension bundles no other site)
- `packages/test-fixtures`: deterministic source fixtures
- `tooling/browser-tests`: manifest policy gate and browser tests

## Browser Support

Every feature must be built and tested for both Firefox and Chromium (desktop). Firefox for
Android is not an official target; see [ANDROID.md](../ANDROID.md). Browser-specific
behavior belongs in the platform layer or WXT configuration.
