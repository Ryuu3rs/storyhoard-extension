import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { chromiumExtension } from "../../src/paths.js"

// With Start page set to Library, opening the app must neither paint Discover first nor load
// Discover's network rails (weeb.ltd discover, AniList recommendations) for a page the user never sees.

async function launch() {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        viewport: { width: 1280, height: 800 },
        args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
    })
    const discoverRequests = []
    await context.route("https://weeb.ltd/**", route => {
        const url = new URL(route.request().url())
        if (url.pathname === "/api/public/discover") {
            discoverRequests.push(url.href)
            const rail = url.searchParams.get("rail")
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ rail, label: rail, note: null, genre: null, items: [] })
            })
        }
        return route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
    })
    await context.route("https://graphql.anilist.co/**", route =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: null }) })
    )
    let [worker] = context.serviceWorkers()
    worker ??= await context.waitForEvent("serviceworker")
    return { context, worker, discoverRequests }
}

test("Start page Library: the app opens on Library without painting or loading Discover", async () => {
    const { context, worker, discoverRequests } = await launch()
    try {
        await worker.evaluate(async () => chrome.storage.local.set({ settings: { startPage: "library" } }))
        const page = await context.newPage()
        await page.addInitScript(() => {
            window.__sectionsSeen = []
            new MutationObserver(() => {
                const current = document.querySelector('nav[aria-label="Main navigation"] button[aria-current="page"]')
                const name = current?.textContent?.trim()
                if (name && window.__sectionsSeen.at(-1) !== name) window.__sectionsSeen.push(name)
            }).observe(document, { childList: true, subtree: true, attributes: true })
        })
        const appUrl = `chrome-extension://${new URL(worker.url()).host}/app.html`
        await page.goto(appUrl, { waitUntil: "domcontentloaded" })
        await expect(
            page
                .getByRole("navigation", { name: "Main navigation" })
                .getByRole("button", { name: "Library", exact: true })
        ).toHaveAttribute("aria-current", "page")
        await page.waitForTimeout(1500)

        expect.soft(await page.evaluate(() => window.__sectionsSeen)).toEqual(["Library"])
        expect(discoverRequests).toEqual([])
    } finally {
        await context.close()
    }
})

test("Start page Library: a click on Discover while the app loads is never undone", async () => {
    const { context, worker } = await launch()
    try {
        await worker.evaluate(async () => chrome.storage.local.set({ settings: { startPage: "library" } }))
        const page = await context.newPage()
        await page.goto(`chrome-extension://${new URL(worker.url()).host}/app.html`, { waitUntil: "domcontentloaded" })
        const nav = page.getByRole("navigation", { name: "Main navigation" })
        await nav.getByRole("button", { name: "Discover", exact: true }).click()
        await page.waitForTimeout(1500)
        await expect(nav.getByRole("button", { name: "Discover", exact: true })).toHaveAttribute("aria-current", "page")
    } finally {
        await context.close()
    }
})
