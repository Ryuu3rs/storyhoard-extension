import type { SourceAdapter } from "@amr/source-sdk"
import { describe, expect, it } from "vitest"
import {
    OFFICIAL_SOURCE_IDS,
    parseBuildScope,
    selectAdaptersInScope,
    siteAdapters,
    sourceAdapters,
    sourceRegistry
} from "./index"

const ids = (adapters: readonly { manifest: { id: string } }[]) => adapters.map(adapter => adapter.manifest.id)
const fake = (id: string) => ({ manifest: { id } }) as unknown as SourceAdapter

// The official adapters plus two made-up sites, standing in for what the local testing build adds from
// the private site lab.
const withSites: readonly SourceAdapter[] = [...sourceAdapters, fake("site-a"), fake("site-b")]

describe("build scope", () => {
    it("the repository bundles the official sources and no site adapters", () => {
        expect(siteAdapters).toEqual([])
        expect(ids(sourceAdapters).sort()).toEqual([...OFFICIAL_SOURCE_IDS].sort())
        expect(ids(sourceRegistry.list()).sort()).toEqual([...OFFICIAL_SOURCE_IDS].sort())
    })

    it("a shipped build keeps only the official sources", () => {
        const selected = selectAdaptersInScope(withSites, parseBuildScope({}))
        expect(ids(selected).sort()).toEqual([...OFFICIAL_SOURCE_IDS].sort())
    })

    it("only the value 1 turns the local bundled build on", () => {
        for (const value of ["", "0", "true"]) {
            const selected = selectAdaptersInScope(withSites, parseBuildScope({ VITE_BUNDLED: value }))
            expect(ids(selected).sort()).toEqual([...OFFICIAL_SOURCE_IDS].sort())
        }
    })

    it("VITE_BUNDLED=1 selects every adapter, the same list, not a copy", () => {
        expect(selectAdaptersInScope(withSites, parseBuildScope({ VITE_BUNDLED: "1" }))).toBe(withSites)
    })

    it("VITE_EXCLUDE_SOURCES drops exactly the named ids from a bundled build", () => {
        const selected = selectAdaptersInScope(
            withSites,
            parseBuildScope({ VITE_BUNDLED: "1", VITE_EXCLUDE_SOURCES: " site-a, site-b ," })
        )
        expect(ids(selected)).toEqual(ids(sourceAdapters))
    })

    it("VITE_EXCLUDE_SOURCES can also drop an official source from a shipped build", () => {
        const [official] = OFFICIAL_SOURCE_IDS
        const selected = selectAdaptersInScope(withSites, parseBuildScope({ VITE_EXCLUDE_SOURCES: official }))
        expect(ids(selected)).not.toContain(official)
        expect(selected).toHaveLength(OFFICIAL_SOURCE_IDS.length - 1)
    })

    it("a misspelled id fails instead of quietly testing a build that still has the adapter", () => {
        expect(() => selectAdaptersInScope(withSites, parseBuildScope({ VITE_EXCLUDE_SOURCES: "nope" }))).toThrow(
            /nope/
        )
    })
})
