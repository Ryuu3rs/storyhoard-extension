import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { By, until } from "selenium-webdriver"
import firefox from "selenium-webdriver/firefox.js"
import { seriesPage } from "./fixtures/detected-list.js"
import { extensionId, extensionUuid, withFirefox } from "./firefox-session.js"

// The Firefox half of detected-updater.test.js: press Track on the real panel of a site with no adapter,
// then the real update check reads the title's chapters from its own page. The site is a made-up host with
// no DNS record, so nothing live can be hit.

const HOST = "read-demo.net"
const CHAPTER_URL = `https://${HOST}/manga/demo-series/chapter-3`
const SOURCE_ID = HOST
const MANGA_ID = `${SOURCE_ID}:manga:demo-series`
const DETECTED_ID = `detected:${HOST}:manga:demo-series`
const PANEL = "#__amr-chapter-prompt__"
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")
const CHAPTER_HTML = readFileSync(path.join(FIXTURES, "detected-chapter.html"), "utf8")
const APP_URL = `moz-extension://${extensionUuid}/app.html`

const TITLE_PAGE_PREF = "amr.test.titlePage"
const TITLE_PAGE_REQUESTS_PREF = "amr.test.titlePageRequests"

// BiDi only sees requests from tabs, and the update check fetches from the extension's background, so the
// site is served one level down, where every channel passes and which is what BiDi's own provideResponse uses.
async function serveSite(driver) {
    await driver.setContext(firefox.Context.CHROME)
    await driver.executeScript(
        `const [host, chapterHtml, pngBase64, titlePref, countPref] = arguments
        const { classes: Cc, interfaces: Ci } = Components
        Services.prefs.setIntPref(countPref, 0)
        Services.obs.addObserver(
            {
                observe(subject) {
                    const channel = subject.QueryInterface(Ci.nsIHttpChannel)
                    if (channel.URI.host !== host) return
                    const pathname = channel.URI.filePath
                    const image = pathname.startsWith("/img/")
                    const titlePage = pathname === "/manga/demo-series" || pathname === "/manga/demo-series/"
                    if (titlePage) Services.prefs.setIntPref(countPref, Services.prefs.getIntPref(countPref) + 1)
                    const response = Cc["@mozilla.org/network/replaced-http-response;1"].createInstance(
                        Ci.nsIReplacedHttpResponse
                    )
                    response.responseStatus = 200
                    response.responseStatusText = "OK"
                    response.responseBody = image
                        ? atob(pngBase64)
                        : titlePage
                          ? Services.prefs.getStringPref(titlePref)
                          : chapterHtml
                    response.setResponseHeader("content-type", image ? "image/png" : "text/html; charset=utf-8", false)
                    channel.QueryInterface(Ci.nsIHttpChannelInternal).setResponseOverride(response)
                }
            },
            "http-on-modify-request"
        )`,
        HOST,
        CHAPTER_HTML,
        PNG_BASE64,
        TITLE_PAGE_PREF,
        TITLE_PAGE_REQUESTS_PREF
    )
    await driver.setContext(firefox.Context.CONTENT)
}

async function setTitlePage(driver, html) {
    await driver.setContext(firefox.Context.CHROME)
    await driver.executeScript(`Services.prefs.setStringPref(arguments[0], arguments[1])`, TITLE_PAGE_PREF, html)
    await driver.setContext(firefox.Context.CONTENT)
}

async function titlePageRequests(driver) {
    await driver.setContext(firefox.Context.CHROME)
    const count = await driver.executeScript(`return Services.prefs.getIntPref(arguments[0])`, TITLE_PAGE_REQUESTS_PREF)
    await driver.setContext(firefox.Context.CONTENT)
    return count
}

async function grantOrigin(driver) {
    await driver.setContext(firefox.Context.CHROME)
    await driver.executeAsyncScript(
        `const [id, origin, done] = arguments
        const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs")
        const { extension } = WebExtensionPolicy.getByID(id)
        ExtensionPermissions.add(id, { permissions: [], origins: [origin] }, extension).then(() => done())`,
        extensionId,
        `https://${HOST}/*`
    )
    await driver.setContext(firefox.Context.CONTENT)
}

// A real check, from a background that has just been woken: added sites must have re-registered from
// storage, and the short-lived response cache is gone, which would otherwise answer a second check inside a
// minute with the page the first one saw.
async function restartBackground(driver) {
    await driver.setContext(firefox.Context.CHROME)
    await driver.executeAsyncScript(
        `const [id, done] = arguments
        Promise.resolve(WebExtensionPolicy.getByID(id).extension.terminateBackground()).then(() => done())`,
        extensionId
    )
    await driver.setContext(firefox.Context.CONTENT)
}

function readLibrary(driver) {
    return driver.executeAsyncScript(
        `const done = arguments[0]
        const open = indexedDB.open("all-mangas-reader")
        open.onerror = () => done(null)
        open.onsuccess = async () => {
            const db = open.result
            const read = store =>
                new Promise((resolve, reject) => {
                    const request = db.transaction(store).objectStore(store).getAll()
                    request.onsuccess = () => resolve(request.result)
                    request.onerror = () => reject(request.error)
                })
            const [manga, chapters, progress, profiles] = await Promise.all(
                ["manga", "chapters", "progress", "archProfiles"].map(read)
            )
            db.close()
            const sortKey = c => (Number.isFinite(c.sortKey) ? c.sortKey : -1)
            done({
                manga: manga.map(m => ({
                    id: m.id,
                    latest: m.latestChapterNumber ?? null,
                    lastRead: m.lastReadChapterNumber ?? null,
                    lastReadChapterId: m.lastReadChapterId ?? null
                })),
                chapters: chapters.map(c => ({ id: c.id, mangaId: c.mangaId, sortKey: sortKey(c) })),
                progress: progress.map(p => p.mangaId),
                profiles: profiles.map(p => p.id)
            })
        }`
    )
}

