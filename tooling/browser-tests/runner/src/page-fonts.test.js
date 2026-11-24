import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { artifactsDirectory, chromiumExtension } from "../../src/paths.js"

// Chrome gives extension pages its own body font (Segoe UI or system-ui at 75%), which Firefox does not. Every
// extension page sets its own body font so both browsers draw the same type. The toolbar popup also fits a
// phone-width window (Firefox for Android) with no sideways scroll.

const SHOTS = process.env.JOURNEY_SHOTS ?? path.join(artifactsDirectory, "journey-shots")
mkdirSync(SHOTS, { recursive: true })

async function launch(viewport) {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        viewport,
        args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
    })
    await context.route(/^https?:\/\//, route => route.fulfill({ status: 404, body: "" }))
    let [worker] = context.serviceWorkers()
    worker ??= await context.waitForEvent("serviceworker")
    return { context, base: `chrome-extension://${new URL(worker.url()).host}` }
}

const bodyFont = page =>
    page.evaluate(() => {
        const style = getComputedStyle(document.body)
        return { size: style.fontSize, family: style.fontFamily }
    })

for (const entry of ["app.html", "popup.html"]) {
    test(`${entry} sets its own body font`, async () => {
        const { context, base } = await launch({ width: 1280, height: 800 })
        try {
            const page = await context.newPage()
            await page.goto(`${base}/${entry}`, { waitUntil: "domcontentloaded" })
            const font = await bodyFont(page)
            expect(font.size).toBe("12px")
            expect(font.family.startsWith("Inter")).toBe(true)
        } finally {
            await context.close()
        }
    })
}

test("the toolbar popup fits a 360 px window", async () => {
    const { context, base } = await launch({ width: 360, height: 640 })
    try {
        const page = await context.newPage()
        await page.goto(`${base}/popup.html`, { waitUntil: "domcontentloaded" })
        const header = page.getByRole("button", { name: "Library", exact: true })
        await expect(header).toBeVisible()
        await page.screenshot({ path: path.join(SHOTS, "popup-360.png"), fullPage: true })
        const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        )
        expect(overflow).toBe(0)
        const box = await header.boundingBox()
        expect(box.x + box.width).toBeLessThanOrEqual(360)
    } finally {
        await context.close()
    }
})
