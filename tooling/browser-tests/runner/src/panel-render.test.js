import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { artifactsDirectory, chromiumExtension } from "../../src/paths.js"

// On-site panel render harness. Loads the built extension, then for each supported site serves a
// synthetic chapter-page fixture AT that site's real chapter URL (via route interception, so no
// live site is hit and no copyrighted content is used), navigates to it, and verifies the panel
// injects and renders the right variant. Screenshots land in artifacts/panel-shots/ so the panel
// can be eyeballed per site. This tests the real injection path (background tabs.onUpdated ->
// findSource match -> scripting.executeScript) without the flakiness/legality of live scraping.

const SHOTS = path.join(artifactsDirectory, "panel-shots")

// A 1x1 transparent gif so the fixture has a "page image" without shipping any real art.
const PX = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="

// Confirmed-injecting real chapter URLs (verified live during development). Official vs user-added
// is decided by the host, so one of each is enough to prove both variants.
// A dark and a light generic fixture (official vs user-added decides the variant, not the content).
const DARK = `<!doctype html><html><head><title>Chapter</title></head><body style="background:#111"><div class="reading-content" id="_imageList"><img src="${PX}"><img src="${PX}"></div></body></html>`
const LIGHT = `<!doctype html><html><head><title>Chapter</title></head><body style="background:#fff"><div class="reading-content"><img src="${PX}"><img src="${PX}"></div></body></html>`

// Chapter URL shapes taken from each adapter's own fixtures/tests, so findSource matches them as a
// chapter and the panel injects. Official hosts (webtoons, mangadex) get the overlay-only variant.
const CASES = [
    {
        name: "webtoons-official",
        url: "https://www.webtoons.com/en/fantasy/tower-of-god/season-1-ep-1/viewer?title_no=95&episode_no=2",
        host: "www.webtoons.com",
        badge: "Official",
        expectReaderControls: false,
        fixture: DARK
    },
    {
        name: "mangadex-official",
        url: "https://mangadex.org/chapter/a96676e5-8ae2-425e-b549-7f15dd34a6d8",
        host: "mangadex.org",
        badge: "Official",
        expectReaderControls: false,
        fixture: DARK
    },
    {
        name: "weebcentral-enhanced",
        url: "https://weebcentral.com/chapters/01M421YWMX4P6PJHW4C1BGN2FM",
        host: "weebcentral.com",
        badge: "Enhanced",
        expectReaderControls: true,
        fixture: LIGHT
    },
    {
        name: "mangahub-enhanced",
        url: "https://mangahub.io/chapter/test-manga/chapter-1",
        host: "mangahub.io",
        badge: "Enhanced",
        expectReaderControls: true,
        fixture: LIGHT
    },
    {
        name: "asurascans-enhanced",
        url: "https://asurascans.com/comics/test-series/chapter/1",
        host: "asurascans.com",
        badge: "Enhanced",
        expectReaderControls: true,
        fixture: DARK
    },
    {
        name: "mgeko-enhanced",
        url: "https://www.mgeko.cc/reader/en/test-manga-chapter-52-eng-li/",
        host: "www.mgeko.cc",
        badge: "Enhanced",
        expectReaderControls: true,
        fixture: LIGHT
    }
]

for (const c of CASES) {
    test(`on-site panel renders on ${c.name}`, async () => {
        mkdirSync(SHOTS, { recursive: true })
        const context = await chromium.launchPersistentContext("", {
            channel: "chromium",
            headless: true,
            args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
        })
        try {
            // Ensure the background service worker is up (it owns the inject-on-navigate handler),
            // and ping it so it is awake when the navigation's onUpdated fires.
            let [worker] = context.serviceWorkers()
            worker ??= await context.waitForEvent("serviceworker")
            await worker.evaluate(() => true)

            // Serve the fixture for anything on this host, so navigation loads it instead of the
            // real site.
            await context.route(`https://${c.host}/**`, route =>
                route.fulfill({ status: 200, contentType: "text/html", body: c.fixture })
            )

            // waitUntil "load" so the navigation's 'complete' fires (the panel injects on it).
            const page = await context.newPage()
            await page.goto(c.url, { waitUntil: "load" })

            // The panel injects on the background's tabs.onUpdated 'complete' event.
            const host = page.locator("#__amr-chapter-prompt__")
            await expect(host).toBeAttached({ timeout: 20_000 })

            // Minimized handle shot, then expand (the handle is .handle inside the shadow root).
            await page.screenshot({ path: path.join(SHOTS, `${c.name}-handle.png`) })
            await host
                .locator(".handle")
                .click({ timeout: 5000 })
                .catch(() => {})
            await page.waitForTimeout(400)
            await page.screenshot({ path: path.join(SHOTS, `${c.name}-panel.png`) })

            // Correct variant badge.
            await expect(host.getByText(c.badge, { exact: false }).first()).toBeVisible({ timeout: 5000 })

            // Reader controls present only on user-added sites.
            const fitWidth = host.getByText("Fit width", { exact: false })
            if (c.expectReaderControls) await expect(fitWidth.first()).toBeVisible({ timeout: 5000 })
            else await expect(fitWidth).toHaveCount(0)
        } finally {
            await context.close()
        }
    })
}
