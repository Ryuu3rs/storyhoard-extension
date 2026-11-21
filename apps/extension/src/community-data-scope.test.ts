import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Firefox build: analytics-flush reads import.meta.env.BROWSER at module load.
vi.stubEnv("BROWSER", "firefox")
vi.stubEnv("VITE_ANALYTICS_API_URL", "https://analytics.example.test")
vi.stubGlobal("browser", fakeBrowser)

const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }))
vi.stubGlobal("fetch", fetchMock)

// Firefox's data_collection permissions, modelled as the set of granted categories.
const granted = new Set<string>()
const categories = (p: unknown) => (p as { data_collection: string[] }).data_collection

const { db, recordAnalyticsEvent } = await import("./database")
const community = await import("./community")
const { flushUsageAnalytics, usageStatsAllowed } = await import("./background/analytics-flush")
const { markUsageNoticeShown } = await import("./analytics-usage")

beforeEach(async () => {
    fakeBrowser.reset()
    granted.clear()
    fetchMock.mockClear()
    await db.analyticsEvents.clear()
    // Past the one-time usage notice, so only the Firefox data permission decides.
    await markUsageNoticeShown()
    vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue({ version: "9.9.9" } as never)
    vi.spyOn(fakeBrowser.permissions, "contains").mockImplementation((async (p: unknown) =>
        categories(p).every(c => granted.has(c))) as never)
    vi.spyOn(fakeBrowser.permissions, "remove").mockImplementation((async (p: unknown) => {
        for (const c of categories(p)) granted.delete(c)
        return true
    }) as never)
})

// What App.svelte does on Firefox: read what is held ahead of the click, ask Firefox for the community
// categories in the click, record what that added; and on the way off, give back what was recorded.
async function turnCommunityOn(olderOptIn = false): Promise<void> {
    const heldBefore = await community.heldCommunityData()
    for (const c of categories(community.COMMUNITY_DATA_PERMISSION)) granted.add(c)
    await community.noteCommunityDataAdded(heldBefore, olderOptIn)
}
const turnCommunityOff = () => community.releaseCommunityData()

async function analyticsSends(): Promise<boolean> {
    await flushUsageAnalytics()
    await recordAnalyticsEvent({ event: "panel_action", ts: Date.now() + 10 })
    fetchMock.mockClear()
    await flushUsageAnalytics()
    return fetchMock.mock.calls.length > 0
}

describe("Firefox data consent scope", () => {
    it("with the optional data permission left unticked at install, analytics sends nothing", async () => {
        expect(await analyticsSends()).toBe(false)
    })

    it("weeb.ltd search counts follow the data permission too", async () => {
        expect(await usageStatsAllowed()).toBe(false)
        granted.add("technicalAndInteraction")
        await community.noteInstallDataChoice()
        expect(await usageStatsAllowed()).toBe(true)
    })

    it("trying community features and turning them off again does not leave usage analytics running", async () => {
        await turnCommunityOn()
        await turnCommunityOff()
        expect(await analyticsSends()).toBe(false)
        expect([...granted]).toEqual([])
    })

    it("keeps the browsing activity grant while account sync, the backup or AniList list sync still uses it", async () => {
        await turnCommunityOn()
        await community.releaseCommunityData(true)
        expect([...granted]).toEqual(["browsingActivity"])
        expect(await analyticsSends()).toBe(false)
    })

    it("does not run usage analytics on a grant community asked for, while community is on", async () => {
        await turnCommunityOn()
        expect(await analyticsSends()).toBe(false)
    })

    it("gives back exactly what community added: analytics chosen at install keeps running", async () => {
        granted.add("technicalAndInteraction")
        await community.noteInstallDataChoice()
        await turnCommunityOn()
        await turnCommunityOff()
        expect([...granted]).toEqual(["technicalAndInteraction"])
        expect(await analyticsSends()).toBe(true)
    })

    it("treats the grants of a community opt-in from an older build as community's", async () => {
        // 0.32.2 asked for these two when community was turned on; the user never chose analytics.
        granted.add("technicalAndInteraction")
        granted.add("personallyIdentifyingInfo")
        await turnCommunityOn(true)
        await turnCommunityOff()
        expect([...granted]).toEqual([])
        expect(await analyticsSends()).toBe(false)
    })

    it("with no record of what community added, turning it off does not leave analytics on a grant nobody chose", async () => {
        for (const c of categories(community.COMMUNITY_DATA_PERMISSION)) granted.add(c)
        await turnCommunityOff()
        expect([...granted]).toEqual([])
    })

    it("switching analytics on in Settings makes the grant the user's own", async () => {
        await turnCommunityOn()
        expect(await community.noteUsageDataChoice(true, true)).toBe(false)
        await turnCommunityOff()
        expect([...granted]).toEqual(["technicalAndInteraction"])
        expect(await analyticsSends()).toBe(true)
    })

    it("switching analytics off while community is on leaves the grant for community and gives it back with it", async () => {
        granted.add("technicalAndInteraction")
        await community.noteInstallDataChoice()
        await turnCommunityOn()
        expect(await community.noteUsageDataChoice(false, true)).toBe(false)
        expect(granted.has("technicalAndInteraction")).toBe(true)
        await turnCommunityOff()
        expect([...granted]).toEqual([])
    })
})

describe("an opt-in from an older build that this build cannot send for yet", () => {
    beforeEach(async () => {
        // 0.32.2 asked for these two when community was turned on, and stored the opt-in.
        granted.add("technicalAndInteraction")
        granted.add("personallyIdentifyingInfo")
        await community.updateCommunityProfile({ enabled: true })
    })

    it("does not run usage analytics on the grant that opt-in asked for", async () => {
        expect(await analyticsSends()).toBe(false)
    })

    it("runs it once the user switches analytics on themselves", async () => {
        await community.noteUsageDataChoice(true, false)
        expect(await analyticsSends()).toBe(true)
    })
})