async function waitFor(check, what) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const value = await check()
        if (value) return value
        await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error(`Timed out waiting for ${what}`)
}

async function runUpdateCheck(driver) {
    await restartBackground(driver)
    await driver.get(APP_URL)
    const lastStatus = () =>
        driver.executeAsyncScript(
            `const done = arguments[0]
            browser.storage.local.get("updateStatus").then(s => done(s.updateStatus ?? null))`
        )
    const before = (await lastStatus())?.checkedAt
    await waitFor(
        () =>
            driver.executeAsyncScript(
                `const done = arguments[0]
                browser.runtime.sendMessage({ type: "updates:check" }).then(
                    reply => done(reply?.data?.started === true),
                    () => done(false)
                )`
            ),
        "the update check to start"
    )
    return waitFor(async () => {
        const status = await lastStatus()
        return status && status.checkedAt !== before ? status : undefined
    }, "the update check to finish")
}

await withFirefox({ systemAccess: true, failureShot: "firefox-updater-failure.png" }, async driver => {
    await serveSite(driver)
    await setTitlePage(driver, seriesPage(HOST, 5))
    await grantOrigin(driver)

    await driver.get(CHAPTER_URL)
    const panel = await driver.wait(until.elementLocated(By.css(`${PANEL}[data-amr-mode="detected"]`)), 15_000)
    console.log("PASS detected panel on the granted page")
    await driver.switchTo().newWindow("tab")
    await driver.get(APP_URL)
    await waitFor(async () => (await readLibrary(driver))?.manga.some(m => m.id === DETECTED_ID), "the detected row")
    await driver.close()
    await driver.switchTo().window((await driver.getAllWindowHandles())[0])
    console.log("PASS detected row recorded")

    const shadow = await panel.getShadowRoot()
    await (await shadow.findElement(By.css(".handle"))).click()
    const buttons = await shadow.findElements(By.css("button"))
    let track
    for (const button of buttons) {
        if ((await button.getText()) === "Track this site") track = button
    }
    assert.ok(track, "the panel offers Track this site")
    await driver.wait(until.elementIsVisible(track), 5_000)
    await track.click()
    await driver.wait(until.elementLocated(By.css(`${PANEL}[data-amr-mode="followed"]`)), 20_000)
    console.log("PASS Track moved the panel to followed")

    // No visit may overlap the checks: the panel's own background refresh of a list would absorb the new
    // chapter this test is about to add.
    await driver.get(APP_URL)
    const followed = await readLibrary(driver)
    assert.deepEqual(
        followed.manga.map(m => m.id),
        [MANGA_ID]
    )
    assert.deepEqual(followed.profiles, [SOURCE_ID])
    assert.deepEqual(followed.progress, [MANGA_ID])
    assert.equal(followed.manga[0].lastRead, 3)
    console.log("PASS one library row after Track, progress carried over")

    const baseline = await runUpdateCheck(driver)
    assert.equal(baseline.checked, 1)
    assert.equal(baseline.failed, 0)
    assert.equal(baseline.updated, 0)
    assert.deepEqual(baseline.emptyLists, {})
    assert.ok((await titlePageRequests(driver)) > 0, "the list page was requested")
    const listed = await readLibrary(driver)
    assert.deepEqual(
        listed.chapters.map(c => c.sortKey).sort((a, b) => a - b),
        [1, 2, 3, 4, 5]
    )
    assert.ok(listed.chapters.every(c => c.mangaId === MANGA_ID))
    assert.equal(listed.manga[0].latest, 5)
    assert.equal(listed.manga[0].lastRead, 3)
    assert.equal(listed.chapters.find(c => c.id === listed.manga[0].lastReadChapterId)?.sortKey, 3)
    console.log("PASS the first check took the title's chapters from its page, none of them announced as new")

    await setTitlePage(driver, seriesPage(HOST, 6))
    const oneNew = await runUpdateCheck(driver)
    assert.equal(oneNew.updated, 1)
    assert.equal(oneNew.failed, 0)
    const after = await readLibrary(driver)
    assert.equal(after.manga[0].latest, 6)
    assert.equal(after.chapters.length, 6)
    console.log("PASS one more chapter on the page is exactly 1 new")

    const none = await runUpdateCheck(driver)
    assert.equal(none.updated, 0)
    assert.equal(none.failed, 0)
    console.log("PASS the next check finds 0 new")

    await setTitlePage(
        driver,
        "<!doctype html><html><head><title>Maintenance</title></head><body>Back soon</body></html>"
    )
    const empty = await runUpdateCheck(driver)
    assert.equal(empty.updated, 0)
    assert.deepEqual(empty.emptyLists, { [SOURCE_ID]: 1 })
    assert.equal((await readLibrary(driver)).manga[0].latest, 6)
    console.log("PASS a page that stops listing chapters is reported, not read as nothing new")
})
