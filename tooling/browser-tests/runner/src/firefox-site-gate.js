import assert from "node:assert/strict"
import { By, until } from "selenium-webdriver"
import { HOST, ORIGIN, SERIES_URL, TITLE, libraryEnvelope, startGatedSite } from "./fixtures/gated-site.js"
import { extensionUuid, grantOrigin, withFirefox } from "./firefox-session.js"

// The Firefox half of site-gate.test.js: a real update check from the background page hits a challenge at
// a made-up site served from this machine, and the app shows a prompt that names no site. The browser
// reaches that one host through a local proxy that refuses to connect anywhere else, so no live site is
// hit, and the site can see whether the browser really attached a cookie.

const APP_URL = `moz-extension://${extensionUuid}/app.html`
const PROMPT = "[data-site-gate]"

const send = (driver, message) =>
    driver.executeAsyncScript(
        `const [m, done] = arguments
        browser.runtime.sendMessage(m).then(done, error => done({ ok: false, error: String(error) }))`,
        message
    )

async function runCheck(driver) {
    const before = (await send(driver, { type: "updates:get" })).data?.checkedAt ?? 0
    assert.equal((await send(driver, { type: "updates:check" })).ok, true)
    for (let attempt = 0; attempt < 40; attempt += 1) {
        await driver.sleep(500)
        const { data } = await send(driver, { type: "updates:get" })
        if ((data?.checkedAt ?? 0) > before) return data
    }
    throw new Error("The update check did not finish")
}

async function openUpdates(driver) {
    await driver.get(APP_URL)
    const nav = await driver.wait(
        until.elementLocated(By.xpath("//nav[@aria-label='Main navigation']//button[contains(., 'Activity')]")),
        15_000
    )
    await nav.click()
}

const fromChecks = requests => requests.filter(request => !request.inTab && request.path.startsWith("/manga/"))

const site = await startGatedSite()
try {
    await withFirefox(
        {
            systemAccess: true,
            insecureCerts: true,
            preferences: {
                "network.proxy.type": 1,
                "network.proxy.ssl": "127.0.0.1",
                "network.proxy.ssl_port": site.proxyPort
            },
            failureShot: "firefox-site-gate-failure.png"
        },
        async driver => {
            await grantOrigin(driver, ORIGIN)
            await driver.get(APP_URL)
            const imported = await send(driver, { type: "data:import", envelope: libraryEnvelope() })
            assert.equal(imported.ok, true, JSON.stringify(imported))

            const status = await runCheck(driver)
            assert.ok(fromChecks(site.requests).length > 0, "the check never reached the made-up site")
            assert.equal(status.failed, 0)
            assert.deepEqual(status.needsVerify, [
                { origin: ORIGIN, sourceId: HOST, count: 1, openUrl: SERIES_URL, sampleTitle: TITLE }
            ])
            assert.deepEqual(status.causesBySource, { [HOST]: { challenge: 1 } })
            console.log("PASS a challenge lands in the needs-verify bucket with its cause")

            await openUpdates(driver)
            const prompt = await driver.wait(until.elementLocated(By.css(PROMPT)), 15_000)
            const text = (await prompt.getText()).toLowerCase()
            const markup = String(await prompt.getAttribute("innerHTML")).toLowerCase()
            assert.ok(text.includes("open the site first"), text)
            assert.ok(text.includes(TITLE.toLowerCase()), text)
            for (const content of [text, markup]) {
                assert.ok(!content.includes(HOST), "the prompt names the site")
                assert.ok(!content.includes("gated demo"), "the prompt names the site")
                assert.ok(!content.includes("https://"), "the prompt carries an address")
            }
            console.log("PASS the prompt shows and names no site")

            const appWindow = await driver.getWindowHandle()
            const before = (await driver.getAllWindowHandles()).length
            await driver.findElement(By.css("[data-site-gate-open]")).click()
            await driver.wait(async () => (await driver.getAllWindowHandles()).length > before, 10_000)
            const handles = await driver.getAllWindowHandles()
            await driver.switchTo().window(handles.find(handle => handle !== appWindow))
            await driver.wait(async () => (await driver.getCurrentUrl()) === SERIES_URL, 10_000)
            await driver.wait(() => site.requests.some(request => request.inTab), 10_000)
            await driver.close()
            await driver.switchTo().window(appWindow)
            console.log("PASS its button opens the title's page")

            const stillGated = await runCheck(driver)
            assert.ok(fromChecks(site.requests).every(request => !request.hasCookie))
            assert.equal(stillGated.needsVerify.length, 1)
            console.log("PASS holding the cookie changes nothing until the user chooses")

            const box = await driver.findElement(By.css(`${PROMPT} input[type="checkbox"]`))
            assert.equal(await box.isSelected(), false)
            await box.click()
            await driver.wait(async () => (await send(driver, { type: "site-session:list" })).data[0]?.enabled, 5000)

            const passed = await runCheck(driver)
            const sent = fromChecks(site.requests).at(-1)
            assert.equal(sent.hasCookie, true, "the browser did not attach the cookie to the background request")
            assert.equal(sent.method, "GET")
            assert.deepEqual(passed.needsVerify, [])
            assert.equal(passed.checked, 1)
            console.log("PASS once chosen the session reaches the site and the check passes")

            const turnOff = await driver.wait(until.elementLocated(By.css("[data-site-sessions] button")), 10_000)
            await turnOff.click()
            await driver.wait(async () => !(await send(driver, { type: "site-session:list" })).data[0]?.enabled, 5000)
            const afterRevoke = site.requests.length
            const revoked = await runCheck(driver)
            const since = fromChecks(site.requests.slice(afterRevoke))
            assert.ok(since.length > 0)
            assert.ok(since.every(request => !request.hasCookie))
            assert.equal(revoked.needsVerify.length, 1)
            console.log("PASS turning it off goes back to cookieless")
        }
    )
} finally {
    await site.close()
}
