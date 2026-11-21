import { describe, expect, it } from "vitest"
import { buildUsageBatch, usageAnalyticsEnabled } from "./analytics-usage"
import { defaultSettings } from "./settings"

describe("buildUsageBatch", () => {
    it("aggregates allowlisted events by name with a count and the UTC day of the latest ts", () => {
        const day1 = Date.UTC(2026, 10, 16)
        const day2 = Date.UTC(2026, 10, 17)
        const out = buildUsageBatch([
            { event: "reader_opened", ts: day1 + 100 },
            { event: "reader_opened", ts: day2 + 5_000_000 },
            { event: "capture_ok", ts: day1 + 86_399_999 }
        ])
        const reader = out.find(e => e.name === "reader_opened")
        const capture = out.find(e => e.name === "capture_ok")
        expect(reader).toEqual({ name: "reader_opened", ts: day2, count: 2 })
        expect(capture).toEqual({ name: "capture_ok", ts: day1, count: 1 })
    })

    it("drops non-allowlisted event names so nothing new leaks by default", () => {
        // A name outside the allowlist must never be forwarded.
        const out = buildUsageBatch([
            { event: "secret_new_event" as never, ts: 1 },
            { event: "capture_ok", ts: 2 }
        ])
        expect(out.map(e => e.name)).toEqual(["capture_ok"])
    })

    it("forwards only name/ts/count - never sourceId or detail from the row", () => {
        const out = buildUsageBatch([
            { event: "capture_ok", ts: 5, sourceId: "asura", detail: '{"url":"secret"}' } as never
        ])
        expect(out).toEqual([{ name: "capture_ok", ts: 0, count: 1 }])
        expect(Object.keys(out[0]!)).toEqual(["name", "ts", "count"])
    })
})

describe("usageAnalyticsEnabled", () => {
    const on = { usageAnalytics: true }

    it("is on by default on Chrome, with no first-run prompt to answer", () => {
        expect(defaultSettings.usageAnalytics).toBe(true)
        expect(usageAnalyticsEnabled(defaultSettings, "chrome", false, false)).toBe(true)
    })

    it("on Firefox it follows the browser's data permission", () => {
        expect(usageAnalyticsEnabled(on, "firefox", false, true)).toBe(true)
        expect(usageAnalyticsEnabled(on, "firefox", false, false)).toBe(false)
    })

    it("the Settings opt-out wins on both browsers", () => {
        expect(usageAnalyticsEnabled({ usageAnalytics: false }, "firefox", false, true)).toBe(false)
        expect(usageAnalyticsEnabled({ usageAnalytics: false }, "chrome", false, false)).toBe(false)
    })

    it("a linked account's opt-out wins", () => {
        expect(usageAnalyticsEnabled(on, "firefox", true, true)).toBe(false)
        expect(usageAnalyticsEnabled(on, "chrome", true, false)).toBe(false)
    })
})
