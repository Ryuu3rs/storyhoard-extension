import assert from "node:assert/strict"
import { By, until } from "selenium-webdriver"
import { extensionId, extensionUuid, withFirefox } from "./firefox-session.js"

await withFirefox({ failureShot: "firefox-failure.png" }, async (driver, installedId) => {
    assert.equal(installedId, extensionId)

    await driver.get(`moz-extension://${extensionUuid}/popup.html`)
    const heading = await driver.wait(until.elementLocated(By.css("h1")), 15_000)
    assert.equal(await heading.getText(), "StoryHoard")

    // Opened directly, the active tab is not a supported manga page and the library is empty,
    // so the popup shows its empty-library state.
    const emptyState = await driver.wait(
        until.elementLocated(By.xpath("//p[contains(text(), 'Your library is empty.')]")),
        15_000
    )
    assert.ok(await emptyState.isDisplayed())

    // The session rules (the extension's own background requests name themselves, image requests to the
    // WEBTOON CDN carry its Referer, and covers on the extension's pages go without cookies): truthful, and
    // only on the extension's own requests. The header rules never reach a request a tab made.
    const rules = await driver.executeAsyncScript(
        `const done = arguments[arguments.length - 1]
        browser.declarativeNetRequest.getSessionRules().then(done, error => done(String(error)))`
    )
    assert.equal(rules.length, 3)
    for (const rule of rules) assert.deepEqual(rule.condition.initiatorDomains, [extensionUuid])
    const cookie = rules.find(rule => rule.action.requestHeaders[0].header === "Cookie")
    assert.deepEqual(cookie.condition.resourceTypes, ["image"])
    for (const rule of rules.filter(r => r !== cookie)) assert.deepEqual(rule.condition.tabIds, [-1])
    const identity = rules.find(rule => rule.action.requestHeaders[0].header === "User-Agent")
    assert.match(identity.action.requestHeaders[0].value, /^StoryHoard\/\d/)
})
