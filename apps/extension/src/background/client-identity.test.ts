import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyClientIdentityRule, clientIdentityRule, clientUserAgent, identifiedHosts } from "./client-identity"

const updateSessionRules = vi.fn()

beforeEach(() => {
    updateSessionRules.mockReset()
    updateSessionRules.mockResolvedValue(undefined)
    vi.stubGlobal("browser", {
        declarativeNetRequest: { updateSessionRules },
        runtime: { getManifest: () => ({ version: "1.2.3" }) }
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe("client identity rule", () => {
    it("identifies the extension truthfully, never as a browser", () => {
        const agent = clientUserAgent("1.2.3")
        expect(agent).toBe("StoryHoard/1.2.3 (+https://weeb.ltd)")
        expect(agent).not.toMatch(/Mozilla|Chrome|Safari|Firefox/)
    })

    it("applies only to requests no tab made, so the user's own pages keep their User-Agent", () => {
        const { condition } = clientIdentityRule(["api.example.org"], "1.2.3")
        expect(condition.tabIds).toEqual([-1])
        expect(condition.requestDomains).toEqual(["api.example.org"])
        expect(condition.resourceTypes).toEqual(["xmlhttprequest"])
    })

    it("takes its hosts from source manifests", () => {
        expect(identifiedHosts()).toEqual(["api.mangadex.org"])
    })

    it("replaces its own rule, so a worker restart cannot stack duplicates", async () => {
        await applyClientIdentityRule()
        await applyClientIdentityRule()
        expect(updateSessionRules).toHaveBeenCalledTimes(2)
        const [update] = updateSessionRules.mock.calls[1]!
        expect(update.removeRuleIds).toEqual([update.addRules[0].id])
        expect(update.addRules).toHaveLength(1)
        expect(update.addRules[0].action.requestHeaders[0].value).toBe("StoryHoard/1.2.3 (+https://weeb.ltd)")
    })

    it("never rejects, because worker startup waits on it", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {})
        updateSessionRules.mockRejectedValue(new Error("no"))
        await expect(applyClientIdentityRule()).resolves.toBeUndefined()
    })
})
