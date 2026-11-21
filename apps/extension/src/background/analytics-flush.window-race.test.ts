import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("browser", fakeBrowser)
vi.stubEnv("VITE_ANALYTICS_API_URL", "https://analytics.example.test")

const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }))
vi.stubGlobal("fetch", fetchMock)

const { db, recordAnalyticsEvent } = await import("../database")
const { updateSettings } = await import("../settings")
const { markUsageNoticeShown } = await import("../analytics-usage")
const { flushUsageAnalytics } = await import("./analytics-flush")

const sentNames = (from = 0) =>
    fetchMock.mock.calls
        .slice(from)
        .flatMap(([, init]) => (JSON.parse(String(init?.body)) as { events: Array<{ name: string }> }).events)
        .map(e => e.name)

beforeEach(async () => {
    vi.restoreAllMocks()
    fakeBrowser.reset()
    vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue({ version: "9.9.9" } as never)
    fetchMock.mockClear()
    await db.analyticsEvents.clear()
    await markUsageNoticeShown()
})

describe("usage window restart during an in-flight flush", () => {
    it("an off-then-on toggle while a send is pending still drops what was counted while off", async () => {
        const t0 = Date.now()
        const clock = vi.spyOn(Date, "now").mockReturnValue(t0)
        await recordAnalyticsEvent({ event: "capture_ok", ts: t0 + 1 })

        let release!: () => void
        fetchMock.mockImplementationOnce(
            () => new Promise<Response>(resolve => (release = () => resolve(new Response("{}", { status: 200 }))))
        )
        clock.mockReturnValue(t0 + 5)
        const inFlight = flushUsageAnalytics()
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

        // While the request is pending (slow network), the user turns usage off, something is counted, and
        // they turn it back on, which restarts the window at t0 + 30.
        clock.mockReturnValue(t0 + 10)
        await updateSettings({ usageAnalytics: false })
        await recordAnalyticsEvent({ event: "reader_opened", ts: t0 + 20 })
        clock.mockReturnValue(t0 + 30)
        await updateSettings({ usageAnalytics: true })

        release()
        await inFlight

        clock.mockReturnValue(t0 + 6 * 3_600_000)
        await flushUsageAnalytics()
        expect(sentNames(1)).not.toContain("reader_opened")
    })
})
