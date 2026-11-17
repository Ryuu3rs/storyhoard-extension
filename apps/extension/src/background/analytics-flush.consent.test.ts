import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("browser", fakeBrowser)
vi.stubEnv("VITE_ANALYTICS_API_URL", "https://analytics.example.test")

const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }))
vi.stubGlobal("fetch", fetchMock)

const { db, recordAnalyticsEvent } = await import("../database")
const { updateSettings } = await import("../settings")
const { finishUsageNotice, getUsageNoticeState, markUsageNoticeShown } = await import("../analytics-usage")
const { flushUsageAnalytics } = await import("./analytics-flush")

const sentEvents = () =>
    fetchMock.mock.calls.flatMap(([, init]) => (JSON.parse(String(init?.body)) as { events: unknown[] }).events)

beforeEach(async () => {
    fakeBrowser.reset()
    vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue({ version: "9.9.9" } as never)
    fetchMock.mockClear()
    await db.analyticsEvents.clear()
})

describe("usage analytics notice", () => {
    it("an upgrading user who never saw the notice has nothing sent", async () => {
        // Settings as an older build stored them: analytics on, no answer to anything.
        await fakeBrowser.storage.local.set({ settings: { usageAnalytics: true, usageAnalyticsChoice: false } })
        await recordAnalyticsEvent({ event: "panel_action", ts: Date.now() + 10 })
        await flushUsageAnalytics()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("sends once the notice has been on screen", async () => {
        await recordAnalyticsEvent({ event: "install", ts: Date.now() })
        await markUsageNoticeShown()
        await flushUsageAnalytics()
        expect(sentEvents()).toMatchObject([{ name: "install", count: 1 }])
    })

    it("Off on the notice means nothing is ever sent, including what waited for it", async () => {
        await recordAnalyticsEvent({ event: "install", ts: Date.now() })
        await markUsageNoticeShown()
        await updateSettings({ usageAnalytics: false })
        await finishUsageNotice()
        await flushUsageAnalytics()
        await recordAnalyticsEvent({ event: "panel_action", ts: Date.now() + 10 })
        await flushUsageAnalytics()
        expect(fetchMock).not.toHaveBeenCalled()
        expect((await getUsageNoticeState()).done).toBe(true)
    })

    it("stamps the first showing only", async () => {
        await markUsageNoticeShown(1000)
        await markUsageNoticeShown(2000)
        expect((await getUsageNoticeState()).shownAt).toBe(1000)
    })
})

describe("usage analytics opt-out", () => {
    beforeEach(async () => {
        await markUsageNoticeShown()
    })

    it("never sends events that were recorded while the user had analytics turned off", async () => {
        await updateSettings({ usageAnalytics: false })
        await flushUsageAnalytics()
        expect(fetchMock).not.toHaveBeenCalled()

        // Recorded while off with no flush in between, then turned back on.
        const offAt = Date.now() + 10
        await recordAnalyticsEvent({ event: "panel_action", ts: offAt })
        await recordAnalyticsEvent({ event: "capture_ok", ts: offAt + 1 })
        vi.spyOn(Date, "now").mockReturnValue(offAt + 5)
        await updateSettings({ usageAnalytics: true })
        vi.restoreAllMocks()
        vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue({ version: "9.9.9" } as never)
        await flushUsageAnalytics()

        expect(sentEvents()).toEqual([])
    })

    it("sends nothing while the linked account has opted out", async () => {
        await fakeBrowser.storage.local.set({
            account: { token: "weeb_token_1234567890", invalid: false, analyticsOptOut: true }
        })
        await recordAnalyticsEvent({ event: "panel_action", ts: Date.now() + 10 })
        await flushUsageAnalytics()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("sends for a linked account that has not opted out, with its device link", async () => {
        await fakeBrowser.storage.local.set({
            account: { token: "weeb_token_1234567890", invalid: false, analyticsOptOut: false }
        })
        await recordAnalyticsEvent({ event: "panel_action", ts: Date.now() + 10 })
        await flushUsageAnalytics()
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>
        expect(headers["Authorization"]).toBe("Bearer weeb_token_1234567890")
    })
})
