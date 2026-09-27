import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing"
import { db, type LibraryManga } from "../database"

vi.stubGlobal("browser", fakeBrowser)

// Hoisted so the vi.mock factories (which run before top-level code) can close over them.
const { resolveSource, switchHandler } = vi.hoisted(() => ({
    resolveSource: vi.fn(),
    switchHandler: vi.fn(async () => ({}))
}))

// resolveSource is the read-only resolver; stub it per title so the test drives the
// confidence gate directly instead of hitting live source search.
vi.mock("../source-resolver", () => ({
    resolveSource: (input: unknown) => resolveSource(input)
}))

// The adopt reuses the real library:switch handler; stub the whole library module so
// the test asserts which rows get adopted without loading the live switch/network path.
vi.mock("./library", () => ({
    libraryHandlers: { "library:switch": switchHandler }
}))

import { importHandlers } from "./import"

const ctx = { sender: undefined } as never

function row(over: Partial<LibraryManga> & { id: string; title: string }): LibraryManga {
    return {
        normalizedTitle: over.title.toLowerCase(),
        authors: [],
        status: "ongoing",
        sourceId: "anilist.co",
        sourceUrl: `https://anilist.co/manga/${over.id}`,
        manualTracking: true,
        addedAt: 1,
        updatedAt: 1,
        ...over
    }
}

const best = { sourceId: "mangadex", sourceMangaId: "md-1", url: "https://mangadex.org/title/md-1" }

beforeEach(async () => {
    await db.manga.clear()
    resolveSource.mockReset()
    switchHandler.mockReset()
    switchHandler.mockResolvedValue({})
})

describe("import:resolve (auto-resolve on import)", () => {
    it("adopts only high-confidence exact matches, leaves ambiguous rows untouched", async () => {
        await db.manga.bulkPut([
            row({ id: "exact", title: "Exact Match", anilistId: 111 }),
            row({ id: "fuzzy", title: "Fuzzy Only" }),
            row({ id: "missing", title: "No Match" }),
            // A row that already has a real reader source must be ignored entirely.
            row({ id: "linked", title: "Already Linked", sourceId: "mangadex", manualTracking: false })
        ])
        resolveSource.mockImplementation(async (input: { title: string }) => {
            if (input.title === "Exact Match") return { matched: true, confidence: "high", best, candidates: [best] }
            if (input.title === "Fuzzy Only") return { matched: true, confidence: "low", best, candidates: [best] }
            return { matched: false, confidence: "none", candidates: [] }
        })

        const result = await importHandlers["import:resolve"]!({ type: "import:resolve" }, ctx)

        expect(result).toEqual({ scanned: 3, resolved: 1 })
        expect(switchHandler).toHaveBeenCalledTimes(1)
        expect(switchHandler).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "library:switch",
                mangaId: "exact",
                sourceId: "mangadex",
                sourceMangaId: "md-1",
                allowTabFallback: false
            }),
            ctx
        )
    })

    it("passes the anilistId to the resolver when the row carries one", async () => {
        await db.manga.bulkPut([row({ id: "exact", title: "Exact Match", anilistId: 111 })])
        resolveSource.mockResolvedValue({ matched: true, confidence: "high", best, candidates: [best] })

        await importHandlers["import:resolve"]!({ type: "import:resolve" }, ctx)

        expect(resolveSource).toHaveBeenCalledWith({ title: "Exact Match", anilistId: 111 })
    })

    it("swallows a per-row adopt failure and keeps sweeping the rest", async () => {
        await db.manga.bulkPut([row({ id: "a", title: "First" }), row({ id: "b", title: "Second" })])
        resolveSource.mockResolvedValue({ matched: true, confidence: "high", best, candidates: [best] })
        switchHandler.mockRejectedValueOnce(new Error("dead source")).mockResolvedValue({})

        const result = await importHandlers["import:resolve"]!({ type: "import:resolve" }, ctx)

        expect(result).toEqual({ scanned: 2, resolved: 1 })
        expect(switchHandler).toHaveBeenCalledTimes(2)
    })

    it("resolves nothing when the library has no tracking-only rows", async () => {
        await db.manga.bulkPut([row({ id: "linked", title: "Linked", sourceId: "mangadex", manualTracking: false })])

        const result = await importHandlers["import:resolve"]!({ type: "import:resolve" }, ctx)

        expect(result).toEqual({ scanned: 0, resolved: 0 })
        expect(resolveSource).not.toHaveBeenCalled()
    })
})

describe("site:open (weeb.ltd deep-link)", () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        fakeBrowser.reset()
    })

    it("adds the title, resolves a source, and opens the app focused on it", async () => {
        resolveSource.mockResolvedValue({ matched: true, confidence: "high", best, candidates: [best] })
        vi.spyOn(fakeBrowser.runtime, "getURL").mockImplementation(((p: string) => `chrome-extension://x${p}`) as never)
        const createSpy = vi.spyOn(fakeBrowser.tabs, "create").mockResolvedValue({ id: 1 } as never)

        const result = await importHandlers["site:open"]!(
            { type: "site:open", anilistId: 555, title: "Deep Linked" },
            ctx
        )

        expect(result).toEqual({ added: true, resolved: true })
        // Title landed in the library under the anilist-scoped id.
        expect(await db.manga.get("anilist:manga:555")).toMatchObject({ title: "Deep Linked", anilistId: 555 })
        expect(resolveSource).toHaveBeenCalledWith({ title: "Deep Linked", anilistId: 555 })
        expect(switchHandler).toHaveBeenCalledTimes(1)
        // Opened the app on that title.
        expect(createSpy).toHaveBeenCalledWith({ url: "chrome-extension://x/app.html?open=anilist%3Amanga%3A555" })
    })

    it("still adds and opens the title when no source resolves", async () => {
        resolveSource.mockResolvedValue({ matched: false, confidence: "none", candidates: [] })
        vi.spyOn(fakeBrowser.runtime, "getURL").mockImplementation(((p: string) => p) as never)
        const createSpy = vi.spyOn(fakeBrowser.tabs, "create").mockResolvedValue({ id: 1 } as never)

        const result = await importHandlers["site:open"]!(
            { type: "site:open", anilistId: 777, title: "No Source" },
            ctx
        )

        expect(result).toEqual({ added: true, resolved: false })
        expect(switchHandler).not.toHaveBeenCalled()
        expect(createSpy).toHaveBeenCalledOnce()
    })
})
