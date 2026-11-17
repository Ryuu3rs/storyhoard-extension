import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { chromiumExtension } from "../../src/paths.js"

// The rule that makes the extension's own background requests name themselves. It must exist after a
// worker start and must never reach a request a tab made, or it would change the user's own browsing.

test("the session rules are installed, truthful and limited to the extension's own requests", async () => {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
    })
    try {
        let [worker] = context.serviceWorkers()
        worker ??= await context.waitForEvent("serviceworker")
        await expect
            .poll(() => worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules().then(r => r.length)))
            .toBe(3)
        const rules = await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules())
        const { version } = await worker.evaluate(() => chrome.runtime.getManifest())
        const extensionHost = await worker.evaluate(() => chrome.runtime.id)
        for (const each of rules) expect(each.condition.initiatorDomains).toEqual([extensionHost])
        // Cover images load on the extension's own page, in its tab, so that rule is limited by initiator only.
        const cookie = rules.find(each => each.action.requestHeaders[0].header === "Cookie")
        expect(cookie.action.requestHeaders).toEqual([{ header: "Cookie", operation: "remove" }])
        expect(cookie.condition).toEqual({ initiatorDomains: [extensionHost], resourceTypes: ["image"] })
        for (const each of rules.filter(r => r !== cookie)) expect(each.condition.tabIds).toEqual([-1])
        const rule = rules.find(each => each.action.requestHeaders[0].header === "User-Agent")
        const referer = rules.find(each => each.action.requestHeaders[0].header === "Referer")
        expect(referer.condition.requestDomains).toEqual(["pstatic.net"])
        expect(rule.condition.requestDomains.length).toBeGreaterThan(0)
        expect(rule.action.requestHeaders).toEqual([
            { header: "User-Agent", operation: "set", value: `StoryHoard/${version} (+https://weeb.ltd)` }
        ])
    } finally {
        await context.close()
    }
})
