import "fake-indexeddb/auto"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
    getAniListConfig,
    setAniListConfig,
    getAniListStatus,
    getViewerProgress,
    saveViewerProgress,
    getViewerName,
    getViewerMangaList,
    mapMediaListEntry,
    resolveStatusSync,
    localStatusToAniList,
    aniListStatusToLocal
} from "./anilist"
import { _resetProtectedStoreForTests } from "./protected-store"

beforeEach(() => _resetProtectedStoreForTests())

function stubStorage() {
    const store = new Map<string, unknown>()
    // @ts-expect-error test-only shim
    globalThis.browser = {
        storage: {
            local: {
                get: vi.fn(async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {})),
                set: vi.fn(async (items: Record<string, unknown>) => {
                    for (const [k, v] of Object.entries(items)) store.set(k, v)
                })
            }
        }
    }
    return store
}

beforeEach(() => stubStorage())
afterEach(() => vi.unstubAllGlobals())

describe("AniList config store", () => {
    it("defaults to autoSync off and no token", async () => {
        expect(await getAniListConfig()).toEqual({ autoSync: false, syncMembership: false })
    })

    it("merges patches and round-trips", async () => {
        await setAniListConfig({ token: "abc", autoSync: true })
        const c = await getAniListConfig()
        expect(c.token).toBe("abc")
        expect(c.autoSync).toBe(true)
    })

    it("maps local status kinds to AniList statuses and back", () => {
        expect(localStatusToAniList("completed")).toBe("COMPLETED")
        expect(localStatusToAniList("dropped")).toBe("DROPPED")
        expect(localStatusToAniList("paused")).toBe("PAUSED")
        expect(localStatusToAniList("planning")).toBe("PLANNING")
        expect(localStatusToAniList("reading")).toBe("CURRENT")
        expect(aniListStatusToLocal("PAUSED")).toEqual({ readingStatus: "paused", completed: false })
        expect(aniListStatusToLocal("COMPLETED")).toEqual({ readingStatus: null, completed: true })
        expect(aniListStatusToLocal("CURRENT")).toEqual({ readingStatus: null, completed: false })
        expect(aniListStatusToLocal("REPEATING")).toEqual({ readingStatus: null, completed: false })
    })

    it("never exposes the token in the status view", async () => {
        await setAniListConfig({ token: "secret", autoSync: true, lastSyncAt: 123 })
        const status = await getAniListStatus()
        expect(status).toEqual({
            hasToken: true,
            autoSync: true,
            syncMembership: false,
            statusPush: false,
            statusPull: false,
            lastSyncAt: 123
        })
        expect(JSON.stringify(status)).not.toContain("secret")
    })
})

describe("AniList authed API", () => {
    it("reads viewer progress, undefined when no list entry", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { Media: { mediaListEntry: null } } }) })
        )
        expect(await getViewerProgress("t", 1)).toBeUndefined()

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ data: { Media: { mediaListEntry: { progress: 42 } } } })
            })
        )
        expect(await getViewerProgress("t", 1)).toBe(42)
    })

    it("saves progress and returns the stored value", async () => {
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValue({ ok: true, json: async () => ({ data: { SaveMediaListEntry: { progress: 50 } } }) })
        )
        expect(await saveViewerProgress("t", 1, 50)).toBe(50)
    })

    it("throws on a GraphQL error (e.g. invalid token)", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({ ok: true, json: async () => ({ errors: [{ message: "Invalid token" }] }) })
        )
        await expect(getViewerName("bad")).rejects.toThrow(/Invalid token/)
    })

    it("throws on a non-ok response", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }))
        await expect(getViewerName("bad")).rejects.toThrow(/401/)
    })
})

