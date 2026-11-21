import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { chromiumExtension } from "../../src/paths.js"

// A user with a real library opens the app on Discover. The new-library layout (weeb.ltd rails as
// the lead section, skeleton included) must never paint for them, not even before the library has loaded.

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

async function launch() {
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
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    rail,
                    label: rail,
                    note: null,
                    genre: null,
                    items: [item(9001, `Rail ${rail}`)]
                })
            })
        }
        return route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
    })
    await context.route("https://graphql.anilist.co/**", route =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: null }) })
    )
    let [worker] = context.serviceWorkers()
    worker ??= await context.waitForEvent("serviceworker")
    return { context, worker }
}

const envelope = titles => {
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

test("an established library never sees the new-library Discover layout while loading", async () => {
    const { context, worker } = await launch()
    try {
        const appUrl = `chrome-extension://${new URL(worker.url()).host}/app.html`
        const page = await context.newPage()
        await page.goto(appUrl, { waitUntil: "domcontentloaded" })
        const imported = await page.evaluate(
            async env => chrome.runtime.sendMessage({ type: "data:import", envelope: env }),
            envelope(["Own One", "Own Two", "Own Three", "Own Four", "Own Five", "Own Six", "Own Seven"])
        )
        expect(imported?.ok).toBe(true)

        await page.addInitScript(() => {
            window.__coldLayoutSeen = false
            new MutationObserver(() => {
                const el = document.querySelector(".weeb-discover-main")
                if (el && !window.__coldLayoutSeen)
                    window.__coldLayoutSeen = el.getAttribute("aria-busy") === "true" ? "skeleton" : "rails"
            }).observe(document, { childList: true, subtree: true })
        })
        await page.reload({ waitUntil: "domcontentloaded" })
        await expect(page.locator(".weeb-discover-more")).toBeVisible()
        expect(await page.evaluate(() => window.__coldLayoutSeen)).toBe(false)
    } finally {
        await context.close()
    }
})
