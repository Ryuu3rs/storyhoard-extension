import { describe, it, expect } from "vitest"
import {
    entryNeedsSource,
    isFlaggedForRelink,
    buildResolveRequest,
    buildAdoptRequest,
    type MangaSearchResult
} from "./find-source"

describe("entryNeedsSource", () => {
    it("offers the flow for a tracking-only anilist.co import", () => {
        expect(entryNeedsSource({ sourceId: "anilist.co" })).toBe(true)
    })

    it("offers the flow for a plain import row", () => {
        expect(entryNeedsSource({ sourceId: "import" })).toBe(true)
    })

    it("offers the flow for a manual dead-source hostname import", () => {
        expect(entryNeedsSource({ sourceId: "asura.gg", manualTracking: true })).toBe(true)
    })

    it("does not offer the flow for a working adapter source", () => {
        expect(entryNeedsSource({ sourceId: "mangadex" })).toBe(false)
        expect(entryNeedsSource({ sourceId: "madara" })).toBe(false)
    })

    it("does not offer the flow for a manual title on a real adapter source", () => {
        // A dotless adapter id is a real source even when the user marked it manual -
        // matches the broken-link panel's own dotted-sourceId rule.
        expect(entryNeedsSource({ sourceId: "mangadex", manualTracking: true })).toBe(false)
    })

    it("offers the flow when the caller flags a needs-relink row", () => {
        expect(entryNeedsSource({ sourceId: "mangadex" }, true)).toBe(true)
    })
})

describe("isFlaggedForRelink", () => {
    const relinkTitles = [
        { mangaId: "m-1", title: "One", sourceId: "mangadex" },
        { mangaId: "m-2", title: "Two", sourceId: "madara" }
    ]

    it("matches a title listed in relinkTitles by manga id", () => {
        expect(isFlaggedForRelink(relinkTitles, "m-2")).toBe(true)
    })

    it("does not match a title missing from relinkTitles", () => {
        expect(isFlaggedForRelink(relinkTitles, "m-3")).toBe(false)
    })

    it("does not treat a sourceId key as a manga id", () => {
        // needsRelink is keyed by sourceId; a manga id must never match a source id.
        expect(isFlaggedForRelink(relinkTitles, "mangadex")).toBe(false)
    })

    it("is false when the status has no relinkTitles", () => {
        expect(isFlaggedForRelink(undefined, "m-1")).toBe(false)
        expect(isFlaggedForRelink([], "m-1")).toBe(false)
    })
})

describe("buildResolveRequest", () => {
    it("passes the AniList id when the row carries one", () => {
        expect(buildResolveRequest({ title: "Solo Leveling", anilistId: 105398 })).toEqual({
            type: "source:resolve",
            title: "Solo Leveling",
            anilistId: 105398
        })
    })

    it("omits anilistId entirely when absent (exactOptionalPropertyTypes)", () => {
        const request = buildResolveRequest({ title: "Nano Machine" })
        expect(request).toEqual({ type: "source:resolve", title: "Nano Machine" })
        expect("anilistId" in request).toBe(false)
        expect("searchTitles" in request).toBe(false)
    })

    it("trims, drops blanks, and de-dupes search-title variants into a plain array", () => {
        const request = buildResolveRequest({ title: "T" }, [" Romaji ", "Romaji", "", "  ", "English"])
        expect(request.searchTitles).toEqual(["Romaji", "English"])
    })

    it("omits searchTitles when the variant list reduces to nothing", () => {
        const request = buildResolveRequest({ title: "T" }, ["", "   "])
        expect("searchTitles" in request).toBe(false)
    })
})

describe("buildAdoptRequest", () => {
    it("builds a library:switch request from the chosen candidate, dropping extra fields", () => {
        // A full candidate carries title/latestChapter/coverUrl; only the three link
        // fields must reach the request.
        const candidate: MangaSearchResult = {
            sourceId: "mangadex",
            sourceMangaId: "abc-123",
            url: "https://mangadex.org/title/abc-123",
            title: "Solo Leveling",
            latestChapter: "200",
            coverUrl: "https://example.test/cover.jpg"
        }
        expect(buildAdoptRequest("manga-1", candidate)).toEqual({
            type: "library:switch",
            mangaId: "manga-1",
            sourceId: "mangadex",
            sourceMangaId: "abc-123",
            mangaUrl: "https://mangadex.org/title/abc-123",
            allowTabFallback: true
        })
    })
})
