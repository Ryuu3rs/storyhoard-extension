import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { chromiumExtension } from "../../src/paths.js"

// A sample title the user kept through the update (its sample cover cleared) is theirs: no Sample chip, and it
// counts in the Sources filter like any title. A sample still carrying its sample cover stays a sample.

const HOST = "kept-demo.net"
const row = (id, title, extra = {}) => ({
    id,
    title,
    normalizedTitle: title.toLowerCase(),
    authors: [],
    status: "ongoing",
    sourceId: id === "own-1" ? "own-site" : "demo-site",
    sourceUrl: `https://${HOST}/series/${id}/chapter-1`,
    sourceMangaId: id,
    mangaUrl: `https://${HOST}/series/${id}`,
    addedAt: 1,
    updatedAt: 1,
    ...extra
})

const seed = manga =>
    new Promise((resolve, reject) => {
        const open = indexedDB.open("all-mangas-reader")
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
            const db = open.result
            const tx = db.transaction(["manga"], "readwrite")
            for (const m of manga) tx.objectStore("manga").put(m)
            tx.oncomplete = () => {
                db.close()
                resolve()
            }
            tx.onerror = () => reject(tx.error)
        }
    })

test("a kept sample loses its Sample chip, an untouched one keeps it", async () => {
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
        await page.evaluate(seed, [
            row("seed-a-001", "Sample Untouched", { coverUrl: "/sample-covers/a.jpg" }),
            row("seed-a-002", "Sample Kept", { lastReadChapterNumber: 4 }),
            row("own-1", "Own Title")
        ])
        await page.reload({ waitUntil: "domcontentloaded" })
        await page
            .getByRole("navigation", { name: "Main navigation" })
            .getByRole("button", { name: "Library", exact: true })
            .click()
        const all = page.getByRole("button", { name: /^All\b/ }).first()
        await expect(all).toBeVisible()
        await all.click()
        const card = title => page.locator(".poster-grid article", { has: page.getByText(title, { exact: true }) })
        await expect(card("Sample Kept")).toBeVisible()
        await expect(page.locator(".sample-chip")).toHaveCount(1)
        await expect(card("Sample Untouched").locator(".sample-chip")).toHaveCount(1)
        await expect(card("Sample Kept").locator(".sample-chip")).toHaveCount(0)
    } finally {
        await context.close()
    }
})
