import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { By, until } from "selenium-webdriver"
import firefox from "selenium-webdriver/firefox.js"
import LogInspector from "selenium-webdriver/bidi/logInspector.js"
import { artifactsDirectory } from "../../src/paths.js"
import { extensionUuid, withFirefox } from "./firefox-session.js"

// Firefox app journey: first app open, Discover on an empty library with weeb.ltd stubbed, open a rail title,
// add it, Library shows it as planned, Search the web below Official, fast section clicks, the sync permission
// banner once an account token exists, and the community "paused" row. Every http(s) request is answered
// locally one level down (http-on-modify-request), so nothing live is hit.

const SHOTS = process.env.JOURNEY_SHOTS ?? path.join(artifactsDirectory, "journey-shots")
mkdirSync(SHOTS, { recursive: true })
const APP_URL = `moz-extension://${extensionUuid}/app.html`

const item = (anilistId, title) => ({
    anilistId,
    workId: null,
    title,
    altTitles: [],
    cover: `https://s4.anilist.co/file/cover-${anilistId}.png`,
    mediaType: "manhwa",
    genres: ["Action"],
    isAdult: false,
    metric: `${anilistId} readers`
})
const RAILS = {
    trending: { label: "Trending", note: null, items: [item(901, "Rail Title One"), item(902, "Rail Title Two")] },
    seasonal: { label: "Fall 2026", note: null, items: [item(903, "Season Title")] },
    staff: { label: "Staff picks", note: null, items: [] },
    community: { label: "Community picks", note: "This week's vote", items: [item(904, "Voted Title")] }
}
const OFFERS = { best: { name: "Official Store", format: "Digital", outUrl: "https://weeb.ltd/out/test" } }
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

async function serveEverything(driver) {
    await driver.setContext(firefox.Context.CHROME)
    await driver.executeScript(
        `const [rails, offers, png] = arguments
        const { classes: Cc, interfaces: Ci } = Components
        Services.obs.addObserver(
            {
                observe(subject) {
                    const channel = subject.QueryInterface(Ci.nsIHttpChannel)
                    const uri = channel.URI
                    if (uri.scheme !== "http" && uri.scheme !== "https") return
                    let status = 404, type = "application/json", body = "{}"
                    if (uri.host === "weeb.ltd" && uri.filePath === "/api/public/discover") {
                        const rail = new URLSearchParams(uri.query).get("rail")
                        status = 200
                        body = JSON.stringify({ rail, genre: null, ...(rails[rail] ?? { label: rail, items: [] }) })
                    } else if (uri.host === "weeb.ltd" && /^\\/api\\/work\\/[^/]+\\/offers$/.test(uri.filePath)) {
                        status = 200
                        body = JSON.stringify(offers)
                    } else if (uri.host === "s4.anilist.co") {
                        status = 200
                        type = "image/png"
                        body = atob(png)
                    }
                    const response = Cc["@mozilla.org/network/replaced-http-response;1"].createInstance(Ci.nsIReplacedHttpResponse)
                    response.responseStatus = status
                    response.responseStatusText = status === 200 ? "OK" : "Not Found"
                    response.responseBody = body
                    response.setResponseHeader("content-type", type, false)
                    channel.QueryInterface(Ci.nsIHttpChannelInternal).setResponseOverride(response)
                }
            },
            "http-on-modify-request"
        )`,
        RAILS,
        OFFERS,
        PNG_BASE64
    )
    await driver.setContext(firefox.Context.CONTENT)
}

const shot = async (driver, name) =>
    writeFileSync(path.join(SHOTS, `firefox-app-${name}.png`), await driver.takeScreenshot(), "base64")
const button = text => By.xpath(`//button[contains(normalize-space(), ${JSON.stringify(text)})]`)
const textOf = driver => driver.executeScript("return document.querySelector('main')?.innerText ?? ''")
const storageSet = (driver, value) =>
    driver.executeAsyncScript(
        `const [value, done] = arguments
        browser.storage.local.set(value).then(() => done(true), e => done(String(e)))`,
        value
    )

