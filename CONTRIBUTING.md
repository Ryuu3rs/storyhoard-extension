# Contributing

## Setup

```powershell
npm install
npm run check
```

## Project Rules

- New product code belongs in `apps/`, `packages/`, or `tooling/`.
- Do not modify archived implementations except to document them.
- Source adapters require fixtures and normalized output tests.
- Any change to an adapter parsing regex requires re-capturing the relevant fixture from the live site the same day and bumping its `FIXTURE_META.capturedAt` (in `packages/sources/src/__fixtures__/`). Stale fixtures hide live-site drift, and the `fixture-meta` guard test enforces that every fixture stays stamped.
- Firefox and Chromium builds must both pass.
- Do not add global host permissions.
- Do not add remote executable code, `eval`, or user-supplied JavaScript.
- Keep changes scoped and update the roadmap when completing a tracked item.

## Commit & PR titles

This repo uses [Conventional Commits](https://www.conventionalcommits.org/). Because
PRs are squash-merged, the **PR title** becomes the commit message and must follow the
format `type(scope): summary`, e.g. `fix(reader): restore progress on resume`.

Allowed types: `feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `ci`,
`build`, `revert`. Use `feat!:` or a `BREAKING CHANGE:` footer for breaking changes.
A CI check validates the PR title.

## Pull Requests

Pull requests must include:

- purpose and user-visible behavior
- tests performed
- screenshots for UI changes
- permission changes
- source fixture changes
- remaining risks

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please).

1. Land PRs to `main` with conventional titles.
2. release-please maintains a **Release PR** that bumps the version in
   `package.json` and updates `CHANGELOG.md` from the commit history.
3. Merging that Release PR tags `vX.Y.Z`; the workflow builds both browsers, runs the full check gate, and uploads the Chrome and Firefox zips plus checksums. It then starts the separate `amo-submit` workflow, which signs that Firefox build and attaches the `.xpi`.

Versioning is single-version semver across the monorepo. While pre-1.0, minor bumps
may contain breaking changes. Firefox AMO signing runs only when the `AMO_JWT_ISSUER`
and `AMO_JWT_SECRET` repository secrets are set; otherwise it is skipped.
