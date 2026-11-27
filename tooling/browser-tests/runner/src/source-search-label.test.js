import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromiumExtension } from "../../src/paths.js"
import { addSiteFromPopup } from "./toolbar-popup.js"

// A user added a site from one of its pages while the app was open on Sources. The new row said "No search",
// which read as "this site can't be searched", and it kept saying so until a reload because the app read the
// source list once at start. A site the title search can't read is searched through a link to the site's own
// search, so the row says that, and the row is complete (Added badge included) without reloading the app.
// The site is a made-up host served through route interception; the host grant is written into a temp copy
// of the manifest, as in followed-site.test.js.

const HOST = "search-demo.net"
const CHAPTER_URL = `https://${HOST}/manga/demo-series/chapter-3`
const DETECTED = '#__amr-chapter-prompt__[data-amr-mode="detected"]'
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64"
)
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")
const CHAPTER_HTML = readFileSync(path.join(FIXTURES, "detected-chapter.html"), "utf8")

function buildWithGrant() {
    const directory = mkdtempSync(path.join(tmpdir(), "amr-search-label-"))
    cpSync(chromiumExtension, directory, { recursive: true })
    const manifestPath = path.join(directory, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    manifest.host_permissions = [...(manifest.host_permissions ?? []), `https://${HOST}/*`, `https://www.${HOST}/*`]
    writeFileSync(manifestPath, JSON.stringify(manifest))
    return directory
}

test("a site added while Sources is open shows how to search it, without reloading the app", async () => {
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

        const app = await context.newPage()
        await app.goto(`chrome-extension://${extensionId}/app.html`, { waitUntil: "domcontentloaded" })
        await app
            .getByRole("navigation", { name: "Main navigation" })
            .getByRole("button", { name: "Sources", exact: true })
            .click()
        const added = app.locator(".source-row").filter({ hasText: "Added" })
        await expect(added).toHaveCount(0)

        const page = await context.newPage()
        await page.goto(CHAPTER_URL, { waitUntil: "load" })
        await expect(page.locator(DETECTED)).toBeAttached({ timeout: 15_000 })
        await addSiteFromPopup(context, extensionId, page)

        await app.bringToFront()
        await app.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
        await expect(added).toHaveCount(1, { timeout: 15_000 })
        await expect(added).toContainText("Search on site")
        await expect(added).not.toContainText("No search")
        await expect(added.getByRole("switch")).toHaveCount(0)
    } finally {
        await context.close()
        rmSync(extension, { recursive: true, force: true })
    }
})
