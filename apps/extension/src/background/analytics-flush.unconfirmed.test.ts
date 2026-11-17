import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("browser", fakeBrowser)
vi.stubEnv("VITE_ANALYTICS_API_URL", "https://analytics.example.test")

// The server refuses a whole batch carrying a name it does not know, as it does today for discover_rail_open.
const KNOWN = new Set(["install", "panel_action", "capture_ok"])
let refuseAll = false
const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const { events } = JSON.parse(String(init?.body)) as { events: { name: string }[] }
    const ok = !refuseAll && events.every(e => KNOWN.has(e.name))
    return new Response("{}", { status: ok ? 200 : 400 })
})
vi.stubGlobal("fetch", fetchMock)

const { db, recordAnalyticsEvent } = await import("../database")
const { getUsageWatermark, markUsageNoticeShown, splitUsageBatch } = await import("../analytics-usage")
const { flushUsageAnalytics } = await import("./analytics-flush")

const batches = () =>
    fetchMock.mock.calls.map(([, init]) =>
        (JSON.parse(String(init?.body)) as { events: { name: string; count: number }[] }).events.map(e => e.name)
    )

beforeEach(async () => {
    fakeBrowser.reset()
    vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue({ version: "9.9.9" } as never)
    fetchMock.mockClear()
    refuseAll = false
    await db.analyticsEvents.clear()
    await markUsageNoticeShown(1)
})

describe("usage events the server may not accept yet", () => {
    it("split away from the main batch", () => {
        const { main, unconfirmed } = splitUsageBatch([
            { name: "install", ts: 1, count: 1 },
            { name: "discover_rail_open", ts: 2, count: 3 }
        ])
        expect(main.map(e => e.name)).toEqual(["install"])
        expect(unconfirmed.map(e => e.name)).toEqual(["discover_rail_open"])
    })

    it("a refused separate request neither loses nor resends the main batch", async () => {
        const now = Date.now()
        await recordAnalyticsEvent({ event: "install", ts: now })
        await recordAnalyticsEvent({ event: "discover_rail_open", ts: now + 1 })
        await recordAnalyticsEvent({ event: "discover_rail_open", ts: now + 2 })

        await flushUsageAnalytics()
        expect(batches()).toEqual([["install"], ["discover_rail_open"]])
        expect(fetchMock.mock.results.length).toBe(2)
        expect(await getUsageWatermark()).toBe(now + 2)

        fetchMock.mockClear()
        await flushUsageAnalytics()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("still sends the main batch when only it has events, and sends the new name alone otherwise", async () => {
        const now = Date.now()
        await recordAnalyticsEvent({ event: "panel_action", ts: now })
        await flushUsageAnalytics()
        expect(batches()).toEqual([["panel_action"]])

        fetchMock.mockClear()
        await recordAnalyticsEvent({ event: "discover_rail_open", ts: now + 5 })
        await flushUsageAnalytics()
        expect(batches()).toEqual([["discover_rail_open"]])
        expect(await getUsageWatermark()).toBe(now + 5)
    })

    it("a failed main batch keeps the window for next time and sends nothing else", async () => {
        const now = Date.now()
        await recordAnalyticsEvent({ event: "install", ts: now })
        await recordAnalyticsEvent({ event: "discover_rail_open", ts: now + 1 })
        refuseAll = true
        await expect(flushUsageAnalytics()).rejects.toThrow()
        expect(batches()).toEqual([["install"]])
        expect(await getUsageWatermark()).toBeLessThan(now)

        refuseAll = false
        fetchMock.mockClear()
        await flushUsageAnalytics()
        expect(batches()).toEqual([["install"], ["discover_rail_open"]])
    })
})
