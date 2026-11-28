import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { chromiumExtension } from "../../src/paths.js"

// Tracking a title from its Discover page files it under the name that page shows. A source can name the
// same series by a romanization nobody searches for; the library used to take that name, so the title
// changed name between Discover, the library and the chapter list.

const DISCOVER_NAME = "Lone Climber"
const SOURCE_NAME = "Na Honja Oreuneun Saram"
const SERIES_ID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f"

const item = {
    anilistId: 901,
    workId: null,
    title: DISCOVER_NAME,
    altTitles: [SOURCE_NAME],
    cover: null,
    mediaType: "manga",
    genres: ["Action"],
    isAdult: false,
    metric: "1 reader"
}

const sourceSeries = {
    id: SERIES_ID,
    type: "manga",
    attributes: {
        title: { "ko-ro": SOURCE_NAME },
        altTitles: [{ en: DISCOVER_NAME }],
        status: "ongoing",
        contentRating: "safe",
        createdAt: "2020-01-01T00:00:00+00:00",
        updatedAt: "2020-01-01T00:00:00+00:00"
    },
    relationships: []
}

const titlesInLibrary = () =>
    new Promise((resolve, reject) => {
        const open = indexedDB.open("all-mangas-reader")
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
            const db = open.result
            const req = db.transaction(["manga"], "readonly").objectStore("manga").getAll()
            req.onsuccess = () => {
                db.close()
                resolve(req.result.map(m => m.title))
            }
            req.onerror = () => reject(req.error)
        }
    })

test("a title tracked from its Discover page keeps the name Discover shows", async () => {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        viewport: { width: 1280, height: 900 },
        args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
    })
    try {
        await context.route(/^https?:\/\//, route => {
            const url = new URL(route.request().url())
            if (url.hostname === "weeb.ltd" && url.pathname === "/api/public/discover") {
                const rail = url.searchParams.get("rail")
                return route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        rail,
                        label: "Trending",
                        note: null,
                        genre: null,
                        items: rail === "trending" ? [item] : []
                    })
                })
            }
            if (url.hostname === "api.mangadex.org" && url.pathname === "/manga") {
                return route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ result: "ok", data: [sourceSeries] })
                })
            }
            return route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
        })
        let [worker] = context.serviceWorkers()
        worker ??= await context.waitForEvent("serviceworker")
        const page = await context.newPage()
        await page.goto(`chrome-extension://${new URL(worker.url()).host}/app.html`, { waitUntil: "domcontentloaded" })

        await page
            .locator(".weeb-discover-main")
            .getByRole("button", { name: new RegExp(DISCOVER_NAME) })
            .click()
        const dialog = page.getByRole("dialog", { name: DISCOVER_NAME })
        await expect(dialog).toBeVisible()
        const track = dialog.locator(".where-row").getByRole("button", { name: "Track", exact: true })
        await expect(track).toBeVisible({ timeout: 15_000 })
        await track.click()
        await expect(dialog.locator(".where-row").getByRole("button", { name: "✓ Tracking" })).toBeVisible()

        await expect.poll(() => page.evaluate(titlesInLibrary)).toEqual([DISCOVER_NAME])
    } finally {
        await context.close()
    }
})