describe("resolveStatusSync", () => {
    it("returns none when local and remote already agree", () => {
        expect(
            resolveStatusSync({
                local: { kind: "paused", ts: 5, explicit: true },
                remote: { status: "PAUSED", ts: 9 },
                push: true,
                pull: true
            })
        ).toEqual({ action: "none" })
    })

    it("push-only always pushes an explicit local status", () => {
        expect(
            resolveStatusSync({
                local: { kind: "dropped", ts: 1, explicit: true },
                remote: { status: "CURRENT", ts: 999 },
                push: true,
                pull: false
            })
        ).toEqual({ action: "push", status: "DROPPED" })
    })

    it("pull-only always applies the remote status", () => {
        expect(
            resolveStatusSync({
                local: { kind: "reading", ts: 999, explicit: false },
                remote: { status: "PAUSED", ts: 1 },
                push: false,
                pull: true
            })
        ).toEqual({ action: "pullLocal", status: "PAUSED" })
    })

    it("pull-only with no remote entry does nothing", () => {
        expect(
            resolveStatusSync({
                local: { kind: "reading", ts: 1, explicit: false },
                remote: { ts: 0 },
                push: false,
                pull: true
            })
        ).toEqual({ action: "none" })
    })

    it("both directions: an explicit local change follows last-writer", () => {
        // Local changed more recently -> push local up.
        expect(
            resolveStatusSync({
                local: { kind: "dropped", ts: 100, explicit: true },
                remote: { status: "CURRENT", ts: 50 },
                push: true,
                pull: true
            })
        ).toEqual({ action: "push", status: "DROPPED" })
        // Remote changed more recently -> pull remote down.
        expect(
            resolveStatusSync({
                local: { kind: "paused", ts: 50, explicit: true },
                remote: { status: "DROPPED", ts: 100 },
                push: true,
                pull: true
            })
        ).toEqual({ action: "pullLocal", status: "DROPPED" })
    })

    it("does nothing when neither direction is enabled", () => {
        expect(
            resolveStatusSync({
                local: { kind: "paused", ts: 1, explicit: true },
                remote: { status: "CURRENT", ts: 1 },
                push: false,
                pull: false
            })
        ).toEqual({ action: "none" })
    })

    // Regression: a DERIVED "reading" (from progress, not a user choice) must never push
    // CURRENT over a deliberate remote hold/drop, however fresh the local read timestamp is.
    it("derived reading does not push CURRENT over a deliberate remote PAUSED", () => {
        // Both on: adopt the remote hold locally rather than clobber it.
        expect(
            resolveStatusSync({
                local: { kind: "reading", ts: Number.MAX_SAFE_INTEGER, explicit: false },
                remote: { status: "PAUSED", ts: 1 },
                push: true,
                pull: true
            })
        ).toEqual({ action: "pullLocal", status: "PAUSED" })
        // Push-only: leave the remote hold untouched, don't push CURRENT.
        expect(
            resolveStatusSync({
                local: { kind: "reading", ts: Number.MAX_SAFE_INTEGER, explicit: false },
                remote: { status: "DROPPED", ts: 1 },
                push: true,
                pull: false
            })
        ).toEqual({ action: "none" })
    })

    it("derived completed does not push over a deliberate remote DROPPED", () => {
        expect(
            resolveStatusSync({
                local: { kind: "completed", ts: Number.MAX_SAFE_INTEGER, explicit: false },
                remote: { status: "DROPPED", ts: 1 },
                push: true,
                pull: false
            })
        ).toEqual({ action: "none" })
    })

    it("derived reading still promotes a remote PLANNING to CURRENT", () => {
        expect(
            resolveStatusSync({
                local: { kind: "reading", ts: 10, explicit: false },
                remote: { status: "PLANNING", ts: 5 },
                push: true,
                pull: true
            })
        ).toEqual({ action: "push", status: "CURRENT" })
    })
})

