import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { By, until } from "selenium-webdriver"
import firefox from "selenium-webdriver/firefox.js"
import { artifactsDirectory } from "../../src/paths.js"
import { extensionUuid, withFirefox } from "./firefox-session.js"

// Firefox "Finish update" journey: AMO (stubbed) says a newer version has been public for three
// days, so the app shows the banner; Finish update opens the AMO listing; Not now hides it for that
// version across reloads; a version published an hour ago shows nothing. Every http(s) request is
// answered locally, so nothing live is hit.

const SHOTS = process.env.JOURNEY_SHOTS ?? path.join(artifactsDirectory, "journey-shots")
mkdirSync(SHOTS, { recursive: true })
const APP_URL = `moz-extension://${extensionUuid}/app.html`
const LISTING = "https://addons.mozilla.org/firefox/addon/storyhoard/"
const PUBLISHED = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()

async function serveAmo(driver) {
    await driver.setContext(firefox.Context.CHROME)
    await driver.executeScript(
        `const [published] = arguments
        const { classes: Cc, interfaces: Ci } = Components
        Services.obs.addObserver(
            {
                observe(subject) {
                    const channel = subject.QueryInterface(Ci.nsIHttpChannel)
                    const uri = channel.URI
                    if (uri.scheme !== "http" && uri.scheme !== "https") return
                    let status = 404, type = "application/json", body = "{}"
                    if (uri.host === "addons.mozilla.org" && uri.filePath.startsWith("/api/v5/addons/addon/")) {
                        status = 200
                        body = JSON.stringify({ current_version: { version: "9.9.9", file: { created: published } } })
                    } else if (uri.host === "addons.mozilla.org") {
                        status = 200
                        type = "text/html"
                        body = "<title>StoryHoard listing</title><h1>listing</h1>"
                    }
                    const response = Cc["@mozilla.org/network/replaced-http-response;1"].createInstance(Ci.nsIReplacedHttpResponse)
                    response.responseStatus = status
                    response.responseStatusText = status === 200 ? "OK" : "Not Found"
                    response.responseBody = body
                    response.setResponseHeader("content-type", type, false)
                    response.setResponseHeader("access-control-allow-origin", "*", false)
                    channel.QueryInterface(Ci.nsIHttpChannelInternal).setResponseOverride(response)
                }
            },
            "http-on-modify-request"
        )`,
        PUBLISHED
    )
    await driver.setContext(firefox.Context.CONTENT)
}

const shot = async (driver, name) =>
    writeFileSync(path.join(SHOTS, `firefox-update-nudge-${name}.png`), await driver.takeScreenshot(), "base64")
const button = text => By.xpath(`//button[contains(normalize-space(), ${JSON.stringify(text)})]`)
const nudge = By.css("[data-testid='firefox-update-nudge']")
const storageSet = (driver, value) =>
    driver.executeAsyncScript(
        `const [value, done] = arguments
        browser.storage.local.set(value).then(() => done(true), e => done(String(e)))`,
        value
    )

const results = []
const check = (ok, label, detail = "") =>
    results.push(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`)

await withFirefox({ systemAccess: true, failureShot: "firefox-update-nudge-failure.png" }, async driver => {
    await serveAmo(driver)
    await driver.get(APP_URL)
    const banner = await driver.wait(until.elementLocated(nudge), 15_000)
    const text = await banner.getText()
    check(/v9\.9\.9/.test(text) && /waiting for you to approve it/.test(text), "banner names the waiting version", text)
    await shot(driver, "01-banner")

    const appWindow = await driver.getWindowHandle()
    await (await driver.findElement(button("Finish update"))).click()
    await driver.wait(async () => (await driver.getAllWindowHandles()).length > 1, 10_000)
    const listingWindow = (await driver.getAllWindowHandles()).find(handle => handle !== appWindow)
    await driver.switchTo().window(listingWindow)
    await driver.wait(async () => (await driver.getCurrentUrl()) === LISTING, 10_000).catch(() => {})
    const opened = await driver.getCurrentUrl()
    check(opened === LISTING, "Finish update opens the AMO listing", opened)
    await driver.close()
    await driver.switchTo().window(appWindow)

    await (await driver.findElement(button("Not now"))).click()
    await driver.sleep(300)
    check((await driver.findElements(nudge)).length === 0, "Not now hides the banner")
    await driver.navigate().refresh()
    await driver.sleep(2500)
    check((await driver.findElements(nudge)).length === 0, "Not now holds across a reload for that version")
    await shot(driver, "02-dismissed")

    await storageSet(driver, {
        firefoxUpdateDismissedVersion: null,
        extensionUpdate: {
            store: "amo",
            available: true,
            latestVersion: "9.9.10",
            publishedAt: Date.now() - 60 * 60 * 1000,
            releaseUrl: LISTING,
            checkedAt: Date.now()
        }
    })
    await driver.navigate().refresh()
    await driver.sleep(2500)
    check((await driver.findElements(nudge)).length === 0, "a version published an hour ago shows nothing")
}).catch(error => {
    results.push(`FAIL script error: ${error.message}`)
})

console.log(results.join("\n"))
if (results.some(r => r.startsWith("FAIL"))) process.exitCode = 1
