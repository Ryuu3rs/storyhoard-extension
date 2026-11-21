import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Firefox build, usage analytics granted (technicalAndInteraction ticked at install), account linked,
// browsingActivity NOT granted, so account sync is paused for the permission.
vi.stubEnv("BROWSER", "firefox")
vi.stubEnv("VITE_ANALYTICS_API_URL", "https://weeb.ltd")
vi.stubGlobal("browser", fakeBrowser)

const fetchMock = vi.fn<typeof fetch>()
vi.stubGlobal("fetch", fetchMock)

const granted = new Set<string>()
const categories = (p: unknown) => (p as { data_collection?: string[] }).data_collection ?? []

const { db, recordAnalyticsEvent } = await import("../database")
const { getAccountProfile, updateAccountProfile } = await import("../account")
const { runAccountSync } = await import("./account")
const { markUsageNoticeShown } = await import("../analytics-usage")
const { noteInstallDataChoice } = await import("../community")
const { flushUsageAnalytics, usageStatsAllowed } = await import("../background/analytics-flush")

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

let analyticsCalls = 0

beforeEach(async () => {
    fakeBrowser.reset()
    granted.clear()
    analyticsCalls = 0
    fetchMock.mockReset()
    await db.analyticsEvents.clear()
    vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue({ version: "9.9.9" } as never)
    vi.spyOn(fakeBrowser.permissions, "contains").mockImplementation((async (p: unknown) =>
        categories(p).every(c => granted.has(c))) as never)
    fetchMock.mockImplementation(async input => {
        const url = new URL(typeof input === "string" ? input : (input as Request).url)
        // The account has since opted out of analytics on weeb.ltd.
        if (url.pathname === "/api/sync/status")
            return json({ userId: "u1", name: null, image: null, itemCount: 0, analyticsOptOut: true })
        if (url.pathname === "/api/analytics") {
            analyticsCalls++
            return json({})
        }
        return json({ accepted: [], rejected: [], invalid: [], serverTime: Date.now(), items: [], hasMore: false })
    })
})

describe("account analytics opt-out while account sync cannot run", () => {
    it("Firefox without browsingActivity: an opt-out made on weeb.ltd after linking is never applied", async () => {
        granted.add("technicalAndInteraction")
        await noteInstallDataChoice()
        await markUsageNoticeShown()
        // Linked earlier while the account had not opted out.
        await updateAccountProfile({ token: "weeb_token_1234567890", userId: "u1", analyticsOptOut: false })

        // The account alarm fires (every 30 min); sync stops at the Firefox permission gate.
        await runAccountSync()
        expect((await getAccountProfile()).syncProblem).toBe("permission")

        await recordAnalyticsEvent({ event: "capture_ok", ts: Date.now() + 10 })
        await flushUsageAnalytics()

        // The account opted out, so nothing should be sent and weeb.ltd search should not count.
        expect(await usageStatsAllowed()).toBe(false)
        expect(analyticsCalls).toBe(0)
    })

    it("Chromium with sync failing (push 500): the opt-out is never learned either", async () => {
        vi.unstubAllEnvs()
        await markUsageNoticeShown()
        await updateAccountProfile({ token: "weeb_token_1234567890", userId: "u1", analyticsOptOut: false })
        fetchMock.mockImplementation(async input => {
            const url = new URL(typeof input === "string" ? input : (input as Request).url)
            if (url.pathname === "/api/sync/status")
                return json({ userId: "u1", name: null, image: null, itemCount: 0, analyticsOptOut: true })
            return json({ error: "boom" }, 500)
        })
        await db.manga.put({
            id: "x:1",
            sourceId: "x",
            sourceUrl: "https://example.test/1",
            title: "T",
            normalizedTitle: "t",
            authors: [],
            status: "ongoing",
            addedAt: 1,
            updatedAt: 1
        } as never)
        await runAccountSync()
        expect((await getAccountProfile()).syncProblem).toBe("failed")
        expect((await getAccountProfile()).analyticsOptOut).toBe(true)
    })
})
