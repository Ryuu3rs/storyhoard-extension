import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SERVER_EVENT_NAMES, serverIngest } from "./analytics-ingest.fixture"

vi.stubGlobal("browser", fakeBrowser)
vi.stubEnv("VITE_ANALYTICS_API_URL", "https://analytics.example.test")

// Models the live ingest: it skips an event it does not list and counts the rest of the batch.
let names: ReadonlySet<string> = SERVER_EVENT_NAMES
let counted: string[] = []
let answer: (() => Response | Promise<Response>) | undefined
const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (answer) return answer()
    const { events } = JSON.parse(String(init?.body)) as { events: { name: string; count: number }[] }
    const result = serverIngest(events, names)
    counted.push(...result.counted.map(e => e.name))
    return new Response(null, { status: result.status })
})
vi.stubGlobal("fetch", fetchMock)

const { db, recordAnalyticsEvent } = await import("../database")
const { ALLOWED_USAGE_EVENTS, MAX_EVENTS_PER_REQUEST, getUsageWatermark, markUsageNoticeShown, usageRequests } =
    await import("../analytics-usage")
const { flushUsageAnalytics } = await import("./analytics-flush")

const batches = () =>
    fetchMock.mock.calls.map(([, init]) =>
        (JSON.parse(String(init?.body)) as { events: { name: string; count: number }[] }).events.map(e => e.name)
    )
const statuses = () => Promise.all(fetchMock.mock.results.map(async r => (await (r.value as Promise<Response>)).status))

beforeEach(async () => {
    fakeBrowser.reset()
    vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue({ version: "9.9.9" } as never)
    fetchMock.mockClear()
    names = SERVER_EVENT_NAMES
    counted = []
    answer = undefined
    await db.analyticsEvents.clear()
    await markUsageNoticeShown(1)
})

describe("the usage batch against the real ingest allowlist", () => {
    it("every allowlisted name is one the ingest counts", () => {
        expect([...ALLOWED_USAGE_EVENTS].filter(name => !SERVER_EVENT_NAMES.has(name))).toEqual([])
    })

    it("a fresh install's first flush sends every name in one request and moves the watermark", async () => {
        const now = Date.now()
        // background.ts records "install" on every fresh install, so it is in every first window.
        await recordAnalyticsEvent({ event: "install", ts: now })
        await recordAnalyticsEvent({ event: "capture_ok", ts: now + 1 })
        await recordAnalyticsEvent({ event: "panel_action", ts: now + 2 })
        await recordAnalyticsEvent({ event: "discover_rail_open", ts: now + 3 })

        await flushUsageAnalytics()
        await flushUsageAnalytics()

        expect(batches()).toEqual([["install", "capture_ok", "panel_action", "discover_rail_open"]])
        expect(await statuses()).toEqual([204])
        expect(counted).toEqual(["install", "capture_ok", "panel_action", "discover_rail_open"])
        expect(await getUsageWatermark()).toBe(now + 3)
    })

    it("a name the server does not list yet costs only itself, and nothing is resent", async () => {
        names = new Set([...SERVER_EVENT_NAMES].filter(name => name !== "discover_rail_open"))
        const now = Date.now()
        await recordAnalyticsEvent({ event: "capture_ok", ts: now })
        await recordAnalyticsEvent({ event: "discover_rail_open", ts: now + 1 })

        await flushUsageAnalytics()
        expect(await statuses()).toEqual([204])
        expect(counted).toEqual(["capture_ok"])
        expect(await getUsageWatermark()).toBe(now + 1)

        fetchMock.mockClear()
        await flushUsageAnalytics()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("reads only the one watermark, not the second one older builds kept", async () => {
        const now = Date.now()
        await fakeBrowser.storage.local.set({
            analyticsUsageWatermark: now + 1,
            analyticsUnconfirmedWatermark: now - 1
        })
        await recordAnalyticsEvent({ event: "panel_action", ts: now })
        await recordAnalyticsEvent({ event: "capture_ok", ts: now + 2 })

        await flushUsageAnalytics()
        expect(batches()).toEqual([["capture_ok"]])
    })
})

describe("a batch the server cannot take", () => {
    it("refused with 400 is dropped, so the window does not grow and resend forever", async () => {
        const now = Date.now()
        await recordAnalyticsEvent({ event: "capture_ok", ts: now })
        answer = () => new Response(null, { status: 400 })
        await flushUsageAnalytics()
        expect(await statuses()).toEqual([400])
        expect(await getUsageWatermark()).toBe(now)

        answer = undefined
        fetchMock.mockClear()
        await recordAnalyticsEvent({ event: "capture_ok", ts: now + 1 })
        await flushUsageAnalytics()
        expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).events)).toEqual([
            [expect.objectContaining({ name: "capture_ok", count: 1 })]
        ])
    })

    for (const status of [429, 500, 503]) {
        it(`answered ${status} keeps the window for next time`, async () => {
            const now = Date.now()
            await recordAnalyticsEvent({ event: "capture_ok", ts: now })
            await recordAnalyticsEvent({ event: "panel_action", ts: now + 1 })
            answer = () => new Response(null, { status })
            await expect(flushUsageAnalytics()).rejects.toThrow()
            expect(await getUsageWatermark()).toBeLessThan(now)

            answer = undefined
            fetchMock.mockClear()
            await flushUsageAnalytics()
            expect(batches()).toEqual([["capture_ok", "panel_action"]])
            expect(await getUsageWatermark()).toBe(now + 1)
        })
    }

    it("with no answer at all keeps the window for next time", async () => {
        const now = Date.now()
        await recordAnalyticsEvent({ event: "capture_ok", ts: now })
        answer = () => {
            throw new TypeError("Failed to fetch")
        }
        await expect(flushUsageAnalytics()).rejects.toThrow()
        expect(await getUsageWatermark()).toBeLessThan(now)

        answer = undefined
        fetchMock.mockClear()
        await flushUsageAnalytics()
        expect(batches()).toEqual([["capture_ok"]])
        expect(await getUsageWatermark()).toBe(now)
    })

    it("a count above the server's per-event cap goes as several events the server adds up", async () => {
        const now = Date.now()
        await db.analyticsEvents.bulkAdd(
            Array.from({ length: 10_001 }, (_, i) => ({ event: "capture_ok" as const, ts: now + i }))
        )
        await flushUsageAnalytics()
        expect(await statuses()).toEqual([204])
        const events = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).events as { count: number }[]
        expect(events.map(e => e.count)).toEqual([10_000, 1])
        expect(counted).toEqual(["capture_ok", "capture_ok"])
    })
})

describe("usageRequests", () => {
    it("never puts more than the server's limit in one request", () => {
        const events = Array.from({ length: 250 }, (_, i) => ({ name: `e${i}`, ts: 0, count: 1 }))
        const requests = usageRequests(events)
        expect(requests.map(r => r.length)).toEqual([MAX_EVENTS_PER_REQUEST, MAX_EVENTS_PER_REQUEST, 50])
        expect(requests.flat()).toEqual(events)
    })

    it("sends nothing for an empty batch", () => {
        expect(usageRequests([])).toEqual([])
    })
})
