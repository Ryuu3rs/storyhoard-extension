import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromiumExtension } from "../../src/paths.js"
import { seriesPage } from "./fixtures/detected-list.js"

// A site with no adapter gets an updater: the user presses Track on the real panel, and the real update
// check then reads the title's chapters from its own page. The site is a made-up host served through route
// interception, so nothing live is hit. The grant is in a temp copy of the manifest, as in detected-panel.

const HOST = "read-demo.net"
const CHAPTER_URL = `https://${HOST}/manga/demo-series/chapter-3`
const SOURCE_ID = HOST
const MANGA_ID = `${SOURCE_ID}:manga:demo-series`
const DETECTED_ID = `detected:${HOST}:manga:demo-series`
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64"
)
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")
const CHAPTER_HTML = readFileSync(path.join(FIXTURES, "detected-chapter.html"), "utf8")

function buildWithGrant() {
    const directory = mkdtempSync(path.join(tmpdir(), "amr-updater-"))
    cpSync(chromiumExtension, directory, { recursive: true })
    const manifestPath = path.join(directory, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    manifest.host_permissions = [...(manifest.host_permissions ?? []), `https://${HOST}/*`]
    writeFileSync(manifestPath, JSON.stringify(manifest))
    return directory
}

async function launch(extension, site) {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    })
    let [worker] = context.serviceWorkers()
    worker ??= await context.waitForEvent("serviceworker")
    await worker.evaluate(() => true)
    await context.route(`https://${HOST}/**`, route => {
        const { pathname } = new URL(route.request().url())
        if (pathname.startsWith("/img/")) return route.fulfill({ status: 200, contentType: "image/png", body: PNG })
        if (/^\/manga\/demo-series\/?$/.test(pathname)) {
            site.titlePageRequests += 1
            return site.titlePage
                ? route.fulfill({ status: 200, contentType: "text/html", body: site.titlePage })
                : route.fulfill({ status: 404, contentType: "text/html", body: "<html><body>gone</body></html>" })
        }
        return route.fulfill({ status: 200, contentType: "text/html", body: CHAPTER_HTML })
    })
    return { context, extensionId: new URL(worker.url()).host }
}

async function openExtensionPage(context, extensionId) {
    const control = await context.newPage()
    await control.goto(`chrome-extension://${extensionId}/app.html`, { waitUntil: "domcontentloaded" })
    return control
}

function readLibrary(control) {
    return control.evaluate(async () => {
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
        const [manga, chapters, progress, profiles] = await Promise.all([
            read("manga"),
            read("chapters"),
            read("progress"),
            read("archProfiles")
        ])
        db.close()
        return { manga, chapters, progress, profiles }
    })
}

// A real check, from a freshly started worker: the worker a user's alarm wakes has lost its memory, so added
// sites must have re-registered from storage. It also drops the worker's short-lived response cache, which
// would otherwise answer a second check inside a minute with the page the first one saw.
async function runUpdateCheck(context, control) {
    const session = await context.newCDPSession(control)
    await session.send("ServiceWorker.enable")
    await session.send("ServiceWorker.stopAllWorkers")
    await session.detach()
    const lastStatus = () => control.evaluate(() => chrome.storage.local.get("updateStatus")).then(s => s.updateStatus)
    const before = (await lastStatus())?.checkedAt
    await expect
        .poll(
            () =>
                control.evaluate(async () => {
                    const reply = await chrome.runtime.sendMessage({ type: "updates:check" })
                    return reply?.data?.started === true
                }),
            { timeout: 30_000 }
        )
        .toBe(true)
    await expect.poll(async () => (await lastStatus())?.checkedAt, { timeout: 30_000 }).not.toBe(before)
    return lastStatus()
}

async function pressTrack(context, extensionId) {
    const page = await context.newPage()
    await page.goto(CHAPTER_URL, { waitUntil: "load" })
    const panel = page.locator('#__amr-chapter-prompt__[data-amr-mode="detected"]')
    await expect(panel).toBeAttached({ timeout: 15_000 })
    const control = await openExtensionPage(context, extensionId)
    await expect
        .poll(async () => (await readLibrary(control)).manga.map(row => row.id), { timeout: 15_000 })
        .toEqual([DETECTED_ID])
    await page.bringToFront()
    await panel.locator(".handle").click()
    await panel.getByRole("button", { name: "Track this site" }).click()
    await expect(page.locator('#__amr-chapter-prompt__[data-amr-mode="followed"]')).toBeAttached({ timeout: 20_000 })
    return { page, control }
}

