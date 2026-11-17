import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { chromiumExtension } from "../../src/paths.js"

// Discover's weeb.ltd rails, with weeb.ltd stubbed through route interception: they lead an empty library,
// drop to a smaller section once the library has titles, and never show a title the library already has.
// A rail item opens the title page, where "Search the web" sits below the official option.

const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
)

const item = (anilistId, title, extra = {}) => ({
    anilistId,
    workId: null,
    title,
    altTitles: [],
    cover: `https://s4.anilist.co/file/cover-${anilistId}.png`,
    mediaType: "manhwa",
    genres: ["Action"],
    isAdult: false,
    metric: `${anilistId} readers`,
    ...extra
})

const RAILS = {
    trending: { label: "Trending", note: null, items: [item(901, "Rail Title One"), item(902, "Rail Title Two")] },
    seasonal: { label: "Fall 2026", note: null, items: [item(903, "Season Title")] },
    staff: { label: "Staff picks", note: null, items: [] },
    community: { label: "Community picks", note: "This week's vote", items: [item(904, "Voted Title")] }
}

async function stubNetwork(context) {
    const requests = []
    await context.route("https://weeb.ltd/**", route => {
        const request = route.request()
        const url = new URL(request.url())
        requests.push({ url: url.href, cookie: request.headers()["cookie"] })
        if (url.pathname === "/api/public/discover") {
            const rail = url.searchParams.get("rail")
            const body = RAILS[rail]
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ rail, genre: null, ...body })
            })
        }
        if (/^\/api\/work\/[^/]+\/offers$/.test(url.pathname)) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    best: { name: "Official Store", format: "Digital", outUrl: "https://weeb.ltd/out/test" }
                })
            })
        }
        return route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
    })
    await context.route("https://s4.anilist.co/**", route =>
        route.fulfill({ status: 200, contentType: "image/png", body: PNG })
    )
    await context.route("https://graphql.anilist.co/**", route =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: null }) })
    )
    return requests
}

async function openApp() {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
    })
    const requests = await stubNetwork(context)
    let [worker] = context.serviceWorkers()
    worker ??= await context.waitForEvent("serviceworker")
    const appUrl = `chrome-extension://${new URL(worker.url()).host}/app.html`
    const page = await context.newPage()
    await page.goto(appUrl, { waitUntil: "domcontentloaded" })
    return { context, page, requests }
}

const libraryEnvelope = titles => {
    const now = Date.now()
    return {
        format: "all-mangas-reader",
        version: 1,
        data: {
            manga: titles.map((title, i) => ({
                id: `e2e:manga:${i}`,
                title,
                normalizedTitle: title.toLowerCase(),
                authors: [],
                status: "ongoing",
                addedAt: now,
                updatedAt: now,
                sourceId: "e2e",
                sourceUrl: `https://example.com/e2e-${i}`
            }))
        }
    }
}

test("weeb.ltd rails lead an empty library and drop below the picks once there is one", async () => {
    const { context, page, requests } = await openApp()
    try {
        const main = page.locator(".weeb-discover-main")
        await expect(main.getByRole("heading", { name: "Trending" })).toBeVisible()
        await expect(main.getByRole("heading", { name: "Fall 2026" })).toBeVisible()
        await expect(main.getByText("This week's vote")).toBeVisible()
        await expect(main.getByRole("heading", { name: "Staff picks" })).toHaveCount(0)
        await expect(main.getByRole("button", { name: /Rail Title One/ })).toBeVisible()
        expect(requests.filter(r => r.url.includes("/api/public/discover")).every(r => !r.cookie)).toBe(true)

        await main.getByRole("button", { name: /Rail Title One/ }).click()
        await expect(page.locator(".title-hero-name")).toHaveText("Rail Title One")
        const official = page.locator(".where-official")
        await expect(official).toContainText("Official Store")
        const webSearch = page.getByRole("button", { name: /Search the web/ })
        await expect(webSearch).toBeVisible()
        const officialBox = await official.boundingBox()
        const webBox = await webSearch.boundingBox()
        expect(webBox.y).toBeGreaterThan(officialBox.y + officialBox.height)
        await expect(page.locator(".where-web-hint")).toContainText("Rail Title One manhwa")

        await page.getByRole("button", { name: "← Discover" }).click()
        await expect(main).toBeVisible()
        await expect(page.getByRole("button", { name: "Mix it up" })).toHaveCount(0)
        await expect(page.getByRole("button", { name: "Refresh" })).toHaveCount(0)

        await main.getByRole("button", { name: /Season Title/ }).click()
        await page.getByRole("button", { name: "Add to library" }).click()
        await expect(page.getByRole("button", { name: "✓ In your library" })).toBeDisabled()
        await expect(page.locator(".where-owned")).toContainText("plan to read")
        await page.getByRole("button", { name: "← Discover" }).click()
        await expect(main.getByRole("heading", { name: "Trending" })).toBeVisible()
        await expect(main.getByRole("button", { name: /Season Title/ })).toHaveCount(0)
        await expect(main.getByRole("heading", { name: "Fall 2026" })).toHaveCount(0)
        await page.locator("nav button", { hasText: "Library" }).first().click()
        await page.locator(".filter-chips .chip", { hasText: "All" }).first().click()
        const card = page.locator("article", { hasText: "Season Title" }).first()
        await expect(card).toBeVisible()
        await expect(card).toContainText("Planning")
        await page.locator("nav button", { hasText: "Discover" }).first().click()

        const imported = await page.evaluate(
            async env => chrome.runtime.sendMessage({ type: "data:import", envelope: env }),
            libraryEnvelope(["Rail Title Two", "Own One", "Own Two", "Own Three", "Own Four"])
        )
        expect(imported?.ok).toBe(true)
        await page.reload({ waitUntil: "domcontentloaded" })

        const more = page.locator(".weeb-discover-more")
        await expect(more.getByRole("button", { name: /Rail Title One/ })).toBeVisible()
        await expect(page.locator(".weeb-discover-main")).toHaveCount(0)
        await expect(more.getByRole("button", { name: /Rail Title Two/ })).toHaveCount(0)
        await expect(page.getByRole("button", { name: "Mix it up" })).toBeVisible()
    } finally {
        await context.close()
    }
})
