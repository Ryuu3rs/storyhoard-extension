import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LibraryManga } from "../database"

vi.stubGlobal("browser", fakeBrowser)

vi.mock("../community", async () => {
    const actual = await vi.importActual<typeof import("../community")>("../community")
    return {
        ...actual,
        apiRegister: vi.fn(),
        apiSyncEvents: vi.fn(),
        apiFetchCommunityStats: vi.fn(),
        apiRate: vi.fn(),
        apiFetchMangaStats: vi.fn()
    }
})

const { db } = await import("../database")
const community = await import("../community")
const { getCommunityProfile, updateCommunityProfile } = community
const apiRegister = vi.mocked(community.apiRegister)
const apiSyncEvents = vi.mocked(community.apiSyncEvents)
const apiFetchCommunityStats = vi.mocked(community.apiFetchCommunityStats)
const { communityAlarmName } = await import("../background/alarms")
const { communityHandlers, runCommunitySync } = await import("./community")

const manga: LibraryManga = {
    id: "mangadex:manga:abc",
    sourceId: "mangadex",
    sourceUrl: "https://mangadex.org/title/abc",
    title: "Test Manga",
    normalizedTitle: "test manga",
    authors: [],
    status: "ongoing",
    addedAt: 1,
    updatedAt: 1
}

beforeEach(async () => {
    fakeBrowser.reset()
    vi.clearAllMocks()
    // clearAllMocks does NOT drain mockResolvedValueOnce queues; reset apiRegister fully so
    // a once-value queued by a test that no longer runs can't leak into a later test.
    apiRegister.mockReset()
    await Promise.all([db.manga.clear(), db.historyEvents.clear()])
    apiSyncEvents.mockResolvedValue({ rank: 5, newAchievements: [], recommendations: [] })
    apiFetchCommunityStats.mockResolvedValue({
        leaderboard: [],
        trendingManga: [],
        topGenres: [],
        topRated: [],
        totalUsers: 0
    })
})

describe("runCommunitySync watermark", () => {
    it("captures the sync watermark before the network call so an in-flight history event is not lost", async () => {
        await updateCommunityProfile({ enabled: true, userId: "user-1", username: "tester", lastSyncAt: 0 })
        await db.manga.put(manga)

        // Simulate a history event recorded WHILE the sync's network call is in flight:
        // apiSyncEvents resolves only after we've inserted the event, mimicking the
        // real-world race between syncStartedAt capture and the completed fetch.
        // eslint-disable-next-line prefer-const -- assigned below; the `!` tells eslint it's never reassigned, but it is
        let recordDuringSync!: () => Promise<void>
        apiSyncEvents.mockImplementation(async () => {
            await recordDuringSync()
            return { rank: 1, newAchievements: [], recommendations: [] }
        })

        // Seed one already-existing history event so apiSyncEvents is actually invoked.
        await db.historyEvents.add({
            mangaId: manga.id,
            chapterId: "mangadex:chapter:1",
            type: "completed",
            occurredAt: 100
        })

        let midSyncEventTime = 0
        recordDuringSync = async () => {
            midSyncEventTime = Date.now()
            await db.historyEvents.add({
                mangaId: manga.id,
                chapterId: "mangadex:chapter:2",
                type: "completed",
                occurredAt: midSyncEventTime
            })
        }

        await runCommunitySync()

        const profile = await getCommunityProfile()
        // The watermark must not have moved past the event recorded during the sync.
        expect(profile.lastSyncAt).toBeLessThanOrEqual(midSyncEventTime)

        // A second sync should still pick up that mid-flight event.
        apiSyncEvents.mockClear()
        apiSyncEvents.mockResolvedValueOnce({ rank: 2, newAchievements: [], recommendations: [] })
        await runCommunitySync()
        expect(apiSyncEvents).toHaveBeenCalledTimes(1)
        const eventsArg = apiSyncEvents.mock.calls[0]![1]
        expect(eventsArg.length).toBe(1)
    })

    it("includes an event whose occurredAt lands exactly on the previous watermark (bughunt aboveOrEqual)", async () => {
        await db.manga.put(manga)
        // Previous sync left the watermark at exactly this event's millisecond.
        await updateCommunityProfile({ enabled: true, userId: "user-1", username: "tester", lastSyncAt: 500 })
        await db.historyEvents.add({
            mangaId: manga.id,
            chapterId: "mangadex:chapter:boundary",
            type: "completed",
            occurredAt: 500
        })
        apiSyncEvents.mockClear()
        apiSyncEvents.mockResolvedValueOnce({ rank: 1, newAchievements: [], recommendations: [] })

        await runCommunitySync()

        // A strict `.above(500)` would drop it and never call the API; `.aboveOrEqual` sends it.
        expect(apiSyncEvents).toHaveBeenCalledTimes(1)
        expect(apiSyncEvents.mock.calls[0]![1].length).toBe(1)
    })
})

