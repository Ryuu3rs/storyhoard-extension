import "fake-indexeddb/auto"
import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ANALYTICS_MAX, db, recordAnalyticsEvent } from "../database"
import type { HandlerContext } from "../background/handler-types"
import { assertSenderMayRequest } from "../background/sender-gate"

vi.mock("../sources", () => ({ resolveChapterUrl: vi.fn() }))
vi.stubGlobal("browser", { runtime: { getURL: (p: string) => `chrome-extension://amr-id/${p}` } })

import { downloadsBookmarksAnalyticsHandlers, PAGE_EVENTS_PER_TAB_PER_MINUTE } from "./downloads-bookmarks-analytics"

// analytics:record is reachable from any page's content script (the gate allows the one panel_action event).
// Each row the page writes is read back whole by the flush and the Stats page, and counts toward the
// panel_action total sent to the usage endpoint, so a page gets only a few rows a minute and no free text.
const PAGE = "https://attacker.example/manga/x/chapter-1"
let nextTab = 100
const pageCtx = () => {
    const tabId = nextTab++
    return { sender: { url: PAGE, tab: { id: tabId, url: PAGE } } } as unknown as HandlerContext
}
const record = (request: { detail?: string; sourceId?: string }, ctx: HandlerContext) =>
    downloadsBookmarksAnalyticsHandlers["analytics:record"]!(
        { type: "analytics:record", event: "panel_action", ...request },
        ctx
    )

async function settledRows(): Promise<number> {
    let last = -1
    for (let settled = 0; settled < 3; ) {
        await new Promise(resolve => setTimeout(resolve, 100))
        const now = await db.analyticsEvents.count()
        settled = now === last ? settled + 1 : 0
        last = now
    }
    return last
}

beforeEach(async () => {
    await db.analyticsEvents.clear()
})

describe("analytics:record from a page", () => {
    it("a burst from one page cannot write an unbounded number of rows", { timeout: 60_000 }, async () => {
        const request = {
            type: "analytics:record" as const,
            event: "panel_action" as const,
            sourceId: "s".repeat(200),
            detail: JSON.stringify({ action: "x".repeat(470) })
        }
        const sender = { url: PAGE, tab: { id: 3, url: PAGE } }
        expect(() => assertSenderMayRequest(request, sender, "chrome-extension://amr-id/")).not.toThrow()
        const ctx = { sender } as unknown as HandlerContext
        for (let i = 0; i < 3000; i++) await downloadsBookmarksAnalyticsHandlers["analytics:record"]!(request, ctx)
        expect(await settledRows()).toBeLessThanOrEqual(100)
    })

    it("keeps at most the per-minute allowance of real panel actions from one tab", async () => {
        const ctx = pageCtx()
        for (let i = 0; i < 200; i++) await record({ detail: JSON.stringify({ action: "next" }) }, ctx)
        expect(await settledRows()).toBe(PAGE_EVENTS_PER_TAB_PER_MINUTE)
    })

    it("stores only the panel's own action name, never a page-chosen source id or text", async () => {
        const ctx = pageCtx()
        await record({ sourceId: "victim-site", detail: JSON.stringify({ action: "mark-read", extra: "x" }) }, ctx)
        await record({ detail: JSON.stringify({ action: "not-a-panel-action" }) }, ctx)
        await record({ detail: "not json" }, ctx)
        await record({}, ctx)
        expect(await settledRows()).toBe(1)
        const [row] = await db.analyticsEvents.toArray()
        expect(row).toMatchObject({ event: "panel_action", detail: JSON.stringify({ action: "mark-read" }) })
        expect(row).not.toHaveProperty("sourceId")
    })

    it("bounds the table by count, dropping the oldest rows", { timeout: 60_000 }, async () => {
        const now = Date.now()
        await db.analyticsEvents.bulkAdd(
            Array.from({ length: ANALYTICS_MAX }, (_, i) => ({ event: "capture_ok", ts: now - 1000 + (i % 1000) }))
        )
        await recordAnalyticsEvent({ event: "install", ts: now })
        expect(await db.analyticsEvents.count()).toBe(ANALYTICS_MAX)
        expect(await db.analyticsEvents.where("event").equals("install").count()).toBe(1)
    })

    it("accepts every action name the panel itself records", () => {
        const panel = readFileSync(new URL("../background/inject-chapter-prompt.ts", import.meta.url), "utf8")
        const handler = readFileSync(new URL("./downloads-bookmarks-analytics.ts", import.meta.url), "utf8")
        const actions = [...panel.matchAll(/\btrack\("([a-z-]+)"\)/g)].map(match => match[1]!)
        expect(actions.length).toBeGreaterThan(5)
        for (const action of actions) expect(handler).toContain(`"${action}"`)
    })
})
