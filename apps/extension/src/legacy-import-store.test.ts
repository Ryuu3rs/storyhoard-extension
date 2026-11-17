import { describe, expect, it } from "vitest"
import { migrateLegacyImport } from "./legacy-import"

// The shipped build has no migration seed, so an alias to a seeded site id would name a source that
// never resolves and is never offered for reconcile. Only the official aliases remain.
describe("legacy import in the shipped build", () => {
    it("leaves an old site domain as a hostname id, which the reconcile check flags", () => {
        const result = migrateLegacyImport({
            mangas: [{ n: "The S-Classes That I Raised", u: "https://asura.gg/manga/the-s-classes-that-i-raised/" }]
        })
        expect((result.envelope as any).data.manga[0].sourceId).toBe("asura.gg")
    })

    it("still maps the official legacy domain", () => {
        const result = migrateLegacyImport({
            mangas: [{ n: "Old", u: "https://www.mangadex.org/chapter/12345" }]
        })
        expect((result.envelope as any).data.manga[0].sourceId).toBe("mangadex")
    })
})
