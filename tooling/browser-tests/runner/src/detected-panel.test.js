import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromiumExtension } from "../../src/paths.js"

// The neutral path: a site with no bundled adapter, recognised only from its own page once the user
// has granted that one origin. The fixture is served at a made-up host through route interception, so
// no live site is hit. Chromium has no way to accept the native permission bubble from a test, so the
// grant is written into a temp copy of the manifest; the no-grant case below uses the real build.

const HOST = "read-demo.net"
const CHAPTER_URL = `https://${HOST}/manga/demo-series/chapter-3`
const DETECTED_PANEL = '#__amr-chapter-prompt__[data-amr-mode="detected"]'
const ANY_PANEL = "#__amr-chapter-prompt__"
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64"
)
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")
const CHAPTER_HTML = readFileSync(path.join(FIXTURES, "detected-chapter.html"), "utf8")
const NOT_A_READER_HTML = `<!doctype html><html><head><title>Chapter 3 summary</title></head><body><h1>Demo Series wiki</h1><p>Plot summary.</p></body></html>`

function buildWithGrant() {
    const directory = mkdtempSync(path.join(tmpdir(), "amr-detected-"))
    cpSync(chromiumExtension, directory, { recursive: true })
    const manifestPath = path.join(directory, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    manifest.host_permissions = [...(manifest.host_permissions ?? []), `https://${HOST}/*`]
    writeFileSync(manifestPath, JSON.stringify(manifest))
    return directory
}

async function launch(extension, html) {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    })
    let [worker] = context.serviceWorkers()
    worker ??= await context.waitForEvent("serviceworker")
    await worker.evaluate(() => true)
    await context.route(`https://${HOST}/**`, route =>
        new URL(route.request().url()).pathname.startsWith("/img/")
            ? route.fulfill({ status: 200, contentType: "image/png", body: PNG })
            : route.fulfill({ status: 200, contentType: "text/html", body: html })
    )
    return { context, extensionId: new URL(worker.url()).host }
}

async function detectedRows(context, extensionId) {
    const inspector = await context.newPage()
    await inspector.goto(`chrome-extension://${extensionId}/app.html`, { waitUntil: "domcontentloaded" })
    const rows = await inspector.evaluate(async host => {
        const db = await new Promise((resolve, reject) => {
            const open = indexedDB.open("all-mangas-reader")
            open.onsuccess = () => resolve(open.result)
            open.onerror = () => reject(open.error)
        })
        const read = store =>
            new Promise((resolve, reject) => {
                const request = db.transaction(store).objectStore(store).getAll()
                request.onsuccess = () => resolve(request.result)
                request.onerror = () => reject(request.error)
            })
        const manga = (await read("manga")).filter(row => String(row.id).startsWith(`detected:${host}:manga:`))
        const chapters = await read("chapters")
        return manga.map(row => ({
            id: row.id,
            title: row.title,
            chapters: chapters.filter(chapter => chapter.mangaId === row.id).length
        }))
    }, HOST)
    await inspector.close()
    return rows
}

test("granted reader page with no adapter gets the detected panel on the first load", async () => {
    const extension = buildWithGrant()
    const { context } = await launch(extension, CHAPTER_HTML)
    try {
        const page = await context.newPage()
        await page.goto(CHAPTER_URL, { waitUntil: "load" })
        await expect(page.locator(DETECTED_PANEL)).toBeAttached({ timeout: 15_000 })
    } finally {
        await context.close()
        rmSync(extension, { recursive: true, force: true })
    }
})

