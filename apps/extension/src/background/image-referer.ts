// The WEBTOON image CDN only serves page images to requests that name the WEBTOON site as Referer, which
// a fetch cannot set. A session rule sets it below fetch, for requests no tab made (tabIds [-1]) only, so
// the user's own visits to anything on that CDN are never changed. Session rules are cleared when the
// browser closes, so this runs on every worker start.

const RULE_ID = 2

export const imageRefererRule = {
    id: RULE_ID,
    priority: 1,
    action: {
        type: "modifyHeaders" as const,
        requestHeaders: [{ header: "Referer", operation: "set" as const, value: "https://www.webtoons.com" }]
    },
    condition: {
        requestDomains: ["pstatic.net"],
        tabIds: [-1],
        resourceTypes: ["image" as const, "media" as const, "xmlhttprequest" as const, "other" as const]
    }
}

export async function applyImageRefererRule(): Promise<void> {
    try {
        await browser.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [RULE_ID],
            addRules: [imageRefererRule]
        })
    } catch (error) {
        console.error("[AMR] Image referer rule failed", error)
    }
}
