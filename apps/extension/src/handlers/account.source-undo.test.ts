import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LibraryManga } from "../database"

vi.stubGlobal("browser", fakeBrowser)
const fetchMock = vi.fn<typeof fetch>()
vi.stubGlobal("fetch", fetchMock)

const { db, createBackup, restoreTitleFromBackup } = await import("../database")
const { runAccountSync } = await import("./account")

const TOKEN = "weeb_test_token_1234567890"
const ID = "source-a:manga:abc"
const T0 = 1_700_000_000_000
const T_SWITCH = T0 + 60_000
const T_UNDO = T_SWITCH + 60_000
const T_SYNC = T_UNDO + 60_000

const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })

const pushed: Array<Record<string, unknown>> = []
let pulled: Array<Record<string, unknown>> = []
let pushAnswer: (items: Array<Record<string, unknown>>) => unknown

beforeEach(async () => {
    fakeBrowser.reset()
    pushed.length = 0
    pulled = []
    pushAnswer = items => ({ accepted: items.map(i => i["clientId"]), rejected: [], invalid: [], serverTime: T_SYNC })
    await Promise.all([db.manga.clear(), db.sourceLinks.clear(), db.chapters.clear(), db.backups.clear()])
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
        const key = `${init?.method ?? "GET"} ${url.pathname}`
        if (key === "POST /api/sync/v2") {
            const body = JSON.parse(init!.body as string) as { items: Array<Record<string, unknown>> }
            pushed.push(...body.items)
            return json(pushAnswer(body.items))
        }
        if (key === "GET /api/sync/v2")
            return json({ items: pulled, nextCursor: "c1", hasMore: false, serverTime: T_SYNC })
        if (key === "GET /api/sync/status") return json({ userId: "u1", name: "Ryu", image: null, itemCount: 1 })
        throw new Error(`unexpected fetch ${key}`)
    })
})

async function switchSyncAndUndo(): Promise<void> {
    vi.spyOn(Date, "now").mockReturnValue(T0)
    await db.manga.put({
        id: ID,
        title: "Original Title",
        normalizedTitle: "original title",
        sourceId: "source-a",
        sourceUrl: "https://source-a.example/title/abc",
        mangaUrl: "https://source-a.example/title/abc",
        authors: [],
        status: "ongoing",
        latestChapterNumber: 40,
        addedAt: T0,
        updatedAt: T0
    } as LibraryManga)
    const backupId = await createBackup("pre-source-change")

    // library:switch moves the title and bumps updatedAt; a sync then pushes it (lastPushAt = T_SWITCH).
    vi.spyOn(Date, "now").mockReturnValue(T_SWITCH)
    await db.manga.update(ID, {
        sourceId: "source-b",
        sourceUrl: "https://source-b.example/s/abc",
        mangaUrl: "https://source-b.example/s/abc",
        latestChapterNumber: 120,
        updatedAt: T_SWITCH
    })
    await fakeBrowser.storage.local.set({
        account: { token: TOKEN, userId: "u1", invalid: false, lastPushAt: T_SWITCH, lastSyncAt: T_SWITCH }
    })

    vi.spyOn(Date, "now").mockReturnValue(T_UNDO)
    await restoreTitleFromBackup(backupId, ID)
    expect((await db.manga.get(ID))!.sourceId).toBe("source-a")
    vi.spyOn(Date, "now").mockReturnValue(T_SYNC)
}

describe("undoing a source change and the account", () => {
    it("pushes the undone source to the account on the next sync", async () => {
        await switchSyncAndUndo()
        await runAccountSync()

        const sent = pushed.find(item => item["clientId"] === ID)
        expect(
            sent,
            "the account still holds the switched source, so other devices and a re-link get it back"
        ).toMatchObject({
            sourceId: "source-a",
            mangaUrl: "https://source-a.example/title/abc",
            latestChapterNumber: 40
        })
        expect(sent!["clientUpdatedAt"]).toBeGreaterThan(T_SWITCH)
    })

    it("sends the undo once, not on every later sync", async () => {
        await switchSyncAndUndo()
        await runAccountSync()
        pushed.length = 0
        vi.spyOn(Date, "now").mockReturnValue(T_SYNC + 60_000)
        await runAccountSync()
        expect(pushed.filter(item => item["clientId"] === ID)).toEqual([])
    })

    it("keeps newer progress from the account and still wins with the undone source", async () => {
        await switchSyncAndUndo()
        const T_OTHER = T_UNDO + 30_000
        pulled = [
            {
                clientId: ID,
                title: "Original Title",
                normalizedTitle: "original title",
                sourceId: "source-b",
                mangaUrl: "https://source-b.example/s/abc",
                status: "ongoing",
                lastReadChapterNumber: 77,
                latestChapterNumber: 120,
                clientUpdatedAt: T_OTHER
            }
        ]
        await runAccountSync()

        const local = (await db.manga.get(ID))!
        expect(local.lastReadChapterNumber).toBe(77)
        expect(local.latestChapterNumber).toBe(40)
        const sent = pushed.find(item => item["clientId"] === ID)
        expect(sent).toMatchObject({ sourceId: "source-a", lastReadChapterNumber: 77, latestChapterNumber: 40 })
        expect(sent!["clientUpdatedAt"]).toBeGreaterThan(T_OTHER)
    })
})

describe("a push answer missing its lists", () => {
    it("does not fail the whole sync", async () => {
        vi.spyOn(Date, "now").mockReturnValue(T0)
        await db.manga.put({
            id: ID,
            title: "Original Title",
            normalizedTitle: "original title",
            sourceId: "source-a",
            sourceUrl: "https://source-a.example/title/abc",
            mangaUrl: "https://source-a.example/title/abc",
            authors: [],
            status: "ongoing",
            addedAt: T0,
            updatedAt: T0 + 1
        } as LibraryManga)
        await fakeBrowser.storage.local.set({
            account: { token: TOKEN, userId: "u1", invalid: false, lastPushAt: 0, lastSyncAt: 0 },
            accountTombstones: { "source-a:manga:gone": T0 }
        })
        pushAnswer = items => ({ accepted: items.map(i => i["clientId"]), serverTime: T_SYNC })
        vi.spyOn(Date, "now").mockReturnValue(T_SYNC)

        const profile = await runAccountSync()
        expect(profile.syncProblem).toBeUndefined()
        expect(profile.lastPushAt).toBe(T0 + 1)
    })
})
