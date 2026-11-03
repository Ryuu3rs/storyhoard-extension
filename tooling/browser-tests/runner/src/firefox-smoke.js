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

    // The rule that makes the extension's own background requests name themselves: truthful, and never
    // on a request a tab made.
    const rules = await driver.executeAsyncScript(
        `const done = arguments[arguments.length - 1]
        browser.declarativeNetRequest.getSessionRules().then(done, error => done(String(error)))`
    )
    assert.equal(rules.length, 1)
    assert.deepEqual(rules[0].condition.tabIds, [-1])
    assert.match(rules[0].action.requestHeaders[0].value, /^StoryHoard\/\d/)
})
