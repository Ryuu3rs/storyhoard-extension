import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { artifactsDirectory, chromiumExtension } from "../../src/paths.js"
import { clickPanel, panelElements, panelText } from "./panel-dom.js"

// On a local fixture reader page the user adds the site from the toolbar popup, the panel turns to followed
// mode, and Mark read in the panel records the chapter, with auto-add on and off. The site is made up and
// served through route interception; the grant is in a temp copy of the manifest.

const SHOTS = process.env.JOURNEY_SHOTS ?? path.join(artifactsDirectory, "journey-shots")
mkdirSync(SHOTS, { recursive: true })

const HOST = "read-demo.net"
const CHAPTER_URL = `https://${HOST}/manga/demo-series/chapter-3`
const NEXT_URL = `https://${HOST}/manga/demo-series/chapter-4`
const DETECTED = '#__amr-chapter-prompt__[data-amr-mode="detected"]'
const FOLLOWED = '#__amr-chapter-prompt__[data-amr-mode="followed"]'
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64"
)
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")
const CHAPTER_HTML = readFileSync(path.join(FIXTURES, "detected-chapter.html"), "utf8")

function buildWithGrant() {
    const directory = mkdtempSync(path.join(tmpdir(), "amr-popup-follow-"))
    cpSync(chromiumExtension, directory, { recursive: true })
    const manifestPath = path.join(directory, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    manifest.host_permissions = [...(manifest.host_permissions ?? []), `https://${HOST}/*`, `https://www.${HOST}/*`]
    writeFileSync(manifestPath, JSON.stringify(manifest))
    return directory
}

const library = page =>
    page.evaluate(async () => {
        const reply = await chrome.runtime.sendMessage({ type: "library:list" })
        return (reply?.data ?? []).map(m => ({
            id: m.id,
            title: m.title,
            lastReadChapterNumber: m.lastReadChapterNumber,
            readingStatus: m.readingStatus
        }))
    })

async function onFollowedPage(autoAdd, shot, run) {
    const extension = buildWithGrant()
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    })
    const errors = []
    try {
        let [worker] = context.serviceWorkers()
        worker ??= await context.waitForEvent("serviceworker")
        const extensionId = new URL(worker.url()).host
        await context.route(`https://${HOST}/**`, route =>
            new URL(route.request().url()).pathname.startsWith("/img/")
                ? route.fulfill({ status: 200, contentType: "image/png", body: PNG })
                : route.fulfill({ status: 200, contentType: "text/html", body: CHAPTER_HTML })
        )
        await context.route(/^https:\/\/(?!read-demo\.net)/, route => route.fulfill({ status: 404, body: "" }))
        const control = await context.newPage()
        await control.goto(`chrome-extension://${extensionId}/app.html`, { waitUntil: "domcontentloaded" })
        control.on("pageerror", e => errors.push(`app pageerror: ${e.message}`))
        await control.evaluate(
            value => chrome.runtime.sendMessage({ type: "settings:update", settings: { autoAdd: value } }),
            autoAdd
        )

        const page = await context.newPage()
        page.on("pageerror", e => errors.push(`site pageerror: ${e.message}`))
        await page.goto(CHAPTER_URL, { waitUntil: "load" })
        await expect(page.locator(DETECTED)).toBeAttached({ timeout: 15_000 })

        const popup = await context.newPage()
        popup.on("pageerror", e => errors.push(`popup pageerror: ${e.message}`))
        popup.on("console", m => m.type() === "error" && errors.push(`popup console.error: ${m.text()}`))
        await popup.setViewportSize({ width: 380, height: 600 })
        await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" })
        await page.bringToFront()
        await popup.reload({ waitUntil: "domcontentloaded" })
        await popup.getByRole("button", { name: "Add this site" }).click({ timeout: 15_000 })
        await popup.screenshot({ path: path.join(SHOTS, `${shot}-popup-confirm.png`) })
        await popup.getByRole("button", { name: "Add site", exact: true }).click()
        await expect(popup.getByText(/^Site added\./)).toBeVisible({ timeout: 20_000 })
        await popup.screenshot({ path: path.join(SHOTS, `${shot}-popup-added.png`) })
        await popup.close()

        await expect(page.locator(FOLLOWED)).toBeAttached({ timeout: 20_000 })
        const [handle] = await panelElements(page, ".handle", { mode: "followed" })
        if (handle?.visible) await clickPanel(page, ".handle", { mode: "followed" })
        await expect.poll(() => panelText(page, { mode: "followed" }), { timeout: 5000 }).toContain("Mark read")
        return { ...(await run(page, control)), errors }
    } finally {
        await context.close()
        rmSync(extension, { recursive: true, force: true })
    }
}

