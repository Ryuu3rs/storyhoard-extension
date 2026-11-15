import { describe, expect, it } from "vitest"
import { OFFICIAL_SOURCE_IDS, parseBuildScope, selectAdaptersInScope, sourceAdapters, sourceRegistry } from "./index"

const ids = (adapters: readonly { manifest: { id: string } }[]) => adapters.map(adapter => adapter.manifest.id)
const [firstOther, secondOther] = ids(sourceAdapters).filter(id => !OFFICIAL_SOURCE_IDS.includes(id))

describe("build scope", () => {
    it("a shipped build keeps only the official sources", () => {
        const selected = selectAdaptersInScope(sourceAdapters, parseBuildScope({}))
        expect(ids(selected).sort()).toEqual([...OFFICIAL_SOURCE_IDS].sort())
    })

    it("only the value 1 turns the local bundled build on", () => {
        for (const value of ["", "0", "true"]) {
            const selected = selectAdaptersInScope(sourceAdapters, parseBuildScope({ VITE_BUNDLED: value }))
            expect(ids(selected).sort()).toEqual([...OFFICIAL_SOURCE_IDS].sort())
        }
    })

    it("VITE_BUNDLED=1 selects every adapter, the same list, not a copy", () => {
        expect(selectAdaptersInScope(sourceAdapters, parseBuildScope({ VITE_BUNDLED: "1" }))).toBe(sourceAdapters)
    })

    it("unit tests run with the bundled scope, so every adapter stays covered", () => {
        expect(ids(sourceRegistry.list())).toEqual(ids(sourceAdapters))
    })

    it("VITE_EXCLUDE_SOURCES drops exactly the named ids from a bundled build", () => {
        const selected = selectAdaptersInScope(
            sourceAdapters,
            parseBuildScope({ VITE_BUNDLED: "1", VITE_EXCLUDE_SOURCES: ` ${firstOther}, ${secondOther} ,` })
        )
        expect(ids(selected)).toEqual(ids(sourceAdapters).filter(id => id !== firstOther && id !== secondOther))
    })

    it("VITE_EXCLUDE_SOURCES can also drop an official source from a shipped build", () => {
        const [official] = OFFICIAL_SOURCE_IDS
        const selected = selectAdaptersInScope(sourceAdapters, parseBuildScope({ VITE_EXCLUDE_SOURCES: official }))
        expect(ids(selected)).not.toContain(official)
        expect(selected).toHaveLength(OFFICIAL_SOURCE_IDS.length - 1)
    })

    it("a misspelled id fails instead of quietly testing a build that still has the adapter", () => {
        expect(() => selectAdaptersInScope(sourceAdapters, parseBuildScope({ VITE_EXCLUDE_SOURCES: "nope" }))).toThrow(
            /nope/
        )
    })
})
