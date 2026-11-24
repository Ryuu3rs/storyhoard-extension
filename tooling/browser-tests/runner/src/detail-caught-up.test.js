import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { artifactsDirectory, chromiumExtension } from "../../src/paths.js"

// The title's options dialog keeps the title, progress, "Continue reading", "Read up to latest" and the status in
// a left column that never scrolls, so a user whose reading was not picked up can catch up in one click. The
// sources, tags, notes and reader settings scroll on the right. The host is made up.

const SHOTS = process.env.JOURNEY_SHOTS ?? path.join(artifactsDirectory, "journey-shots")
mkdirSync(SHOTS, { recursive: true })

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

async function openDialog(viewport) {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        viewport,
        args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
    })
    await context.route(/^https?:\/\//, route => route.fulfill({ status: 404, body: "" }))
    let [worker] = context.serviceWorkers()
    worker ??= await context.waitForEvent("serviceworker")
    const page = await context.newPage()
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/app.html`, { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(1500)
    await page.evaluate(seed, behind)
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Library" }).click()
    await page.locator(".filter-chips .chip", { hasText: /^\s*All/ }).click()
    await page.locator("article", { hasText: "Behind By Seven" }).getByRole("button", { name: "Options" }).click()
    const dialog = page.getByRole("dialog", { name: "Behind By Seven" })
    await expect(dialog).toBeVisible()
    return { context, page, dialog }
}

test("the options dialog marks a title read up to its latest chapter in one click", async () => {
    const { context, page, dialog } = await openDialog({ width: 1280, height: 900 })
    try {
        await expect(dialog.getByText("7 new")).toBeVisible()
        await page.screenshot({ path: path.join(SHOTS, "title-dialog-wide.png") })
        const caughtUp = page.getByRole("button", { name: /Read up to latest \(Ch 10\)/ })
        await expect(caughtUp).toBeVisible()
        await caughtUp.click()

        await expect.poll(() => page.evaluate(readNumber, behind.id)).toBe(10)
        await expect(caughtUp).toHaveCount(0)
        await expect(page.getByLabel("Read ch")).toHaveValue("10")
        await expect(dialog.getByText("7 new")).toHaveCount(0)
    } finally {
        await context.close()
    }
})

test("the options dialog shows its title, one selected status and its main actions without scrolling", async () => {
    const { context, page, dialog } = await openDialog({ width: 1280, height: 720 })
    try {
        await expect(dialog.getByRole("heading", { name: "Behind By Seven" })).toBeInViewport()
        await expect(dialog.getByRole("button", { name: "Continue reading" })).toBeInViewport()
        await expect(dialog.getByRole("button", { name: /Read up to latest/ })).toBeInViewport()
        const status = dialog.getByRole("group", { name: "Status" })
        await expect(status.locator('button[aria-pressed="true"]')).toHaveCount(1)
        await expect(status.getByRole("button", { name: "Reading" })).toHaveAttribute("aria-pressed", "true")

        await status.getByRole("button", { name: "On Hold" }).click()
        await expect(status.getByRole("button", { name: "On Hold" })).toHaveAttribute("aria-pressed", "true")
        await expect(status.locator('button[aria-pressed="true"]')).toHaveCount(1)

        await dialog.getByRole("button", { name: "Close", exact: true }).click()
        await expect(page.getByRole("dialog")).toHaveCount(0)
    } finally {
        await context.close()
    }
})

test("the options dialog stacks into one column with no sideways scroll in a narrow window", async () => {
    const { context, page, dialog } = await openDialog({ width: 420, height: 800 })
    try {
        await expect(dialog.getByRole("heading", { name: "Behind By Seven" })).toBeVisible()
        await page.screenshot({ path: path.join(SHOTS, "title-dialog-narrow.png") })
        const overflow = await dialog.evaluate(el => el.scrollWidth - el.clientWidth)
        expect(overflow).toBeLessThanOrEqual(0)
        await expect(page.getByLabel("Read ch")).toHaveValue("3")
        await page.getByLabel("Read ch").scrollIntoViewIfNeeded()
        await expect(page.getByLabel("Read ch")).toBeInViewport()
    } finally {
        await context.close()
    }
})
