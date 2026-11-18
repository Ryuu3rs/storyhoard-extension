import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyCoverCookieRules, coverCookieRules } from "./cover-cookies"
import { clientIdentityRule } from "./client-identity"
import { imageRefererRule } from "./image-referer"

const rules = coverCookieRules("abcdefghijklmnop", "https://weeb.ltd")
const updateSessionRules = vi.fn()

beforeEach(() => {
    updateSessionRules.mockReset().mockResolvedValue(undefined)
    vi.stubGlobal("browser", {
        declarativeNetRequest: { updateSessionRules },
        runtime: { getURL: (path: string) => `chrome-extension://abcdefghijklmnop${path}` }
    })
})

afterEach(() => vi.unstubAllGlobals())

describe("cover cookie rules", () => {
    it("remove the Cookie header and nothing else", () => {
        for (const rule of rules) {
            expect(rule.action).toEqual({
                type: "modifyHeaders",
                requestHeaders: [{ header: "Cookie", operation: "remove" }]
            })
        }
    })

    it("reach only the catalog cover hosts and weeb.ltd's cover route, for images the extension loads", () => {
        expect(rules.map(rule => rule.condition)).toEqual([
            {
                requestDomains: ["s4.anilist.co", "cdn.myanimelist.net", "uploads.mangadex.org"],
                initiatorDomains: ["abcdefghijklmnop"],
                resourceTypes: ["image"]
            },
            {
                urlFilter: "|https://weeb.ltd/api/cover",
                requestDomains: ["weeb.ltd"],
                initiatorDomains: ["abcdefghijklmnop"],
                resourceTypes: ["image"]
            }
        ])
    })

    it("never share a session rule id with the other session rules", () => {
        const others = [imageRefererRule("abcdefghijklmnop").id, clientIdentityRule(["a.example"], "1.0.0", "x").id]
        for (const rule of rules) expect(others).not.toContain(rule.id)
        expect(new Set(rules.map(rule => rule.id)).size).toBe(rules.length)
    })

    it("replace their own rules on every worker start", async () => {
        await applyCoverCookieRules()
        expect(updateSessionRules).toHaveBeenCalledWith({
            removeRuleIds: rules.map(rule => rule.id),
            addRules: coverCookieRules("abcdefghijklmnop")
        })
    })

    it("never throw when the browser refuses the rules", async () => {
        updateSessionRules.mockRejectedValue(new Error("no"))
        vi.spyOn(console, "error").mockImplementation(() => undefined)
        await expect(applyCoverCookieRules()).resolves.toBeUndefined()
    })
})
