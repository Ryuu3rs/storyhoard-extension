import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SERVER_EVENT_NAMES, serverAccepts } from "./analytics-ingest.fixture"

vi.stubGlobal("browser", fakeBrowser)
vi.stubEnv("VITE_ANALYTICS_API_URL", "https://analytics.example.test")

// Models the live ingest: the deployed server does not take the unconfirmed names yet, and refuses a whole
// batch carrying a name it does not know.
let accepted: ReadonlySet<string> = SERVER_EVENT_NAMES
let answer: (() => Response | Promise<Response>) | undefined
const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (answer) return answer()
    const { events } = JSON.parse(String(init?.body)) as { events: { name: string; count: number }[] }
    const ok = serverAccepts(events) && events.every(e => accepted.has(e.name))
    return new Response(null, { status: ok ? 204 : 400 })
})
vi.stubGlobal("fetch", fetchMock)

const { db, recordAnalyticsEvent } = await import("../database")
const {
    ALLOWED_USAGE_EVENTS,
    MAX_EVENTS_PER_REQUEST,
    UNCONFIRMED_USAGE_EVENTS,
    getUsageWatermark,
    markUsageNoticeShown,
    usageRequests
} = await import("../analytics-usage")
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
    accepted = SERVER_EVENT_NAMES
    answer = undefined
    await db.analyticsEvents.clear()
    await markUsageNoticeShown(1)
})

describe("the main usage batch against the real ingest allowlist", () => {
    it("every name sent in the main batch is one the ingest accepts", () => {
        const main = [...ALLOWED_USAGE_EVENTS].filter(name => !UNCONFIRMED_USAGE_EVENTS.has(name))
        expect(main.filter(name => !SERVER_EVENT_NAMES.has(name))).toEqual([])
    })

    it("a fresh install's first flush delivers capture_ok and moves the watermark", async () => {
        accepted = new Set([...SERVER_EVENT_NAMES].filter(name => !UNCONFIRMED_USAGE_EVENTS.has(name)))
        const now = Date.now()
        // background.ts records "install" on every fresh install, so it is in every first window.
        await recordAnalyticsEvent({ event: "install", ts: now })
        await recordAnalyticsEvent({ event: "capture_ok", ts: now + 1 })

        await flushUsageAnalytics()
        await flushUsageAnalytics()

        expect(batches()).toEqual([["capture_ok"], ["install"]])
        expect(await statuses()).toEqual([204, 400])
        expect(await getUsageWatermark()).toBe(now + 1)
    })
})

describe("usage events the server may not accept yet", () => {
    it("go in a request of their own", async () => {
        const now = Date.now()
        await recordAnalyticsEvent({ event: "capture_ok", ts: now })
        await recordAnalyticsEvent({ event: "panel_action", ts: now + 1 })
        await recordAnalyticsEvent({ event: "discover_rail_open", ts: now + 2 })
        await flushUsageAnalytics()
        expect(batches()).toEqual([["capture_ok"], ["panel_action", "discover_rail_open"]])
    })

    it("a refused separate request neither loses nor resends the main batch", async () => {
        accepted = new Set(["capture_ok"])
        const now = Date.now()
        await recordAnalyticsEvent({ event: "capture_ok", ts: now })
        await recordAnalyticsEvent({ event: "discover_rail_open", ts: now + 1 })
        await recordAnalyticsEvent({ event: "discover_rail_open", ts: now + 2 })

        await flushUsageAnalytics()
        expect(batches()).toEqual([["capture_ok"], ["discover_rail_open"]])
        expect(await getUsageWatermark()).toBe(now + 2)

        fetchMock.mockClear()
        await flushUsageAnalytics()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("still sends the main batch when only it has events, and sends the new name alone otherwise", async () => {
        const now = Date.now()
        await recordAnalyticsEvent({ event: "capture_error", ts: now })
        await flushUsageAnalytics()
        expect(batches()).toEqual([["capture_error"]])

        fetchMock.mockClear()
        await recordAnalyticsEvent({ event: "discover_rail_open", ts: now + 5 })
        await flushUsageAnalytics()
        expect(batches()).toEqual([["discover_rail_open"]])
        expect(await getUsageWatermark()).toBe(now + 5)
    })

    it("a separate request with no answer at all keeps its window", async () => {
        const now = Date.now()
        await recordAnalyticsEvent({ event: "discover_rail_open", ts: now })
        await recordAnalyticsEvent({ event: "discover_rail_open", ts: now + 1 })
        const before = await getUsageWatermark()
        answer = () => {
            throw new TypeError("Failed to fetch")
        }

        await expect(flushUsageAnalytics()).rejects.toThrow()
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(await getUsageWatermark()).toBe(before)

        answer = undefined
        fetchMock.mockClear()
        await flushUsageAnalytics()
        expect(batches()).toEqual([["discover_rail_open"]])
        expect(await getUsageWatermark()).toBe(now + 1)
    })

    for (const status of [429, 500, 503]) {
        it(`a separate request answered ${status} keeps its window without resending the main batch`, async () => {
            const now = Date.now()
            await recordAnalyticsEvent({ event: "capture_ok", ts: now })
            await recordAnalyticsEvent({ event: "panel_action", ts: now + 1 })
            answer = () => {
                const { events } = JSON.parse(String(fetchMock.mock.lastCall?.[1]?.body)) as {
                    events: { name: string }[]
                }
                return new Response(null, { status: events[0]!.name === "capture_ok" ? 204 : status })
            }
            await expect(flushUsageAnalytics()).rejects.toThrow()

            answer = undefined
            fetchMock.mockClear()
            await flushUsageAnalytics()
            expect(batches()).toEqual([["panel_action"]])
        })
    }
})

describe("a main batch the server cannot take", () => {
    it("refused with 400 is dropped, so the window does not grow and resend forever", async () => {
        accepted = new Set()
        const now = Date.now()
        await recordAnalyticsEvent({ event: "capture_ok", ts: now })
        await flushUsageAnalytics()
        expect(await statuses()).toEqual([400])
        expect(await getUsageWatermark()).toBe(now)

        accepted = SERVER_EVENT_NAMES
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
            answer = () => new Response(null, { status })
            await expect(flushUsageAnalytics()).rejects.toThrow()
            expect(await getUsageWatermark()).toBeLessThan(now)

            answer = undefined
            fetchMock.mockClear()
            await flushUsageAnalytics()
            expect(batches()).toEqual([["capture_ok"]])
            expect(await getUsageWatermark()).toBe(now)
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
