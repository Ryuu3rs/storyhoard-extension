import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LibraryManga } from "../database"
import type { AccountProfile } from "../account"
import { _resetProtectedStoreForTests, setProtected } from "../protected-store"

beforeEach(() => _resetProtectedStoreForTests())

vi.stubGlobal("browser", fakeBrowser)

const fetchMock = vi.fn<typeof fetch>()
vi.stubGlobal("fetch", fetchMock)

const { db } = await import("../database")
const { getAccountProfile, getTombstones, recordTombstone, clearTombstones } = await import("../account")
const { accountHandlers, runAccountSync, applyRemoteItem } = await import("./account")
const { importDatabase, libraryChangeSignature, updateManga } = await import("../database")

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

describe("account:status", () => {
    beforeEach(async () => {
        await setProtected("account", { token: TOKEN, userId: "u1", name: "Ryu", invalid: false })
    })

    it("hands the device token only to the extension's own pages", async () => {
        const appPage = { sender: { url: fakeBrowser.runtime.getURL("/app.html"), tab: { id: 3 } } as never }
        const res = (await accountHandlers["account:status"]!({ type: "account:status" }, appPage)) as AccountProfile
        expect(res.token).toBe(TOKEN)
    })

    it("never hands the token to a content script, but says whether an account is linked", async () => {
        const bridge = { sender: { url: "https://weeb.ltd/welcome", tab: { id: 7, url: "https://weeb.ltd/welcome" } } }
        const res = (await accountHandlers["account:status"]!({ type: "account:status" }, bridge as never)) as Record<
            string,
            unknown
        >
        expect(res).not.toHaveProperty("token")
        expect(JSON.stringify(res)).not.toContain(TOKEN)
        expect(res.linked).toBe(true)
    })

    it("reports a revoked token as not linked to a content script", async () => {
        await setProtected("account", { token: TOKEN, invalid: true })
        const bridge = { sender: { url: "https://weeb.ltd/", tab: { id: 7 } } }
        const res = (await accountHandlers["account:status"]!({ type: "account:status" }, bridge as never)) as Record<
            string,
            unknown
        >
        expect(res.linked).toBe(false)
    })
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

    // BUGHUNT (errors/funnel): linkAccountWithToken validates the token (GET status 200), stores
    // it, then runs the first sync. If that first sync hits a 401 (token revoked in the window, or
    // the push endpoint rejecting auth the status endpoint accepted), runAccountSync swallows the
    // AccountAuthError and returns invalid:true WITHOUT throwing. account:link therefore still fires
    // the account_linked funnel event for a link that landed straight in the unusable invalid state,
    // overcounting successful onboardings. (The handoff redeem path shares the same emit-after-link.)
    it("does not emit account_linked when the first sync lands the profile in the invalid state", async () => {
        await db.analyticsEvents.clear()
        routeFetch({
            "GET /api/sync/status": () => json(statusBody),
            "POST /api/sync/v2": () => json({ error: "Unauthorized" }, 401)
        })
        await db.manga.put(manga({ id: "m1", title: "One", updatedAt: 10 }))

        const profile = (await accountHandlers["account:link"]!(
            { type: "account:link", token: TOKEN },
            ctx
        )) as AccountProfile

        // The link is actually in the invalid state - sync is stopped until the user re-links.
        expect(profile.invalid).toBe(true)
        // So the onboarding funnel must NOT count this as a completed link.
        const events = await db.analyticsEvents.where("event").equals("account_linked").toArray()
        expect(events).toHaveLength(0)
    })

    it("rejects a bad token without storing it", async () => {
        routeFetch({ "GET /api/sync/status": () => json({ error: "Unauthorized" }, 401) })
        await expect(accountHandlers["account:link"]!({ type: "account:link", token: TOKEN }, ctx)).rejects.toThrow(
            /no longer valid/
        )
        expect((await getAccountProfile()).token).toBeUndefined()
    })

    it("does not link the community id of an opt-in that has not accepted the current consent card", async () => {
        const { updateCommunityProfile } = await import("../community")
        await updateCommunityProfile({
            enabled: true,
            userId: "reader-abc-123",
            username: "Reader1234",
            consentVersion: 0
        })
        const link = vi.fn((_init?: RequestInit) => json({ ok: true, communityUserId: "reader-abc-123" }))
        routeFetch({
            "GET /api/sync/status": () => json(statusBody),
            "POST /api/sync/v2": () => json({ accepted: [], rejected: [], invalid: [], serverTime: 5000 }),
            "GET /api/sync/v2": () => json({ items: [], nextCursor: null, hasMore: false, serverTime: 5000 }),
            "POST /api/sync/link": link
        })

        await accountHandlers["account:link"]!({ type: "account:link", token: TOKEN }, ctx)
        expect(link).not.toHaveBeenCalled()
    })

    it("links the community id once when community features are on", async () => {
        const { CONSENT_VERSION, updateCommunityProfile } = await import("../community")
        await updateCommunityProfile({
            enabled: true,
            userId: "reader-abc-123",
            username: "Reader1234",
            consentVersion: CONSENT_VERSION
        })
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
        await setProtected("account", { token: TOKEN, lastPushAt: 50, lastPullAt: 0, invalid: false, autoSync: true })
        await db.manga.put(manga({ id: "old", title: "Old", updatedAt: 10 }))
        await db.manga.put(manga({ id: "new", title: "New", updatedAt: 100 }))
        await recordTombstone("gone")
        routeFetch({
            "POST /api/sync/v2": init => {
                const { items } = JSON.parse(init!.body as string) as { items: Array<{ clientId: string }> }
                return json({ accepted: items.map(i => i.clientId), rejected: [], invalid: [], serverTime: 9000 })
            },
            "GET /api/sync/v2": () => json({ items: [], nextCursor: null, hasMore: false, serverTime: 9000 }),
            "GET /api/sync/status": () => json(statusBody)
        })

        await runAccountSync()

        const pushes = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")
        const sent = pushes.flatMap(
            ([, init]) =>
                (JSON.parse(init!.body as string) as { items: Array<{ clientId: string; deleted?: boolean }> }).items
        )
        expect(sent.map(i => [i.clientId, i.deleted ?? false])).toEqual([
            ["new", false],
            ["gone", true]
        ])
        expect(await getTombstones()).toEqual({})
        expect((await getAccountProfile()).lastPushAt).toBe(100)
    })

    it("applies pulled items: creates, updates newer, removes tombstoned, keeps newer local edits", async () => {
        await setProtected("account", { token: TOKEN, lastPushAt: 0, lastPullAt: 0, invalid: false, autoSync: true })
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
        await setProtected("account", { token: TOKEN, lastPushAt: 0, invalid: false, autoSync: true })
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
        await setProtected("account", { token: TOKEN, lastPushAt: 0, invalid: false, autoSync: true })
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
        await setProtected("account", { token: TOKEN, lastPushAt: 0, invalid: false, autoSync: true })
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
        expect(warn).toHaveBeenCalledWith("[AMR:account-sync] the server refused rows", {
            invalid: [{ clientId: "bad", issues: ["title: Required"] }]
        })
        warn.mockRestore()
    })

    it("marks the profile invalid and clears the alarm on 401", async () => {
        await setProtected("account", { token: TOKEN, lastPushAt: 0, lastPullAt: 0, invalid: false, autoSync: true })
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
    it("gives a pulled new title a source link, so update checks reach it", async () => {
        await applyRemoteItem({
            clientId: "mangadex:manga:abc",
            title: "Pulled",
            normalizedTitle: "pulled",
            sourceId: "mangadex",
            sourceMangaId: "abc",
            mangaUrl: "https://mangadex.org/title/abc",
            clientUpdatedAt: 1
        })
        expect(await db.sourceLinks.get("mangadex:manga:abc")).toMatchObject({
            mangaId: "mangadex:manga:abc",
            sourceId: "mangadex",
            sourceMangaId: "abc",
            url: "https://mangadex.org/title/abc"
        })
    })

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

    it("ignores an out-of-range synced pageWidthPct", async () => {
        await applyRemoteItem({
            clientId: "w",
            title: "W",
            normalizedTitle: "w",
            sourceId: "s",
            mangaUrl: "https://example.test/w",
            pageWidthPct: 5000,
            clientUpdatedAt: 1
        })
        expect((await db.manga.get("w"))?.pageWidthPct).toBeUndefined()
    })

    it("carries readingStatusUpdatedAt across a device through the sync contract", async () => {
        const { toSyncItem } = await import("../account")
        const wire = toSyncItem(
            manga({ id: "m1", title: "Drop", readingStatus: "dropped", readingStatusUpdatedAt: 5000, updatedAt: 5000 })
        )
        await applyRemoteItem({ ...wire, clientUpdatedAt: 5000 })
        const onB = await db.manga.get("m1")
        expect(onB?.readingStatus).toBe("dropped")
        // Without the change-time crossing, AniList's tiebreak on the receiving device falls back
        // to lastReadAt ?? 0 and can clobber the just-synced status.
        expect(onB?.readingStatusUpdatedAt).toBe(5000)
    })

    it("keeps the auto-add stamp on this device only", async () => {
        const { toSyncItem } = await import("../account")
        const wire = toSyncItem(
            manga({ id: "auto", title: "Auto", mangaUrl: "https://example.test/auto", autoAddedAt: 5000 } as never)
        )
        expect(wire).not.toHaveProperty("autoAddedAt")
        await applyRemoteItem({ ...wire, autoAddedAt: 5000, clientUpdatedAt: 5000 } as never)
        const pulled = await db.manga.get("auto")
        expect(pulled?.title).toBe("Auto")
        expect(pulled?.autoAddedAt).toBeUndefined()
    })

    it("carries a title added by its Work id to another device, with no site and its Work id", async () => {
        const { toSyncItem } = await import("../account")
        const wire = toSyncItem(
            manga({
                id: "weeb:work:w_only-1",
                title: "Catalog Only",
                sourceId: "weeb.ltd",
                sourceUrl: "amr:work:w_only-1",
                workId: "w_only-1",
                manualTracking: true,
                readingStatus: "planning",
                updatedAt: 5000
            })
        )
        expect(wire).toMatchObject({ clientId: "weeb:work:w_only-1", sourceId: "weeb.ltd", mangaUrl: null })
        // The server never echoes a client Work id back, and may not have resolved one yet.
        expect(await applyRemoteItem({ ...wire, workId: null, clientUpdatedAt: 5000 })).toBe(true)
        const onB = await db.manga.get("weeb:work:w_only-1")
        expect(onB).toMatchObject({
            title: "Catalog Only",
            sourceId: "weeb.ltd",
            sourceUrl: "amr:work:w_only-1",
            workId: "w_only-1",
            manualTracking: true,
            readingStatus: "planning"
        })
        expect(onB?.mangaUrl).toBeUndefined()
    })

    it("keeps a Work-keyed title on its catalog sentinel whatever source a pulled copy names", async () => {
        await applyRemoteItem({
            clientId: "weeb:work:w2",
            title: "Pulled Work",
            normalizedTitle: "pulled work",
            sourceId: "mangadex",
            mangaUrl: "https://mangadex.org/title/x",
            workId: "w2",
            clientUpdatedAt: 10
        })
        expect(await db.manga.get("weeb:work:w2")).toMatchObject({
            sourceId: "weeb.ltd",
            sourceUrl: "amr:work:w2",
            workId: "w2",
            manualTracking: true
        })
        expect(await db.sourceLinks.get("weeb:work:w2")).toBeUndefined()
    })

    it("does not drop a local Work id when the pulled copy has none", async () => {
        await db.manga.put(
            manga({
                id: "weeb:work:w3",
                title: "Local Work",
                sourceId: "weeb.ltd",
                sourceUrl: "amr:work:w3",
                workId: "w3",
                updatedAt: 1
            })
        )
        await applyRemoteItem({
            clientId: "weeb:work:w3",
            title: "Local Work",
            normalizedTitle: "local work",
            sourceId: "weeb.ltd",
            mangaUrl: null,
            workId: null,
            rating: 4,
            clientUpdatedAt: 50
        })
        expect(await db.manga.get("weeb:work:w3")).toMatchObject({ workId: "w3", rating: 4 })
    })

    it("skips a pulled row with no site whose Work id is malformed", async () => {
        expect(
            await applyRemoteItem({
                clientId: "weeb:work:bad id",
                title: "Bad",
                normalizedTitle: "bad",
                sourceId: "weeb.ltd",
                mangaUrl: null,
                clientUpdatedAt: 10
            })
        ).toBe(false)
        expect(await db.manga.count()).toBe(0)
    })

    it("does not regress updatedAt when a user edit lands during applyRemoteItem (TOCTOU)", async () => {
        const { updateManga } = await import("../database")
        await db.manga.put(manga({ id: "m1", title: "One", updatedAt: 100 }))
        const server = { clientId: "m1", title: "One", normalizedTitle: "one", clientUpdatedAt: 200 } as never

        const orig = db.manga.get.bind(db.manga)
        let once = true
        vi.spyOn(db.manga, "get").mockImplementation((async (id: string) => {
            const row = await orig(id)
            if (once && id === "m1") {
                once = false
                await updateManga("m1", { pageFit: "width", updatedAt: 300 } as never)
            }
            return row
        }) as never)
        await applyRemoteItem(server)
        vi.restoreAllMocks()

        expect((await db.manga.get("m1"))?.updatedAt).toBe(300)
    })
})

describe("runAccountSync re-link race", () => {
    it("keeps the re-link reset when a prior sync finishes afterwards", async () => {
        const { updateAccountProfile, getAccountProfile } = await import("../account")
        await updateAccountProfile({
            token: "old_token_000000000000",
            lastPushAt: 100,
            pullCursor: "cursorOld",
            invalid: false,
            autoSync: true
        })
        await db.manga.put(manga({ id: "m1", title: "One", updatedAt: 150 }))

        let releasePull!: () => void
        const pullGate = new Promise<Response>(res => {
            releasePull = () => res(json({ items: [], nextCursor: "cursorOld", hasMore: false, serverTime: 9000 }))
        })
        routeFetch({
            "POST /api/sync/v2": () => json({ accepted: ["m1"], rejected: [], invalid: [], serverTime: 9000 }),
            // routeFetch awaits the handler's return, so a pending promise gates the pull until released.
            "GET /api/sync/v2": () => pullGate as unknown as Response,
            "GET /api/sync/status": () => json(statusBody)
        })

        const syncP = runAccountSync() // running=true; pushes, then parks on the gated pull
        for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))

        // Re-link to a new account while the old sync is parked on the pull.
        await accountHandlers["account:link"]!({ type: "account:link", token: "new_token_111111111111" }, ctx)

        releasePull()
        await syncP

        const prof = await getAccountProfile()
        expect(prof.token).toBe("new_token_111111111111")
        expect(prof.lastPushAt).toBe(0)
        expect(prof.pullCursor).toBeUndefined()
    })
})

