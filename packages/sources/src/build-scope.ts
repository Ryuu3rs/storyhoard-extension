import type { SourceAdapter } from "@amr/source-sdk"

// Which bundled adapters a build registers. A normal (shipped) build keeps only the official sources;
// users add every other site themselves. VITE_BUNDLED=1 keeps every adapter, for local testing only,
// and VITE_EXCLUDE_SOURCES=a,b drops named ids from either kind.

// The bundled adapters on official partner sites, which stay in every build. Kept equal to what
// OFFICIAL_SITES_DEFAULT matches by a test in the extension, which owns that list.
export const OFFICIAL_SOURCE_IDS: readonly string[] = ["mangadex", "webtoons"]

export type BuildScope = {
    bundled: boolean
    excluded: readonly string[]
}

type BuildEnv = Readonly<Record<string, string | undefined>>

export function parseBuildScope(env: BuildEnv): BuildScope {
    return {
        bundled: env["VITE_BUNDLED"] === "1",
        excluded: (env["VITE_EXCLUDE_SOURCES"] ?? "")
            .split(",")
            .map(id => id.trim())
            .filter(id => id !== "")
    }
}

// Vite inlines import.meta.env into the bundle; wxt.config.ts loads this module in Node, where only
// process.env exists, and the test runner sets its scope through process.env as well.
function currentEnv(): BuildEnv {
    const node = (globalThis as { process?: { env?: BuildEnv } }).process?.env ?? {}
    const bundled = (import.meta as unknown as { env?: BuildEnv }).env ?? {}
    return { ...node, ...bundled }
}

export const buildScope: BuildScope = parseBuildScope(currentEnv())

export function isScopeActive(scope: BuildScope): boolean {
    return !scope.bundled || scope.excluded.length > 0
}

export function isSourceInScope(sourceId: string, scope: BuildScope = buildScope): boolean {
    if (scope.excluded.includes(sourceId)) return false
    return scope.bundled || OFFICIAL_SOURCE_IDS.includes(sourceId)
}

// A misspelled id would quietly test a build that still has the adapter, so it fails the build.
export function selectAdaptersInScope(adapters: readonly SourceAdapter[], scope: BuildScope): readonly SourceAdapter[] {
    if (!isScopeActive(scope)) return adapters
    const unknown = scope.excluded.filter(id => !adapters.some(adapter => adapter.manifest.id === id))
    if (unknown.length > 0) throw new Error(`VITE_EXCLUDE_SOURCES names unknown source(s): ${unknown.join(", ")}`)
    return adapters.filter(adapter => isSourceInScope(adapter.manifest.id, scope))
}
