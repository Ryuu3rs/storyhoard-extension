import { describe, expect, it } from "vitest"
import { OFFICIAL_SOURCE_IDS, parseBuildScope, selectAdaptersInScope, sourceAdapters, sourceRegistry } from "./index"

const ids = (adapters: readonly { manifest: { id: string } }[]) => adapters.map(adapter => adapter.manifest.id)
const [firstOther, secondOther] = ids(sourceAdapters).filter(id => !OFFICIAL_SOURCE_IDS.includes(id))

describe("build scope", () => {
    it("a default build registers every adapter, in registry order", () => {
        expect(sourceAdapters.length).toBeGreaterThan(0)
        expect(ids(sourceRegistry.list())).toEqual(ids(sourceAdapters))
    })

    it("no flags selects the same list, not a copy", () => {
        expect(selectAdaptersInScope(sourceAdapters, parseBuildScope({}))).toBe(sourceAdapters)
    })

    it("VITE_NO_BUNDLED=1 keeps only the official sources", () => {
        const selected = selectAdaptersInScope(sourceAdapters, parseBuildScope({ VITE_NO_BUNDLED: "1" }))
        expect(ids(selected).sort()).toEqual([...OFFICIAL_SOURCE_IDS].sort())
    })

    it("only the value 1 turns VITE_NO_BUNDLED on", () => {
        for (const value of ["", "0", "true"]) {
            expect(selectAdaptersInScope(sourceAdapters, parseBuildScope({ VITE_NO_BUNDLED: value }))).toBe(
                sourceAdapters
            )
        }
    })

    it("VITE_EXCLUDE_SOURCES drops exactly the named ids", () => {
        const selected = selectAdaptersInScope(
            sourceAdapters,
            parseBuildScope({ VITE_EXCLUDE_SOURCES: ` ${firstOther}, ${secondOther} ,` })
        )
        expect(ids(selected)).toEqual(ids(sourceAdapters).filter(id => id !== firstOther && id !== secondOther))
    })

    it("VITE_EXCLUDE_SOURCES can also drop an official source from a VITE_NO_BUNDLED build", () => {
        const [official] = OFFICIAL_SOURCE_IDS
        const selected = selectAdaptersInScope(
            sourceAdapters,
            parseBuildScope({ VITE_NO_BUNDLED: "1", VITE_EXCLUDE_SOURCES: official })
        )
        expect(ids(selected)).not.toContain(official)
        expect(selected).toHaveLength(OFFICIAL_SOURCE_IDS.length - 1)
    })

    it("a misspelled id fails instead of quietly testing a build that still has the adapter", () => {
        expect(() => selectAdaptersInScope(sourceAdapters, parseBuildScope({ VITE_EXCLUDE_SOURCES: "nope" }))).toThrow(
            /nope/
        )
    })
})
