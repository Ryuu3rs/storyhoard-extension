import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubEnv("BROWSER", "firefox")
vi.stubEnv("VITE_ANALYTICS_API_URL", "https://analytics.example.test")
vi.stubGlobal("browser", fakeBrowser)

const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }))
vi.stubGlobal("fetch", fetchMock)

const granted = new Set<string>()
const categories = (p: unknown) => (p as { data_collection?: string[] }).data_collection ?? []

const { db, recordAnalyticsEvent } = await import("../database")
const community = await import("../community")
const { communityHandlers } = await import("./community")
const { markUsageNoticeShown } = await import("../analytics-usage")
const { flushUsageAnalytics, usageStatsAllowed } = await import("../background/analytics-flush")

const analyticsCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/analytics"))

beforeEach(async () => {
    vi.restoreAllMocks()
    fakeBrowser.reset()
    granted.clear()
    fetchMock.mockClear()
    await db.analyticsEvents.clear()
    vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue({ version: "9.9.9" } as never)
    vi.spyOn(fakeBrowser.permissions, "contains").mockImplementation((async (p: unknown) =>
        categories(p).every(c => granted.has(c))) as never)
    vi.spyOn(fakeBrowser.permissions, "remove").mockImplementation((async (p: unknown) => {
        for (const c of categories(p)) granted.delete(c)
        return true
    }) as never)
})

// App.svelte declineConsent on Firefox: the handler, then the grants an older opt-in held go back.
async function declineConsent(): Promise<void> {
    const status = await community.communityStatusOf(await community.getCommunityProfile())
    await communityHandlers["community:decline"]!({ type: "community:decline" } as never, { sender: {} } as never)
    if (community.communityOptedIn(status)) await community.releaseCommunityData(false)
}

describe("Firefox: legacy community opt-in answered No thanks on the consent card", () => {
    it("does not leave usage analytics running on community's grant", async () => {
        // Community turned on by an older build: Firefox granted all three categories, no record of what
        // community added, the user never chose usage analytics, and the current consent card is unanswered.
        for (const c of community.COMMUNITY_DATA_CATEGORIES) granted.add(c)
        await community.updateCommunityProfile({ enabled: true, consentVersion: 0, userId: "", declined: false })
        await markUsageNoticeShown()
        expect(await usageStatsAllowed()).toBe(false)
        await flushUsageAnalytics()

        await recordAnalyticsEvent({ event: "capture_ok", ts: Date.now() + 10 })

        // The consent card shows (consentVersion 0) and the user taps No thanks.
        await declineConsent()
        expect(granted.has("personallyIdentifyingInfo")).toBe(false)

        expect(await usageStatsAllowed()).toBe(false)
        await flushUsageAnalytics()
        expect(analyticsCalls()).toEqual([])
    })
})

describe("Firefox: No thanks when the grant stays", () => {
    it("starts a new usage window, so what was counted while it was community's is not sent", async () => {
        const t0 = Date.now()
        const clock = vi.spyOn(Date, "now").mockReturnValue(t0)
        for (const c of community.COMMUNITY_DATA_CATEGORIES) granted.add(c)
        await community.updateCommunityProfile({ enabled: true, consentVersion: 0, userId: "", declined: false })
        await markUsageNoticeShown()
        await flushUsageAnalytics()
        await recordAnalyticsEvent({ event: "capture_ok", ts: t0 + 10 })
        vi.mocked(fakeBrowser.permissions.remove).mockRejectedValue(new Error("kept"))

        clock.mockReturnValue(t0 + 20)
        await declineConsent()
        clock.mockReturnValue(t0 + 30)
        expect(await usageStatsAllowed()).toBe(true)
        await flushUsageAnalytics()
        expect(analyticsCalls()).toEqual([])
    })
})