describe("runCommunitySync cold start", () => {
    it("waits for the added sources to be registered before syncing", async () => {
        const { beginUserSourcesInit } = await import("../background/user-sources-ready")
        await updateCommunityProfile({ enabled: true, userId: "user-1", username: "tester", lastSyncAt: 0 })
        await db.manga.put(manga)
        await db.historyEvents.add({
            mangaId: manga.id,
            chapterId: "mangadex:chapter:1",
            type: "completed",
            occurredAt: 100
        })

        let release!: () => void
        void beginUserSourcesInit(() => new Promise<void>(resolve => (release = resolve)))

        const pending = runCommunitySync()
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(apiSyncEvents).not.toHaveBeenCalled()

        release()
        await pending
        expect(apiSyncEvents).toHaveBeenCalledTimes(1)
        await beginUserSourcesInit(async () => undefined)
    })
})

describe("runCommunitySync concurrency", () => {
    it("only allows one sync in flight - a concurrent call is a no-op", async () => {
        await updateCommunityProfile({ enabled: true, userId: "user-1", username: "tester", lastSyncAt: 0 })
        await db.manga.put(manga)
        await db.historyEvents.add({
            mangaId: manga.id,
            chapterId: "mangadex:chapter:1",
            type: "completed",
            occurredAt: 100
        })

        let resolveSync!: (v: { rank: number | null; newAchievements: string[]; recommendations: never[] }) => void
        apiSyncEvents.mockImplementation(
            () =>
                new Promise(resolve => {
                    resolveSync = resolve
                })
        )

        const first = runCommunitySync()
        const second = runCommunitySync()

        // Let the microtask queue drain so first's chain of db reads/awaits reaches
        // apiSyncEvents and assigns resolveSync before we resolve it.
        await vi.waitFor(() => expect(resolveSync).toBeDefined())
        resolveSync({ rank: 1, newAchievements: [], recommendations: [] })
        await Promise.all([first, second])

        expect(apiSyncEvents).toHaveBeenCalledTimes(1)
    })
})

describe("runCommunitySync with no new events", () => {
    it("refreshes communityStats but does not call apiSyncEvents", async () => {
        await updateCommunityProfile({ enabled: true, userId: "user-1", username: "tester", lastSyncAt: Date.now() })

        await runCommunitySync()

        expect(apiSyncEvents).not.toHaveBeenCalled()
        expect(apiFetchCommunityStats).toHaveBeenCalledTimes(1)
    })
})

describe("runCommunitySync auto-registration", () => {
    it("silently registers a generated anonymous username when enabled but never registered, then proceeds", async () => {
        // Opted in (enabled) but never registered (empty userId) - sync auto-registers.
        await updateCommunityProfile({ enabled: true })
        apiRegister.mockResolvedValueOnce({ userId: "auto-1" })

        await runCommunitySync()

        expect(apiRegister).toHaveBeenCalledTimes(1)
        expect(apiRegister.mock.calls[0]![0]).toMatch(/^Reader\d{4}$/)

        const profile = await getCommunityProfile()
        expect(profile.userId).toBe("auto-1")
        expect(profile.username).toMatch(/^Reader\d{4}$/)
        expect(apiFetchCommunityStats).toHaveBeenCalledTimes(1)
    })

    it("retries with a freshly generated name on a username collision", async () => {
        await updateCommunityProfile({ enabled: true })
        apiRegister
            .mockRejectedValueOnce(new Error("Username already taken"))
            .mockResolvedValueOnce({ userId: "auto-2" })

        await runCommunitySync()

        expect(apiRegister).toHaveBeenCalledTimes(2)
        const profile = await getCommunityProfile()
        expect(profile.userId).toBe("auto-2")
    })

    it("gives up after repeated collisions without throwing and leaves sync a no-op", async () => {
        await updateCommunityProfile({ enabled: true })
        apiRegister.mockRejectedValue(new Error("Username already taken"))
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

        await expect(runCommunitySync()).resolves.toBeUndefined()

        expect(apiRegister).toHaveBeenCalledTimes(5)
        expect(warnSpy).toHaveBeenCalled()
        const profile = await getCommunityProfile()
        expect(profile.userId).toBe("")
        expect(apiSyncEvents).not.toHaveBeenCalled()
    })

    it("fails soft (no throw) on a non-collision registration error", async () => {
        await updateCommunityProfile({ enabled: true })
        apiRegister.mockRejectedValueOnce(new Error("network down"))
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

        await expect(runCommunitySync()).resolves.toBeUndefined()

        expect(apiRegister).toHaveBeenCalledTimes(1)
        expect(warnSpy).toHaveBeenCalled()
        const profile = await getCommunityProfile()
        expect(profile.userId).toBe("")
    })

    it("does not auto-register when the user disabled community sync", async () => {
        await updateCommunityProfile({ enabled: false })

        await runCommunitySync()

        expect(apiRegister).not.toHaveBeenCalled()
    })
})

