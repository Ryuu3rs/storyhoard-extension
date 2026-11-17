import { sourceRegistry } from "@amr/sources"

// Some APIs require a client to identify itself and reject a spoofed or browser-shaped User-Agent. A
// browser will not let a service worker's fetch set that header, so a session rule sets it below fetch.
// tabIds [-1] keeps the rule off the user's own pages and initiatorDomains keeps it off a website's own
// service worker, so only the extension's requests are changed. Session rules are cleared when the
// browser closes, so this runs on every worker start.

const RULE_ID = 1

export function clientUserAgent(version: string): string {
    return `StoryHoard/${version} (+https://weeb.ltd)`
}

export function identifiedHosts(): string[] {
    return [...new Set(sourceRegistry.list().flatMap(adapter => adapter.manifest.identifiedRequestHosts ?? []))]
}

// The host of the extension's own origin: the extension id on Chrome, the per-install UUID on Firefox. Both
// browsers report it as the initiator of requests the extension's pages and worker make.
export function extensionInitiatorHost(): string {
    return new URL(browser.runtime.getURL("/")).hostname
}

export function clientIdentityRule(hosts: string[], version: string, extensionHost: string) {
    return {
        id: RULE_ID,
        priority: 1,
        action: {
            type: "modifyHeaders" as const,
            requestHeaders: [{ header: "User-Agent", operation: "set" as const, value: clientUserAgent(version) }]
        },
        condition: {
            requestDomains: hosts,
            initiatorDomains: [extensionHost],
            tabIds: [-1],
            resourceTypes: ["xmlhttprequest" as const]
        }
    }
}

export async function applyClientIdentityRule(): Promise<void> {
    try {
        const hosts = identifiedHosts()
        await browser.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [RULE_ID],
            addRules: hosts.length
                ? [clientIdentityRule(hosts, browser.runtime.getManifest().version, extensionInitiatorHost())]
                : []
        })
    } catch (error) {
        console.error("[AMR] Client identity rule failed", error)
    }
}
