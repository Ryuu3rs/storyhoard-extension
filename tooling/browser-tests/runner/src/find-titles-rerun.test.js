import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromiumExtension } from "../../src/paths.js"
import { addSiteFromPopup } from "./toolbar-popup.js"

// "Find my titles here" started again while an earlier search on the same site is still going: from a tab that
// was closed mid-search, or from a panel closed while it waited. The new search takes over and finishes, and a
// closed panel leaves nothing asking the site for pages. The site is a made-up host served through route
// interception, with the host grant written into a temp copy of the manifest, as in find-titles-here.test.js.

const HOST = "rerun-demo.net"
const CHAPTER_URL = `https://${HOST}/manga/demo-series/chapter-3`
const DETECTED = '#__amr-chapter-prompt__[data-amr-mode="detected"]'
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64"
)
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")
const CHAPTER_HTML = readFileSync(path.join(FIXTURES, "detected-chapter.html"), "utf8")

const LIBRARY = Array.from({ length: 30 }, (_, i) => {
    const n = String(i).padStart(2, "0")
    return {
        id: `older-site:manga:t${n}`,
        title: `Missing Series ${n}`,
        normalizedTitle: `missing series ${n}`,
        authors: [],
        status: "ongoing",
        addedAt: 1,
        updatedAt: 1,
        sourceId: "older-site",
        sourceUrl: `https://older-site.example/series/old-${n}/chapter-1`,
        sourceMangaId: `old-series-${n}`,
        mangaUrl: `https://older-site.example/series/old-${n}`
    }
})

function buildWithGrant() {
    const directory = mkdtempSync(path.join(tmpdir(), "amr-find-rerun-"))
    cpSync(chromiumExtension, directory, { recursive: true })
    const manifestPath = path.join(directory, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    manifest.host_permissions = [...(manifest.host_permissions ?? []), `https://${HOST}/*`, `https://www.${HOST}/*`]
    writeFileSync(manifestPath, JSON.stringify(manifest))
    return directory
}

const seedLibrary = manga =>
    new Promise((resolve, reject) => {
        const open = indexedDB.open("all-mangas-reader")
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
            const tx = open.result.transaction("manga", "readwrite")
            for (const m of manga) tx.objectStore("manga").put(m)
            tx.oncomplete = () => {
                open.result.close()
                resolve()
            }
            tx.onerror = () => reject(tx.error)
        }
    })

// Every series address misses; `onSeries` sees each request first and may hold it.
async function openWithSite(onSeries) {
    const extension = buildWithGrant()
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    })
    let [worker] = context.serviceWorkers()
    worker ??= await context.waitForEvent("serviceworker")
    await worker.evaluate(() => true)
    const extensionId = new URL(worker.url()).host
    await context.route(`https://${HOST}/**`, async route => {
        const { pathname } = new URL(route.request().url())
        if (pathname.startsWith("/img/")) return route.fulfill({ status: 200, contentType: "image/png", body: PNG })
        if (pathname.startsWith("/manga/demo-series")) {
            return route.fulfill({ status: 200, contentType: "text/html", body: CHAPTER_HTML })
        }
        await onSeries()
        return route.fulfill({ status: 404, contentType: "text/html", body: "<title>Not found</title>" })
    })
    const page = await context.newPage()
    await page.goto(CHAPTER_URL, { waitUntil: "load" })
    await expect(page.locator(DETECTED)).toBeAttached({ timeout: 15_000 })
    await addSiteFromPopup(context, extensionId, page)
    await worker.evaluate(seedLibrary, LIBRARY)
    const findUrl = `chrome-extension://${extensionId}/app.html?findOn=${HOST}`
    return { context, extension, findUrl }
}

test("closing the app mid-search and opening Find again on the same site still finishes the search", async () => {
    test.setTimeout(120_000)
    let seriesRequests = 0
    const { context, extension, findUrl } = await openWithSite(async () => {
        seriesRequests += 1
    })
    try {
        const first = await context.newPage()
        await first.goto(findUrl, { waitUntil: "domcontentloaded" })
        await expect(first.locator(".find-titles")).toContainText("Looking for your titles", { timeout: 15_000 })
        await expect.poll(() => seriesRequests, { timeout: 15_000 }).toBeGreaterThan(1)
        await first.close()

        const second = await context.newPage()
        await second.goto(findUrl, { waitUntil: "domcontentloaded" })
        const status = second.locator(".find-titles p[role=status]").first()
        await expect(status).toHaveText(/None (of your other titles were found here|found yet)/, { timeout: 60_000 })
    } finally {
        await context.close()
        rmSync(extension, { recursive: true, force: true })
    }
})

test("closing the panel while its search waits for an earlier one leaves nothing asking the site", async () => {
    test.setTimeout(120_000)
    let seriesRequests = 0
    let releaseHeld
    const held = new Promise(resolve => (releaseHeld = resolve))
    let sawHeld
    const heldSeen = new Promise(resolve => (sawHeld = resolve))
    const { context, extension, findUrl } = await openWithSite(async () => {
        seriesRequests += 1
        if (seriesRequests === 1) {
            sawHeld()
            await held
        }
    })
    await context.addInitScript(() => {
        if (!location.pathname.endsWith("/app.html")) return
        window.__findSends = 0
        const original = chrome.runtime.sendMessage.bind(chrome.runtime)
        chrome.runtime.sendMessage = (message, ...rest) => {
            if (message?.type === "source:find-titles") window.__findSends += 1
            return original(message, ...rest)
        }
    })
    try {
        const app = await context.newPage()
        await app.goto(findUrl, { waitUntil: "domcontentloaded" })
        await heldSeen
        // The first search waits on the site. The user closes the panel and opens Find again, so the second
        // search waits for the first to finish its request; then the user closes that panel too.
        await app.locator(".find-titles").getByRole("button", { name: "Close" }).click()
        await app.goto(findUrl, { waitUntil: "domcontentloaded" })
        await expect(app.locator(".find-titles")).toContainText("Looking for your titles", { timeout: 15_000 })
        await app.waitForFunction(() => window.__findSends >= 1, null, { polling: 10, timeout: 10_000 })
        await app.waitForTimeout(150)
        const beforeRelease = seriesRequests
        releaseHeld()
        await app.locator(".find-titles").getByRole("button", { name: "Close" }).click()
        await expect(app.locator(".find-titles")).toHaveCount(0)
        await app.waitForTimeout(5000)
        expect(seriesRequests - beforeRelease).toBe(0)
    } finally {
        await context.close()
        rmSync(extension, { recursive: true, force: true })
    }
})
