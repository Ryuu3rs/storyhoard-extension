import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromiumExtension } from "../../src/paths.js"
import { addSiteFromPopup } from "./toolbar-popup.js"

// A title read on a detected site is tracked under the site's observe-only source. Adding the site moves the
// title to the added source, but the observe-only source stayed on the Sources page as a second row with
// "0 titles" and kept first place above the site the user just added, because its ranking row and its place
// in the order were left behind. After the add there is one row, the added site's, holding the title.
// The site is a made-up host served through route interception; the host grant is written into a temp copy
// of the manifest, as in followed-site.test.js.

const HOST = "ghost-demo.net"
const CHAPTER_URL = `https://${HOST}/manga/demo-series/chapter-3`
const DETECTED = '#__amr-chapter-prompt__[data-amr-mode="detected"]'
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64"
)
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")
const CHAPTER_HTML = readFileSync(path.join(FIXTURES, "detected-chapter.html"), "utf8")

function buildWithGrant() {
    const directory = mkdtempSync(path.join(tmpdir(), "amr-added-row-"))
    cpSync(chromiumExtension, directory, { recursive: true })
    const manifestPath = path.join(directory, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    manifest.host_permissions = [...(manifest.host_permissions ?? []), `https://${HOST}/*`, `https://www.${HOST}/*`]
    writeFileSync(manifestPath, JSON.stringify(manifest))
    return directory
}

async function openSources(app) {
    await app
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("button", { name: "Sources", exact: true })
        .click()
}

test("adding a detected site leaves one source row, the added site's, holding the title", async () => {
    const extension = buildWithGrant()
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    })
    try {
        let [worker] = context.serviceWorkers()
        worker ??= await context.waitForEvent("serviceworker")
        await worker.evaluate(() => true)
        const extensionId = new URL(worker.url()).host
        await context.route(`https://${HOST}/**`, route =>
            new URL(route.request().url()).pathname.startsWith("/img/")
                ? route.fulfill({ status: 200, contentType: "image/png", body: PNG })
                : route.fulfill({ status: 200, contentType: "text/html", body: CHAPTER_HTML })
        )

        const page = await context.newPage()
        await page.goto(CHAPTER_URL, { waitUntil: "load" })
        await expect(page.locator(DETECTED)).toBeAttached({ timeout: 15_000 })

        // The app lists the library, which writes the detected title's ranking row, and gives the
        // detected source its place in the order.
        const app = await context.newPage()
        await app.goto(`chrome-extension://${extensionId}/app.html`, { waitUntil: "domcontentloaded" })
        await openSources(app)
        const rows = app.locator(".source-row")
        await expect(rows).toHaveCount(1, { timeout: 15_000 })
        await expect(rows.first()).toContainText("1 title")

        await page.bringToFront()
        await addSiteFromPopup(context, extensionId, page)

        await app.reload({ waitUntil: "domcontentloaded" })
        await openSources(app)
        const added = app.locator(".source-row").filter({ hasText: "Added" })
        await expect(added).toHaveCount(1, { timeout: 15_000 })
        await expect(app.locator(".source-row")).toHaveCount(1)
        await expect(added).toContainText("1 title")
        await expect(added.locator(".source-num")).toHaveText("1")

        const left = await worker.evaluate(
            detected =>
                new Promise((resolve, reject) => {
                    const open = indexedDB.open("all-mangas-reader")
                    open.onerror = () => reject(open.error)
                    open.onsuccess = () => {
                        const tx = open.result.transaction(["versions", "sourcePrefs"], "readonly")
                        const versions = tx.objectStore("versions").getAll()
                        const pref = tx.objectStore("sourcePrefs").get(detected)
                        tx.oncomplete = () => {
                            resolve({
                                versions: versions.result.filter(v => v.sourceId === detected).length,
                                pref: pref.result ?? null
                            })
                            open.result.close()
                        }
                    }
                }),
            `detected:${HOST}`
        )
        expect(left).toEqual({ versions: 0, pref: null })
    } finally {
        await context.close()
        rmSync(extension, { recursive: true, force: true })
    }
})
