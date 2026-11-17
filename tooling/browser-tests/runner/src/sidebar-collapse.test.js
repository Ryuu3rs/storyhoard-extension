import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { chromiumExtension } from "../../src/paths.js"

// The app's left sidebar collapses to an icon rail, keeps working as navigation, remembers the
// choice across reloads, and auto-collapses on a narrow window without overwriting that choice.

async function openApp() {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        viewport: { width: 1280, height: 800 },
        args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
    })
    let [worker] = context.serviceWorkers()
    worker ??= await context.waitForEvent("serviceworker")
    const appUrl = `chrome-extension://${new URL(worker.url()).host}/app.html`
    const page = await context.newPage()
    await page.goto(appUrl, { waitUntil: "domcontentloaded" })
    return { context, page, worker }
}

const sidebar = page => page.locator("aside.app-sidebar")
const nav = page => page.getByRole("navigation", { name: "Main navigation" })
const labelOpacity = (page, name) =>
    nav(page)
        .locator(".rail-label", { hasText: name })
        .first()
        .evaluate(el => getComputedStyle(el).opacity)
const stored = worker =>
    worker.evaluate(async () => (await chrome.storage.local.get("sidebarCollapsed")).sidebarCollapsed)

test("the sidebar collapses to an icon rail, navigates, and remembers the choice", async () => {
    const { context, page, worker } = await openApp()
    try {
        const collapse = page.getByRole("button", { name: "Collapse sidebar" })
        await expect(collapse).toHaveAttribute("aria-expanded", "true")
        await expect(nav(page).locator(".rail-label", { hasText: "Library" })).toBeVisible()
        expect(await labelOpacity(page, "Library")).toBe("1")

        await collapse.click()
        const expand = page.getByRole("button", { name: "Expand sidebar" })
        await expect(expand).toHaveAttribute("aria-expanded", "false")
        await expect.poll(async () => (await sidebar(page).boundingBox()).width).toBeLessThan(80)
        expect(await labelOpacity(page, "Library")).toBe("0")
        await expect(page.locator(".brand-name")).toBeHidden()
        await expect(page.locator(".sidebar-version")).toBeHidden()
        const icons = nav(page).locator("svg.nav-icon")
        expect(await icons.count()).toBeGreaterThanOrEqual(7)
        for (const icon of await icons.all()) await expect(icon).toBeVisible()
        await expect.poll(() => stored(worker)).toBe(true)

        const stats = nav(page).getByRole("button", { name: "Stats", exact: true })
        await stats.hover()
        await expect.poll(() => labelOpacity(page, "Stats")).toBe("1")
        await stats.click()
        await expect(stats).toHaveAttribute("aria-current", "page")
        await expect(page.getByRole("button", { name: /^(Sign in|Account)$/ })).toBeVisible()

        await page.addInitScript(() => {
            new MutationObserver((_, observer) => {
                const shell = document.querySelector(".shell")
                if (!shell) return
                window.__firstShellClass = shell.className
                observer.disconnect()
            }).observe(document, { childList: true, subtree: true })
        })
        await page.reload({ waitUntil: "domcontentloaded" })
        await expect(page.locator(".shell")).toHaveClass(/sidebar-collapsed/)
        expect(await page.evaluate(() => window.__firstShellClass)).toContain("sidebar-collapsed")
        await expect(page.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute("aria-expanded", "false")

        await page.getByRole("button", { name: "Expand sidebar" }).click()
        await expect.poll(() => stored(worker)).toBe(false)
        await page.reload({ waitUntil: "domcontentloaded" })
        await expect(page.getByRole("button", { name: "Collapse sidebar" })).toHaveAttribute("aria-expanded", "true")
        await expect.poll(async () => (await sidebar(page).boundingBox()).width).toBeGreaterThan(150)
    } finally {
        await context.close()
    }
})

test("a narrow window auto-collapses the sidebar without overwriting the remembered choice", async () => {
    const { context, page, worker } = await openApp()
    try {
        await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible()
        await page.setViewportSize({ width: 800, height: 700 })
        const expand = page.getByRole("button", { name: "Expand sidebar" })
        await expect(expand).toHaveAttribute("aria-expanded", "false")
        await expect.poll(async () => (await sidebar(page).boundingBox()).width).toBeLessThan(80)

        await expand.click()
        await expect(page.getByRole("button", { name: "Collapse sidebar" })).toHaveAttribute("aria-expanded", "true")
        expect(await stored(worker)).toBeUndefined()
        expect(
            await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        ).toBeLessThanOrEqual(0)

        await page.setViewportSize({ width: 1280, height: 800 })
        await expect(page.getByRole("button", { name: "Collapse sidebar" })).toHaveAttribute("aria-expanded", "true")
        await page.setViewportSize({ width: 800, height: 700 })
        await expect(page.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute("aria-expanded", "false")
    } finally {
        await context.close()
    }
})
