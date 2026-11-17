// The WEBTOON image CDN only serves page images to requests that name the WEBTOON site as Referer, which
// a fetch cannot set. A session rule sets it below fetch, only for requests the extension itself made: no
// tab (tabIds [-1]) and the extension's own origin as initiator, so neither the user's visits nor a
// website's own service worker on that CDN are changed. Session rules are cleared when the browser
// closes, so this runs on every worker start.

import { extensionInitiatorHost } from "./client-identity"

const RULE_ID = 2

export function imageRefererRule(extensionHost: string) {
    return {
        id: RULE_ID,
        priority: 1,
        action: {
            type: "modifyHeaders" as const,
            requestHeaders: [{ header: "Referer", operation: "set" as const, value: "https://www.webtoons.com" }]
        },
        condition: {
            requestDomains: ["pstatic.net"],
            initiatorDomains: [extensionHost],
            tabIds: [-1],
            resourceTypes: ["image" as const, "media" as const, "xmlhttprequest" as const, "other" as const]
        }
    }
}

export async function applyImageRefererRule(): Promise<void> {
    try {
        await browser.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [RULE_ID],
            addRules: [imageRefererRule(extensionInitiatorHost())]
        })
    } catch (error) {
        console.error("[AMR] Image referer rule failed", error)
    }
}