describe("community:status handler", () => {
    it("auto-registers on status check when enabled but not yet registered, and returns the updated profile", async () => {
        await updateCommunityProfile({ enabled: true })
        apiRegister.mockResolvedValueOnce({ userId: "auto-status-1" })

        const result = await communityHandlers["community:status"]!(
            { type: "community:status" },
            { sender: {} as never }
        )

        expect(apiRegister).toHaveBeenCalledTimes(1)
        expect((result as { userId: string }).userId).toBe("auto-status-1")
    })

    it("does not disturb an already-registered profile", async () => {
        await updateCommunityProfile({ userId: "existing-user", username: "already-here", enabled: true })

        const result = await communityHandlers["community:status"]!(
            { type: "community:status" },
            { sender: {} as never }
        )

        expect(apiRegister).not.toHaveBeenCalled()
        expect((result as { userId: string }).userId).toBe("existing-user")
    })
})

describe("community:register handler", () => {
    it("is idempotent - returns the existing profile without calling apiRegister when userId is already set", async () => {
        await updateCommunityProfile({ userId: "existing-user", username: "already-here", enabled: true })

        const result = await communityHandlers["community:register"]!(
            { type: "community:register", username: "newname" },
            { sender: {} as never }
        )

        expect(apiRegister).not.toHaveBeenCalled()
        expect((result as { userId: string }).userId).toBe("existing-user")
    })

    it("still lets a user register a chosen username manually when nothing has auto-registered yet", async () => {
        apiRegister.mockResolvedValueOnce({ userId: "chosen-user" })

        const result = await communityHandlers["community:register"]!(
            { type: "community:register", username: "MyChosenName" },
            { sender: {} as never }
        )

        expect(apiRegister).toHaveBeenCalledWith("MyChosenName")
        expect((result as { userId: string; username: string }).userId).toBe("chosen-user")
        expect((result as { userId: string; username: string }).username).toBe("MyChosenName")
    })
})

describe("community:toggle handler", () => {
    it("clears the community alarm when disabling", async () => {
        const clearSpy = vi.spyOn(fakeBrowser.alarms, "clear")

        await communityHandlers["community:toggle"]!(
            { type: "community:toggle", enabled: false },
            { sender: {} as never }
        )

        expect(clearSpy).toHaveBeenCalledWith(communityAlarmName)
    })

    it("(re)creates the alarm when enabling with a registered profile", async () => {
        await updateCommunityProfile({ userId: "user-1", username: "tester" })
        const createSpy = vi.spyOn(fakeBrowser.alarms, "create")

        await communityHandlers["community:toggle"]!(
            { type: "community:toggle", enabled: true },
            { sender: {} as never }
        )

        expect(createSpy).toHaveBeenCalledWith(communityAlarmName, expect.objectContaining({ periodInMinutes: 60 }))
    })

    it("auto-registers when enabling a profile that has never been registered", async () => {
        apiRegister.mockResolvedValueOnce({ userId: "auto-toggle-1" })

        const result = await communityHandlers["community:toggle"]!(
            { type: "community:toggle", enabled: true },
            { sender: {} as never }
        )

        expect(apiRegister).toHaveBeenCalledTimes(1)
        expect((result as { userId: string }).userId).toBe("auto-toggle-1")
    })
})

describe("runCommunitySync chapter labels", () => {
    it("sends the chapter number when known and a URL-free hash otherwise", async () => {
        const { chapterLabel } = await import("./community")
        expect(chapterLabel("x", 12)).toBe("12")
        expect(chapterLabel("x", 12.5)).toBe("12.5")
        expect(chapterLabel("src:chapter:https://example.com/c/9", undefined)).toMatch(/^h[0-9a-f]+$/)
        expect(chapterLabel("src:chapter:https://example.com/c/9", Number.POSITIVE_INFINITY)).toMatch(/^h[0-9a-f]+$/)

        await updateCommunityProfile({ enabled: true, userId: "user-1", username: "tester", lastSyncAt: 0 })
        await db.manga.put(manga)
        await db.chapters.put({
            id: "mangadex:chapter:1",
            mangaId: manga.id,
            sourceId: manga.sourceId,
            title: "Chapter 12",
            url: "https://example.com/c/12",
            sortKey: 12
        } as never)
        await db.historyEvents.add({
            mangaId: manga.id,
            chapterId: "mangadex:chapter:1",
            type: "completed",
            occurredAt: 100
        })
        await db.historyEvents.add({
            mangaId: manga.id,
            chapterId: "mangadex:chapter:zzz",
            type: "completed",
            occurredAt: 101
        })

        apiSyncEvents.mockClear()
        apiSyncEvents.mockResolvedValueOnce({ rank: 1, newAchievements: [], recommendations: [] })
        await runCommunitySync()
        const events = apiSyncEvents.mock.calls[0]![1]
        expect(events.map(e => e.chapter)).toEqual(["12", expect.stringMatching(/^h[0-9a-f]+$/)])
    })
})
