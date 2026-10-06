import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LibraryManga } from "../database"
import type { AccountProfile } from "../account"

vi.stubGlobal("browser", fakeBrowser)

const fetchMock = vi.fn<typeof fetch>()
vi.stubGlobal("fetch", fetchMock)

const { db } = await import("../database")
const { getAccountProfile, getTombstones, recordTombstone, clearTombstones } = await import("../account")
const { accountHandlers, runAccountSync, applyRemoteItem } = await import("./account")

const ctx = { sender: {} as never }
const TOKEN = "weeb_test_token_1234567890"

function manga(overrides: Partial<LibraryManga> & Pick<LibraryManga, "id" | "title">): LibraryManga {
    return {
        sourceId: "mangadex",
        sourceUrl: `https://mangadex.org/title/${overrides.id}`,
        normalizedTitle: overrides.title.toLowerCase(),
        authors: [],
        status: "ongoing",
        addedAt: 1,
        updatedAt: 1,
        ...overrides
    }
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

const statusBody = { userId: "u1", name: "Ryu", image: null, itemCount: 0 }

function routeFetch(handlers: Record<string, (init?: RequestInit) => Response>) {
    fetchMock.mockImplementation(async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        const path = new URL(url).pathname + new URL(url).search
        const key = `${init?.method ?? "GET"} ${path.split("?")[0]}`
        const h = handlers[key]
        if (!h) throw new Error(`unexpected fetch ${key}`)
        return h(init)
    })
}

beforeEach(async () => {
    fakeBrowser.reset()
    fetchMock.mockReset()
    await db.manga.clear()
})

