import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { artifactsDirectory, chromiumExtension } from "../../src/paths.js"

// After an update check where some titles could not be checked because their site is not connected, the
// Activity page lists them under "Needs attention". It must not then claim everything is up to date: those
// titles were never checked. Hosts are made up and stubbed.

const SHOTS = process.env.JOURNEY_SHOTS ?? path.join(artifactsDirectory, "journey-shots")
mkdirSync(SHOTS, { recursive: true })

const HOST = "oldreader-demo.net"
const row = (id, title) => ({
    id,
    title,
    normalizedTitle: title.toLowerCase(),
    authors: [],
    status: "ongoing",
    sourceId: "oldreader",
    sourceUrl: `https://${HOST}/series/${id}/chapter-1`,
    sourceMangaId: id,
    mangaUrl: `https://${HOST}/series/${id}`,
    addedAt: 1,
    updatedAt: 1
})
const PROFILE = {
    profileFormat: 2,
    id: "oldreader",
    name: "oldreader",
    engine: "generic",
    numberingKind: "chapter",
    origin: `https://${HOST}`,
    domains: [HOST],
    languages: ["en"],
    capabilities: ["manga"],
    requestRateLimit: { requests: 3, intervalMs: 1000 },
    origins: [`https://${HOST}/*`],
    match: { manga: "^/series/([a-z0-9-]+)/?$", chapter: "^/series/([a-z0-9-]+)/chapter-([0-9]+)/?$" },
    series: { urlTemplate: "/series/{slug}", titlePattern: "<title>(?<title>[^<]+)</title>" }
}

const seed = ({ manga, profiles }) =>
    new Promise((resolve, reject) => {
        const open = indexedDB.open("all-mangas-reader")
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
            const db = open.result
            const tx = db.transaction(["manga", "archProfiles"], "readwrite")
            for (const m of manga) tx.objectStore("manga").put(m)
            for (const p of profiles) tx.objectStore("archProfiles").put(p)
            tx.oncomplete = () => {
                db.close()
                resolve()
            }
            tx.onerror = () => reject(tx.error)
        }
    })

test("Activity does not say everything is up to date when titles could not be checked", async () => {
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
        const appUrl = `chrome-extension://${new URL(worker.url()).host}/app.html`
        const page = await context.newPage()
        await page.goto(appUrl, { waitUntil: "domcontentloaded" })
        await page.waitForTimeout(1500)
        await page.evaluate(seed, {
            manga: [row("t1", "Unchecked One"), row("t2", "Unchecked Two")],
            profiles: [{ id: "oldreader", profile: PROFILE, importedAt: 1, origin: "seed" }]
        })
        await page.evaluate(() => chrome.runtime.sendMessage({ type: "updates:check" }))
        await expect
            .poll(
                () =>
                    page.evaluate(async () => (await chrome.storage.local.get("updateStatus")).updateStatus?.checkedAt),
                { timeout: 30_000 }
            )
            .toBeTruthy()
        await page.reload({ waitUntil: "domcontentloaded" })
        await page.locator("nav button", { hasText: "Activity" }).first().click()
        const main = page.locator("main")
        await expect(main.getByText("not connected")).toBeVisible()
        await expect(main.getByText(/Reconnect your sites/)).toBeVisible()
        await expect(main.getByText("Everything else is up to date.")).toBeVisible()
        await page.screenshot({ path: path.join(SHOTS, "activity-fix-it.png"), fullPage: true })
        await expect(main.getByText("Everything is up to date.")).toHaveCount(0)
    } finally {
        await context.close()
    }
})

async function openActivity() {
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

const quickAdd = (page, anilistId, title) =>
    page.evaluate(request => chrome.runtime.sendMessage(request), {
        type: "library:quick-add",
        anilistId,
        title,
        mode: "planning"
    })

const checkAndWait = async page => {
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "updates:check" }))
    await expect
        .poll(
            () => page.evaluate(async () => (await chrome.storage.local.get("updateStatus")).updateStatus?.checkedAt),
            { timeout: 30_000 }
        )
        .toBeTruthy()
}

const showActivity = async page => {
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.locator("nav button", { hasText: "Activity" }).first().click()
    return page.locator("main")
}

test("Activity before any check does not also say everything is up to date", async () => {
    const { context, page } = await openActivity()
    try {
        await quickAdd(page, 7101, "Planned One")
        const main = await showActivity(page)
        await expect(main.getByText("No update check has run yet.", { exact: false })).toBeVisible()
        await page.screenshot({ path: path.join(SHOTS, "activity-no-check.png"), fullPage: true })
        await expect(main.getByText("Everything is up to date.")).toHaveCount(0)
    } finally {
        await context.close()
    }
})

test("Activity with nothing to fix does not head the all-clear line with Needs attention", async () => {
    const { context, page } = await openActivity()
    try {
        await quickAdd(page, 7101, "Planned One")
        await quickAdd(page, 7102, "Planned Two")
        await checkAndWait(page)
        const main = await showActivity(page)
        await expect(main.getByText("Nothing needs fixing.", { exact: false })).toBeVisible()
        await page.screenshot({ path: path.join(SHOTS, "activity-nothing-to-fix.png"), fullPage: true })
        await expect(main.getByText("Needs attention", { exact: true })).toHaveCount(0)
    } finally {
        await context.close()
    }
})

test("Reconnect offers to turn on both sites when two are off", async () => {
    const { context, page } = await openActivity()
    try {
        const OTHER = "otherreader-demo.net"
        const other = {
            ...PROFILE,
            id: "otherreader",
            name: "otherreader",
            origin: `https://${OTHER}`,
            domains: [OTHER],
            origins: [`https://${OTHER}/*`]
        }
        const otherRow = (id, title) => ({
            ...row(id, title),
            sourceId: "otherreader",
            sourceUrl: `https://${OTHER}/series/${id}/chapter-1`,
            mangaUrl: `https://${OTHER}/series/${id}`
        })
        await page.evaluate(seed, {
            manga: [row("t1", "Unchecked One"), otherRow("t2", "Unchecked Two")],
            profiles: [
                { id: "oldreader", profile: PROFILE, importedAt: 1, origin: "seed" },
                { id: "otherreader", profile: other, importedAt: 1, origin: "seed" }
            ]
        })
        await checkAndWait(page)
        const main = await showActivity(page)
        await expect(main.getByText(/Reconnect your sites/)).toBeVisible()
        await page.screenshot({ path: path.join(SHOTS, "activity-two-sites.png"), fullPage: true })
        await expect(main.getByRole("button", { name: "Turn on both sites" })).toBeVisible()
    } finally {
        await context.close()
    }
})