const journey = (autoAdd, shot) =>
    onFollowedPage(autoAdd, shot, async (page, control) => {
        await clickPanel(page, "button.btn.pri", { mode: "followed", text: "Mark read" })
        await expect
            .poll(async () => (await panelElements(page, "button.btn.pri", { mode: "followed" })).map(b => b.text), {
                timeout: 10_000
            })
            .not.toContain("Mark read")
        await page.screenshot({ path: path.join(SHOTS, `${shot}-panel-after-mark.png`) })
        const buttons = (await panelElements(page, "button.btn.pri", { mode: "followed" })).map(b => b.text)
        const after = await library(control)
        let heading = ""
        await expect
            .poll(async () => (heading = (await panelText(page, { mode: "followed" })) ?? ""), { timeout: 15_000 })
            .not.toContain("Detecting chapter...")
            .catch(() => undefined)
        let chapter
        await expect
            .poll(
                async () =>
                    (chapter = (await panelElements(page, "select.chapsel", { mode: "followed" }))[0]?.selected),
                { timeout: 15_000 }
            )
            .not.toBe("This chapter")
            .catch(() => undefined)
        return { buttons, after, heading, chapter }
    })

const markAndNext = (autoAdd, shot) =>
    onFollowedPage(autoAdd, shot, async (page, control) => {
        await clickPanel(page, "button.btn.sec", { mode: "followed", text: "Mark & next" })
        if (autoAdd) {
            await page.waitForURL(NEXT_URL, { timeout: 15_000 })
            await expect(page.locator(FOLLOWED)).toBeAttached({ timeout: 15_000 })
            await page.screenshot({ path: path.join(SHOTS, `${shot}-next-chapter.png`) })
            return { url: page.url(), buttons: [], after: await library(control) }
        }
        await expect
            .poll(async () => (await panelElements(page, "button.btn.sec", { mode: "followed" })).map(b => b.text), {
                timeout: 10_000
            })
            .not.toContain("Mark & next")
        await page.screenshot({ path: path.join(SHOTS, `${shot}-panel-after-mark-next.png`) })
        const buttons = (await panelElements(page, "button.btn.sec", { mode: "followed" })).map(b => b.text)
        return { url: page.url(), buttons, after: await library(control) }
    })

test("followed site, auto-add on: Mark read keeps the title with chapter 3 read", async () => {
    test.setTimeout(90_000)
    const { buttons, after, errors } = await journey(true, "follow-auto-add-on")
    expect(buttons).toContain("Marked ✓")
    expect(after).toHaveLength(1)
    expect(after[0].lastReadChapterNumber).toBe(3)
    expect(errors).toEqual([])
})

test("followed site, auto-add off: Mark read says Not in library and adds nothing", async () => {
    test.setTimeout(90_000)
    const { buttons, after, errors, heading, chapter } = await journey(false, "follow-auto-add-off")
    expect(buttons).toContain("Not in library")
    expect(after).toHaveLength(0)
    expect(errors).toEqual([])
    // With no kept title the panel used to stay on "Detecting chapter..." and "This chapter" for good, while
    // its footer already said "tracking this page".
    expect(heading).not.toContain("Detecting chapter...")
    expect(heading).toContain("Demo Series")
    expect(chapter).toBe("Chapter 3")
})

test("followed site, auto-add on: Mark & next saves chapter 3, then opens chapter 4", async () => {
    test.setTimeout(90_000)
    const { url, after, errors } = await markAndNext(true, "follow-mark-next-on")
    expect(url).toBe(NEXT_URL)
    expect(after).toHaveLength(1)
    expect(after[0].lastReadChapterNumber).toBeGreaterThanOrEqual(3)
    expect(errors).toEqual([])
})

test("followed site, auto-add off: Mark & next stays on the chapter and says Not in library", async () => {
    test.setTimeout(90_000)
    const { url, buttons, after, errors } = await markAndNext(false, "follow-mark-next-off")
    expect(url).toBe(CHAPTER_URL)
    expect(buttons).toContain("Not in library")
    expect(after).toHaveLength(0)
    expect(errors).toEqual([])
})
