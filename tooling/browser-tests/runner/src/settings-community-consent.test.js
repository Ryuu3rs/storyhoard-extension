import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { chromiumExtension } from "../../src/paths.js"

// Community features are opt-in through the consent card only. Switching them on in Settings opens that
// card and turns nothing on; only its Turn on does. Switching them off stays immediate.

async function launch() {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        viewport: { width: 1280, height: 800 },
        args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
    })
    await context.route("https://weeb.ltd/**", route =>
        route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
    )
    await context.route("https://graphql.anilist.co/**", route =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: null }) })
    )
    let [worker] = context.serviceWorkers()
    worker ??= await context.waitForEvent("serviceworker")
    return { context, worker }
}

const profile = worker => worker.evaluate(async () => (await chrome.storage.local.get("community")).community ?? {})

test("the Settings community switch opens the consent card, and only Turn on turns community on", async () => {
    const { context, worker } = await launch()
    try {
        const page = await context.newPage()
        await page.goto(`chrome-extension://${new URL(worker.url()).host}/app.html`, { waitUntil: "domcontentloaded" })
        await page
            .getByRole("navigation", { name: "Main navigation" })
            .getByRole("button", { name: "Settings" })
            .click()

        const row = page.locator("#settings-community .settings-row", { hasText: "Community features" }).first()
        const checkbox = row.locator("input[type=checkbox]")
        const card = page.getByRole("region", { name: "Community features" })
        await expect(checkbox).not.toBeChecked()
        await expect(card).toHaveCount(0)

        await row.locator("label.toggle").click()
        await expect(card).toBeVisible()
        await expect(card.getByRole("button", { name: "Turn on" })).toBeFocused()
        await expect(checkbox).not.toBeChecked()
        expect((await profile(worker)).enabled).not.toBe(true)

        await card.getByRole("button", { name: "No thanks" }).click()
        await expect(card).toHaveCount(0)
        await expect(checkbox).not.toBeChecked()
        expect((await profile(worker)).enabled).not.toBe(true)

        await row.locator("label.toggle").click()
        await expect(card).toBeVisible()
        await card.getByRole("button", { name: "Turn on" }).click()
        await expect(card).toHaveCount(0)
        await expect.poll(async () => (await profile(worker)).enabled).toBe(true)
        await expect(checkbox).toBeChecked()
        await expect(page.locator(".sug-toast")).toContainText("Community features are on.")

        await row.locator("label.toggle").click()
        await expect(card).toHaveCount(0)
        await expect.poll(async () => (await profile(worker)).enabled).toBe(false)
        await expect(checkbox).not.toBeChecked()
    } finally {
        await context.close()
    }
})
