import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { chromiumExtension } from "../../src/paths.js"

// Proves the MAIN-world DM5 continuous-scroll flattener: on a paginated DM5-engine reader (one page
// image at a time, fetched by the site's own window.requestimagedata), turning on continuous scroll
// drives the site's own pager to resolve every page and stacks them into one vertical strip. The
// fixture is a synthetic DM5 reader served at a fanfox chapter URL (so the panel + the flattener
// inject); no real site is hit and no copyrighted art is used.

const HOST = "fanfox.net"
const URL = "https://fanfox.net/manga/test-manga/c1/1.html"
const PX = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="

// A fake DM5 reader: 3 pages, requestimagedata swaps .reader-main-img to the current page's image.
// Page srcs are .jpg-style URLs (like a real tokened CDN url) so they match the flattener's
// image-extension check; they're routed to a 1px gif below.
const FIXTURE = `<!doctype html><html><head><title>Chapter</title></head><body style="background:#111">
<div class="reader-main"><img class="reader-main-img" data-loading-img="loading.gif" src="https://cdn.fanfox.net/pages/b001.jpg?token=1"></div>
<script>
  window.imagecount = 3;
  window.imagepage = 1;
  window.requestimagedata = function () {
    document.querySelector('.reader-main-img').setAttribute('src',
      'https://cdn.fanfox.net/pages/b00' + window.imagepage + '.jpg?token=' + window.imagepage);
  };
</script>
</body></html>`

test("DM5 continuous scroll flattens a paginated reader into a stacked strip", async () => {
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
        // Serve the page images (any host) as a 1px gif so the stacked <img> slots resolve.
        await context.route("**/pages/*.jpg*", route =>
            route.fulfill({
                status: 200,
                contentType: "image/gif",
                body: Buffer.from(PX.split(",")[1], "base64")
            })
        )

        const page = await context.newPage()
        await page.goto(URL, { waitUntil: "load" })

        // Panel injects on a chapter page; the flattener is injected in the MAIN world alongside it.
        await expect(page.locator("#__amr-chapter-prompt__")).toBeAttached({ timeout: 20_000 })

        // Turn continuous scroll on the way the panel toggle does (the flattener watches this attr).
        await page.evaluate(() => document.documentElement.setAttribute("data-amr-continuous", "1"))

        // The flattener shows one slot per page immediately (before the walk), so the reader sees the
        // full strip at once and each page fills in as it resolves.
        const strip = page.locator("#__amr-cs-strip__ img")
        await expect(strip).toHaveCount(3, { timeout: 10_000 })

        // The single-page image is hidden as soon as the strip is shown, not only after the walk ends.
        await expect(page.locator(".reader-main-img")).toHaveCSS("display", "none")

        // Each slot then fills with its resolved per-page src; wait for the progressive walk to finish.
        await expect
            .poll(
                async () =>
                    (await strip.evaluateAll(imgs => imgs.map(i => i.getAttribute("src")).filter(Boolean))).length,
                { timeout: 10_000 }
            )
            .toBe(3)
        const srcs = await strip.evaluateAll(imgs => imgs.map(i => i.getAttribute("src")))
        expect(new Set(srcs).size).toBe(3)
    } finally {
        await context.close()
    }
})
