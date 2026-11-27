import "fake-indexeddb/auto"
import { sourceRegistry } from "@amr/sources"
import { fakeBrowser } from "wxt/testing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { HandlerContext } from "../background/handler-types"
import { fakeSiteAdapter } from "../fake-sites"
import { runtimeRequestSchema, type RuntimeRequest } from "../runtime"

vi.stubGlobal("browser", fakeBrowser)

const libraryMock = vi.hoisted(() => ({ switch: vi.fn() }))
const diagMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock("./library", () => ({ libraryHandlers: { "library:switch": libraryMock.switch } }))
vi.mock("../live", () => ({ publishLive: vi.fn() }))
vi.mock("../diag-log", () => ({ diag: diagMock }))
vi.mock("../background/chapter-cache", () => ({ scheduleChapterListRefresh: vi.fn() }))
vi.mock("../settings", () => ({ getSettings: vi.fn().mockResolvedValue({ language: "en" }) }))

const { db } = await import("../database")
import type { LibraryManga } from "../database"
const { titleSourcesHandlers } = await import("./title-sources")

const SITE = "newsite"
const SERIES = (slug: string) => `https://${SITE}.example/manga/${slug}`
const ctx: HandlerContext = { sender: {} as HandlerContext["sender"] }
const addFound = titleSourcesHandlers["source:add-found"]!

function title(id: string, over: Partial<LibraryManga> = {}): LibraryManga {
    return {
        id,
        sourceId: "older",
        sourceMangaId: id,
        sourceUrl: `https://older.example/manga/${id}/ch-1`,
        mangaUrl: `https://older.example/manga/${id}`,
        title: `Title ${id}`,
        normalizedTitle: `title ${id}`,
        authors: [],
        status: "ongoing",
        addedAt: 1,
        updatedAt: 1,
        ...over
    }
}

function request(picks: Array<{ mangaId: string; sourceMangaId: string; url: string }>) {
    return runtimeRequestSchema.parse({ type: "source:add-found", sourceId: SITE, picks }) as Extract<
        RuntimeRequest,
        { type: "source:add-found" }
    >
}

function noSiteTitle(id: string): LibraryManga {
    const { sourceMangaId: _unused, ...rest } = title(id, {
        sourceId: "anilist.co",
        sourceUrl: "https://anilist.co/manga/2"
    })
    return rest
}

beforeEach(async () => {
    await db.manga.clear()
    await db.versions.clear()
    libraryMock.switch.mockReset().mockResolvedValue({})
    diagMock.warn.mockReset()
    sourceRegistry.register(fakeSiteAdapter(SITE))
})

afterEach(() => {
    sourceRegistry.unregister(SITE)
})

describe("source:add-found", () => {
    it("adds a title already on a site as another source and moves a title on no site onto this one", async () => {
        await db.manga.bulkPut([title("a"), noSiteTitle("b")])
        const result = await addFound(
            request([
                { mangaId: "a", sourceMangaId: "title-a", url: SERIES("title-a") },
                { mangaId: "b", sourceMangaId: "title-b", url: SERIES("title-b") }
            ]),
            ctx
        )
        expect(result).toEqual({ added: 2, already: 0, failed: 0 })
        const versions = await db.versions.toArray()
        expect(versions.map(v => [v.sourceId, v.sourceMangaId])).toEqual([[SITE, "title-a"]])
        expect((await db.manga.get("a"))?.sourceId).toBe("older")
        expect(libraryMock.switch).toHaveBeenCalledTimes(1)
        expect(libraryMock.switch.mock.calls[0]![0]).toMatchObject({
            type: "library:switch",
            mangaId: "b",
            sourceId: SITE,
            sourceMangaId: "title-b",
            mangaUrl: SERIES("title-b"),
            allowTabFallback: false
        })
    })

    it("refuses a pick on another host, a non-series page, plain http or a title no longer in the library", async () => {
        await db.manga.bulkPut([title("a")])
        const result = await addFound(
            request([
                { mangaId: "a", sourceMangaId: "x", url: "https://elsewhere.example/manga/x" },
                { mangaId: "a", sourceMangaId: "x", url: `https://${SITE}.example/manga/x/ch-1` },
                { mangaId: "a", sourceMangaId: "x", url: `http://${SITE}.example/manga/x` },
                { mangaId: "gone", sourceMangaId: "x", url: SERIES("x") }
            ]),
            ctx
        )
        expect(result).toEqual({ added: 0, already: 0, failed: 4 })
        expect(await db.versions.count()).toBe(0)
        expect(libraryMock.switch).not.toHaveBeenCalled()
        expect(diagMock.warn).toHaveBeenCalledTimes(4)
    })

    it("logs a move that fails and carries on with the rest", async () => {
        await db.manga.bulkPut([title("a"), noSiteTitle("b")])
        libraryMock.switch.mockRejectedValueOnce(new Error("switch broke"))
        const result = await addFound(
            request([
                { mangaId: "b", sourceMangaId: "title-b", url: SERIES("title-b") },
                { mangaId: "a", sourceMangaId: "title-a", url: SERIES("title-a") }
            ]),
            ctx
        )
        expect(result).toEqual({ added: 1, already: 0, failed: 1 })
        expect(diagMock.warn).toHaveBeenCalledWith("find-titles", "adding a found title failed", expect.anything())
        expect(await db.versions.count()).toBe(1)
    })

    it("does not count a pick that changed nothing as added", async () => {
        await db.manga.bulkPut([
            title("b", { sourceId: SITE, sourceMangaId: "title-b", mangaUrl: SERIES("title-b") }),
            title("a")
        ])
        await addFound(request([{ mangaId: "a", sourceMangaId: "title-a", url: SERIES("title-a") }]), ctx)
        libraryMock.switch.mockClear()
        const result = await addFound(
            request([
                { mangaId: "b", sourceMangaId: "title-b", url: SERIES("title-b") },
                { mangaId: "a", sourceMangaId: "title-a", url: SERIES("title-a") }
            ]),
            ctx
        )
        expect(result).toEqual({ added: 0, already: 2, failed: 0 })
        expect(await db.versions.count()).toBe(1)
        expect(libraryMock.switch).not.toHaveBeenCalled()
    })

    it("refuses a site that is not registered", async () => {
        sourceRegistry.unregister(SITE)
        await expect(addFound(request([{ mangaId: "a", sourceMangaId: "x", url: SERIES("x") }]), ctx)).rejects.toThrow(
            "not available"
        )
    })
})
