import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { artifactsDirectory, chromiumExtension } from "../../src/paths.js"

// The app at 800 px and 600 px wide, and keyboard-only use of the sidebar and the Discover rails. weeb.ltd
// is stubbed.

const SHOTS = process.env.JOURNEY_SHOTS ?? path.join(artifactsDirectory, "journey-shots")
mkdirSync(SHOTS, { recursive: true })

const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
)
const item = (anilistId, title) => ({
    anilistId,
    workId: null,
    title,
    altTitles: [],
    cover: `https://s4.anilist.co/file/cover-${anilistId}.png`,
    mediaType: "manhwa",
    genres: ["Action"],
    isAdult: false,
    metric: `${anilistId} readers`
})
const RAILS = {
    trending: {
        label: "Trending",
        note: null,
        items: Array.from({ length: 12 }, (_, i) => item(900 + i, `Rail Title ${i + 1}`))
    },
    seasonal: { label: "Fall 2026", note: null, items: [item(950, "Season Title")] },
    staff: { label: "Staff picks", note: null, items: [] },
    community: { label: "Community picks", note: "This week's vote", items: [item(960, "Voted Title")] }
}

export async function openApp(viewport) {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        viewport,
        args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
    })
    await context.route(/^https?:\/\//, route => {
        const url = new URL(route.request().url())
        if (url.hostname === "weeb.ltd" && url.pathname === "/api/public/discover") {
            const rail = url.searchParams.get("rail")
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ rail, genre: null, ...(RAILS[rail] ?? { label: rail, items: [] }) })
            })
        }
        if (url.hostname === "s4.anilist.co") return route.fulfill({ status: 200, contentType: "image/png", body: PNG })
        return route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
    })
    let [worker] = context.serviceWorkers()
    worker ??= await context.waitForEvent("serviceworker")
    const page = await context.newPage()
    const errors = []
    page.on("pageerror", e => errors.push(`pageerror: ${e.message}`))
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/app.html`, { waitUntil: "domcontentloaded" })
    return { context, page, errors }
}

const overflowX = page =>
    page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

const mainNav = page => page.getByRole("navigation", { name: "Main navigation" })

for (const width of [800, 650, 600]) {
    test(`every section fits a ${width} px window with no sideways scroll`, async () => {
        const { context, page, errors } = await openApp({ width, height: 700 })
        try {
            await expect(page.locator(".weeb-discover-main").getByRole("heading", { name: "Trending" })).toBeVisible()
            const overflow = {}
            for (const section of ["Discover", "Library", "Activity", "Stats", "Sources", "Data", "Settings"]) {
                await mainNav(page).getByRole("button", { name: section, exact: true }).click()
                await page.waitForTimeout(600)
                overflow[section] = await overflowX(page)
                await page.screenshot({ path: path.join(SHOTS, `narrow-${width}-${section}.png`) })
            }
            expect(Object.entries(overflow).filter(([, px]) => px > 0)).toEqual([])
            expect(errors).toEqual([])
        } finally {
            await context.close()
        }
    })
}

test("keyboard only: sidebar, a Discover rail item, the title page and back", async () => {
    const { context, page } = await openApp({ width: 1280, height: 800 })
    try {
        const main = page.locator(".weeb-discover-main")
        const rail = main.getByRole("button", { name: /Rail Title 1\b/ })
        await expect(rail).toBeVisible()
        let reached = false
        for (let i = 0; i < 80 && !reached; i += 1) {
            if (await rail.evaluate(el => el === document.activeElement)) reached = true
            else await page.keyboard.press("Tab")
        }
        expect(reached).toBe(true)
        await page.keyboard.press("Enter")
        await expect(page.locator(".title-hero-name")).toHaveText("Rail Title 1")
    } finally {
        await context.close()
    }
})

// At 600 px the sidebar is a top bar. Its footer (Scales, version, Sign in, Discord, Ko-fi, weeb.ltd) used to
// stay a vertical stack beside the sections, so the bar took a third of the window and showed one section.
test("a 600 px window gets a compact top bar with the sections visible", async () => {
    const { context, page } = await openApp({ width: 600, height: 700 })
    try {
        await expect(page.locator(".weeb-discover-main").getByRole("heading", { name: "Trending" })).toBeVisible()
        const measure = await page.evaluate(() => {
            const aside = document.querySelector("aside.app-sidebar").getBoundingClientRect()
            const nav = document.querySelector("nav[aria-label='Main navigation']")
            const navBox = nav.getBoundingClientRect()
            const fully = [...nav.querySelectorAll("button")].filter(b => {
                const r = b.getBoundingClientRect()
                return r.left >= navBox.left - 1 && r.right <= navBox.right + 1
            }).length
            const active = nav.querySelector("button.active")
            return {
                asideHeight: Math.round(aside.height),
                navWidth: Math.round(navBox.width),
                fullyVisibleSections: fully,
                activeArrow: active ? getComputedStyle(active, "::after").display : "none"
            }
        })
        await page.screenshot({ path: path.join(SHOTS, "narrow-600-top-bar.png") })
        expect.soft(measure.asideHeight, "top bar height").toBeLessThanOrEqual(110)
        expect.soft(measure.activeArrow, "active section arrow").toBe("none")
        expect(measure.fullyVisibleSections, "sections fully visible in the bar").toBeGreaterThanOrEqual(3)
        const sidebar = page.locator("aside.app-sidebar")
        for (const name of ["Sign in", "Join Discord", "Support on Ko-fi"]) {
            await expect(sidebar.getByRole("button", { name, exact: true })).toBeVisible()
        }
    } finally {
        await context.close()
    }
})

// Below 980 px the Settings rail stacks above the settings. It is an <aside> with a <nav>, and the app
// sidebar's rules used to reach it: a full window tall rail (an empty screen before the first setting) and
// the main nav's active arrow over the tab label.
test("at 800 px the first settings show without scrolling past an empty screen", async () => {
    const { context, page } = await openApp({ width: 800, height: 700 })
    try {
        await mainNav(page).getByRole("button", { name: "Settings", exact: true }).click()
        const heading = page.locator("main h2", { hasText: "Library & updates" }).first()
        await expect(heading).toBeAttached()
        await page.waitForTimeout(500)
        const top = await heading.evaluate(el => Math.round(el.getBoundingClientRect().top))
        const arrow = await page
            .locator("aside.settings-rail nav button.active")
            .evaluate(el => getComputedStyle(el, "::after").content)
        await page.screenshot({ path: path.join(SHOTS, "narrow-800-settings.png") })
        expect.soft(arrow, "settings tab arrow").toBe("none")
        expect(top, "first settings section top (window is 700 px tall)").toBeLessThan(700)
    } finally {
        await context.close()
    }
})
