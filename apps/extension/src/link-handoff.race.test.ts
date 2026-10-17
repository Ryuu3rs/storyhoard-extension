import { beforeEach, describe, expect, it, vi } from "vitest"

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
    tabs: { create: () => Promise.resolve({}) }
})

const { handleHandoffMessage, WEEB_ORIGIN } = await import("./link-handoff")

beforeEach(() => {
    vi.clearAllMocks()
    store.clear()
    getSettings.mockResolvedValue({ linkHandoff: true })
    linkAccountWithToken.mockResolvedValue(undefined)
    apiRedeemHandoff.mockResolvedValue({ deviceToken: "dev-token", userId: "u1", handle: "reader" })
})

async function hello() {
    const reply = await handleHandoffMessage({ type: "handoff:hello", client: "ext" }, WEEB_ORIGIN)
    return (reply as { nonce: string }).nonce
}

describe("handoff nonce storage under a double welcome-page open", () => {
    it("still lets the first tab's code redeem after a second tab issues its own nonce", async () => {
        // Two welcome tabs are open (user re-opened / refreshed the funnel page). Each asks the
        // extension for a nonce; both write the single shared "handoffNonce" key, so the second
        // hello silently clobbers the first tab's nonce.
        const nonce1 = await hello()
        const nonce2 = await hello()
        expect(nonce1).not.toBe(nonce2)

        // The first tab now hands back the one-time code the server minted bound to nonce1.
        // It is a perfectly valid code for a legitimate flow, but matchAndConsumeNonce compares
        // against the stored nonce2 and rejects it: the first tab can NEVER link.
        const reply = await handleHandoffMessage(
            { type: "handoff:code", nonce: nonce1, code: "code-for-nonce1" },
            WEEB_ORIGIN
        )
        expect(reply).toEqual({ type: "handoff:done", ok: true })
        expect(apiRedeemHandoff).toHaveBeenCalledWith("code-for-nonce1", nonce1, "chrome")
    })
})
