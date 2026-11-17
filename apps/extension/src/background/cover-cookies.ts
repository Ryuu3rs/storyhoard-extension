// Cover images on the extension's own pages are plain <img> loads, and a browser sends the image host's
// cookies with them. A session rule removes the Cookie header from images the extension's pages load, so a
// cover tells its server the IP address and nothing else. initiatorDomains keeps it to the extension's own
// requests: an image a website loads is never changed. Session rules are cleared when the browser closes,
// so this runs on every worker start.

import { extensionInitiatorHost } from "./client-identity"

const RULE_ID = 3

export function coverCookieRule(extensionHost: string) {
    return {
        id: RULE_ID,
        priority: 1,
        action: {
            type: "modifyHeaders" as const,
            requestHeaders: [{ header: "Cookie", operation: "remove" as const }]
        },
        condition: {
            initiatorDomains: [extensionHost],
            resourceTypes: ["image" as const]
        }
    }
}

export async function applyCoverCookieRule(): Promise<void> {
    try {
        await browser.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [RULE_ID],
            addRules: [coverCookieRule(extensionInitiatorHost())]
        })
    } catch (error) {
        console.error("[AMR] Cover cookie rule failed", error)
    }
}
