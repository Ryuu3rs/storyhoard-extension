import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("browser", fakeBrowser)

const sourcesMock = vi.hoisted(() => ({ getSourceById: vi.fn() }))
vi.mock("./sources", async () => {
    const actual = await vi.importActual<typeof import("./sources")>("./sources")
    return { ...actual, ...sourcesMock }
})

const { db } = await import("./database")
const { listUnresolvedTitles } = await import("./title-sources")
const { isKeptSample } = await import("./sample-rows")

beforeEach(async () => {
    fakeBrowser.reset()
    sourcesMock.getSourceById.mockReturnValue(undefined)
    await Promise.all([db.manga.clear(), db.sourceLinks.clear()])
})

describe("a kept sample in the unresolved list", () => {
    it("lists a kept sample whose site no longer resolves, like any other title, and skips a sample", async () => {
        const kept = {
            id: "seed-xx-001",
            title: "Kept",
            normalizedTitle: "kept",
            authors: [],
            status: "ongoing" as const,
            sourceId: "gone-site",
            sourceUrl: "https://gone-site.example/manga/kept/ch-1",
            mangaUrl: "https://gone-site.example/manga/kept",
            lastReadChapterNumber: 3,
            addedAt: 1,
            updatedAt: 1
        }
        const other = { ...kept, id: "gone-site:manga:other", title: "Other", normalizedTitle: "other" }
        const stillSample = { ...kept, id: "seed-xx-002", coverUrl: "/sample-covers/x.jpg" }
        await db.manga.bulkPut([kept, other, stillSample])
        expect(isKeptSample(kept)).toBe(true)

        const ids = (await listUnresolvedTitles()).map(entry => entry.mangaId).sort()
        expect(ids).toEqual([other.id, kept.id].sort())
    })
})
