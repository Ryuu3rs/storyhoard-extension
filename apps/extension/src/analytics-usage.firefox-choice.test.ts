import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubEnv("BROWSER", "firefox")
vi.stubEnv("VITE_ANALYTICS_API_URL", "https://analytics.example.test")
vi.stubGlobal("browser", fakeBrowser)

const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }))
vi.stubGlobal("fetch", fetchMock)

const granted = new Set<string>()
const categories = (p: unknown) => (p as { data_collection: string[] }).data_collection

const { db, recordAnalyticsEvent } = await import("./database")
const community = await import("./community")
const { updateSettings } = await import("./settings")
const { flushUsageAnalytics } = await import("./background/analytics-flush")
const { chooseUsageData, markUsageNoticeShown, finishUsageNotice, restartUsageWindow } =
    await import("./analytics-usage")

const sentEvents = () =>
    fetchMock.mock.calls.flatMap(([, init]) => (JSON.parse(String(init?.body)) as { events: unknown[] }).events)

beforeEach(async () => {
    vi.restoreAllMocks()
    fakeBrowser.reset()
    granted.clear()
    fetchMock.mockClear()
    await db.analyticsEvents.clear()
    vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue({ version: "9.9.9" } as never)
    vi.spyOn(fakeBrowser.permissions, "contains").mockImplementation((async (p: unknown) =>
        categories(p).every(c => granted.has(c))) as never)
    // Firefox fires permissions.onAdded only for a category that was not held; background.ts restarts the
    // window there. Model that faithfully: request() of an already held category adds nothing.
    vi.spyOn(fakeBrowser.permissions, "request").mockImplementation((async (p: unknown) => {
        const fresh = categories(p).filter(c => !granted.has(c))
        for (const c of fresh) granted.add(c)
        if (fresh.includes("technicalAndInteraction")) await restartUsageWindow()
        return true
    }) as never)
    vi.spyOn(fakeBrowser.permissions, "remove").mockImplementation((async (p: unknown) => {
        for (const c of categories(p)) granted.delete(c)
        return true
    }) as never)
})

// Community on: Firefox grants all three categories (onAdded restarts the usage window), community records them.
async function turnCommunityOn(): Promise<void> {
    const heldBefore = await community.heldCommunityData()
    await fakeBrowser.permissions.request(community.COMMUNITY_DATA_PERMISSION)
    await community.updateCommunityProfile({ enabled: true, consentVersion: 1, consentAt: Date.now() })
    await community.noteCommunityDataAdded(heldBefore)
}

// What App.svelte setUsageAnalytics(on) does on Firefox.
async function settingsToggleOn(): Promise<void> {
    const ok = await fakeBrowser.permissions.request({ data_collection: ["technicalAndInteraction"] } as never)
    if (ok) await chooseUsageData(true)
    await updateSettings({ usageAnalytics: true })
    await finishUsageNotice()
}

describe("Firefox: usage turned on while community already holds the data grant", () => {
    it("does not send what was counted while usage analytics was off (notice seen)", async () => {
        const t0 = Date.now()
        vi.spyOn(Date, "now").mockReturnValue(t0)
        await markUsageNoticeShown(t0)
        await turnCommunityOn()
        // Usage is off: the grant is held for community only. A flush runs and moves the window.
        await flushUsageAnalytics()
        expect(fetchMock).not.toHaveBeenCalled()

        // Counted while usage analytics is still off.
        await recordAnalyticsEvent({ event: "capture_ok", ts: t0 + 10 })
        await recordAnalyticsEvent({ event: "reader_opened", ts: t0 + 11 })

        // User switches usage analytics on in Settings an hour later (before the 6 h flush).
        vi.mocked(Date.now).mockReturnValue(t0 + 3_600_000)
        await settingsToggleOn()
        await flushUsageAnalytics()

        expect(sentEvents()).toEqual([])
    })

    it("does not send weeks of rows counted while waiting with only the community grant", async () => {
        const t0 = Date.now()
        vi.spyOn(Date, "now").mockReturnValue(t0)
        // Notice never shown: UsageNotice.decide() returns false on Firefox without a usage grant.
        await turnCommunityOn()
        await flushUsageAnalytics()
        await recordAnalyticsEvent({ event: "capture_ok", ts: t0 + 86_400_000 })
        await recordAnalyticsEvent({ event: "capture_ok", ts: t0 + 2 * 86_400_000 })
        vi.mocked(Date.now).mockReturnValue(t0 + 14 * 86_400_000)
        await flushUsageAnalytics()
        expect(fetchMock).not.toHaveBeenCalled()

        await settingsToggleOn()
        await flushUsageAnalytics()
        expect(sentEvents()).toEqual([])
    })
})

// Off on the usage notice takes the same path as Off in Settings.
describe("Firefox: usage analytics answered Off", () => {
    it("keeps the grant community features need", async () => {
        granted.add("technicalAndInteraction")
        await community.noteInstallDataChoice()
        await turnCommunityOn()
        await chooseUsageData(false)
        expect(await community.communityAllowed(await community.getCommunityProfile())).toBe(true)
        expect(granted.has("technicalAndInteraction")).toBe(true)
        expect(await community.usageDataHeldForCommunityOnly()).toBe(true)
    })

    it("gives the grant back when community features are off", async () => {
        granted.add("technicalAndInteraction")
        await community.noteInstallDataChoice()
        await chooseUsageData(false)
        expect(granted.has("technicalAndInteraction")).toBe(false)
    })
})