describe("mapMediaListEntry", () => {
    it("maps media status to our publication-status enum", () => {
        const cases: Array<[string, string]> = [
            ["RELEASING", "ongoing"],
            ["FINISHED", "completed"],
            ["HIATUS", "hiatus"],
            ["CANCELLED", "cancelled"],
            ["NOT_YET_RELEASED", "unknown"]
        ]
        for (const [raw, expected] of cases) {
            expect(mapMediaListEntry({ media: { id: 1, status: raw } }).status).toBe(expected)
        }
    })

    it("prefers romaji, falls back to english then native", () => {
        expect(mapMediaListEntry({ media: { id: 1, title: { english: "E", romaji: "R", native: "N" } } }).title).toBe(
            "R"
        )
        expect(mapMediaListEntry({ media: { id: 1, title: { english: "E", native: "N" } } }).title).toBe("E")
        expect(mapMediaListEntry({ media: { id: 1, title: { native: "N" } } }).title).toBe("N")
    })

    it("prefers extraLarge cover, falls back to large, else undefined", () => {
        expect(mapMediaListEntry({ media: { id: 1, coverImage: { extraLarge: "xl", large: "l" } } }).coverUrl).toBe(
            "xl"
        )
        expect(mapMediaListEntry({ media: { id: 1, coverImage: { large: "l" } } }).coverUrl).toBe("l")
        expect(mapMediaListEntry({ media: { id: 1 } }).coverUrl).toBeUndefined()
    })

    it("maps the entry list status to our reading-status override (paused/dropped/planning only)", () => {
        expect(mapMediaListEntry({ status: "PAUSED", media: { id: 1 } }).listStatus).toBe("paused")
        expect(mapMediaListEntry({ status: "DROPPED", media: { id: 1 } }).listStatus).toBe("dropped")
        expect(mapMediaListEntry({ status: "PLANNING", media: { id: 1 } }).listStatus).toBe("planning")
        // Derived states carry no override.
        expect(mapMediaListEntry({ status: "CURRENT", media: { id: 1 } }).listStatus).toBeUndefined()
        expect(mapMediaListEntry({ status: "COMPLETED", media: { id: 1 } }).listStatus).toBeUndefined()
        expect(mapMediaListEntry({ status: "REPEATING", media: { id: 1 } }).listStatus).toBeUndefined()
        expect(mapMediaListEntry({ media: { id: 1 } }).listStatus).toBeUndefined()
    })

    it("preserves the raw list status and a positive chapter total", () => {
        const mapped = mapMediaListEntry({ status: "COMPLETED", media: { id: 1, chapters: 120 } })
        expect(mapped.rawListStatus).toBe("COMPLETED")
        expect(mapped.totalChapters).toBe(120)
        // null / zero / missing totals do not produce a total.
        expect(mapMediaListEntry({ media: { id: 1, chapters: null } }).totalChapters).toBeUndefined()
        expect(mapMediaListEntry({ media: { id: 1, chapters: 0 } }).totalChapters).toBeUndefined()
        expect(mapMediaListEntry({ media: { id: 1 } }).totalChapters).toBeUndefined()
        expect(mapMediaListEntry({ media: { id: 1 } }).rawListStatus).toBeUndefined()
    })

    it("maps format, isAdult -> nsfw, and Story/Art staff -> authors", () => {
        const mapped = mapMediaListEntry({
            media: {
                id: 1,
                format: "LIGHT_NOVEL",
                isAdult: true,
                staff: {
                    edges: [
                        { role: "Story & Art", node: { name: { full: "Solo Creator" } } },
                        { role: "Story", node: { name: { full: "Writer San" } } },
                        { role: "Art (Ch. 1-10)", node: { name: { full: "Artist San" } } },
                        { role: "Translator", node: { name: { full: "Not An Author" } } }
                    ]
                }
            }
        })
        expect(mapped.format).toBe("LIGHT_NOVEL")
        expect(mapped.nsfw).toBe(true)
        expect(mapped.authors).toEqual(["Solo Creator", "Writer San", "Artist San"])
        // No adult flag / no staff -> fields omitted.
        const plain = mapMediaListEntry({ media: { id: 2 } })
        expect(plain.nsfw).toBeUndefined()
        expect(plain.authors).toBeUndefined()
        expect(plain.format).toBeUndefined()
    })

    it("dedups authors on the trimmed name and covers Artist / Original Story roles", () => {
        const mapped = mapMediaListEntry({
            media: {
                id: 1,
                staff: {
                    edges: [
                        { role: "Story & Art", node: { name: { full: "Kentaro Miura" } } },
                        // Same creator, second edge, stray surrounding whitespace - must not double.
                        { role: "Art", node: { name: { full: " Kentaro Miura " } } },
                        { role: "Artist", node: { name: { full: "Studio Gaga" } } },
                        { role: "Original Story", node: { name: { full: "Original Author" } } }
                    ]
                }
            }
        })
        expect(mapped.authors).toEqual(["Kentaro Miura", "Studio Gaga", "Original Author"])
    })

    it("carries anilistId, genres, and progress; defaults a missing progress to 0", () => {
        const mapped = mapMediaListEntry({
            progress: 12,
            media: { id: 99, genres: ["Action", null, ""], title: { romaji: "R" } }
        })
        expect(mapped.anilistId).toBe(99)
        expect(mapped.genres).toEqual(["Action"])
        expect(mapped.progress).toBe(12)
        expect(mapMediaListEntry({ media: { id: 1 } }).progress).toBe(0)
    })
})

describe("getViewerMangaList", () => {
    it("resolves the viewer id then flattens every list's entries", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { Viewer: { id: 7 } } }) })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    data: {
                        MediaListCollection: {
                            lists: [
                                {
                                    entries: [
                                        { progress: 3, media: { id: 1, title: { romaji: "A" }, status: "RELEASING" } }
                                    ]
                                },
                                {
                                    entries: [
                                        { progress: 0, media: { id: 2, title: { english: "B" }, status: "FINISHED" } }
                                    ]
                                },
                                null
                            ]
                        }
                    }
                })
            })
        vi.stubGlobal("fetch", fetchMock)

        const list = await getViewerMangaList("t")

        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(list).toHaveLength(2)
        expect(list[0]).toMatchObject({ anilistId: 1, title: "A", status: "ongoing", progress: 3 })
        expect(list[1]).toMatchObject({ anilistId: 2, title: "B", status: "completed", progress: 0 })
    })

    it("dedups a title AniList surfaces twice via a custom list", async () => {
        // A title on both its status group and a user's custom list appears twice in the
        // MediaListCollection response - the identical entry. getViewerMangaList must return it once.
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { Viewer: { id: 7 } } }) })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    data: {
                        MediaListCollection: {
                            lists: [
                                {
                                    entries: [
                                        {
                                            progress: 3,
                                            media: { id: 31224, title: { romaji: "A" }, status: "RELEASING" }
                                        }
                                    ]
                                },
                                {
                                    entries: [
                                        {
                                            progress: 3,
                                            media: { id: 31224, title: { romaji: "A" }, status: "RELEASING" }
                                        }
                                    ]
                                }
                            ]
                        }
                    }
                })
            })
        vi.stubGlobal("fetch", fetchMock)

        const list = await getViewerMangaList("t")
        expect(list).toHaveLength(1)
        expect(list[0]).toMatchObject({ anilistId: 31224 })
    })

    it("rejects and never fires the collection query when the viewer id is null", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { Viewer: { id: null } } }) })
        vi.stubGlobal("fetch", fetchMock)

        await expect(getViewerMangaList("t")).rejects.toThrow(/viewer id/)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })
})
