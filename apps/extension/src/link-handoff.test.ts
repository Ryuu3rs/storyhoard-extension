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
const tabsCreate = vi.fn()
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
    tabs: {
        create: (...a: unknown[]) => {
            tabsCreate(...a)
            return Promise.resolve({})
        }
    }
})

const { handleHandoffMessage, openWelcomeOnInstall, WEEB_ORIGIN } = await import("./link-handoff")

const ON = { linkHandoff: true }
const OFF = { linkHandoff: false }

beforeEach(() => {
    vi.clearAllMocks()
    store.clear()
    getSettings.mockResolvedValue(ON)
    linkAccountWithToken.mockResolvedValue({ invalid: false })
    apiRedeemHandoff.mockResolvedValue({ deviceToken: "dev-token", userId: "u1", handle: "reader" })
})

async function hello(origin = WEEB_ORIGIN) {
    return handleHandoffMessage({ type: "handoff:hello", client: "ext" }, origin)
}

describe("link handoff message handling", () => {
    it("drops any message from an origin that is not exactly weeb.ltd", async () => {
        expect(await hello("https://evil.example")).toBeUndefined()
        expect(await hello("https://weeb.ltd.evil.io")).toBeUndefined()
        expect(await hello("http://weeb.ltd")).toBeUndefined()
        expect(await hello("https://sub.weeb.ltd")).toBeUndefined()
        expect(store.size).toBe(0)
    })

    it("does nothing while the linkHandoff flag is off", async () => {
        getSettings.mockResolvedValue(OFF)
        expect(await hello()).toBeUndefined()
        expect(await handleHandoffMessage({ type: "handoff:code", nonce: "n", code: "c" }, WEEB_ORIGIN)).toBeUndefined()
        expect(apiRedeemHandoff).not.toHaveBeenCalled()
    })

    it("never routes a RuntimeRequest-shaped message into anything", async () => {
        expect(await handleHandoffMessage({ type: "library:get", mangaId: "x" }, WEEB_ORIGIN)).toBeUndefined()
        expect(await handleHandoffMessage({ type: "account:unlink" }, WEEB_ORIGIN)).toBeUndefined()
    })

    it("issues a 22-64 char url-safe nonce on hello and stores it", async () => {
        const reply = await hello()
        expect(reply?.type).toBe("handoff:nonce")
        const nonce = (reply as { nonce: string }).nonce
        expect(nonce).toMatch(/^[A-Za-z0-9_-]{22,64}$/)
        // Nonces are stored as a map (nonce -> issuedAt) so a second welcome tab cannot clobber the first.
        expect(Object.keys(store.get("handoffNonces") as Record<string, number>)).toContain(nonce)
    })

    it("redeems a code whose nonce matches, links the account, and emits account_linked once", async () => {
        const nonce = ((await hello()) as { nonce: string }).nonce
        const done = await handleHandoffMessage({ type: "handoff:code", nonce, code: "the-code" }, WEEB_ORIGIN)

        expect(done).toEqual({ type: "handoff:done", ok: true })
        expect(apiRedeemHandoff).toHaveBeenCalledWith("the-code", nonce, "chrome")
        expect(linkAccountWithToken).toHaveBeenCalledWith("dev-token")
        expect(recordAnalyticsEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "account_linked" }))
    })

    it("consumes the nonce so the same pair cannot be replayed", async () => {
        const nonce = ((await hello()) as { nonce: string }).nonce
        await handleHandoffMessage({ type: "handoff:code", nonce, code: "c1" }, WEEB_ORIGIN)
        apiRedeemHandoff.mockClear()

        const second = await handleHandoffMessage({ type: "handoff:code", nonce, code: "c1" }, WEEB_ORIGIN)
        expect(second).toEqual({ type: "handoff:error" })
        expect(apiRedeemHandoff).not.toHaveBeenCalled()
    })

    it("rejects a code whose nonce does not match the issued one", async () => {
        await hello()
        const reply = await handleHandoffMessage(
            { type: "handoff:code", nonce: "not-the-nonce", code: "c" },
            WEEB_ORIGIN
        )
        expect(reply).toEqual({ type: "handoff:error" })
        expect(apiRedeemHandoff).not.toHaveBeenCalled()
    })

    it("reports an error and does not link when redeem fails", async () => {
        const nonce = ((await hello()) as { nonce: string }).nonce
        apiRedeemHandoff.mockRejectedValue(new Error("400"))
        const reply = await handleHandoffMessage({ type: "handoff:code", nonce, code: "c" }, WEEB_ORIGIN)
        expect(reply).toEqual({ type: "handoff:error" })
        expect(linkAccountWithToken).not.toHaveBeenCalled()
    })

    // BUGHUNT (errors): the nonce is consumed BEFORE apiRedeemHandoff runs, so a TRANSIENT
    // redeem failure (offline, 500, timeout) that never consumed the server-side code still
    // burns the install nonce. The welcome page can legitimately resend the SAME nonce+code
    // (the server code has not been spent and is inside its 120s TTL), but this side now
    // rejects it without even calling the server - the only recovery is a fresh handoff:hello.
    it("a transient redeem failure burns the nonce so the same code cannot be retried", async () => {
        const nonce = ((await hello()) as { nonce: string }).nonce

        // First attempt: a transient (retryable) failure - server did NOT consume the code.
        apiRedeemHandoff.mockRejectedValueOnce(new Error("network error"))
        const first = await handleHandoffMessage({ type: "handoff:code", nonce, code: "the-code" }, WEEB_ORIGIN)
        expect(first).toEqual({ type: "handoff:error" })

        // The server code is still valid, so a resend of the SAME nonce+code should redeem.
        apiRedeemHandoff.mockResolvedValue({ deviceToken: "dev-token", userId: "u1", handle: "reader" })
        const retry = await handleHandoffMessage({ type: "handoff:code", nonce, code: "the-code" }, WEEB_ORIGIN)

        // What we want: the retry succeeds (the code is still good). What actually happens: the
        // consumed nonce makes this side short-circuit to handoff:error and never retry the server.
        expect(retry).toEqual({ type: "handoff:done", ok: true })
        expect(linkAccountWithToken).toHaveBeenCalledWith("dev-token")
    })
})

describe("openWelcomeOnInstall", () => {
    it("opens the welcome tab on install when the flag is on and no account is linked", async () => {
        getAccountProfile.mockResolvedValue({})
        await openWelcomeOnInstall()
        expect(tabsCreate).toHaveBeenCalledWith({ url: "https://weeb.ltd/welcome?client=ext" })
    })

    it("does nothing when the flag is off", async () => {
        getSettings.mockResolvedValue(OFF)
        await openWelcomeOnInstall()
        expect(tabsCreate).not.toHaveBeenCalled()
    })

    it("does not re-onboard a reinstall that already has a token", async () => {
        getAccountProfile.mockResolvedValue({ token: "existing" })
        await openWelcomeOnInstall()
        expect(tabsCreate).not.toHaveBeenCalled()
    })
})