describe("account:link", () => {
    it("validates the token, stores the profile and runs a first sync", async () => {
        routeFetch({
            "GET /api/sync/status": () => json(statusBody),
            "POST /api/sync/v2": () => json({ accepted: [], rejected: [], invalid: [], serverTime: 5000 }),
            "GET /api/sync/v2": () => json({ items: [], nextCursor: null, hasMore: false, serverTime: 5000 })
        })
        await db.manga.put(manga({ id: "m1", title: "One", updatedAt: 10 }))

        const profile = await accountHandlers["account:link"]!({ type: "account:link", token: TOKEN }, ctx)

        expect(profile).toMatchObject({ token: TOKEN, userId: "u1", name: "Ryu", invalid: false, lastSyncAt: 5000 })
        const push = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!
        expect((push[1]!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
        const sent = JSON.parse(push[1]!.body as string) as { items: Array<{ clientId: string }> }
        expect(sent.items.map(i => i.clientId)).toEqual(["m1"])
    })

    it("rejects a bad token without storing it", async () => {
        routeFetch({ "GET /api/sync/status": () => json({ error: "Unauthorized" }, 401) })
        await expect(accountHandlers["account:link"]!({ type: "account:link", token: TOKEN }, ctx)).rejects.toThrow(
            /no longer valid/
        )
        expect((await getAccountProfile()).token).toBeUndefined()
    })

    it("links the community id once when community features are on", async () => {
        const { updateCommunityProfile } = await import("../community")
        await updateCommunityProfile({ enabled: true, userId: "reader-abc-123", username: "Reader1234" })
        const link = vi.fn((_init?: RequestInit) => json({ ok: true, communityUserId: "reader-abc-123" }))
        routeFetch({
            "GET /api/sync/status": () => json(statusBody),
            "POST /api/sync/v2": () => json({ accepted: [], rejected: [], invalid: [], serverTime: 5000 }),
            "GET /api/sync/v2": () => json({ items: [], nextCursor: null, hasMore: false, serverTime: 5000 }),
            "POST /api/sync/link": link
        })

        const profile = await accountHandlers["account:link"]!({ type: "account:link", token: TOKEN }, ctx)
        expect(profile).toMatchObject({ communityLinkedId: "reader-abc-123" })
        expect(link).toHaveBeenCalledTimes(1)
        expect(JSON.parse(String(link.mock.calls[0]![0]!.body))).toEqual({ communityUserId: "reader-abc-123" })

        await runAccountSync()
        expect(link).toHaveBeenCalledTimes(1)
    })
})

describe("runAccountSync", () => {
    it("pushes only items changed since the last push, plus parked tombstones", async () => {
        await fakeBrowser.storage.local.set({
            account: { token: TOKEN, lastPushAt: 50, lastPullAt: 0, invalid: false, autoSync: true }
        })
        await db.manga.put(manga({ id: "old", title: "Old", updatedAt: 10 }))
        await db.manga.put(manga({ id: "new", title: "New", updatedAt: 100 }))
        await recordTombstone("gone")
        routeFetch({
            "POST /api/sync/v2": () => json({ accepted: [], rejected: [], invalid: [], serverTime: 9000 }),
            "GET /api/sync/v2": () => json({ items: [], nextCursor: null, hasMore: false, serverTime: 9000 }),
            "GET /api/sync/status": () => json(statusBody)
        })

        await runAccountSync()

        const push = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!
        const sent = JSON.parse(push[1]!.body as string) as { items: Array<{ clientId: string; deleted?: boolean }> }
        expect(sent.items.map(i => [i.clientId, i.deleted ?? false])).toEqual([
            ["new", false],
            ["gone", true]
        ])
        expect(await getTombstones()).toEqual({})
        expect((await getAccountProfile()).lastPushAt).toBe(100)
    })

    it("applies pulled items: creates, updates newer, removes tombstoned, keeps newer local edits", async () => {
        await fakeBrowser.storage.local.set({
            account: { token: TOKEN, lastPushAt: 0, lastPullAt: 0, invalid: false, autoSync: true }
        })
        await db.manga.put(manga({ id: "keep", title: "Keep", rating: 2, updatedAt: 500 }))
        await db.manga.put(manga({ id: "upd", title: "Upd", rating: 2, updatedAt: 10 }))
        await db.manga.put(manga({ id: "del", title: "Del", updatedAt: 10 }))
        routeFetch({
            "POST /api/sync/v2": () => json({ accepted: [], rejected: [], invalid: [], serverTime: 9000 }),
            "GET /api/sync/v2": () =>
                json({
                    items: [
                        { clientId: "keep", title: "Keep", normalizedTitle: "keep", rating: 5, clientUpdatedAt: 100 },
                        { clientId: "upd", title: "Upd", normalizedTitle: "upd", rating: 5, clientUpdatedAt: 900 },
                        { clientId: "del", title: "Del", normalizedTitle: "del", deleted: true, clientUpdatedAt: 900 },
                        {
                            clientId: "fresh",
                            title: "Fresh",
                            normalizedTitle: "fresh",
                            sourceId: "mangadex",
                            mangaUrl: "https://mangadex.org/title/fresh",
                            status: "completed",
                            clientUpdatedAt: 900
                        },
                        { clientId: "nosource", title: "No Source", normalizedTitle: "no source", clientUpdatedAt: 900 }
                    ],
                    nextCursor: null,
                    hasMore: false,
                    serverTime: 9000
                }),
            "GET /api/sync/status": () => json(statusBody)
        })

        await runAccountSync()

        expect((await db.manga.get("keep"))?.rating).toBe(2)
        expect((await db.manga.get("upd"))?.rating).toBe(5)
        expect(await db.manga.get("del")).toBeUndefined()
        expect((await db.manga.get("fresh"))?.status).toBe("completed")
        expect(await db.manga.get("nosource")).toBeUndefined()
        expect((await getAccountProfile()).lastSyncAt).toBe(9000)
    })

    it("follows the keyset cursor across pages and stores the final cursor", async () => {
        await fakeBrowser.storage.local.set({
            account: { token: TOKEN, lastPushAt: 0, invalid: false, autoSync: true }
        })
        let pull = 0
        const pages = [
            {
                items: [
                    {
                        clientId: "p1",
                        title: "Page1",
                        normalizedTitle: "page1",
                        sourceId: "mangadex",
                        mangaUrl: "https://mangadex.org/title/p1",
                        clientUpdatedAt: 900
                    }
                ],
                nextCursor: "cursor-1",
                hasMore: true,
                serverTime: 9000
            },
            {
                items: [
                    {
                        clientId: "p2",
                        title: "Page2",
                        normalizedTitle: "page2",
                        sourceId: "mangadex",
                        mangaUrl: "https://mangadex.org/title/p2",
                        clientUpdatedAt: 900
                    }
                ],
                nextCursor: "cursor-2",
                hasMore: false,
                serverTime: 9000
            }
        ]
        routeFetch({
            "POST /api/sync/v2": () => json({ accepted: [], rejected: [], invalid: [], serverTime: 9000 }),
            "GET /api/sync/v2": () => json(pages[Math.min(pull++, 1)]),
            "GET /api/sync/status": () => json(statusBody)
        })

        await runAccountSync()

        expect(await db.manga.get("p1")).toBeTruthy()
        expect(await db.manga.get("p2")).toBeTruthy()
        expect(pull).toBe(2)
        expect((await getAccountProfile()).pullCursor).toBe("cursor-2")
    })

    it("stores the server-resolved workId carried by a pulled item", async () => {
        await fakeBrowser.storage.local.set({
            account: { token: TOKEN, lastPushAt: 0, invalid: false, autoSync: true }
        })
        routeFetch({
            "POST /api/sync/v2": () => json({ accepted: [], rejected: [], invalid: [], serverTime: 9000 }),
            "GET /api/sync/v2": () =>
                json({
                    items: [
                        {
                            clientId: "w1",
                            title: "Worked",
                            normalizedTitle: "worked",
                            sourceId: "mangadex",
                            mangaUrl: "https://mangadex.org/title/w1",
                            workId: "work_xyz",
                            mediaType: "manga",
                            clientUpdatedAt: 900
                        }
                    ],
                    nextCursor: null,
                    hasMore: false,
                    serverTime: 9000
                }),
            "GET /api/sync/status": () => json(statusBody)
        })

        await runAccountSync()

        expect((await db.manga.get("w1"))?.workId).toBe("work_xyz")
    })

    it("adopts a rejected push's server copy and logs invalid items", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        await fakeBrowser.storage.local.set({
            account: { token: TOKEN, lastPushAt: 0, invalid: false, autoSync: true }
        })
        await db.manga.put(manga({ id: "loser", title: "Local", rating: 1, updatedAt: 10 }))
        routeFetch({
            "POST /api/sync/v2": () =>
                json({
                    accepted: [],
                    rejected: [
                        {
                            clientId: "loser",
                            server: {
                                clientId: "loser",
                                title: "Local",
                                normalizedTitle: "local",
                                rating: 5,
                                clientUpdatedAt: 999
                            }
                        }
                    ],
                    invalid: [{ clientId: "bad", issues: ["title: Required"] }],
                    serverTime: 9000
                }),
            "GET /api/sync/v2": () => json({ items: [], nextCursor: null, hasMore: false, serverTime: 9000 }),
            "GET /api/sync/status": () => json(statusBody)
        })

        await runAccountSync()

        expect((await db.manga.get("loser"))?.rating).toBe(5)
        expect(warn).toHaveBeenCalledWith("[AMR] Account sync rejected invalid items", [
            { clientId: "bad", issues: ["title: Required"] }
        ])
        warn.mockRestore()
    })

    it("marks the profile invalid and clears the alarm on 401", async () => {
        await fakeBrowser.storage.local.set({
            account: { token: TOKEN, lastPushAt: 0, lastPullAt: 0, invalid: false, autoSync: true }
        })
        await db.manga.put(manga({ id: "m1", title: "One", updatedAt: 10 }))
        routeFetch({ "POST /api/sync/v2": () => json({ error: "Unauthorized" }, 401) })

        const profile = await runAccountSync()

        expect(profile.invalid).toBe(true)
        expect(profile.token).toBe(TOKEN)
    })

    it("does nothing when unlinked", async () => {
        await runAccountSync()
        expect(fetchMock).not.toHaveBeenCalled()
    })
})

describe("applyRemoteItem", () => {
    it("coerces unknown status / rating values safely", async () => {
        await applyRemoteItem({
            clientId: "x",
            title: "X",
            normalizedTitle: "x",
            sourceId: "s",
            mangaUrl: "https://example.test/x",
            status: "weird",
            rating: 9,
            clientUpdatedAt: 1
        })
        const row = await db.manga.get("x")
        expect(row?.status).toBe("unknown")
        expect(row?.rating).toBeUndefined()
    })

    it("applies synced notes, tags, flags and per-title reader overrides on a new title", async () => {
        await applyRemoteItem({
            clientId: "meta",
            title: "Meta",
            normalizedTitle: "meta",
            sourceId: "s",
            mangaUrl: "https://example.test/meta",
            notes: "a note",
            categories: ["Favorites"],
            onHold: true,
            manualTracking: true,
            nsfw: true,
            pageWidthPct: 60,
            readingDirection: "rtl",
            pageFit: "height",
            noGapContinuous: true,
            continuousScroll: true,
            readerTheme: "dark",
            clientUpdatedAt: 1
        })
        const row = await db.manga.get("meta")
        expect(row).toMatchObject({
            notes: "a note",
            categories: ["Favorites"],
            onHold: true,
            manualTracking: true,
            nsfw: true,
            pageWidthPct: 60,
            readingDirection: "rtl",
            pageFit: "height",
            noGapContinuous: true,
            continuousScroll: true,
            readerTheme: "dark"
        })
    })

    it("ignores an invalid synced readingDirection/pageFit/readerTheme rather than storing junk", async () => {
        await applyRemoteItem({
            clientId: "bad",
            title: "Bad",
            normalizedTitle: "bad",
            sourceId: "s",
            mangaUrl: "https://example.test/bad",
            readingDirection: "sideways",
            pageFit: "zoomzoom",
            readerTheme: "sepia",
            clientUpdatedAt: 1
        })
        const row = await db.manga.get("bad")
        expect(row?.readingDirection).toBeUndefined()
        expect(row?.pageFit).toBeUndefined()
        expect(row?.readerTheme).toBeUndefined()
    })
})

describe("account:unlink", () => {
    it("clears the profile and parked tombstones", async () => {
        await fakeBrowser.storage.local.set({
            account: { token: TOKEN, lastPushAt: 0, lastPullAt: 0, invalid: false, autoSync: true }
        })
        await recordTombstone("gone")
        const profile = (await accountHandlers["account:unlink"]!({ type: "account:unlink" }, ctx)) as AccountProfile
        expect(profile.token).toBeUndefined()
        expect(await getTombstones()).toEqual({})
    })
})

describe("tombstone concurrency (bughunt)", () => {
    beforeEach(async () => {
        await fakeBrowser.storage.local.set({
            account: { token: TOKEN, lastPushAt: 0, lastPullAt: 0, invalid: false, autoSync: true }
        })
    })

    it("a removal fired while clearTombstones runs is not lost", async () => {
        await recordTombstone("A")
        const parked = await getTombstones()
        // Clear the pushed set and record a new removal concurrently - the lock must keep B.
        await Promise.all([clearTombstones(parked), recordTombstone("B")])
        const after = await getTombstones()
        expect(Object.keys(after)).toContain("B")
        expect(after.A).toBeUndefined()
    })

    it("clearTombstones only removes ids whose timestamp still matches", async () => {
        await recordTombstone("A")
        const pushed = await getTombstones()
        // Simulate A being re-removed with a newer timestamp while the sync's push was in flight.
        await fakeBrowser.storage.local.set({ accountTombstones: { A: (pushed.A as number) + 1000 } })
        await clearTombstones(pushed) // pushed timestamp no longer matches the stored one -> keep it parked
        expect((await getTombstones()).A).toBeDefined()
    })
})
