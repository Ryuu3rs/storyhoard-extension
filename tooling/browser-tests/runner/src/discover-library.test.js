import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { chromiumExtension } from "../../src/paths.js"

// The app page's own behaviour, on a seeded library: the filter it opens on, the per-page control, opening
// a title from Activity, and the search popover's backdrop. Nothing here reaches a live site.

const SITE = "https://mangadex.org"
const row = (id, title, extra = {}) => ({
    id,
    title,
    normalizedTitle: title.toLowerCase(),
    authors: [],
    status: "ongoing",
    addedAt: 1,
    updatedAt: 1,
    sourceId: "mangadex",
    sourceUrl: `${SITE}/chapter/${id}`,
    mangaUrl: `${SITE}/title/${id}`,
    ...extra
})

const seed = ({ manga, history }) =>
    new Promise((resolve, reject) => {
        const open = indexedDB.open("all-mangas-reader")
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
            const db = open.result
            const tx = db.transaction(["manga", "historyEvents"], "readwrite")
            for (const m of manga) tx.objectStore("manga").put(m)
            for (const h of history) tx.objectStore("historyEvents").put(h)
            tx.oncomplete = () => {
                db.close()
                resolve()
            }
            tx.onerror = () => reject(tx.error)
        }
    })

async function openApp(manga, history = []) {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
    })
    let [worker] = context.serviceWorkers()
    worker ??= await context.waitForEvent("serviceworker")
    const appUrl = `chrome-extension://${new URL(worker.url()).host}/app.html`
    const page = await context.newPage()
    await page.goto(appUrl, { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(1500)
    await page.evaluate(seed, { manga, history })
    await page.goto(appUrl, { waitUntil: "domcontentloaded" })
    return { context, page }
}

const activeFilter = page => page.locator(".filter-chips .chip.active")
const openSection = (page, name) => page.locator("nav button", { hasText: name }).first().click()

test("the library opens on Updates when something is new, and offers All per page", async () => {
    const titles = Array.from({ length: 60 }, (_, i) => row(`m${i}`, `Quiet ${i}`))
    titles.push(row("fresh", "Fresh Title", { latestChapterNumber: 9, lastReadChapterNumber: 3 }))
    const { context, page } = await openApp(titles)
    try {
        await openSection(page, "Library")
        await expect(activeFilter(page)).toContainText("Updates")
        await expect(page.getByText("Fresh Title").first()).toBeVisible()

        await page.locator(".filter-chips .chip", { hasText: "All" }).first().click()
        await page.getByLabel("Items per page").selectOption({ label: "All" })
        await expect(page.getByRole("button", { name: /Load more/ })).toHaveCount(0)
    } finally {
        await context.close()
    }
})

test("the library falls back when nothing is new, instead of opening empty", async () => {
    const { context, page } = await openApp([row("q", "Quiet Title")])
    try {
        await openSection(page, "Library")
        await expect(activeFilter(page)).toContainText("Ongoing")
        await expect(page.getByText("Quiet Title").first()).toBeVisible()
    } finally {
        await context.close()
    }
})

test("Activity opens a title on its site, even with no saved chapter row", async () => {
    const address = "https://history-title.invalid/title/t1"
    const history = [{ id: "h1", mangaId: "t1", type: "completed", occurredAt: Date.now() }]
    const { context, page } = await openApp([row("t1", "History Title", { mangaUrl: address })], history)
    try {
        await openSection(page, "Activity")
        await page.getByRole("button", { name: "History", exact: true }).click()
        await page.getByRole("button", { name: "History Title" }).click()
        const [worker] = context.serviceWorkers()
        await expect
            .poll(() => worker.evaluate(async () => (await chrome.tabs.query({})).map(t => t.pendingUrl || t.url)))
            .toContain(address)

        await page.getByRole("button", { name: "Show chapters" }).click()
        await expect(page.locator(".history-row.clickable")).toHaveCount(1)
    } finally {
        await context.close()
    }
})

test("the search popover's backdrop stays clear on hover, and it closes", async () => {
    const { context, page } = await openApp([row("q", "Quiet Title")])
    try {
        const field = page.getByPlaceholder(/search/i).first()
        await field.fill("zzzz no such title")
        await field.press("Enter")
        const backdrop = page.locator(".search-backdrop")
        await expect(backdrop).toBeVisible()
        await backdrop.hover({ position: { x: 5, y: 5 } })
        await expect.poll(() => backdrop.evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)")

        await page.keyboard.press("Escape")
        await expect(backdrop).toHaveCount(0)

        await field.fill("zzzz again")
        await field.press("Enter")
        await expect(backdrop).toBeVisible()
        await backdrop.click({ position: { x: 5, y: 5 } })
        await expect(backdrop).toHaveCount(0)
    } finally {
        await context.close()
    }
})

test("the account row says when sync is paused or failing", async () => {
    const { context, page } = await openApp([])
    try {
        const [worker] = context.serviceWorkers()
        const setProblem = syncProblem =>
            worker.evaluate(
                problem =>
                    chrome.storage.local.set({
                        account: {
                            token: "test_token",
                            lastPushAt: 0,
                            lastSyncAt: 0,
                            invalid: false,
                            autoSync: false,
                            syncProblem: problem
                        }
                    }),
                syncProblem
            )
        await setProblem("suspended")
        await page.reload({ waitUntil: "domcontentloaded" })
        await openSection(page, "Settings")
        await page.getByRole("button", { name: "weeb.ltd account" }).first().click()
        await expect(page.getByText("account suspended, sync paused")).toBeVisible()

        await setProblem("failed")
        await page.reload({ waitUntil: "domcontentloaded" })
        await openSection(page, "Settings")
        await page.getByRole("button", { name: "weeb.ltd account" }).first().click()
        await expect(page.getByText("last sync failed")).toBeVisible()
    } finally {
        await context.close()
    }
})
