import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromiumExtension } from "../../src/paths.js"
import { addSiteFromPopup } from "./toolbar-popup.js"

// A site whose series addresses end in a per-series hash and whose series pages answer every background
// request with a challenge: a title read there is named from the reader's own page, not from its address.
// Served at a made-up host through route interception; the grant is written into a temp copy of the manifest.

const HOST = "reader-demo.net"
const DETECTED = '#__amr-chapter-prompt__[data-amr-mode="detected"]'
const FOLLOWED = '#__amr-chapter-prompt__[data-amr-mode="followed"]'
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64"
)
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")
const CHAPTER_HTML = readFileSync(path.join(FIXTURES, "detected-chapter.html"), "utf8")
const CHALLENGE_HTML = "<!doctype html><html><head><title>Just a moment...</title></head><body></body></html>"
const SHELL_HTML =
    '<!doctype html><html><head><title>Reader Demo</title></head><body><div id="app"></div></body></html>'

const SERIES = {
    "lantern-keeper-7de80a82": "The Lantern Keeper's Oath",
    "harbor-lights-3c4d5e6f": "Harbor Lights at Dusk"
}
const chapterUrl = (slug, n) => `https://${HOST}/comics/${slug}/chapter/${n}`

function chapterPage(slug, n) {
    const name = SERIES[slug]
    return CHAPTER_HTML.replaceAll("/manga/demo-series/chapter-", `/comics/${slug}/chapter/`)
        .replace("<title>Demo Series - Chapter 3</title>", `<title>${name} Chapter ${n} - Reader Demo</title>`)
        .replace(
            '<meta property="og:type" content="book" />',
            `<meta property="og:title" content="${name} Chapter ${n}" />`
        )
        .replace("<h1>Demo Series</h1>", `<h1>${name}</h1>`)
}

function buildWithGrant() {
    const directory = mkdtempSync(path.join(tmpdir(), "amr-series-name-"))
    cpSync(chromiumExtension, directory, { recursive: true })
    const manifestPath = path.join(directory, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    manifest.host_permissions = [...(manifest.host_permissions ?? []), `https://${HOST}/*`, `https://www.${HOST}/*`]
    writeFileSync(manifestPath, JSON.stringify(manifest))
    return directory
}

// Until `walled` is set, a series page is a script-drawn shell that names nothing; after it, a challenge.
async function withSite(body) {
    const site = { walled: true }
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
        await context.route(`https://${HOST}/**`, route => {
            const { pathname } = new URL(route.request().url())
            if (pathname.startsWith("/img/")) return route.fulfill({ status: 200, contentType: "image/png", body: PNG })
            const chapter = /^\/comics\/([^/]+)\/chapter\/(\d+)$/.exec(pathname)
            if (chapter && SERIES[chapter[1]]) {
                return route.fulfill({
                    status: 200,
                    contentType: "text/html",
                    body: chapterPage(chapter[1], chapter[2])
                })
            }
            return site.walled
                ? route.fulfill({ status: 403, contentType: "text/html", body: CHALLENGE_HTML })
                : route.fulfill({ status: 200, contentType: "text/html", body: SHELL_HTML })
        })
        await body({ context, extensionId: new URL(worker.url()).host, site })
    } finally {
        await context.close()
        rmSync(extension, { recursive: true, force: true })
    }
}

async function titleFor(context, extensionId, slug) {
    const inspector = await context.newPage()
    await inspector.goto(`chrome-extension://${extensionId}/app.html`, { waitUntil: "domcontentloaded" })
    const titles = await inspector.evaluate(async wanted => {
        const db = await new Promise((resolve, reject) => {
            const open = indexedDB.open("all-mangas-reader")
            open.onsuccess = () => resolve(open.result)
            open.onerror = () => reject(open.error)
        })
        const rows = await new Promise((resolve, reject) => {
            const request = db.transaction("manga").objectStore("manga").getAll()
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        return rows.filter(row => row.sourceMangaId === wanted).map(row => row.title)
    }, slug)
    await inspector.close()
    return titles
}

test("a title read on a detected site is named from its page, not from the hashed address", async () => {
    await withSite(async ({ context, extensionId }) => {
        const page = await context.newPage()
        await page.goto(chapterUrl("lantern-keeper-7de80a82", 1), { waitUntil: "load" })
        await expect(page.locator(DETECTED)).toBeAttached({ timeout: 15_000 })

        await expect
            .poll(() => titleFor(context, extensionId, "lantern-keeper-7de80a82"), { timeout: 20_000 })
            .toEqual(["The Lantern Keeper's Oath"])
    })
})

test("a new title on a followed site is named from its page when the series page is walled", async () => {
    await withSite(async ({ context, extensionId, site }) => {
        site.walled = false
        const page = await context.newPage()
        await page.goto(chapterUrl("lantern-keeper-7de80a82", 1), { waitUntil: "load" })
        await expect(page.locator(DETECTED)).toBeAttached({ timeout: 15_000 })
        await addSiteFromPopup(context, extensionId, page)
        await expect(page.locator(FOLLOWED)).toBeAttached({ timeout: 20_000 })
        site.walled = true

        await page.goto(chapterUrl("harbor-lights-3c4d5e6f", 2), { waitUntil: "load" })
        await expect(page.locator(FOLLOWED)).toBeAttached({ timeout: 15_000 })

        await expect
            .poll(() => titleFor(context, extensionId, "harbor-lights-3c4d5e6f"), { timeout: 20_000 })
            .toEqual(["Harbor Lights at Dusk"])
        await expect
            .poll(() => titleFor(context, extensionId, "lantern-keeper-7de80a82"), { timeout: 10_000 })
            .toEqual(["The Lantern Keeper's Oath"])
    })
})
