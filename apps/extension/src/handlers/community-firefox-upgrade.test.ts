import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Upgrade from 0.32.2. 0.32.2's Firefox manifest declared optional data collection
// ["technicalAndInteraction", "personallyIdentifyingInfo"] and community features sent on profile.enabled
// alone. The new build adds "browsingActivity" to the optional list and requires all three before any
// community send (communityAllowed). A user who had opted in on 0.32.2 cannot hold browsingActivity and the
// consent card stays hidden (consentVersion is already current), so the status must say sending is not
// allowed: the toggle reads off and Settings offers to ask Firefox again.

vi.stubGlobal("browser", fakeBrowser)

vi.mock("../community", async () => {
    const actual = await vi.importActual<typeof import("../community")>("../community")
    return {
        ...actual,
        apiRegister: vi.fn(),
        apiSyncEvents: vi.fn(),
        apiFetchCommunityStats: vi.fn(),
        apiRate: vi.fn(),
        apiFetchMangaStats: vi.fn(),
        apiClaim: vi.fn(),
        apiPing: vi.fn(async () => {}),
        apiDeleteMe: vi.fn(async () => {})
    }
})

const { db } = await import("../database")
const community = await import("../community")
const apiSyncEvents = vi.mocked(community.apiSyncEvents)
const { communityHandlers, runCommunitySync } = await import("./community")
const { firefoxDataGranted } = await import("../analytics-usage")

// What a 0.32.2 Firefox user who accepted community features can hold: the old optional set.
const GRANTED_ON_0322 = new Set<string>()
const contains = vi.fn(async (request: { data_collection?: string[] }) =>
    (request.data_collection ?? []).every(item => GRANTED_ON_0322.has(item))
)
const remove = vi.fn(async (request: { data_collection?: string[] }) => {
    for (const item of request.data_collection ?? []) GRANTED_ON_0322.delete(item)
    return true
})

beforeEach(async () => {
    fakeBrowser.reset()
    vi.clearAllMocks()
    vi.stubEnv("BROWSER", "firefox")
    GRANTED_ON_0322.clear()
    GRANTED_ON_0322.add("technicalAndInteraction").add("personallyIdentifyingInfo")
    vi.stubGlobal("browser", { ...fakeBrowser, permissions: { contains, remove } })
    await db.historyEvents.clear()
    apiSyncEvents.mockResolvedValue({ rank: 1, newAchievements: [], recommendations: [] })
    // The 0.32.2 profile of an opted-in user, as stored.
    await community.updateCommunityProfile({
        enabled: true,
        userId: "user-1",
        username: "tester",
        secret: "s",
        lastSyncAt: 0,
        consentVersion: community.CONSENT_VERSION,
        consentAt: 1,
        declined: false
    })
    await db.historyEvents.add({ mangaId: "m", chapterId: "c1", type: "completed", occurredAt: 10 })
})

afterEach(() => {
    vi.unstubAllEnvs()
    vi.stubGlobal("browser", fakeBrowser)
})

describe("a Firefox user who opted in on 0.32.2, after the upgrade", () => {
    it("is not shown community features as on while the upgrade silently stops every send", async () => {
        await runCommunitySync()
        const synced = apiSyncEvents.mock.calls.length > 0
        const status = (await communityHandlers["community:status"]!(
            { type: "community:status" } as never,
            {} as never
        )) as { enabled: boolean }
        // Either the sync still runs, or the status the Settings toggle reads must not claim it is on.
        expect({ toggleShowsOn: status.enabled, synced }).not.toEqual({ toggleShowsOn: true, synced: false })
    })

    it("reports that Firefox needs the permission again, and keeps the stored opt-in", async () => {
        const status = (await communityHandlers["community:status"]!(
            { type: "community:status" } as never,
            {} as never
        )) as { enabled: boolean; allowed: boolean; needsPermission: boolean }
        expect(status).toMatchObject({ enabled: false, allowed: false, needsPermission: true })
        expect((await community.getCommunityProfile()).enabled).toBe(true)
    })

    it("reads on again once the permission is granted", async () => {
        GRANTED_ON_0322.add("browsingActivity")
        try {
            const status = (await communityHandlers["community:status"]!(
                { type: "community:status" } as never,
                {} as never
            )) as { enabled: boolean; allowed: boolean; needsPermission: boolean }
            expect(status).toMatchObject({ enabled: true, allowed: true, needsPermission: false })
            vi.mocked(community.apiFetchCommunityStats).mockResolvedValue(null as never)
            await runCommunitySync()
            expect(vi.mocked(community.apiFetchCommunityStats)).toHaveBeenCalled()
        } finally {
            GRANTED_ON_0322.delete("browsingActivity")
        }
    })
})

// Settings keeps the status as communityProfile. "Delete my community data" (App.svelte deleteCommunityData)
// must give back the grants community asked for while the opt-in is paused too, or usage analytics starts
// running on a permission given only for community.
describe("deleting community data as a paused 0.32.2 opt-in", () => {
    async function appDeleteCommunityData() {
        const status = (await communityHandlers["community:status"]!(
            { type: "community:status" } as never,
            {} as never
        )) as community.CommunityStatus
        expect(status.enabled).toBe(false)
        const wasOn = community.communityOptedIn(status)
        await communityHandlers["community:delete-data"]!({ type: "community:delete-data" } as never, {} as never)
        if (wasOn) await community.releaseCommunityData(false).catch(() => {})
    }

    it("does not leave usage analytics running on the grant community asked for", async () => {
        expect(await firefoxDataGranted()).toBe(false)
        await appDeleteCommunityData()
        expect(await firefoxDataGranted()).toBe(false)
    })

    it("gives back the identifying-info grant that only community used", async () => {
        await appDeleteCommunityData()
        expect(GRANTED_ON_0322.has("personallyIdentifyingInfo")).toBe(false)
    })
})

describe("communityOptedIn", () => {
    it("is on while sending and while paused for the permission, off otherwise", () => {
        expect(community.communityOptedIn({ allowed: true, needsPermission: false })).toBe(true)
        expect(community.communityOptedIn({ allowed: false, needsPermission: true })).toBe(true)
        expect(community.communityOptedIn({ allowed: false, needsPermission: false })).toBe(false)
        expect(community.communityOptedIn(null)).toBe(false)
    })
})