describe("account:unlink", () => {
    it("clears the profile but keeps parked removals for the same account", async () => {
        await setProtected("account", {
            token: TOKEN,
            userId: "u1",
            lastPushAt: 0,
            lastSyncAt: 0,
            invalid: false,
            autoSync: true
        })
        await recordTombstone("gone")
        const profile = (await accountHandlers["account:unlink"]!({ type: "account:unlink" }, ctx)) as AccountProfile
        expect(profile.token).toBeUndefined()
        expect(Object.keys(await getTombstones())).toEqual(["gone"])
    })
})

describe("deletes reach the account safely", () => {
    const pushBody = (init?: RequestInit) =>
        JSON.parse(init!.body as string) as { items: Array<{ clientId: string; deleted?: boolean }> }
    const linked = (extra = {}) =>
        setProtected("account", {
            token: TOKEN,
            userId: "u1",
            lastPushAt: 0,
            lastSyncAt: 0,
            invalid: false,
            autoSync: true,
            ...extra
        })
    const pull = () => json({ items: [], nextCursor: null, hasMore: false, serverTime: 9000 })
    const sentItems = () =>
        fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").flatMap(([, init]) => pushBody(init).items)

    function serverRejectsInvalid(isInvalid: (id: string) => boolean) {
        routeFetch({
            "POST /api/sync/v2": init => {
                const ids = pushBody(init).items.map(i => i.clientId)
                return json({
                    accepted: ids.filter(id => !isInvalid(id)),
                    rejected: [],
                    invalid: ids.filter(isInvalid).map(clientId => ({ clientId, issues: ["too long"] })),
                    serverTime: 9000
                })
            },
            "GET /api/sync/v2": pull,
            "GET /api/sync/status": () => json(statusBody)
        })
    }

    it("keeps a removal the server did not accept, and sends it again", async () => {
        await linked()
        await recordTombstone("gone")
        serverRejectsInvalid(() => true)
        await runAccountSync()
        expect(Object.keys(await getTombstones())).toEqual(["gone"])

        fetchMock.mockReset()
        serverRejectsInvalid(() => false)
        await runAccountSync()
        expect(sentItems().map(i => i.clientId)).toEqual(["gone"])
        expect(await getTombstones()).toEqual({})
    })

    it("drops a removal once the server holds something newer", async () => {
        await linked()
        await recordTombstone("gone")
        routeFetch({
            "POST /api/sync/v2": () =>
                json({
                    accepted: [],
                    rejected: [
                        {
                            clientId: "gone",
                            server: { clientId: "gone", title: "Gone", normalizedTitle: "gone", clientUpdatedAt: 1 }
                        }
                    ],
                    invalid: [],
                    serverTime: 9000
                }),
            "GET /api/sync/v2": pull,
            "GET /api/sync/status": () => json(statusBody)
        })
        await runAccountSync()
        expect(await getTombstones()).toEqual({})
    })

    it("does not delete a moved title's old row while its new row is refused, and retries both", async () => {
        const longId = `thunderscans:manga:${"x".repeat(190)}`
        await linked()
        await db.manga.put(manga({ id: longId, title: "Moved", updatedAt: 100 }))
        await recordTombstone("thunderscans:manga:old", longId)

        serverRejectsInvalid(id => id === longId)
        await runAccountSync()
        expect(sentItems().some(i => i.clientId === "thunderscans:manga:old")).toBe(false)
        expect(Object.keys(await getTombstones())).toEqual(["thunderscans:manga:old"])

        fetchMock.mockReset()
        serverRejectsInvalid(id => id === longId)
        await runAccountSync()
        expect(sentItems().map(i => i.clientId)).toEqual([longId])
        expect(Object.keys(await getTombstones())).toEqual(["thunderscans:manga:old"])

        fetchMock.mockReset()
        serverRejectsInvalid(() => false)
        await runAccountSync()
        expect(sentItems().map(i => [i.clientId, i.deleted ?? false])).toEqual([
            [longId, false],
            ["thunderscans:manga:old", true]
        ])
        expect(await getTombstones()).toEqual({})

        fetchMock.mockReset()
        serverRejectsInvalid(() => false)
        await runAccountSync()
        expect(sentItems()).toEqual([])
    })

    it("drops a parked removal when the title is back in the library", async () => {
        await linked({ lastPushAt: 500 })
        await recordTombstone("back")
        await db.manga.put(manga({ id: "back", title: "Back", updatedAt: 100 }))
        serverRejectsInvalid(() => false)
        await runAccountSync()
        expect(sentItems()).toEqual([])
        expect(await getTombstones()).toEqual({})
    })

    it("records a removal made while unlinked and sends it when the same account links again", async () => {
        await linked()
        await accountHandlers["account:unlink"]!({ type: "account:unlink" }, ctx)
        await recordTombstone("removed-offline")
        serverRejectsInvalid(() => false)
        await accountHandlers["account:link"]!({ type: "account:link", token: TOKEN }, ctx)
        expect(sentItems().map(i => [i.clientId, i.deleted ?? false])).toEqual([["removed-offline", true]])
        expect(await getTombstones()).toEqual({})
    })

    it("never carries removals over to a different account", async () => {
        await linked({ userId: "someone-else" })
        await accountHandlers["account:unlink"]!({ type: "account:unlink" }, ctx)
        await recordTombstone("removed-offline")
        serverRejectsInvalid(() => false)
        await accountHandlers["account:link"]!({ type: "account:link", token: TOKEN }, ctx)
        expect(sentItems()).toEqual([])
        expect(await getTombstones()).toEqual({})
    })

    it("records nothing for someone who has never linked", async () => {
        await recordTombstone("never-linked")
        expect(await getTombstones()).toEqual({})
    })

    it("backs up once before a pulled delete, and not when nothing is deleted", async () => {
        await linked()
        await db.backups.clear()
        await db.manga.bulkPut([
            manga({ id: "a", title: "A", updatedAt: 1 }),
            manga({ id: "b", title: "B", updatedAt: 1 })
        ])
        const tomb = (clientId: string) => ({
            clientId,
            title: clientId,
            normalizedTitle: clientId,
            deleted: true,
            clientUpdatedAt: 5000
        })
        routeFetch({
            "POST /api/sync/v2": init => {
                const ids = pushBody(init).items.map(i => i.clientId)
                return json({ accepted: ids, rejected: [], invalid: [], serverTime: 9000 })
            },
            "GET /api/sync/v2": () =>
                json({ items: [tomb("a"), tomb("b")], nextCursor: null, hasMore: false, serverTime: 9000 }),
            "GET /api/sync/status": () => json(statusBody)
        })
        await runAccountSync()
        const backups = await db.backups.toArray()
        expect(backups.map(b => b.reason)).toEqual(["pre-sync-delete"])
        expect(JSON.stringify(backups[0]!.envelope)).toContain('"title":"A"')
        expect(await db.manga.count()).toBe(0)

        fetchMock.mockReset()
        serverRejectsInvalid(() => false)
        await runAccountSync()
        expect(await db.backups.count()).toBe(1)
    })

    it("keeps the title when the backup before a pulled delete fails", async () => {
        await linked()
        await db.manga.put(manga({ id: "keep", title: "Keep", updatedAt: 1 }))
        const backupSpy = vi.spyOn(db.backups, "add").mockRejectedValueOnce(new Error("disk full"))
        routeFetch({
            "POST /api/sync/v2": init => {
                const ids = pushBody(init).items.map(i => i.clientId)
                return json({ accepted: ids, rejected: [], invalid: [], serverTime: 9000 })
            },
            "GET /api/sync/v2": () =>
                json({
                    items: [
                        { clientId: "keep", title: "x", normalizedTitle: "x", deleted: true, clientUpdatedAt: 5000 }
                    ],
                    nextCursor: null,
                    hasMore: false,
                    serverTime: 9000
                }),
            "GET /api/sync/status": () => json(statusBody)
        })
        await runAccountSync()
        backupSpy.mockRestore()
        expect(await db.manga.get("keep")).toBeDefined()
    })
})

