import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { chromiumExtension } from "../../src/paths.js"

// Proves the pop-up / pop-under guard actually works end-to-end: the background injects
// popupGuardMain into the page's MAIN world (so a page CSP can't disable it, unlike the old inline
// <script>), the isolated panel flips data-amr-block-popups=1 by default on a user-added site, and
// with it on the page's own window.open is neutered (returns null) - while toggling it off restores
// a real window. This is the regression guard for the "sent to an 18+ site on any click" bug.

// A user-added (Enhanced) host with a chapter-shaped URL so the panel injects. The body carries a
// cross-origin target=_blank anchor like the overlay-anchor pop-under trick.
const HOST = "weebcentral.com"
const URL = "https://weebcentral.com/chapters/01M421YWMX4P6PJHW4C1BGN2FM"
const PX = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="
const FIXTURE = `<!doctype html><html><head><title>Chapter</title></head><body style="background:#fff">
<a id="ad" href="https://evil.example/18plus" target="_blank">ad overlay</a>
<div class="reading-content"><img src="${PX}"><img src="${PX}"></div></body></html>`

test("MAIN-world guard neuters window.open while the block attribute is on, restores it when off", async () => {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
    })
    try {
        let [worker] = context.serviceWorkers()
        worker ??= await context.waitForEvent("serviceworker")
        await worker.evaluate(() => true)

        await context.route(`https://${HOST}/**`, route =>
            route.fulfill({ status: 200, contentType: "text/html", body: FIXTURE })
        )

        const page = await context.newPage()
        await page.goto(URL, { waitUntil: "load" })

        // Panel injected => both executeScript calls ran (panel + MAIN-world guard).
        await expect(page.locator("#__amr-chapter-prompt__")).toBeAttached({ timeout: 20_000 })

        // Default ON for a user-added site: the panel set the shared attribute, and the guard read it.
        await expect
            .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-amr-block-popups")), {
                timeout: 5000
            })
            .toBe("1")

        // With the block on, the page's own window.open is neutered (returns null, NOT a stub that
        // looks "closed" - so an ad page's fallback can't detect the block and redirect instead).
        const blocked = await page.evaluate(() => {
            const w = window.open("https://evil.example/18plus", "_blank")
            return w === null
        })
        expect(blocked).toBe(true)

        // Toggle off -> real window.open is restored (and we immediately close whatever opened).
        const allowed = await page.evaluate(async () => {
            document.documentElement.setAttribute("data-amr-block-popups", "")
            const w = window.open("about:blank", "_blank")
            const ok = w !== null
            try {
                w?.close()
            } catch {
                /* ignore */
            }
            return ok
        })
        expect(allowed).toBe(true)
    } finally {
        await context.close()
    }
})
