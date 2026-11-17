import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyImageRefererRule, imageRefererRule } from "./image-referer"
import { clientIdentityRule } from "./client-identity"

const updateSessionRules = vi.fn()

beforeEach(() => {
    updateSessionRules.mockReset().mockResolvedValue(undefined)
    vi.stubGlobal("browser", { declarativeNetRequest: { updateSessionRules } })
})

afterEach(() => vi.unstubAllGlobals())

describe("image referer rule", () => {
    it("only reaches requests no tab made, so the user's own browsing keeps its Referer", () => {
        expect(imageRefererRule.condition.tabIds).toEqual([-1])
        expect(imageRefererRule.condition.requestDomains).toEqual(["pstatic.net"])
    })

    it("never shares a session rule id with the client identity rule", () => {
        expect(imageRefererRule.id).not.toBe(clientIdentityRule(["a.example"], "1.0.0").id)
    })

    it("replaces its own rule on every worker start", async () => {
        await applyImageRefererRule()
        expect(updateSessionRules).toHaveBeenCalledWith({
            removeRuleIds: [imageRefererRule.id],
            addRules: [imageRefererRule]
        })
    })

    it("never throws when the browser refuses the rule", async () => {
        updateSessionRules.mockRejectedValue(new Error("no"))
        vi.spyOn(console, "error").mockImplementation(() => undefined)
        await expect(applyImageRefererRule()).resolves.toBeUndefined()
    })
})
