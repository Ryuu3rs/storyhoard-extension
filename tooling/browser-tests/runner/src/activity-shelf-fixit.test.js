import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { artifactsDirectory, chromiumExtension } from "../../src/paths.js"

// Activity puts what the user is reading first (the Continue shelf), and every problem row on it can be
// closed for good: a closed row stays hidden after a reload until "Show hidden". A row whose title has no
// name says so instead of "(untitled)", and a title renamed since the check shows its current name.

const SHOTS = process.env.JOURNEY_SHOTS ?? path.join(artifactsDirectory, "journey-shots")
mkdirSync(SHOTS, { recursive: true })

const row = (id, title, extra = {}) => ({
    id,
    title,
    normalizedTitle: title.toLowerCase(),
    authors: [],
    status: "ongoing",
    sourceId: "mangadex",
    sourceUrl: `https://mangadex.org/title/00000000-0000-4000-8000-00000000000${id.slice(-1)}`,
    sourceMangaId: `00000000-0000-4000-8000-00000000000${id.slice(-1)}`,
    addedAt: 1,
    updatedAt: 1,
    ...extra
})

const seed = ({ manga, status }) =>
    new Promise((resolve, reject) => {
        const open = indexedDB.open("all-mangas-reader")
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
            const db = open.result
            const tx = db.transaction(["manga"], "readwrite")
            for (const m of manga) tx.objectStore("manga").put(m)
            tx.oncomplete = () => {
                db.close()
                chrome.storage.local.set({ updateStatus: status }).then(resolve, reject)
            }
            tx.onerror = () => reject(tx.error)
        }
    })

async function openApp() {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        viewport: { width: 1280, height: 900 },
        args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
    })
    await context.route(/^https?:\/\//, route => route.fulfill({ status: 404, body: "" }))
    let [worker] = context.serviceWorkers()
    worker ??= await context.waitForEvent("serviceworker")
    const page = await context.newPage()
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/app.html`, { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(1500)
    return { context, page }
}

const showActivity = async page => {
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.locator("nav button", { hasText: "Activity" }).first().click()
    return page.locator("main")
}

const status = {
    checkedAt: Date.now(),
    updated: 0,
    failed: 2,
    checked: 3,
    errors: [
        { mangaId: "t1", title: "", message: "Request failed", sourceId: "mangadex", cause: "network" },
        { mangaId: "t2", title: "", message: "Request failed", sourceId: "mangadex", cause: "network" }
    ]
}

test("a closed problem row stays hidden after a reload, and rows show the title's current name", async () => {
    const { context, page } = await openApp()
    try {
        await page.evaluate(seed, {
            manga: [row("t1", "Renamed Since The Check"), row("t2", "")],
            status
        })
        const main = await showActivity(page)
        const fixit = main.locator("[data-fixit]")
        await expect(fixit.getByText("Renamed Since The Check")).toBeVisible()
        await expect(fixit.getByText("no name yet")).toBeVisible()
        await expect(fixit.getByText("(untitled)")).toHaveCount(0)
        await page.screenshot({ path: path.join(SHOTS, "activity-fixit-rows.png"), fullPage: true })

        await fixit.getByRole("button", { name: "Hide this problem" }).first().click()
        await expect(fixit.getByText("Renamed Since The Check")).toHaveCount(0)
        await expect(fixit.getByText("1 problem hidden")).toBeVisible()

        const again = (await showActivity(page)).locator("[data-fixit]")
        await expect(again.getByText("no name yet")).toBeVisible()
        await expect(again.getByText("Renamed Since The Check")).toHaveCount(0)
        await again.getByRole("button", { name: "Show hidden" }).click()
        await expect(again.getByText("Renamed Since The Check")).toBeVisible()
    } finally {
        await context.close()
    }
})

test("the row menu offers another source, stop checking and remove", async () => {
    const { context, page } = await openApp()
    try {
        await page.evaluate(seed, { manga: [row("t1", "Menu Title"), row("t2", "Other Title")], status })
        const fixit = (await showActivity(page)).locator("[data-fixit]")
        await fixit.getByRole("button", { name: "More options for Menu Title" }).click()
        const menu = fixit.getByRole("menu")
        await expect(menu.getByRole("menuitem", { name: "Use another source" })).toBeVisible()
        await expect(menu.getByRole("menuitem", { name: "Remove from library" })).toBeVisible()
        await menu.getByRole("menuitem", { name: "Stop checking this title" }).click()
        await expect
            .poll(() =>
                page.evaluate(
                    () =>
                        new Promise(resolve => {
                            const open = indexedDB.open("all-mangas-reader")
                            open.onsuccess = () => {
                                const get = open.result.transaction("manga").objectStore("manga").get("t1")
                                get.onsuccess = () => {
                                    resolve(get.result?.manualTracking === true)
                                    open.result.close()
                                }
                            }
                        })
                )
            )
            .toBe(true)
        await expect(fixit.getByText("Menu Title")).toHaveCount(0)
    } finally {
        await context.close()
    }
})

test("the Continue shelf leads Activity with what the user is reading", async () => {
    const { context, page } = await openApp()
    try {
        const now = Date.now()
        await page.evaluate(seed, {
            manga: [
                row("t1", "Reading Now", {
                    readingStatus: "reading",
                    lastReadAt: now - 3_600_000,
                    lastReadChapterNumber: 10,
                    latestChapterNumber: 13
                }),
                row("t2", "Finished Long Ago", {
                    status: "completed",
                    lastReadAt: now - 86_400_000,
                    lastReadChapterNumber: 50,
                    latestChapterNumber: 50
                })
            ],
            status: { checkedAt: now, updated: 0, failed: 0, checked: 2, errors: [] }
        })
        const main = await showActivity(page)
        const shelf = main.locator("[data-continue-shelf]")
        await expect(shelf.getByText("Continue reading")).toBeVisible()
        await expect(shelf.getByText("Reading Now")).toBeVisible()
        await expect(shelf.getByText("3 new")).toBeVisible()
        await expect(shelf.getByText("Finished Long Ago")).toHaveCount(0)
        await page.screenshot({ path: path.join(SHOTS, "activity-continue-shelf.png"), fullPage: true })
    } finally {
        await context.close()
    }
})
