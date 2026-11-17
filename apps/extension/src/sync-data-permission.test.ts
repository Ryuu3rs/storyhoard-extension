import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LibraryManga } from "./database"

const contains = vi.fn<(permissions: unknown) => Promise<boolean>>()
const request = vi.fn<(permissions: unknown) => Promise<boolean>>()
vi.stubGlobal("browser", { ...fakeBrowser, permissions: { contains, request } })
const fetchMock = vi.fn<typeof fetch>()
vi.stubGlobal("fetch", fetchMock)

const { db } = await import("./database")
const { runAccountSync } = await import("./handlers/account")
const { runAniListSync, removeFromAniList } = await import("./handlers/anilist")
const { pushToGist } = await import("./sync")
const { requestSyncData, syncDataAllowed } = await import("./sync-data-permission")

const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })

beforeEach(async () => {
    fakeBrowser.reset()
    contains.mockReset()
    request.mockReset()
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
        if (url.pathname === "/api/sync/v2" && init?.method === "POST") {
            return json({ accepted: [], rejected: [], invalid: [], serverTime: 1 })
        }
        if (url.pathname === "/api/sync/v2") return json({ items: [], nextCursor: null, hasMore: false, serverTime: 1 })
        if (url.pathname === "/api/sync/status") return json({ userId: "u1", name: null, image: null, itemCount: 0 })
        return json({ data: {} })
    })
    await db.manga.clear()
    await db.manga.put({
        id: "site-a:manga:1",
        title: "A Title",
        normalizedTitle: "a title",
        sourceId: "site-a",
        sourceUrl: "https://site-a.example/t/1",
        mangaUrl: "https://site-a.example/t/1",
        authors: [],
        status: "ongoing",
        anilistId: 7,
        lastReadChapterNumber: 3,
        addedAt: 1,
        updatedAt: 2
    } as LibraryManga)
    await fakeBrowser.storage.local.set({
        account: { token: "weeb_test_token_1234567890", invalid: false, lastPushAt: 0, lastSyncAt: 0 },
        syncConfig: { token: "gh-token", autoSync: true },
        anilistConfig: { token: "al-token", autoSync: true, syncMembership: true }
    })
})

afterEach(() => vi.unstubAllEnvs())

describe("sync on Firefox waits for the browsingActivity data permission", () => {
    beforeEach(() => vi.stubEnv("BROWSER", "firefox"))

    it("asks Firefox for browsing activity only", async () => {
        contains.mockResolvedValue(false)
        expect(await syncDataAllowed()).toBe(false)
        expect(contains).toHaveBeenCalledWith({ data_collection: ["browsingActivity"] })
    })

    it("account sync sends nothing and says why", async () => {
        contains.mockResolvedValue(false)
        const profile = await runAccountSync()
        expect(fetchMock).not.toHaveBeenCalled()
        expect(profile.syncProblem).toBe("permission")
    })

    it("the GitHub backup sends nothing", async () => {
        contains.mockResolvedValue(false)
        await expect(pushToGist({ manga: [] })).rejects.toThrow(/Firefox/)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("AniList list sync and removal send nothing", async () => {
        contains.mockResolvedValue(false)
        await runAniListSync()
        await removeFromAniList(7)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("AniList removal goes out once Firefox allows it", async () => {
        contains.mockResolvedValue(true)
        await removeFromAniList(7)
        expect(fetchMock).toHaveBeenCalled()
    })

    it("account sync runs once Firefox allows it", async () => {
        contains.mockResolvedValue(true)
        const profile = await runAccountSync()
        expect(fetchMock).toHaveBeenCalled()
        expect(profile.syncProblem).toBeUndefined()
    })

    it("folds a host grant into the same prompt", async () => {
        request.mockResolvedValue(true)
        await requestSyncData(["https://api.github.com/*"])
        expect(request).toHaveBeenCalledTimes(1)
        expect(request).toHaveBeenCalledWith({
            data_collection: ["browsingActivity"],
            origins: ["https://api.github.com/*"]
        })
    })
})

describe("sync on Chrome", () => {
    beforeEach(() => vi.stubEnv("BROWSER", "chrome"))

    it("needs no data permission", async () => {
        expect(await syncDataAllowed()).toBe(true)
        expect(contains).not.toHaveBeenCalled()
        expect(await requestSyncData()).toBe(true)
        expect(request).not.toHaveBeenCalled()
    })
})
