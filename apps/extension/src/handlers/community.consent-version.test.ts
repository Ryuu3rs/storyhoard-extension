import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("browser", fakeBrowser)

vi.mock("../community", async () => {
    const actual = await vi.importActual<typeof import("../community")>("../community")
    return {
        ...actual,
        apiRegister: vi.fn(),
        apiSyncEvents: vi.fn(async () => ({ rank: 1, newAchievements: [], recommendations: [] })),
        apiFetchCommunityStats: vi.fn(async () => null),
        apiClaim: vi.fn(async () => ({ secret: "s" })),
        apiPing: vi.fn(async () => {})
    }
})

const { db } = await import("../database")
const community = await import("../community")
const { communityHandlers, runCommunitySync } = await import("./community")

beforeEach(async () => {
    fakeBrowser.reset()
    vi.clearAllMocks()
    await Promise.all([db.manga.clear(), db.historyEvents.clear(), db.chapters.clear()])
})

describe("community consent version", () => {
    it("sends nothing for a profile that never accepted the consent card (consentVersion 0)", async () => {
        // A profile from the opt-out era: enabled and registered, but the current consent card never accepted.
        await community.updateCommunityProfile({
            enabled: true,
            userId: "legacy-user",
            secret: "s",
            username: "Reader1234",
            consentVersion: 0,
            consentAt: 0
        })
        await db.manga.put({
            id: "m1",
            sourceId: "src",
            sourceUrl: "https://example.test/m1",
            title: "Some Title",
            normalizedTitle: "some title",
            authors: [],
            status: "ongoing",
            addedAt: 1,
            updatedAt: 1
        } as never)
        await db.historyEvents.add({ type: "completed", mangaId: "m1", chapterId: "c1", occurredAt: 5 } as never)

        await runCommunitySync()

        expect(community.apiPing).not.toHaveBeenCalled()
        expect(community.apiSyncEvents).not.toHaveBeenCalled()
    })
})

describe("community status for an opt-in from before the consent card", () => {
    it("reads off and asks for consent, not for Firefox's permission", async () => {
        await community.updateCommunityProfile({ enabled: true, userId: "legacy-user", consentVersion: 0 })
        const status = await community.communityStatusOf(await community.getCommunityProfile())
        expect(status).toMatchObject({ enabled: false, allowed: false, needsPermission: false, needsConsent: true })
        expect(community.communityOptedIn(status)).toBe(true)
    })

    it("sends again once the card is accepted", async () => {
        await community.updateCommunityProfile({ enabled: true, userId: "legacy-user", secret: "s", consentVersion: 0 })
        await communityHandlers["community:toggle"]!({ type: "community:toggle", enabled: true } as never, {} as never)
        const status = await community.communityStatusOf(await community.getCommunityProfile())
        expect(status).toMatchObject({ enabled: true, allowed: true, needsConsent: false })
    })
})
