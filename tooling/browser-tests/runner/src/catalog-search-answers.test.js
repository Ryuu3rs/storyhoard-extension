import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { chromiumExtension } from "../../src/paths.js"

// A hostile (or simply buggy) weeb.ltd title-search answer, stubbed through route
// interception. weeb.ltd is first party, but the app must not break or store spoofed text because one JSON
// answer repeats a key or carries direction overrides.

const result = (extra = {}) => ({
    workId: "work-a",
    anilistId: 7001,
    title: "Plain Title",
    altTitles: [],
    cover: null,
    mediaType: "manga",
    status: "releasing",
    year: 2020,
    genres: ["Action"],
    isAdult: false,
    readers: 3,
    ...extra
})

async function openApp(searchResults) {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
    })
    await context.route("https://weeb.ltd/**", route => {
        const url = new URL(route.request().url())
        if (url.pathname === "/api/public/search") {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ results: searchResults })
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
    const errors = []
    page.on("pageerror", error => errors.push(String(error.message ?? error)))
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/app.html`, { waitUntil: "domcontentloaded" })
    return { context, page, errors }
}

async function search(page, term) {
    const field = page.getByPlaceholder("Search every source for a title…")
    await field.fill(term)
    await field.press("Enter")
}

test("two search results that share a work id still render, and the app keeps working", async () => {
    const { context, page, errors } = await openApp([result({ title: "Copy One" }), result({ title: "Copy Two" })])
    try {
        await search(page, "copy")
        await page.waitForTimeout(1500)
        expect(errors.filter(e => /each_key_duplicate|Keyed each block/i.test(e))).toEqual([])
        await expect(page.locator(".title-card", { hasText: "Copy One" })).toBeVisible()
    } finally {
        await context.close()
    }
})

test("a search result that repeats a genre still opens its title page", async () => {
    const { context, page, errors } = await openApp([result({ title: "Genre Repeat", genres: ["Action", "Action"] })])
    try {
        await search(page, "genre repeat")
        await page.locator(".title-card", { hasText: "Genre Repeat" }).click()
        await page.waitForTimeout(1000)
        expect(errors.filter(e => /each_key_duplicate|Keyed each block/i.test(e))).toEqual([])
        await expect(page.locator(".title-hero-name")).toHaveText("Genre Repeat")
    } finally {
        await context.close()
    }
})

test("Add to library from a search result does not store a direction override or zero-width text", async () => {
    const spoofed = "Real Name ‮gnp.exe‬ ​Hidden"
    const { context, page } = await openApp([result({ workId: "work-spoof", anilistId: 7002, title: spoofed })])
    try {
        await search(page, "real name")
        await page.locator(".title-card").first().click()
        await page.getByRole("button", { name: "Add to library" }).click()
        await expect(page.getByRole("button", { name: "✓ In your library" })).toBeDisabled()
        const listed = await page.evaluate(async () => chrome.runtime.sendMessage({ type: "library:list" }))
        const row = listed.data.find(m => m.anilistId === 7002)
        expect(row).toBeTruthy()
        expect(/[‪-‮⁦-⁩​-‏]/u.test(row.title)).toBe(false)
    } finally {
        await context.close()
    }
})
