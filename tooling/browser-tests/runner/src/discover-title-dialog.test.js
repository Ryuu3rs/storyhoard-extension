import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { chromiumExtension } from "../../src/paths.js"

// Keyboard use of the title view, opened from a weeb.ltd rail or a title search. It is a modal dialog: opening
// it moves focus in, Tab stays inside, and Escape or the back button gives focus back to the card that
// opened it, so a keyboard user never restarts from the top of the page.

const item = (anilistId, title) => ({
    anilistId,
    workId: null,
    title,
    altTitles: [],
    cover: null,
    mediaType: "manga",
    genres: ["Action"],
    isAdult: false,
    metric: "1 reader"
})

const result = (workId, title) => ({
    workId,
    anilistId: null,
    title,
    altTitles: [],
    cover: null,
    mediaType: "manga",
    status: "releasing",
    year: 2020,
    genres: ["Action"],
    isAdult: false,
    readers: 3
})

async function openApp() {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        viewport: { width: 1280, height: 800 },
        args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
    })
    await context.route("https://weeb.ltd/**", route => {
        const url = new URL(route.request().url())
        if (url.pathname === "/api/public/discover") {
            const rail = url.searchParams.get("rail")
            const items =
                rail === "trending" ? [item(801, "Focus One"), item(802, "Focus Two"), item(803, "Focus Three")] : []
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ rail, label: "Trending", note: null, genre: null, items })
            })
        }
        if (url.pathname === "/api/public/search") {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ results: [result("w-a", "Search Alpha"), result("w-b", "Search Beta")] })
            })
        }
        return route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
    })
    await context.route("https://graphql.anilist.co/**", route =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: null }) })
    )
    let [worker] = context.serviceWorkers()
    worker ??= await context.waitForEvent("serviceworker")
    const page = await context.newPage()
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/app.html`, { waitUntil: "domcontentloaded" })
    return { context, page }
}

const focusInDialog = page =>
    page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
        return Boolean(dialog && dialog.contains(document.activeElement))
    })

const focusedText = page =>
    page.evaluate(() => {
        const el = document.activeElement
        return el === document.body || !el ? "body" : (el.textContent ?? "").trim()
    })

test("a rail title opens as a dialog that holds focus and gives it back to its card", async () => {
    const { context, page } = await openApp()
    try {
        const card = page.locator(".weeb-discover-main").getByRole("button", { name: /Focus Two/ })
        await expect(card).toBeVisible()
        await card.focus()
        await page.keyboard.press("Enter")

        const dialog = page.getByRole("dialog", { name: "Focus Two" })
        await expect(dialog).toBeVisible()
        await expect(dialog).toHaveAttribute("aria-modal", "true")
        await expect(page.getByRole("button", { name: "← Discover" })).toBeFocused()

        for (let i = 0; i < 12; i++) {
            await page.keyboard.press("Tab")
            expect(await focusInDialog(page)).toBe(true)
        }
        for (let i = 0; i < 12; i++) {
            await page.keyboard.press("Shift+Tab")
            expect(await focusInDialog(page)).toBe(true)
        }

        await page.keyboard.press("Escape")
        await expect(dialog).toHaveCount(0)
        await expect(card).toBeFocused()

        await page.keyboard.press("Enter")
        await expect(page.getByRole("button", { name: "← Discover" })).toBeFocused()
        await page.keyboard.press("Enter")
        await expect(page.getByRole("dialog")).toHaveCount(0)
        await expect(card).toBeFocused()
        expect(await focusedText(page)).toContain("Focus Two")
    } finally {
        await context.close()
    }
})

test("the command palette over a title keeps Tab, and Escape closes only the palette", async () => {
    const { context, page } = await openApp()
    try {
        const card = page.locator(".weeb-discover-main").getByRole("button", { name: /Focus One/ })
        await expect(card).toBeVisible()
        await card.focus()
        await page.keyboard.press("Enter")
        const dialog = page.getByRole("dialog", { name: "Focus One" })
        await expect(dialog).toBeVisible()

        await page.keyboard.press("ControlOrMeta+k")
        const paletteInput = page.locator(".palette-input")
        await expect(paletteInput).toBeFocused()

        await page.keyboard.press("Tab")
        const inPalette = await page.evaluate(() =>
            Boolean(document.querySelector(".palette")?.contains(document.activeElement))
        )
        expect(inPalette).toBe(true)

        await paletteInput.focus()
        await page.keyboard.press("Escape")
        await expect(page.locator(".palette")).toHaveCount(0)
        await expect(dialog).toBeVisible()
    } finally {
        await context.close()
    }
})

test("a search title opens as a dialog, and Escape goes back to the card in the results", async () => {
    const { context, page } = await openApp()
    try {
        const field = page.getByPlaceholder("Search every source for a title…")
        await field.fill("search")
        await field.press("Enter")
        const card = page.locator(".title-card", { hasText: "Search Beta" })
        await expect(card).toBeVisible()
        await card.focus()
        await page.keyboard.press("Enter")

        await expect(page.getByRole("dialog", { name: "Search Beta" })).toBeVisible()
        await expect(page.getByRole("button", { name: "← All titles" })).toBeFocused()

        await page.keyboard.press("Escape")
        await expect(page.getByRole("dialog")).toHaveCount(0)
        await expect(page.locator(".title-card", { hasText: "Search Beta" })).toBeFocused()

        await page.keyboard.press("Escape")
        await expect(page.locator(".search-backdrop")).toHaveCount(0)
    } finally {
        await context.close()
    }
})