describe("when sync cannot run", () => {
    const linked = (extra = {}) =>
        setProtected("account", {
            token: TOKEN,
            userId: "u1",
            lastPushAt: 0,
            lastSyncAt: 0,
            invalid: false,
            autoSync: true,
            ...extra
        })
    const suspended = () => json({ error: "Account suspended", code: "account_suspended" }, 403)

    it("marks a suspended account and keeps the link, removals and cursor for when it lifts", async () => {
        await linked({ pullCursor: "c1" })
        await recordTombstone("gone")
        routeFetch({ "POST /api/sync/v2": suspended })

        const profile = await runAccountSync()

        expect(profile).toMatchObject({ token: TOKEN, invalid: false, pullCursor: "c1", syncProblem: "suspended" })
        expect(Object.keys(await getTombstones())).toEqual(["gone"])
    })

    it("treats any other refusal or outage as a failed sync, not a suspension", async () => {
        await linked()
        await db.manga.put(manga({ id: "a", title: "A", updatedAt: 100 }))
        routeFetch({ "POST /api/sync/v2": () => json({ error: "Forbidden" }, 403) })

        expect((await runAccountSync()).syncProblem).toBe("failed")
    })

    it("clears the problem on the next good sync", async () => {
        await linked({ syncProblem: "suspended" })
        routeFetch({
            "POST /api/sync/v2": () => json({ accepted: [], rejected: [], invalid: [], serverTime: 9000 }),
            "GET /api/sync/v2": () => json({ items: [], nextCursor: null, hasMore: false, serverTime: 9000 }),
            "GET /api/sync/status": () => json(statusBody)
        })

        expect((await runAccountSync()).syncProblem).toBeUndefined()
    })
})

