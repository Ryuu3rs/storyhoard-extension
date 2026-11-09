import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromiumExtension } from "../../src/paths.js"

// The panel behaviours that the bundled-adapter tests (panel-render, popup-guard, dm5-continuous) prove on
// named sites, proved here on a made-up site that has no adapter: it is detected, then followed with the
// real Track button, as a user adds a site. These run in every build, so a build with no bundled sites
// keeps the same coverage. The host grant is written into a temp copy of the manifest, as in
// detected-panel.test.js, and the site is served through route interception.

const HOST = "read-demo.net"
const CHAPTER_URL = `https://${HOST}/manga/demo-series/chapter-3`
const DETECTED = '#__amr-chapter-prompt__[data-amr-mode="detected"]'
const FOLLOWED = '#__amr-chapter-prompt__[data-amr-mode="followed"]'
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64"
)
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")
const CHAPTER_HTML = readFileSync(path.join(FIXTURES, "detected-chapter.html"), "utf8")
const AD_LINK = '<a id="ad" href="https://evil.example/18plus" target="_blank">ad overlay</a>'
const PAGED_READER = `<div class="reader-main"><img class="reader-main-img" src="/img/b001.png"></div>
<script>
  window.imagecount = 3;
  window.imagepage = 1;
  window.requestimagedata = function () {
    document.querySelector('.reader-main-img').setAttribute('src', '/img/b00' + window.imagepage + '.png');
  };
</script>`

function buildWithGrant() {
    const directory = mkdtempSync(path.join(tmpdir(), "amr-followed-"))
    cpSync(chromiumExtension, directory, { recursive: true })
    const manifestPath = path.join(directory, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    manifest.host_permissions = [...(manifest.host_permissions ?? []), `https://${HOST}/*`]
    writeFileSync(manifestPath, JSON.stringify(manifest))
    return directory
}

async function withSite(html, body) {
    const extension = buildWithGrant()
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    })
    try {
        let [worker] = context.serviceWorkers()
        worker ??= await context.waitForEvent("serviceworker")
        await worker.evaluate(() => true)
        await context.route(`https://${HOST}/**`, route =>
            new URL(route.request().url()).pathname.startsWith("/img/")
                ? route.fulfill({ status: 200, contentType: "image/png", body: PNG })
                : route.fulfill({ status: 200, contentType: "text/html", body: html })
        )
        const page = await context.newPage()
        await page.goto(CHAPTER_URL, { waitUntil: "load" })
        await expect(page.locator(DETECTED)).toBeAttached({ timeout: 15_000 })
        await body({ page })
    } finally {
        await context.close()
        rmSync(extension, { recursive: true, force: true })
    }
}

async function follow(page) {
    const panel = page.locator(DETECTED)
    await panel.locator(".handle").click()
    await panel.getByRole("button", { name: "Track this site" }).click()
    await expect(page.locator(FOLLOWED)).toBeAttached({ timeout: 20_000 })
    return page.locator(FOLLOWED)
}

test("on a detected site the panel says Detected and offers no reader controls", async () => {
    await withSite(CHAPTER_HTML, async ({ page }) => {
        const panel = page.locator(DETECTED)
        await panel.locator(".handle").click()
        await expect(panel.getByText("Detected", { exact: false }).first()).toBeVisible({ timeout: 5000 })
        await expect(panel.getByText("Fit width", { exact: false })).toHaveCount(0)
        await expect(panel.getByText("Go there", { exact: false })).toBeHidden()
    })
})

test("on a followed site the panel says Enhanced and shows the reader controls", async () => {
    await withSite(CHAPTER_HTML, async ({ page }) => {
        const panel = await follow(page)
        await panel.locator(".handle").click()
        await expect(panel.getByText("Enhanced", { exact: false }).first()).toBeVisible({ timeout: 5000 })
        await expect(panel.getByText("Fit width", { exact: false }).first()).toBeVisible({ timeout: 5000 })
        await expect(panel.getByText("Go there", { exact: false })).toBeHidden()
    })
})

test("on a followed site the MAIN-world guard neuters window.open while on, restores it when off", async () => {
    await withSite(CHAPTER_HTML.replace("<body>", `<body>${AD_LINK}`), async ({ page }) => {
        expect(await page.evaluate(() => document.documentElement.getAttribute("data-amr-block-popups"))).not.toBe("1")
        await follow(page)
        await expect
            .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-amr-block-popups")), {
                timeout: 5000
            })
            .toBe("1")
        expect(await page.evaluate(() => window.open("https://evil.example/18plus", "_blank") === null)).toBe(true)

        const allowed = await page.evaluate(() => {
            document.documentElement.setAttribute("data-amr-block-popups", "")
            const opened = window.open("about:blank", "_blank")
            const ok = opened !== null
            try {
                opened?.close()
            } catch {
                void 0
            }
            return ok
        })
        expect(allowed).toBe(true)
    })
})

test("on a followed site, continuous scroll flattens a paginated reader into a stacked strip", async () => {
    await withSite(CHAPTER_HTML.replace("</body>", `${PAGED_READER}</body>`), async ({ page }) => {
        await follow(page)
        await page.evaluate(() => document.documentElement.setAttribute("data-amr-continuous", "1"))
        const strip = page.locator("#__amr-cs-strip__ img")
        await expect(strip).toHaveCount(3, { timeout: 10_000 })
        await expect(page.locator(".reader-main-img")).toHaveCSS("display", "none")
        await expect
            .poll(
                async () =>
                    (await strip.evaluateAll(imgs => imgs.map(i => i.getAttribute("src")).filter(Boolean))).length,
                { timeout: 10_000 }
            )
            .toBe(3)
        const srcs = await strip.evaluateAll(imgs => imgs.map(i => i.getAttribute("src")))
        expect(new Set(srcs).size).toBe(3)
    })
})
