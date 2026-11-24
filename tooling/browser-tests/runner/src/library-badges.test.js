import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { artifactsDirectory, chromiumExtension } from "../../src/paths.js"

// A title added from Discover has no site yet: its card says so and it is not counted as "Manual", a word the
// add flow never used. "Manual" stays for a site title the user chose to track by hand. Hosts are made up.

const SHOTS = process.env.JOURNEY_SHOTS ?? path.join(artifactsDirectory, "journey-shots")
mkdirSync(SHOTS, { recursive: true })

const HOST = "oldreader-demo.net"
const manualSiteRow = {
    id: "oldreader:manga:kept",
    title: "Kept By Hand",
    normalizedTitle: "kept by hand",
    authors: [],
    status: "ongoing",
    sourceId: "oldreader",
    sourceUrl: `https://${HOST}/series/kept/chapter-1`,
    sourceMangaId: "kept",
    mangaUrl: `https://${HOST}/series/kept`,
    manualTracking: true,
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

test("a Discover add is badged No site yet, and Manual stays for titles tracked by hand", async () => {
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
        await page.evaluate(() =>
            chrome.runtime.sendMessage({
                type: "library:quick-add",
                anilistId: 7201,
                title: "Planned From Discover",
                mode: "planning"
            })
        )
        await page.evaluate(seed, manualSiteRow)
        await page.reload({ waitUntil: "domcontentloaded" })
        await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Library" }).click()
        const chips = page.locator(".filter-chips")
        await chips.locator(".chip", { hasText: /^\s*All/ }).click()

        const planned = page.locator("article", { hasText: "Planned From Discover" })
        const kept = page.locator("article", { hasText: "Kept By Hand" })
        await expect(planned).toBeVisible()
        await expect(kept).toBeVisible()
        await page.screenshot({ path: path.join(SHOTS, "library-badges.png"), fullPage: true })
        await expect(planned.getByText("No site yet")).toBeVisible()
        await expect(planned.getByText("Manual", { exact: true })).toHaveCount(0)
        await expect(kept.getByText("Manual", { exact: true })).toBeVisible()

        await expect(chips.locator(".chip", { hasText: /^\s*Manual/ }).locator(".chip-count")).toHaveText("1")
        await expect(chips.locator(".chip", { hasText: /^\s*No site yet/ }).locator(".chip-count")).toHaveText("1")
        await chips.locator(".chip", { hasText: /^\s*Manual/ }).click()
        await expect(kept).toBeVisible()
        await expect(planned).toHaveCount(0)

        await page.getByRole("button", { name: "List", exact: true }).click()
        await chips.locator(".chip", { hasText: /^\s*All/ }).click()
        const plannedRow = page.locator(".list-main", { hasText: "Planned From Discover" })
        await expect(plannedRow).toContainText("no site yet")
        await expect(plannedRow).not.toContainText("manual")
        await expect(page.locator(".list-main", { hasText: "Kept By Hand" })).toContainText("manual")
    } finally {
        await context.close()
    }
})