// What a user normally hits: the worker has gone idle and this navigation is what wakes it. The marker
// proves the page was served by a new worker, not the one the test started with.
test("a stopped worker woken by the navigation still gets the panel on the first load", async () => {
    const extension = buildWithGrant()
    const { context, extensionId } = await launch(extension, CHAPTER_HTML)
    try {
        const [worker] = context.serviceWorkers()
        await worker.evaluate(() => {
            globalThis.__amrMarker = true
        })
        const control = await context.newPage()
        await control.goto(`chrome-extension://${extensionId}/app.html`, { waitUntil: "domcontentloaded" })
        // The app page messages the worker while it loads, which would restart a worker stopped too early.
        await control.waitForTimeout(3000)
        const session = await context.newCDPSession(control)
        const statuses = []
        session.on("ServiceWorker.workerVersionUpdated", event => {
            statuses.push(...event.versions.map(version => version.runningStatus))
        })
        await session.send("ServiceWorker.enable")
        await session.send("ServiceWorker.stopAllWorkers")
        await expect.poll(() => statuses.at(-1), { timeout: 10_000 }).toBe("stopped")
        await control.close()

        const page = await context.newPage()
        await page.goto(CHAPTER_URL, { waitUntil: "load" })
        await expect(page.locator(DETECTED_PANEL)).toBeAttached({ timeout: 15_000 })
        const live = context.serviceWorkers().at(-1)
        expect(await live.evaluate(() => globalThis.__amrMarker === true)).toBe(false)
    } finally {
        await context.close()
        rmSync(extension, { recursive: true, force: true })
    }
})

test("detected panel records the series and its chapter in the library", async () => {
    const extension = buildWithGrant()
    const { context, extensionId } = await launch(extension, CHAPTER_HTML)
    try {
        const page = await context.newPage()
        await page.goto(CHAPTER_URL, { waitUntil: "load" })
        await expect(page.locator(DETECTED_PANEL)).toBeAttached({ timeout: 15_000 })
        await expect
            .poll(async () => (await detectedRows(context, extensionId))[0]?.id, { timeout: 15_000 })
            .toBe(`detected:${HOST}:manga:demo-series`)
        const [row] = await detectedRows(context, extensionId)
        expect(row.chapters).toBeGreaterThan(0)
    } finally {
        await context.close()
        rmSync(extension, { recursive: true, force: true })
    }
})

// The page lists chapters 1, 2, 3 and 9, so the list's next after 3 is 9. The page's own Next link says 4.
test("Next follows the page's own link when the stored list would skip chapters", async () => {
    const extension = buildWithGrant()
    const sparse = CHAPTER_HTML.replace(
        '<option value="/manga/demo-series/chapter-3" selected>Chapter 3</option>',
        `<option value="/manga/demo-series/chapter-3" selected>Chapter 3</option>
            <option value="/manga/demo-series/chapter-9">Chapter 9</option>`
    )
    const { context } = await launch(extension, sparse)
    try {
        const page = await context.newPage()
        await page.goto(CHAPTER_URL, { waitUntil: "load" })
        await expect(page.locator(DETECTED_PANEL)).toBeAttached({ timeout: 15_000 })
        await page.locator(`${ANY_PANEL} .handle`).click()
        const chapters = page.locator(`${ANY_PANEL} select`).first()
        await expect.poll(() => chapters.locator("option").count(), { timeout: 15_000 }).toBeGreaterThan(3)
        const next = page.locator(`${ANY_PANEL} button[aria-label="Next chapter"]`)
        await expect(next).toBeEnabled()
        await next.click()
        await expect.poll(() => new URL(page.url()).pathname).toBe("/manga/demo-series/chapter-4")
    } finally {
        await context.close()
        rmSync(extension, { recursive: true, force: true })
    }
})

test("no panel and no library row without the user's grant", async () => {
    const { context, extensionId } = await launch(chromiumExtension, CHAPTER_HTML)
    try {
        const page = await context.newPage()
        await page.goto(CHAPTER_URL, { waitUntil: "load" })
        await page.waitForTimeout(4000)
        await expect(page.locator(ANY_PANEL)).toHaveCount(0)
        expect(await detectedRows(context, extensionId)).toEqual([])
    } finally {
        await context.close()
    }
})

test("granted page whose address looks like a chapter but is not a reader gets no panel", async () => {
    const extension = buildWithGrant()
    const { context, extensionId } = await launch(extension, NOT_A_READER_HTML)
    try {
        const page = await context.newPage()
        await page.goto(CHAPTER_URL, { waitUntil: "load" })
        await page.waitForTimeout(4000)
        await expect(page.locator(ANY_PANEL)).toHaveCount(0)
        expect(await detectedRows(context, extensionId)).toEqual([])
    } finally {
        await context.close()
        rmSync(extension, { recursive: true, force: true })
    }
})
