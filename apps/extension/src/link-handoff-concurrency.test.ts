import { beforeEach, describe, expect, it, vi } from "vitest"

// Mirrors the harness in link-handoff.test.ts (stubs storage.local + mocks account/handlers/
// account/database/settings). This file isolates the single-use / replay exploit on the
// install-issued nonce so a run of it alone is unambiguous.

const apiRedeemHandoff = vi.fn()
const getAccountProfile = vi.fn()
vi.mock("./account", () => ({
    SITE_BASE: "https://weeb.ltd",
    apiRedeemHandoff: (...a: unknown[]) => apiRedeemHandoff(...a),
    getAccountProfile: (...a: unknown[]) => getAccountProfile(...a)
}))

const linkAccountWithToken = vi.fn()
vi.mock("./handlers/account", () => ({ linkAccountWithToken: (...a: unknown[]) => linkAccountWithToken(...a) }))

const recordAnalyticsEvent = vi.fn()
vi.mock("./database", () => ({ recordAnalyticsEvent: (...a: unknown[]) => recordAnalyticsEvent(...a) }))

const getSettings = vi.fn()
vi.mock("./settings", () => ({ getSettings: () => getSettings() }))

// storage.local mock. get/remove are genuinely async (resolve on a microtask), exactly like the
// real browser.storage.local, so two inbound handoff:code messages processed by the single-
// threaded service worker interleave their get/check/remove the way they do at runtime.
const store = new Map<string, unknown>()
vi.stubGlobal("browser", {
    storage: {
        local: {
            get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
            set: async (obj: Record<string, unknown>) => {
                for (const [k, v] of Object.entries(obj)) store.set(k, v)
            },
            remove: async (key: string) => {
                store.delete(key)
            }
        }
    },
    runtime: { getURL: (p: string) => `chrome-extension://ext${p}` },
    tabs: { query: async () => [], update: () => Promise.resolve({}), create: () => Promise.resolve({}) }
})

const { handleHandoffMessage, WEEB_ORIGIN } = await import("./link-handoff")

beforeEach(() => {
    vi.clearAllMocks()
    store.clear()
    getSettings.mockResolvedValue({ linkHandoff: true })
    linkAccountWithToken.mockResolvedValue(undefined)
    apiRedeemHandoff.mockResolvedValue({ deviceToken: "dev-token", userId: "u1", handle: "reader" })
})

describe("H34 nonce single-use under concurrency", () => {
    it("consumes an install-issued nonce exactly once even if two codes race it", async () => {
        const nonce = ((await handleHandoffMessage({ type: "handoff:hello" }, WEEB_ORIGIN)) as { nonce: string }).nonce

        // A controlled weeb.ltd page (it was handed the nonce in the hello reply) fires the same
        // (nonce, code) twice without awaiting the first. The service worker processes both, their
        // get/check/remove interleave, and the "single-use ... cannot be replayed from this side"
        // invariant should still hold: at most one redeem, one account link.
        const [a, b] = await Promise.all([
            handleHandoffMessage({ type: "handoff:code", nonce, code: "the-code" }, WEEB_ORIGIN),
            handleHandoffMessage({ type: "handoff:code", nonce, code: "the-code" }, WEEB_ORIGIN)
        ])

        const successes = [a, b].filter(r => r && (r as { type: string }).type === "handoff:done").length
        expect(successes).toBe(1)
        // Exactly one redeem reaches the server; the other is rejected by the in-flight lock before
        // any redeem. Linking happens later on user confirm, so neither call links here.
        expect(apiRedeemHandoff).toHaveBeenCalledTimes(1)
        expect(linkAccountWithToken).not.toHaveBeenCalled()
    })
})