test("Track gives a detected site an updater: its chapters, then exactly one new, then none", async () => {
    test.setTimeout(120_000)
    const extension = buildWithGrant()
    const site = { titlePage: seriesPage(HOST, 5), titlePageRequests: 0 }
    const { context, extensionId } = await launch(extension, site)
    try {
        const { page, control } = await pressTrack(context, extensionId)
        // No visit may overlap the checks: the panel's own background refresh of a list would absorb the
        // new chapter this test is about to add.
        await page.close()

        const followed = await readLibrary(control)
        expect(followed.manga.map(row => row.id)).toEqual([MANGA_ID])
        expect(followed.profiles.map(row => row.id)).toEqual([SOURCE_ID])
        expect(followed.progress.map(row => row.mangaId)).toEqual([MANGA_ID])
        const readNumber = followed.manga[0].lastReadChapterNumber
        expect(readNumber).toBe(3)

        const baseline = await runUpdateCheck(context, control)
        expect(baseline).toMatchObject({ checked: 1, failed: 0, updated: 0, emptyLists: {}, trackingOnly: {} })
        expect(site.titlePageRequests).toBeGreaterThan(0)

        const listed = await readLibrary(control)
        expect(listed.manga.map(row => row.id)).toEqual([MANGA_ID])
        expect(listed.manga[0].latestChapterNumber).toBe(5)
        expect(listed.manga[0].lastReadChapterNumber).toBe(readNumber)
        const numbers = listed.chapters.map(chapter => chapter.sortKey).sort((a, b) => a - b)
        expect(numbers).toEqual([1, 2, 3, 4, 5])
        expect(listed.chapters.every(chapter => chapter.mangaId === MANGA_ID)).toBe(true)
        expect(listed.progress.map(row => row.mangaId)).toEqual([MANGA_ID])
        const readRow = listed.chapters.find(chapter => chapter.id === listed.manga[0].lastReadChapterId)
        expect(readRow?.sortKey).toBe(readNumber)

        site.titlePage = seriesPage(HOST, 6)
        const oneNew = await runUpdateCheck(context, control)
        expect(oneNew).toMatchObject({ checked: 1, failed: 0, updated: 1 })
        const after = await readLibrary(control)
        expect(after.manga[0].latestChapterNumber).toBe(6)
        expect(after.chapters.map(chapter => chapter.sortKey).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6])

        const none = await runUpdateCheck(context, control)
        expect(none).toMatchObject({ checked: 1, failed: 0, updated: 0 })
        expect((await readLibrary(control)).manga[0].latestChapterNumber).toBe(6)

        // A page that stops listing chapters is reported, not read as "nothing new".
        site.titlePage = "<!doctype html><html><head><title>Maintenance</title></head><body>Back soon</body></html>"
        const empty = await runUpdateCheck(context, control)
        expect(empty).toMatchObject({ updated: 0, emptyLists: { [SOURCE_ID]: 1 } })
        expect((await readLibrary(control)).manga[0].latestChapterNumber).toBe(6)
    } finally {
        await context.close()
        rmSync(extension, { recursive: true, force: true })
    }
})

test("a title page with no readable list still follows, and the check says updates come from visits", async () => {
    test.setTimeout(120_000)
    const extension = buildWithGrant()
    const site = {
        titlePage: "<!doctype html><html><head><title>Demo Series</title></head><body>No chapters here</body></html>",
        titlePageRequests: 0
    }
    const { context, extensionId } = await launch(extension, site)
    try {
        const { page, control } = await pressTrack(context, extensionId)
        await page.close()

        const { profiles } = await readLibrary(control)
        expect(profiles.map(row => row.profile.listSource)).toEqual(["on-visit"])

        const status = await runUpdateCheck(context, control)
        expect(status).toMatchObject({ checked: 0, updated: 0, trackingOnly: { [SOURCE_ID]: 1 } })
        const after = await readLibrary(control)
        expect(after.manga.map(row => row.id)).toEqual([MANGA_ID])
        expect(after.manga[0].lastReadChapterNumber).toBe(3)
    } finally {
        await context.close()
        rmSync(extension, { recursive: true, force: true })
    }
})
