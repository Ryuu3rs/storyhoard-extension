import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("wxt/browser", () => ({ browser: { permissions: { contains: vi.fn(async () => true) } } }))
vi.mock("../source-resolver", () => ({ resolveSource: vi.fn() }))
vi.mock("../arch-sources", () => ({ isProfileSource: vi.fn(() => false), registerStoredArchProfiles: vi.fn() }))
vi.mock("../sources", () => ({ getSourceById: vi.fn(() => ({ manifest: { id: "site" } })) }))
vi.mock("../background/capture", () => ({
    isPlaceholderTitle: (title: string, sourceMangaId: string) =>
        title.toLowerCase().replace(/[^a-z0-9]+/g, "") === sourceMangaId.toLowerCase().replace(/[^a-z0-9]+/g, ""),
    refreshExternalMangaMetadata: vi.fn()
}))
vi.mock("./library", () => ({ libraryHandlers: { "library:switch": vi.fn(async () => ({})) } }))

const { db } = await import("../database")
const { resolveSource } = await import("../source-resolver")
const { libraryHandlers } = await import("./library")
const { refreshExternalMangaMetadata } = await import("../background/capture")
const { fixItHandlers } = await import("./fix-it")

const ctx = {} as never
const base = { normalizedTitle: "x", authors: [], status: "unknown" as const, addedAt: 1, updatedAt: 1 }

beforeEach(async () => {
    await db.manga.clear()
    await db.archProfiles.clear()
    vi.mocked(resolveSource).mockReset()
    vi.mocked(libraryHandlers["library:switch"]!).mockClear()
    vi.mocked(refreshExternalMangaMetadata).mockClear()
})

describe("fixit:overview", () => {
    it("offers to turn a known site back on and lists titles named after their address", async () => {
        await db.archProfiles.put({
            id: "known",
            profile: { id: "known", origins: ["https://known.example/*", "http://old.example/*"] },
            importedAt: 1,
            origin: "user"
        } as never)
        await db.manga.bulkPut([
            {
                ...base,
                id: "a",
                title: "019c2921 C7b9",
                sourceId: "s",
                sourceMangaId: "019c2921-c7b9",
                sourceUrl: "https://s.example/a"
            },
            { ...base, id: "b", title: "mangadex.org", sourceId: "s", sourceUrl: "https://s.example/b" },
            {
                ...base,
                id: "c",
                title: "Real Name",
                sourceId: "s",
                sourceMangaId: "real",
                sourceUrl: "https://s.example/c"
            }
        ] as never)

        const result = (await fixItHandlers["fixit:overview"]!(
            { type: "fixit:overview", sourceIds: ["known", "gone"] } as never,
            ctx
        )) as { sites: unknown[]; names: Array<{ mangaId: string }> }

        expect(result.sites).toEqual([
            { sourceId: "known", canTurnOn: true, origins: ["https://known.example/*"] },
            { sourceId: "gone", canTurnOn: false, origins: [] }
        ])
        expect(result.names.map(n => n.mangaId).sort()).toEqual(["a", "b"])
    })
})

describe("fixit:find", () => {
    it("relinks only sure matches and leaves the rest for the user to pick", async () => {
        await db.manga.bulkPut([
            { ...base, id: "sure", title: "Sure", sourceId: "s", sourceUrl: "https://s.example/1" },
            { ...base, id: "unsure", title: "Unsure", sourceId: "s", sourceUrl: "https://s.example/2" }
        ] as never)
        vi.mocked(resolveSource).mockImplementation(async input =>
            input.title === "Sure"
                ? ({
                      confidence: "high",
                      best: { sourceId: "site", sourceMangaId: "sure", url: "https://site.example/sure", title: "Sure" }
                  } as never)
                : ({ confidence: "low", best: undefined } as never)
        )

        const result = (await fixItHandlers["fixit:find"]!(
            { type: "fixit:find", mangaIds: ["sure", "unsure", "missing"] } as never,
            ctx
        )) as { results: Array<{ mangaId: string; outcome: string }> }

        expect(result.results).toEqual([
            { mangaId: "sure", outcome: "relinked" },
            { mangaId: "unsure", outcome: "pick" },
            { mangaId: "missing", outcome: "missing" }
        ])
        expect(libraryHandlers["library:switch"]).toHaveBeenCalledTimes(1)
    })
})

describe("fixit:names", () => {
    it("re-reads the name of titles still named after their address", async () => {
        await db.manga.bulkPut([
            {
                ...base,
                id: "a",
                title: "019c2921 C7b9",
                sourceId: "s",
                sourceMangaId: "019c2921-c7b9",
                mangaUrl: "https://s.example/title/019c2921-c7b9",
                sourceUrl: "https://s.example/a"
            },
            {
                ...base,
                id: "c",
                title: "Real Name",
                sourceId: "s",
                sourceMangaId: "real",
                mangaUrl: "https://s.example/r",
                sourceUrl: "https://s.example/c"
            }
        ] as never)

        const result = await fixItHandlers["fixit:names"]!({ type: "fixit:names" } as never, ctx)

        expect(refreshExternalMangaMetadata).toHaveBeenCalledTimes(1)
        expect(refreshExternalMangaMetadata).toHaveBeenCalledWith(
            "s",
            { sourceMangaId: "019c2921-c7b9", mangaUrl: "https://s.example/title/019c2921-c7b9" },
            "a"
        )
        expect(result).toEqual({ tried: 1, remaining: 1 })
    })
})
