import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { By, until } from "selenium-webdriver"
import { AddInterceptParameters } from "selenium-webdriver/bidi/addInterceptParameters.js"
import { InterceptPhase } from "selenium-webdriver/bidi/interceptPhase.js"
import { Network } from "selenium-webdriver/bidi/network.js"
import { BytesValue, Header } from "selenium-webdriver/bidi/networkTypes.js"
import { ProvideResponseParameters } from "selenium-webdriver/bidi/provideResponseParameters.js"
import { UrlPattern } from "selenium-webdriver/bidi/urlPattern.js"
import { extensionUuid, grantOrigin, withFirefox } from "./firefox-session.js"

// The Firefox half of detected-panel.test.js: a site with no bundled adapter, no panel until the user
// grants the origin, then the detected panel and a library row. The fixture is served at a made-up host
// through WebDriver BiDi, so no live site is hit. The grant goes through ExtensionPermissions, the same
// store the real permission prompt writes to.

const HOST = "read-demo.net"
const CHAPTER_URL = `https://${HOST}/manga/demo-series/chapter-3`
const PANEL = '#__amr-chapter-prompt__[data-amr-mode="detected"]'
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")
const CHAPTER_HTML = readFileSync(path.join(FIXTURES, "detected-chapter.html"), "utf8")

async function serveFixture(driver) {
    const network = await Network(driver)
    await network.addIntercept(
        new AddInterceptParameters(InterceptPhase.BEFORE_REQUEST_SENT).urlPattern(
            new UrlPattern().protocol("https").hostname(HOST)
        )
    )
    await network.beforeRequestSent(async event => {
        const url = new URL(event.request.url)
        if (url.hostname !== HOST) return
        const image = url.pathname.startsWith("/img/")
        const response = new ProvideResponseParameters(event.request.request)
            .statusCode(200)
            .reasonPhrase("OK")
            .headers([
                new Header(
                    "content-type",
                    new BytesValue(BytesValue.Type.STRING, image ? "image/png" : "text/html; charset=utf-8")
                )
            ])
            .body(
                image
                    ? new BytesValue(BytesValue.Type.BASE64, PNG_BASE64)
                    : new BytesValue(BytesValue.Type.STRING, CHAPTER_HTML)
            )
        await network.provideResponse(response)
    })
}

async function detectedRowIds(driver) {
    await driver.get(`moz-extension://${extensionUuid}/app.html`)
    return driver.executeAsyncScript(
        `const [host, done] = arguments
        const open = indexedDB.open("all-mangas-reader")
        open.onerror = () => done([])
        open.onsuccess = () => {
            const request = open.result.transaction("manga").objectStore("manga").getAllKeys()
            request.onsuccess = () => done(request.result.map(String).filter(key => key.startsWith("detected:" + host + ":manga:")))
            request.onerror = () => done([])
        }`,
        HOST
    )
}

await withFirefox({ bidi: true, systemAccess: true, failureShot: "firefox-detected-failure.png" }, async driver => {
    await serveFixture(driver)

    await driver.get(CHAPTER_URL)
    await driver.sleep(4000)
    assert.equal((await driver.findElements(By.css(PANEL))).length, 0, "panel appeared without the user's grant")
    assert.deepEqual(await detectedRowIds(driver), [], "library row written without the user's grant")
    console.log("PASS no panel and no library row without the grant")

    await grantOrigin(driver, `https://${HOST}`)
    await driver.get(CHAPTER_URL)
    await driver.wait(until.elementLocated(By.css(PANEL)), 15_000)
    console.log("PASS detected panel after the grant")

    const expected = `detected:${HOST}:manga:demo-series`
    let ids = []
    for (let attempt = 0; attempt < 15 && !ids.includes(expected); attempt += 1) {
        await driver.sleep(1000)
        ids = await detectedRowIds(driver)
    }
    assert.deepEqual(ids, [expected])
    console.log(`PASS library row ${expected}`)
})
