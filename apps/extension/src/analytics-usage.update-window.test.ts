import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("browser", fakeBrowser)
vi.stubEnv("VITE_ANALYTICS_API_URL", "https://analytics.example.test")

const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }))
vi.stubGlobal("fetch", fetchMock)

const { db, recordAnalyticsEvent } = await import("./database")
const { markUsageNoticeShown, finishUsageNotice, restartUsageWindowOnUpdate } = await import("./analytics-usage")
const { flushUsageAnalytics } = await import("./background/analytics-flush")

const sentNames = () =>
    fetchMock.mock.calls
        .flatMap(([, init]) => (JSON.parse(String(init?.body)) as { events: Array<{ name: string }> }).events)
        .map(e => e.name)

beforeEach(async () => {
    vi.restoreAllMocks()
    fakeBrowser.reset()
    vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue({ version: "9.9.9" } as never)
    fetchMock.mockClear()
    await db.analyticsEvents.clear()
})

describe("Chromium upgrade from 0.32.2, where usage analytics was off until a first-run choice", () => {
    it("never sends what 0.32.2 counted while it was off", async () => {
        const lastOldFlush = Date.now() - 3 * 3_600_000
        // 0.32.2 state: on Chromium nothing was sent without usageAnalyticsChoice; its off-flush moved the
        // watermark to the flush time every 6 hours.
        await fakeBrowser.storage.local.set({
            settings: { usageAnalytics: true, usageAnalyticsChoice: false },
            analyticsUsageWatermark: lastOldFlush
        })
        // Counted by 0.32.2 after its last flush, while analytics was off for this user.
        await recordAnalyticsEvent({ event: "capture_ok", ts: lastOldFlush + 60_000 })
        await recordAnalyticsEvent({ event: "reader_opened", ts: lastOldFlush + 120_000 })

        // Update to this build, the notice is shown and answered OK, and the next flush runs.
        await restartUsageWindowOnUpdate()
        await markUsageNoticeShown()
        await finishUsageNotice()
        await flushUsageAnalytics()

        expect(sentNames()).toEqual([])
    })
})

describe("an update once the notice has been shown", () => {
    it("keeps the window, so nothing counted since the last flush is lost", async () => {
        await markUsageNoticeShown(1)
        await recordAnalyticsEvent({ event: "capture_ok", ts: Date.now() - 1000 })
        await restartUsageWindowOnUpdate()
        await flushUsageAnalytics()
        expect(sentNames()).toEqual(["capture_ok"])
    })
})
