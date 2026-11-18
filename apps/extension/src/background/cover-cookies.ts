// Catalog covers on the extension's own pages are plain <img> loads, and a browser sends the image host's
// cookies with them. Session rules remove the Cookie header from those images, so a catalog cover tells its
// server the IP address and nothing else. They reach only the catalog cover hosts the extension names
// (cover-crossorigin.ts) and weeb.ltd's own cover route: covers from the sites the user follows keep their
// cookies, because some of those hosts need them. initiatorDomains keeps the rules to the extension's own
// requests: an image a website loads is never changed. Session rules are cleared when the browser closes, so
// this runs on every worker start.

import { SITE_BASE } from "../account"
import { CATALOG_COVER_HOSTS, CATALOG_COVER_PATH } from "../cover-crossorigin"
import { extensionInitiatorHost } from "./client-identity"

export const COVER_COOKIE_RULE_IDS = [3, 4] as const

const removeCookie = {
    type: "modifyHeaders" as const,
    requestHeaders: [{ header: "Cookie", operation: "remove" as const }]
}

export function coverCookieRules(extensionHost: string, siteBase = SITE_BASE) {
    const site = new URL(siteBase)
    return [
        {
            id: COVER_COOKIE_RULE_IDS[0],
            priority: 1,
            action: removeCookie,
            condition: {
                requestDomains: [...CATALOG_COVER_HOSTS],
                initiatorDomains: [extensionHost],
                resourceTypes: ["image" as const]
            }
        },
        {
            id: COVER_COOKIE_RULE_IDS[1],
            priority: 1,
            action: removeCookie,
            condition: {
                urlFilter: `|${site.origin}${CATALOG_COVER_PATH}`,
                requestDomains: [site.hostname],
                initiatorDomains: [extensionHost],
                resourceTypes: ["image" as const]
            }
        }
    ]
}

export async function applyCoverCookieRules(): Promise<void> {
    try {
        await browser.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [...COVER_COOKIE_RULE_IDS],
            addRules: coverCookieRules(extensionInitiatorHost())
        })
    } catch (error) {
        console.error("[AMR] Cover cookie rules failed", error)
    }
}
