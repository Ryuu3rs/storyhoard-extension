import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { chromiumExtension } from "../../src/paths.js"

// The Continue shelf on Activity: a title whose last read chapter has no number had no "Ch N of M" line,
// so its button sat a line higher than its neighbours'. Every card now carries the line and its button sits
// at the foot of the card. The host is made up.

const row = (id, title, extra) => ({
    id,
    title,
    normalizedTitle: title.toLowerCase(),
    authors: [],
    status: "ongoing",
    sourceId: "demo",
    sourceMangaId: id,
    sourceUrl: `https://reader.example/series/${id}`,
    mangaUrl: `https://reader.example/series/${id}`,
    addedAt: 1,
    updatedAt: 1,
    readingStatus: "reading",
    lastReadAt: Date.now(),
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

test("every Continue card shows a progress line and lines its button up with the others", async () => {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        viewport: { width: 1280, height: 900 },
        args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
    })
    try {
        await context.route(/^https?:\/\//, route => route.fulfill({ status: 404, body: "" }))
        let [worker] = context.serviceWorkers()
        worker ??= await context.waitForEvent("serviceworker")
        const page = await context.newPage()
        await page.goto(`chrome-extension://${new URL(worker.url()).host}/app.html`, { waitUntil: "domcontentloaded" })
        await page.waitForTimeout(1500)
        await page.evaluate(seed, [
            row("opened", "Unnumbered Read", {
                latestChapterNumber: 15,
                lastReadChapterId: "demo:chapter:opened:extra"
            }),
            row("caught", "Caught Up", { latestChapterNumber: 85, lastReadChapterNumber: 80 })
        ])
        await page.reload({ waitUntil: "domcontentloaded" })
        await page.locator("nav button", { hasText: "Activity" }).first().click()

        const cards = page.locator(".continue-card")
        await expect(cards).toHaveCount(2)
        const opened = cards.filter({ hasText: "Unnumbered Read" })
        await expect(opened.locator(".continue-meta")).toHaveText(/Started · 15 ch/)
        const tops = await cards
            .locator(".continue-btn")
            .evaluateAll(buttons => buttons.map(b => Math.round(b.getBoundingClientRect().top)))
        expect(tops).toHaveLength(2)
        expect(tops[0]).toBe(tops[1])
    } finally {
        await context.close()
    }
})
