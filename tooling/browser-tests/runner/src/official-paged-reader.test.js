import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { chromiumExtension } from "../../src/paths.js"
import { clickPanel, panelElements } from "./panel-dom.js"

// A page-at-a-time reader shows the current page and keeps the next few preloaded but hidden with an
// inline display:none, the way the official MangaDex reader does. The panel's reading-view layers must
// never unhide those preloaded pages: doing so stacked the current page and the preloaded ones into a
// short strip that stopped after a few pages, and every tap on "next" flipped the view back up.

const CHAPTER_URL = "https://mangadex.org/chapter/a96676e5-8ae2-425e-b549-7f15dd34a6d8"

const PAGE = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200"><rect width="800" height="1200" fill="#888"/></svg>'
)}`

const FIXTURE = `<!doctype html><html><head><title>Chapter 1</title></head><body style="background:#111">
<div class="reader"><div class="md--page" style="display:flex">
<img class="pg" src="${PAGE}">
<img class="pg" src="${PAGE}" style="display: none;">
<img class="pg" src="${PAGE}" style="display: none;">
<img class="pg" src="${PAGE}" style="display: none;">
</div></div></body></html>`

const STRIP = FIXTURE.replaceAll(' style="display: none;"', "")

async function launch(settings, body = FIXTURE) {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
    })
    let [worker] = context.serviceWorkers()
    worker ??= await context.waitForEvent("serviceworker")
    await worker.evaluate(async seeded => chrome.storage.local.set({ settings: seeded }), settings)
    await context.route("https://mangadex.org/**", route =>
        route.fulfill({ status: 200, contentType: "text/html", body })
    )
    const page = await context.newPage()
    await page.goto(CHAPTER_URL, { waitUntil: "load" })
    await expect(page.locator("#__amr-chapter-prompt__")).toBeAttached({ timeout: 20_000 })
    return { context, page }
}

const pageDisplays = page =>
    page.locator("img.pg").evaluateAll(images => images.map(image => getComputedStyle(image).display))

test("remembered reading-view defaults leave an official paged reader as the site built it", async () => {
    const { context, page } = await launch({
        readerContinuousScroll: true,
        readerFitWidth: true,
        readerNoGap: true,
        readerTheme: "dark"
    })
    try {
        await page.waitForTimeout(1500)
        expect(await pageDisplays(page)).toEqual(["block", "none", "none", "none"])
        expect(await page.locator("style[id^='__amr-layer-']").count()).toBe(0)
        expect(await page.locator("[data-amr-reader]").count()).toBe(0)
    } finally {
        await context.close()
    }
})

test("turning on a reading-view layer never unhides a page the reader preloaded", async () => {
    const { context, page } = await launch({})
    try {
        await clickPanel(page, ".handle", { timeout: 5000 })
        for (const label of ["Fit width", "No gap"]) {
            await clickPanel(page, `.sw[aria-label="${label}"]`)
        }
        await expect.poll(() => page.locator("style[id^='__amr-layer-']").count(), { timeout: 5000 }).toBe(2)
        expect(await pageDisplays(page)).toEqual(["block", "none", "none", "none"])
    } finally {
        await context.close()
    }
})

const scrollControls = async page => ({
    toggle: (await panelElements(page, '.sw[aria-label="Continuous scroll"]'))[0]?.visible,
    hint: (await panelElements(page, "[data-amr-scroll-hint]"))[0]?.visible
})

test("on a page-at-a-time reader the panel points to the site's own long-strip mode instead of a switch that cannot work", async () => {
    const { context, page } = await launch({})
    try {
        await clickPanel(page, ".handle", { timeout: 5000 })
        await expect.poll(() => scrollControls(page)).toEqual({ toggle: false, hint: true })
    } finally {
        await context.close()
    }
})

test("on a reader that shows every page the Continuous scroll switch stays", async () => {
    const { context, page } = await launch({}, STRIP)
    try {
        await clickPanel(page, ".handle", { timeout: 5000 })
        await expect.poll(() => scrollControls(page)).toEqual({ toggle: true, hint: false })
    } finally {
        await context.close()
    }
})
