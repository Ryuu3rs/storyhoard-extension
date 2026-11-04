import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { chromiumExtension } from "../../src/paths.js"

// The rule that makes the extension's own background requests name themselves. It must exist after a
// worker start and must never reach a request a tab made, or it would change the user's own browsing.

test("the identity rule is installed, truthful and limited to requests no tab made", async () => {
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
            .toBe(1)
        const [rule] = await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules())
        const { version } = await worker.evaluate(() => chrome.runtime.getManifest())
        expect(rule.condition.tabIds).toEqual([-1])
        expect(rule.condition.requestDomains.length).toBeGreaterThan(0)
        expect(rule.action.requestHeaders).toEqual([
            { header: "User-Agent", operation: "set", value: `StoryHoard/${version} (+https://weeb.ltd)` }
        ])
    } finally {
        await context.close()
    }
})
