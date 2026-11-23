import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { chromiumExtension } from "../../src/paths.js"

// The title's options dialog puts "Read up to latest" right under the chapter fields, so a user whose reading
// was not picked up can catch up in one click instead of stepping the read chapter by hand. The host is made up.

const HOST = "behind-demo.net"
const behind = {
    id: "behinddemo:manga:behind",
    title: "Behind By Seven",
    normalizedTitle: "behind by seven",
    authors: [],
    status: "ongoing",
    sourceId: "behinddemo",
    sourceUrl: `https://${HOST}/series/behind/chapter-3`,
    sourceMangaId: "behind",
    mangaUrl: `https://${HOST}/series/behind`,
    manualTracking: true,
    lastReadChapterNumber: 3,
    latestChapterNumber: 10,
    addedAt: 1,
    updatedAt: 1
}

const seed = manga =>
    new Promise((resolve, reject) => {
        const open = indexedDB.open("all-mangas-reader")
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
            const db = open.result
            const tx = db.transaction(["manga"], "readwrite")
            tx.objectStore("manga").put(manga)
            tx.oncomplete = () => {
                db.close()
                resolve()
            }
            tx.onerror = () => reject(tx.error)
        }
    })

const readNumber = id =>
    new Promise((resolve, reject) => {
        const open = indexedDB.open("all-mangas-reader")
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
            const db = open.result
            const request = db.transaction(["manga"], "readonly").objectStore("manga").get(id)
            request.onsuccess = () => {
                db.close()
                resolve(request.result?.lastReadChapterNumber)
            }
            request.onerror = () => reject(request.error)
        }
    })

test("the options dialog marks a title read up to its latest chapter in one click", async () => {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        viewport: { width: 1280, height: 900 },
        args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
    })
    await context.route(/^https?:\/\//, route => route.fulfill({ status: 404, body: "" }))
    try {
        let [worker] = context.serviceWorkers()
        worker ??= await context.waitForEvent("serviceworker")
        const page = await context.newPage()
        await page.goto(`chrome-extension://${new URL(worker.url()).host}/app.html`, { waitUntil: "domcontentloaded" })
        await page.waitForTimeout(1500)
        await page.evaluate(seed, behind)
        await page.reload({ waitUntil: "domcontentloaded" })
        await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Library" }).click()
        await page.locator(".filter-chips .chip", { hasText: /^\s*All/ }).click()

        const card = page.locator("article", { hasText: "Behind By Seven" })
        await card.getByRole("button", { name: "Options" }).click()
        const caughtUp = page.getByRole("button", { name: /Read up to latest \(Ch 10\)/ })
        await expect(caughtUp).toBeVisible()
        await caughtUp.click()

        await expect.poll(() => page.evaluate(readNumber, behind.id)).toBe(10)
        await expect(caughtUp).toHaveCount(0)
        await expect(page.getByLabel("Read ch")).toHaveValue("10")
    } finally {
        await context.close()
    }
})
