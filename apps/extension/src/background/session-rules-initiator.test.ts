import { describe, expect, it } from "vitest"
import { imageRefererRule } from "./image-referer"
import { clientIdentityRule } from "./client-identity"
import { coverCookieRules } from "./cover-cookies"

const EXTENSION_HOST = "abcdefghijklmnop"

// A minimal model of how Chrome and Firefox match a declarativeNetRequest rule condition against a
// request (a left-anchored urlFilter, requestDomains, tabIds, resourceTypes, initiatorDomains,
// excludedInitiatorDomains). Only the keys these rules use are modelled.
type Condition = {
    urlFilter?: string
    requestDomains?: readonly string[]
    tabIds?: readonly number[]
    resourceTypes?: readonly string[]
    initiatorDomains?: readonly string[]
    excludedInitiatorDomains?: readonly string[]
}
type Request = { url: string; tabId: number; type: string; initiator: string }

const hostMatches = (host: string, domains: readonly string[]) =>
    domains.some(domain => host === domain || host.endsWith(`.${domain}`))

function matches(condition: Condition, request: Request): boolean {
    const host = new URL(request.url).hostname
    const initiatorHost = new URL(request.initiator).hostname
    if (condition.urlFilter?.startsWith("|") && !request.url.startsWith(condition.urlFilter.slice(1))) return false
    if (condition.requestDomains && !hostMatches(host, condition.requestDomains)) return false
    if (condition.tabIds && !condition.tabIds.includes(request.tabId)) return false
    if (condition.resourceTypes && !condition.resourceTypes.includes(request.type)) return false
    if (condition.initiatorDomains && !hostMatches(initiatorHost, condition.initiatorDomains)) return false
    if (condition.excludedInitiatorDomains && hostMatches(initiatorHost, condition.excludedInitiatorDomains)) {
        return false
    }
    return true
}

// A website's own service worker fetching an image from the same CDN. Browsers report requests made
// by a service worker with tabId -1, exactly like the extension's own background fetches.
const pageServiceWorkerImage: Request = {
    url: "https://blogpfthumb-phinf.pstatic.net/some/photo.jpg",
    tabId: -1,
    type: "xmlhttprequest",
    initiator: "https://blog.example-portal.test"
}

describe("session header rules stay on the extension's own requests", () => {
    it("sanity: the extension's own background image fetch is rewritten", () => {
        const own: Request = { ...pageServiceWorkerImage, initiator: `chrome-extension://${EXTENSION_HOST}` }
        expect(matches(imageRefererRule(EXTENSION_HOST).condition, own)).toBe(true)
    })

    it("the Referer rule does not rewrite a request a website's service worker makes", () => {
        expect(matches(imageRefererRule(EXTENSION_HOST).condition, pageServiceWorkerImage)).toBe(false)
    })

    it("the User-Agent rule does not rewrite an API call a website's service worker makes", () => {
        const rule = clientIdentityRule(["api.official-source.test"], "1.0.0", EXTENSION_HOST)
        const siteWorkerApiCall: Request = {
            url: "https://api.official-source.test/manga?title=x",
            tabId: -1,
            type: "xmlhttprequest",
            initiator: "https://official-source.test"
        }
        expect(matches(rule.condition, siteWorkerApiCall)).toBe(false)
    })

    it("the cover cookie rules reach catalog covers on the extension's page, never a followed site or a website", () => {
        const conditions = coverCookieRules(EXTENSION_HOST, "https://weeb.ltd").map(rule => rule.condition)
        const reached = (request: Request) => conditions.some(condition => matches(condition, request))
        const cover: Request = {
            url: "https://s4.anilist.co/file/c.png",
            tabId: 7,
            type: "image",
            initiator: `chrome-extension://${EXTENSION_HOST}`
        }
        expect(reached(cover)).toBe(true)
        expect(reached({ ...cover, url: "https://weeb.ltd/api/cover?u=a&s=b" })).toBe(true)
        expect(reached({ ...cover, url: "https://weeb.ltd/images/banner.png" })).toBe(false)
        expect(reached({ ...cover, url: "https://img.followed-site.test/c.png" })).toBe(false)
        expect(reached({ ...cover, initiator: "https://reader.example.test" })).toBe(false)
        expect(reached({ ...cover, type: "xmlhttprequest" })).toBe(false)
    })
})