const results = []
const errors = []
const check = (ok, label, detail = "") => {
    results.push(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`)
}

await withFirefox({ bidi: true, systemAccess: true, failureShot: "firefox-app-failure.png" }, async driver => {
    const logs = await LogInspector(driver)
    await logs.onConsoleEntry(entry => {
        if (entry.level === "error" || entry.level === "warn") errors.push(`console.${entry.level}: ${entry.text}`)
    })
    await logs.onJavascriptException(entry => errors.push(`exception: ${entry.text}`))
    await serveEverything(driver)

    await driver.get(APP_URL)
    await driver.sleep(2500)
    await shot(driver, "01-first-open")
    const notice = await driver.findElements(By.css("[aria-label='Usage analytics notice']"))
    const dataGranted = await driver.executeAsyncScript(
        `const done = arguments[0]
            browser.permissions.contains({ data_collection: ["technicalAndInteraction"] }).then(done, e => done(String(e)))`
    )
    check(
        true,
        "first open",
        `usage notice shown: ${notice.length > 0}, technicalAndInteraction granted: ${dataGranted}`
    )

    const trending = await driver.findElements(
        By.xpath(
            "//*[contains(@class,'weeb-discover-main')]//h3[normalize-space()='Trending'] | //*[contains(@class,'weeb-discover-main')]//*[normalize-space()='Trending']"
        )
    )
    check(trending.length > 0, "Discover rails on an empty library")
    await (await driver.wait(until.elementLocated(button("Rail Title One")), 10_000)).click()
    await driver.wait(until.elementLocated(By.css(".title-hero-name")), 10_000)
    await (await driver.wait(until.elementLocated(button("Add to library")), 10_000)).click()
    await driver.wait(until.elementLocated(button("In your library")), 10_000)
    const official = await driver.findElements(By.css(".where-official"))
    const web = await driver.findElements(button("Search the web"))
    let below = false
    if (official.length && web.length) {
        const o = await official[0].getRect()
        const w = await web[0].getRect()
        below = w.y > o.y + o.height
    }
    check(official.length > 0 && web.length > 0 && below, "Search the web below Official")
    const fonts = await driver.executeScript(
        `const size = selector => getComputedStyle(document.querySelector(selector)).fontSize
        return { body: size("body"), row: size(".where-row"), site: size(".where-site") }`
    )
    check(
        fonts.body === "12px" && fonts.row === "12px" && fonts.site === "12px",
        "body type matches Chrome",
        JSON.stringify(fonts)
    )
    await shot(driver, "02-title")
    await (await driver.findElement(button("← Discover"))).click()
    await driver.sleep(500)

    await (await driver.findElement(By.xpath("//nav//button[.//span[normalize-space()='Library']]"))).click()
    await driver.sleep(800)
    const allChip = await driver.findElements(
        By.xpath(
            "//*[contains(@class,'filter-chips')]//*[contains(@class,'chip')][starts-with(normalize-space(),'All')]"
        )
    )
    if (allChip.length) await allChip[0].click()
    await driver.sleep(500)
    const libText = await textOf(driver)
    check(/Rail Title One[\s\S]*Planning/.test(libText), "Library shows the title as Planning")
    const sortFont = await driver.executeScript(
        `return getComputedStyle(document.querySelector("select[aria-label='Sort library']")).fontSize`
    )
    check(sortFont === "13px", "Library sort select uses the app's select style", sortFont)
    await shot(driver, "03-library")

    for (const s of ["Discover", "Library", "Activity", "Stats", "Sources", "Data", "Settings", "Discover", "Stats"]) {
        await (
            await driver.findElement(
                By.xpath(`//nav[@aria-label='Main navigation']//button[.//span[normalize-space()='${s}']]`)
            )
        ).click()
    }
    await driver.sleep(2000)
    await shot(driver, "04-after-fast-nav")

    await storageSet(driver, {
        account: { token: "test_token", lastPushAt: 0, lastSyncAt: 0, invalid: false, autoSync: false }
    })
    await driver.navigate().refresh()
    await driver.sleep(2000)
    const banner = await driver.findElements(
        By.xpath("//strong[normalize-space()='Firefox needs your permission to sync']")
    )
    check(banner.length > 0, "sync permission banner with an account token")
    await shot(driver, "05-sync-banner")

    await storageSet(driver, {
        community: {
            enabled: true,
            userId: "user-1",
            username: "tester",
            secret: "s",
            lastSyncAt: 0,
            consentVersion: 999,
            consentAt: 1,
            declined: false
        }
    })
    await driver.navigate().refresh()
    await driver.sleep(1500)
    await (
        await driver.findElement(
            By.xpath("//nav[@aria-label='Main navigation']//button[.//span[normalize-space()='Settings']]")
        )
    ).click()
    await driver.sleep(800)
    const privacyTab = await driver.findElements(button("Privacy & community"))
    if (privacyTab.length) await privacyTab[0].click()
    await driver.sleep(800)
    const paused = await driver.findElements(By.xpath("//p[normalize-space()='Community features are paused']"))
    const pausedVisible = paused.length ? await paused[0].isDisplayed() : false
    check(pausedVisible, "community paused row")
    await shot(driver, "06-community-paused")
}).catch(error => {
    results.push(`FAIL script error: ${error.message}`)
})

console.log(results.join("\n"))
console.log("ERRORS:\n" + errors.join("\n"))
if (results.some(r => r.startsWith("FAIL"))) process.exitCode = 1
