import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyCoverCookieRule, coverCookieRule } from "./cover-cookies"
import { clientIdentityRule } from "./client-identity"
import { imageRefererRule } from "./image-referer"

const rule = coverCookieRule("abcdefghijklmnop")
const updateSessionRules = vi.fn()

beforeEach(() => {
    updateSessionRules.mockReset().mockResolvedValue(undefined)
    vi.stubGlobal("browser", {
        declarativeNetRequest: { updateSessionRules },
        runtime: { getURL: (path: string) => `chrome-extension://abcdefghijklmnop${path}` }
    })
})

afterEach(() => vi.unstubAllGlobals())

describe("cover cookie rule", () => {
    it("removes the Cookie header and nothing else", () => {
        expect(rule.action).toEqual({
            type: "modifyHeaders",
            requestHeaders: [{ header: "Cookie", operation: "remove" }]
        })
    })

    it("only reaches images the extension's own pages load", () => {
        expect(rule.condition).toEqual({ initiatorDomains: ["abcdefghijklmnop"], resourceTypes: ["image"] })
    })

    it("never shares a session rule id with the other session rules", () => {
        expect(rule.id).not.toBe(imageRefererRule("abcdefghijklmnop").id)
        expect(rule.id).not.toBe(clientIdentityRule(["a.example"], "1.0.0", "abcdefghijklmnop").id)
    })

    it("replaces its own rule on every worker start", async () => {
        await applyCoverCookieRule()
        expect(updateSessionRules).toHaveBeenCalledWith({ removeRuleIds: [rule.id], addRules: [rule] })
    })

    it("never throws when the browser refuses the rule", async () => {
        updateSessionRules.mockRejectedValue(new Error("no"))
        vi.spyOn(console, "error").mockImplementation(() => undefined)
        await expect(applyCoverCookieRule()).resolves.toBeUndefined()
    })
})