describe("tombstone concurrency (bughunt)", () => {
    beforeEach(async () => {
        await setProtected("account", { token: TOKEN, lastPushAt: 0, lastPullAt: 0, invalid: false, autoSync: true })
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

describe("hostile or malformed account payloads", () => {
    const FAR_FUTURE = 8_000_000_000_000_000
    const emptyPush = { accepted: [], rejected: [], invalid: [], serverTime: 5000 }
    const rawJson = (text: string) =>
        new Response(text, { status: 200, headers: { "Content-Type": "application/json" } })
    const pushedItems = () =>
        fetchMock.mock.calls
            .filter(([, init]) => init?.method === "POST")
            .flatMap(
                ([, init]) =>
                    (
                        JSON.parse(init!.body as string) as {
                            items: Array<{ clientId: string; clientUpdatedAt: number }>
                        }
                    ).items
            )
    const pushedIds = () => pushedItems().map(i => i.clientId)
    const pull = (items: unknown[]) => () => json({ items, nextCursor: "c1", hasMore: false, serverTime: 5000 })
    const row = (clientId: string, extra: Record<string, unknown> = {}) => ({
        clientId,
        title: clientId.toUpperCase(),
        normalizedTitle: clientId,
        sourceId: "mangadex",
        mangaUrl: `https://mangadex.org/title/${clientId}`,
        clientUpdatedAt: 100,
        ...extra
    })

    beforeEach(async () => {
        await Promise.all([db.sourceLinks.clear(), db.backups.clear()])
        await setProtected("account", {
            token: TOKEN,
            userId: "u1",
            invalid: false,
            lastPushAt: 0,
            lastSyncAt: 0,
            autoSync: true
        })
    })

    it("clamps a pulled far-future clientUpdatedAt so later local edits to other titles still push", async () => {
        await db.manga.put(manga({ id: "mine", title: "Mine", updatedAt: 10 }))
        let pulled = false
        routeFetch({
            "GET /api/sync/status": () => json(statusBody),
            "POST /api/sync/v2": () => json(emptyPush),
            "GET /api/sync/v2": () => {
                const items = pulled ? [] : [row("poison", { clientUpdatedAt: FAR_FUTURE })]
                pulled = true
                return json({ items, nextCursor: "c1", hasMore: false, serverTime: 5000 })
            }
        })

        await runAccountSync()
        expect((await db.manga.get("poison"))!.updatedAt).toBeLessThanOrEqual(Date.now() + 60_000)
        await runAccountSync()
        expect((await getAccountProfile()).lastPushAt).toBeLessThan(Date.now())

        await updateManga("mine", { rating: 5, updatedAt: Date.now() } as Partial<LibraryManga>)
        fetchMock.mockClear()
        await runAccountSync()
        expect(pushedIds()).toContain("mine")
    })

    it("clamps an imported far-future updatedAt so later local edits still push", async () => {
        await db.manga.put(manga({ id: "mine", title: "Mine", updatedAt: 10 }))
        await importDatabase({
            format: "all-mangas-reader",
            version: 1,
            data: { manga: [manga({ id: "crafted", title: "Crafted", updatedAt: FAR_FUTURE })] }
        })
        expect((await db.manga.get("crafted"))!.updatedAt).toBeLessThanOrEqual(Date.now())
        routeFetch({
            "GET /api/sync/status": () => json(statusBody),
            "POST /api/sync/v2": () => json(emptyPush),
            "GET /api/sync/v2": () => json({ items: [], nextCursor: null, hasMore: false, serverTime: 5000 })
        })
        await runAccountSync()

        await updateManga("mine", { rating: 4, updatedAt: Date.now() } as Partial<LibraryManga>)
        fetchMock.mockClear()
        await runAccountSync()
        expect(pushedIds()).toContain("mine")
    })

    it("recovers an install whose push clock and rows were already stamped in the future", async () => {
        await setProtected("account", {
            token: TOKEN,
            userId: "u1",
            invalid: false,
            lastPushAt: FAR_FUTURE,
            lastSyncAt: 0,
            autoSync: true
        })
        await db.manga.bulkPut([
            manga({ id: "mine", title: "Mine", updatedAt: 10 }),
            manga({ id: "poisoned", title: "Poisoned", updatedAt: FAR_FUTURE })
        ])
        routeFetch({
            "GET /api/sync/status": () => json(statusBody),
            "POST /api/sync/v2": () => json(emptyPush),
            "GET /api/sync/v2": () => json({ items: [], nextCursor: null, hasMore: false, serverTime: 5000 })
        })
        await runAccountSync()

        expect(pushedIds()).toEqual(expect.arrayContaining(["mine", "poisoned"]))
        expect(Math.max(...pushedItems().map(i => i.clientUpdatedAt))).toBeLessThanOrEqual(Date.now())
        expect((await db.manga.get("poisoned"))!.updatedAt).toBeLessThanOrEqual(Date.now())
        expect((await getAccountProfile()).lastPushAt).toBeLessThan(Date.now())
    })

    it("clamps a future serverTime before storing lastSyncAt", async () => {
        routeFetch({
            "GET /api/sync/status": () => json(statusBody),
            "POST /api/sync/v2": () => json(emptyPush),
            "GET /api/sync/v2": () => json({ items: [], nextCursor: null, hasMore: false, serverTime: FAR_FUTURE })
        })
        const profile = await runAccountSync()
        expect(profile.lastSyncAt).toBeLessThanOrEqual(Date.now())
    })

    it("stops paging when the server never advances the cursor, and can sync again after", async () => {
        let pulls = 0
        routeFetch({
            "GET /api/sync/status": () => json(statusBody),
            "POST /api/sync/v2": () => json(emptyPush),
            "GET /api/sync/v2": () => {
                pulls++
                if (pulls > 50) throw new Error("test guard: pull loop did not stop")
                return json({ items: [], nextCursor: "stuck", hasMore: true, serverTime: 5000 })
            }
        })
        await runAccountSync()
        expect(pulls).toBeLessThanOrEqual(3)
        const before = pulls
        await runAccountSync()
        expect(pulls).toBeGreaterThan(before)
    })

    it("stops paging when the server answers hasMore with no cursor", async () => {
        let pulls = 0
        routeFetch({
            "GET /api/sync/status": () => json(statusBody),
            "POST /api/sync/v2": () => json(emptyPush),
            "GET /api/sync/v2": () => {
                pulls++
                if (pulls > 50) throw new Error("test guard: pull loop did not stop")
                return json({ items: [], nextCursor: null, hasMore: true, serverTime: 5000 })
            }
        })
        await runAccountSync()
        expect(pulls).toBe(1)
    })

    it("skips one malformed pulled row and keeps the good rows in the same page", async () => {
        routeFetch({
            "GET /api/sync/status": () => json(statusBody),
            "POST /api/sync/v2": () => json(emptyPush),
            "GET /api/sync/v2": pull([row("bad", { title: 42 }), "not a row", null, row("good")])
        })
        const profile = await runAccountSync()
        expect(profile.syncProblem).toBeUndefined()
        expect(profile.pullCursor).toBe("c1")
        expect(await db.manga.get("bad")).toBeUndefined()
        expect(await db.manga.get("good")).toBeDefined()
    })

    it("drops a pulled chapter number of 1e400 instead of aborting the sync", async () => {
        routeFetch({
            "GET /api/sync/status": () => json(statusBody),
            "POST /api/sync/v2": () => json(emptyPush),
            "GET /api/sync/v2": () =>
                rawJson(
                    '{"items":[{"clientId":"inf","title":"Inf","normalizedTitle":"inf","sourceId":"mangadex",' +
                        '"mangaUrl":"https://mangadex.org/title/inf","lastReadChapterNumber":1e400,' +
                        '"clientUpdatedAt":100},' +
                        '{"clientId":"good","title":"Good","normalizedTitle":"good","sourceId":"mangadex",' +
                        '"mangaUrl":"https://mangadex.org/title/good","clientUpdatedAt":100}],' +
                        '"nextCursor":"c1","hasMore":false,"serverTime":5000}'
                )
        })
        const profile = await runAccountSync()
        expect(profile.syncProblem).toBeUndefined()
        expect(await db.manga.get("good")).toBeDefined()
        expect((await db.manga.get("inf"))?.lastReadChapterNumber).toBeUndefined()
    })

    it("keeps only strings from pulled genres and categories, so the backup signature still works", async () => {
        await applyRemoteItem({
            ...row("g"),
            genres: "Action" as unknown as string[],
            categories: ["Fav", 7, null, " "] as unknown as string[]
        })
        const stored = await db.manga.get("g")
        expect(stored?.genres).toBeUndefined()
        expect(stored?.categories).toEqual(["Fav"])
        await expect(libraryChangeSignature()).resolves.toEqual(expect.any(String))
    })

    it("still computes the backup signature over a row that already holds a non-array genres", async () => {
        await db.manga.put({ ...manga({ id: "old", title: "Old" }), genres: "Action" as unknown as string[] })
        await expect(libraryChangeSignature()).resolves.toEqual(expect.any(String))
    })

    it("never stores a pulled javascript: mangaUrl as an openable sourceUrl", async () => {
        await applyRemoteItem({ ...row("js"), mangaUrl: "javascript:alert(document.domain)" })
        const stored = await db.manga.get("js")
        const openable = [stored?.sourceUrl, stored?.mangaUrl].filter(
            (u): u is string => typeof u === "string" && !u.startsWith("amr:")
        )
        expect(openable.every(u => /^https?:\/\//.test(u))).toBe(true)
    })

    it("keeps only a public https cover from a pulled row", async () => {
        await applyRemoteItem({ ...row("lan"), coverUrl: "http://192.168.1.1/cgi-bin/reboot?x.jpg" })
        await applyRemoteItem({ ...row("pub"), coverUrl: "https://cdn.example.com/pub.jpg" })
        expect((await db.manga.get("lan"))?.coverUrl).toBeUndefined()
        expect((await db.manga.get("pub"))?.coverUrl).toBe("https://cdn.example.com/pub.jpg")
    })

    it("ignores a rejected push whose server copy names a different title", async () => {
        await db.manga.bulkPut([
            manga({ id: "mine", title: "Mine", updatedAt: 10 }),
            manga({ id: "other", title: "Other", updatedAt: 1 })
        ])
        routeFetch({
            "GET /api/sync/status": () => json(statusBody),
            "POST /api/sync/v2": () =>
                json({
                    accepted: [],
                    rejected: [
                        { clientId: "mine", server: row("other", { title: "Hijacked", clientUpdatedAt: 5000 }) }
                    ],
                    invalid: [],
                    serverTime: 5000
                }),
            "GET /api/sync/v2": () => json({ items: [], nextCursor: null, hasMore: false, serverTime: 5000 })
        })
        await runAccountSync()
        expect((await db.manga.get("other"))?.title).toBe("Other")
    })

    it("does not push a cover the cover fetch would refuse", async () => {
        await db.manga.put(manga({ id: "mine", title: "Mine", updatedAt: 10, coverUrl: "http://10.0.0.1/c.jpg" }))
        routeFetch({
            "GET /api/sync/status": () => json(statusBody),
            "POST /api/sync/v2": () => json(emptyPush),
            "GET /api/sync/v2": () => json({ items: [], nextCursor: null, hasMore: false, serverTime: 5000 })
        })
        await runAccountSync()
        const sent = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")
        expect(JSON.parse(sent![1]!.body as string).items[0].coverUrl).toBeNull()
    })
})
