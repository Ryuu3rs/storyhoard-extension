import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromiumExtension } from "../../src/paths.js"

// A user who updated from a release that bundled their sites keeps a stored row for each site, but the store
// build grants no site access, so the row does not register and nothing recognises the site's pages. The
// toolbar popup used to offer such a page as a brand-new site (a second copy beside the stored one); it now
// offers to turn the stored site back on, and the panel comes up on the page straight away. The site is a
// made-up host served through route interception. A headless browser cannot answer the permission bubble, so
// the grant is written into a temp copy of the manifest, and the stored row is written after the worker has
// started, so it is still switched off when the page opens.

const HOST = "reader-demo.net"
const SITE_ID = "reader-demo"
const CHAPTER_URL = `https://${HOST}/manga/demo-series/chapter-3`
const FOLLOWED = '#__amr-chapter-prompt__[data-amr-mode="followed"]'
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64"
)
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")
const CHAPTER_HTML = readFileSync(path.join(FIXTURES, "detected-chapter.html"), "utf8")

const STORED_SITE = {
    profileFormat: 2,
    id: SITE_ID,
    name: "Reader Demo",
    engine: "generic",
    numberingKind: "chapter",
    origin: `https://${HOST}`,
    domains: [HOST],
    languages: ["en"],
    capabilities: ["manga"],
    requestRateLimit: { requests: 3, intervalMs: 1000 },
    origins: [`https://${HOST}/*`],
    match: { manga: "^/manga/([a-z0-9-]+)/?$", chapter: "^/manga/([a-z0-9-]+)/chapter-(\\d+)/?$" },
    series: {
        urlTemplate: "/manga/{slug}/",
        titlePattern: '<meta[^>]+property="og:title"[^>]+content="(?<title>[^"]+)"'
    }
}

function buildWithGrant() {
    const directory = mkdtempSync(path.join(tmpdir(), "amr-turn-on-"))
    cpSync(chromiumExtension, directory, { recursive: true })
    const manifestPath = path.join(directory, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    manifest.host_permissions = [...(manifest.host_permissions ?? []), `https://${HOST}/*`, `https://www.${HOST}/*`]
    writeFileSync(manifestPath, JSON.stringify(manifest))
    return directory
}

async function storedSiteIds(page) {
    return page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
            const open = indexedDB.open("all-mangas-reader")
            open.onsuccess = () => resolve(open.result)
            open.onerror = () => reject(open.error)
        })
        const keys = await new Promise((resolve, reject) => {
            const request = db.transaction("archProfiles").objectStore("archProfiles").getAllKeys()
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        db.close()
        return keys.map(String)
    })
}

async function writeStoredSite(page) {
    return page.evaluate(
        async row => {
            const db = await new Promise((resolve, reject) => {
                const open = indexedDB.open("all-mangas-reader")
                open.onsuccess = () => resolve(open.result)
                open.onerror = () => reject(open.error)
            })
            await new Promise((resolve, reject) => {
                const tx = db.transaction("archProfiles", "readwrite")
                tx.objectStore("archProfiles").put(row)
                tx.oncomplete = resolve
                tx.onerror = () => reject(tx.error)
            })
            db.close()
        },
        { id: SITE_ID, profile: STORED_SITE, importedAt: Date.now(), origin: "seed" }
    )
}

test("a chapter page of a switched-off library site offers Turn on, and the panel comes up after it", async () => {
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

        const popup = await context.newPage()
        await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" })
        await writeStoredSite(popup)

        const page = await context.newPage()
        await page.goto(CHAPTER_URL, { waitUntil: "load" })
        await expect(page.locator(FOLLOWED)).toHaveCount(0)

        await page.bringToFront()
        await popup.reload({ waitUntil: "domcontentloaded" })
        const turnOn = popup.getByRole("button", { name: "Turn this site on" })
        await expect(turnOn).toBeVisible({ timeout: 15_000 })
        await expect(popup.getByRole("button", { name: "Add this site" })).toHaveCount(0)

        await turnOn.click()
        await expect(popup.getByText(/^Site turned on\./)).toBeVisible({ timeout: 20_000 })
        await expect(page.locator(FOLLOWED)).toBeAttached({ timeout: 20_000 })
        expect(await storedSiteIds(popup)).toEqual([SITE_ID])
    } finally {
        await context.close()
        rmSync(extension, { recursive: true, force: true })
    }
})
