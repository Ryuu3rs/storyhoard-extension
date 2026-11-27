import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { artifactsDirectory, chromiumExtension } from "../../src/paths.js"

const SHOTS = process.env.JOURNEY_SHOTS ?? path.join(artifactsDirectory, "journey-shots")
mkdirSync(SHOTS, { recursive: true })

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

const seedPicks = page =>
    page.evaluate(() =>
        chrome.storage.local.set({
            suggestions: {
                updatedAt: Date.now(),
                suggestions: [
                    {
                        anilistId: 7001,
                        title: "Pick One",
                        genres: ["Action"],
                        frequency: 2,
                        overlapScore: 0.5,
                        community: false,
                        score: 1,
                        reasons: ["Own One"]
                    }
                ]
            }
        })
    )
test("weeb.ltd rails lead Discover, for an empty library and with the picks below them once there is one", async () => {
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
        await seedPicks(page)
        await page.reload({ waitUntil: "domcontentloaded" })

        await expect(main.getByRole("button", { name: /Rail Title One/ })).toBeVisible()
        await expect(main.getByRole("button", { name: /Rail Title Two/ })).toHaveCount(0)
        const picks = page.locator("[data-picks-head]")
        await expect(picks.getByRole("button", { name: "Mix it up" })).toBeVisible()
        await expect(picks.getByRole("button", { name: "Refresh" })).toBeVisible()
        const railsBox = await main.boundingBox()
        const picksBox = await picks.boundingBox()
        expect(picksBox.y).toBeGreaterThan(railsBox.y + railsBox.height - 1)
        await expect(page.getByRole("heading", { name: "Continue the series" })).toHaveCount(0)
        await expect(page.getByText("Rails powered by")).toBeVisible()
        await page.screenshot({ path: path.join(SHOTS, "discover-rails-then-picks.png"), fullPage: true })
    } finally {
        await context.close()
    }
})

test("weeb.ltd rails lead an established library that has no picks yet", async () => {
    const { context, page } = await openApp()
    try {
        const imported = await page.evaluate(
            async env => chrome.runtime.sendMessage({ type: "data:import", envelope: env }),
            libraryEnvelope(["Own One", "Own Two", "Own Three", "Own Four", "Own Five", "Own Six"])
        )
        expect(imported?.ok).toBe(true)
        await page.reload({ waitUntil: "domcontentloaded" })

        const main = page.locator(".weeb-discover-main")
        await expect(main.getByRole("button", { name: /Rail Title One/ })).toBeVisible()
        await expect(page.getByText("once they are matched on AniList", { exact: false })).toBeVisible()
        await expect(page.getByRole("heading", { name: "Start your library" })).toHaveCount(0)
        await expect(page.getByRole("heading", { name: "No picks for you yet" })).toBeVisible()
        await expect(page.getByRole("button", { name: "Mix it up" })).toHaveCount(0)
        await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible()
    } finally {
        await context.close()
    }
})

test("a title's site search shows the first eight sites, and the rest behind a toggle", async () => {
    const { context, page } = await openApp()
    try {
        const now = Date.now()
        const profile = i => ({
            id: `added${i}`,
            profile: {
                profileFormat: 2,
                id: `added${i}`,
                name: `added${i}`,
                engine: "generic",
                numberingKind: "chapter",
                origin: `https://added${i}.example`,
                domains: [`added${i}.example`],
                languages: ["en"],
                capabilities: ["manga"],
                requestRateLimit: { requests: 3, intervalMs: 1000 },
                origins: [`https://added${i}.example/*`],
                match: { manga: "^/series/([a-z0-9-]+)/?$", chapter: "^/series/([a-z0-9-]+)/chapter-([0-9]+)/?$" },
                series: { urlTemplate: "/series/{slug}", titlePattern: "<title>(?<title>[^<]+)</title>" }
            },
            importedAt: 1,
            origin: "user"
        })
        const manga = Array.from({ length: 8 }, (_, i) => ({
            id: `e2e:manga:${i}`,
            title: `Spread Title ${i}`,
            normalizedTitle: `spread title ${i}`,
            authors: [],
            status: "ongoing",
            addedAt: now,
            updatedAt: now,
            sourceId: "e2e",
            sourceUrl: `https://site${i}.example/series/spread-${i}/chapter-1`,
            mangaUrl: `https://site${i}.example/series/spread-${i}`
        }))
        await page.evaluate(
            ({ manga, profiles }) =>
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
                }),
            { manga, profiles: [1, 2, 3, 4].map(profile) }
        )
        await page.reload({ waitUntil: "domcontentloaded" })
        await page
            .locator(".weeb-discover-main")
            .getByRole("button", { name: /Rail Title One/ })
            .click()
        const chips = page.locator("[data-site-search-chips]")
        const more = chips.getByRole("button", { name: /^\+\d+ more$/ })
        await expect(more).toBeVisible()
        await expect(chips.getByRole("button")).toHaveCount(9)
        await more.click()
        await expect(chips.getByRole("button", { name: "Show fewer" })).toBeVisible()
        expect(await chips.getByRole("button").count()).toBeGreaterThan(9)
    } finally {
        await context.close()
    }
})

test("sequels to series you read sit in Library under Next in your series, not on Discover", async () => {
    const { context, page } = await openApp()
    try {
        const imported = await page.evaluate(
            async env => chrome.runtime.sendMessage({ type: "data:import", envelope: env }),
            libraryEnvelope(["Own One", "Own Two", "Own Three", "Own Four", "Own Five", "Own Six"])
        )
        expect(imported?.ok).toBe(true)
        await page.evaluate(() =>
            chrome.storage.local.set({
                nextInSeries: {
                    updatedAt: Date.now(),
                    suggestions: [
                        {
                            anilistId: 8001,
                            title: "Sequel Season Two",
                            genres: ["Action"],
                            frequency: 1,
                            overlapScore: 1,
                            community: false,
                            score: 1,
                            reasons: ["Own One"]
                        }
                    ]
                }
            })
        )
        await page.reload({ waitUntil: "domcontentloaded" })
        await expect(page.locator(".weeb-discover-main")).toBeVisible()
        await expect(page.getByRole("heading", { name: "Continue the series" })).toHaveCount(0)

        await page.locator("nav button", { hasText: "Library" }).first().click()
        const button = page.locator("[data-next-in-series]")
        await expect(button).toContainText("1")
        await button.click()
        const pop = page.getByRole("dialog", { name: "Next in your series" })
        await expect(pop.getByText("Sequel Season Two")).toBeVisible()
        await page.screenshot({ path: path.join(SHOTS, "library-next-in-series.png") })
        await pop.getByRole("button", { name: "Close" }).click()
        await expect(pop).toHaveCount(0)
    } finally {
        await context.close()
    }
})
