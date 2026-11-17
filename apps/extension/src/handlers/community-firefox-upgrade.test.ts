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
        apiPing: vi.fn(async () => {})
    }
})

const { db } = await import("../database")
const community = await import("../community")
const apiSyncEvents = vi.mocked(community.apiSyncEvents)
const { communityHandlers, runCommunitySync } = await import("./community")

// What a 0.32.2 Firefox user who accepted community features can hold: the old optional set.
const GRANTED_ON_0322 = new Set(["technicalAndInteraction", "personallyIdentifyingInfo"])
const contains = vi.fn(async (request: { data_collection?: string[] }) =>
    (request.data_collection ?? []).every(item => GRANTED_ON_0322.has(item))
)

beforeEach(async () => {
    fakeBrowser.reset()
    vi.clearAllMocks()
    vi.stubEnv("BROWSER", "firefox")
    vi.stubGlobal("browser", { ...fakeBrowser, permissions: { contains } })
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
