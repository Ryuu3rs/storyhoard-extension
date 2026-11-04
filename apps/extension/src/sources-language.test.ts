import { sourceRegistry } from "@amr/sources"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LibraryManga } from "./database"

const settings = vi.hoisted(() => ({ getSettings: vi.fn() }))
vi.mock("./settings", () => settings)

const { listChaptersBySource, listChaptersForSource } = await import("./sources")

const listChapters = vi.fn(async () => [])
const source = {
    manifest: { id: "multi", name: "Multi", domains: ["multi.example"], languages: [], capabilities: [] },
    listChapters
}
const manga = { id: "multi:manga:a", title: "A" } as unknown as LibraryManga
const askedFor = () => (listChapters.mock.calls[0] as unknown as [{ languages?: string[] }])[0].languages

beforeEach(() => {
    listChapters.mockClear()
    settings.getSettings.mockResolvedValue({ language: "en" })
    vi.spyOn(sourceRegistry, "get").mockReturnValue(source as never)
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe("a chapter list asked for without a language", () => {
    it("uses the reader's language, so another language's uploads do not stand in for its chapters", async () => {
        await listChaptersBySource("multi", "a", "https://multi.example/a")
        expect(askedFor()).toEqual(["en"])
    })

    it("does the same when listing for a title in the library", async () => {
        await listChaptersForSource(manga, "multi", "a", "https://multi.example/a")
        expect(askedFor()).toEqual(["en"])
    })

    it("still honours a language the caller names", async () => {
        await listChaptersBySource("multi", "a", "https://multi.example/a", ["fr"])
        expect(askedFor()).toEqual(["fr"])
    })

    it("still lists when the settings cannot be read", async () => {
        settings.getSettings.mockRejectedValue(new Error("no storage"))
        await listChaptersBySource("multi", "a", "https://multi.example/a")
        expect(askedFor()).toBeUndefined()
    })
})
