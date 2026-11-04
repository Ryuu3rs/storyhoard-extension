import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { chromiumExtension } from "../../src/paths.js"
import {
    HOST,
    MOVED_TITLE,
    ORIGIN,
    REFUSED_TITLE,
    SERIES_URL,
    TITLE,
    libraryEnvelope,
    startGatedSite
} from "./fixtures/gated-site.js"

// The whole user gate against a made-up site served from this machine: a real update check from the worker
// hits a challenge, the app shows the prompt without naming the site, its button opens the title's page,
// and the optional session setting sends that site's cookie only once the user turned it on. As in
// detected-panel.test.js, the host grant is written into a temp copy of the manifest.

// Each flow runs up to three real update checks, with the app's own pause between titles.
test.setTimeout(90_000)

function buildWithGrant() {
    const directory = mkdtempSync(path.join(tmpdir(), "amr-gate-"))
    cpSync(chromiumExtension, directory, { recursive: true })
    const manifestPath = path.join(directory, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    manifest.host_permissions = [...(manifest.host_permissions ?? []), `${ORIGIN}/*`]
    writeFileSync(manifestPath, JSON.stringify(manifest))
    return directory
}

async function withApp(body) {
    const extension = buildWithGrant()
    const site = await startGatedSite()
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        args: [
            `--disable-extensions-except=${extension}`,
            `--load-extension=${extension}`,
            `--host-resolver-rules=MAP ${HOST}:443 127.0.0.1:${site.sitePort}`,
            "--ignore-certificate-errors"
        ]
    })
    try {
        let [worker] = context.serviceWorkers()
        worker ??= await context.waitForEvent("serviceworker")
        await worker.evaluate(() => true)
        const app = await context.newPage()
        await app.goto(`chrome-extension://${new URL(worker.url()).host}/app.html`)
        await expect(app.getByRole("navigation", { name: "Main navigation" })).toBeVisible()
        await body({ app, context, site })
    } finally {
        await context.close()
        await site.close()
        rmSync(extension, { recursive: true, force: true })
    }
}

const send = (app, message) => app.evaluate(m => chrome.runtime.sendMessage(m), message)

async function importLibrary(app, envelope = libraryEnvelope()) {
    const imported = await send(app, { type: "data:import", envelope })
    expect(imported.ok, JSON.stringify(imported)).toBe(true)
}

// Starts a check and waits for the status that run writes, not the one before it.
async function runCheck(app) {
    const before = (await send(app, { type: "updates:get" })).data?.checkedAt ?? 0
    expect((await send(app, { type: "updates:check" })).ok).toBe(true)
    await expect
        .poll(async () => (await send(app, { type: "updates:get" })).data?.checkedAt ?? 0, { timeout: 20_000 })
        .toBeGreaterThan(before)
    return (await send(app, { type: "updates:get" })).data
}

async function goToUpdates(app) {
    await app.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Activity" }).click()
}

// A loaded tab also fetches its favicon, with cookies, which has nothing to do with an update check.
const fromChecks = requests => requests.filter(request => !request.inTab && request.path.startsWith("/manga/"))

test("a challenge leads to a prompt that names no site, and its button opens the title's page", async () => {
    await withApp(async ({ app, context, site }) => {
        await importLibrary(app)
        const status = await runCheck(app)

        expect(fromChecks(site.requests).length).toBeGreaterThan(0)
        expect(status.failed).toBe(0)
        expect(status.needsVerify).toEqual([
            { origin: ORIGIN, sourceId: HOST, count: 1, openUrl: SERIES_URL, sampleTitle: TITLE }
        ])
        expect(status.causesBySource).toEqual({ [HOST]: { challenge: 1 } })

        await app.reload()
        // Visible from wherever the user is, not only on the page that holds the details.
        const notice = app.locator("[data-site-gate-notice]")
        await expect(notice).toBeVisible()
        expect((await notice.innerHTML()).toLowerCase()).not.toContain(HOST)
        await notice.getByRole("button", { name: "Show me" }).click()
        await expect(notice).toBeHidden()
        const prompt = app.locator("[data-site-gate]")
        await expect(prompt).toBeVisible()
        await expect(prompt).toContainText("Open the site first")
        await expect(prompt).toContainText(TITLE)
        for (const text of [await prompt.innerText(), await prompt.innerHTML()]) {
            expect(text.toLowerCase()).not.toContain(HOST)
            expect(text.toLowerCase()).not.toContain("gated demo")
            expect(text.toLowerCase()).not.toContain("https://")
        }

        const opened = context.waitForEvent("page")
        await prompt.getByRole("button", { name: "Open the site" }).click()
        const tab = await opened
        await tab.waitForLoadState("domcontentloaded")
        expect(tab.url()).toBe(SERIES_URL)
        await tab.close()
    })
})

test("the exported log says what failed and why, and names no site", async () => {
    await withApp(async ({ app, context }) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"])
        await importLibrary(app)
        await runCheck(app)
        await app.reload()
        await goToUpdates(app)
        await app.getByRole("button", { name: "Copy for support" }).click()
        await expect(app.getByRole("button", { name: "Copied" })).toBeVisible()
        const log = (await app.evaluate(() => navigator.clipboard.readText())).replaceAll("\r\n", "\n")
        expect(log).toContain("needs verify: 1")
        expect(log).toContain("causes by source:\n- Source 1: challenge 1")
        expect(log).toContain("- Source 1: 1 title(s) - open the site once")
        expect(log.toLowerCase()).not.toContain(HOST)
        expect(log.toLowerCase()).not.toContain("gate_clearance")
    })
})

test("the session setting is off until chosen, sends the cookie to that site only, and can be revoked", async () => {
    await withApp(async ({ app, context, site }) => {
        await importLibrary(app)
        await runCheck(app)
        await app.reload()
        await goToUpdates(app)

        // The user opens the site and passes its check, so the browser now holds the cookie.
        const prompt = app.locator("[data-site-gate]")
        const opened = context.waitForEvent("page")
        await prompt.getByRole("button", { name: "Open the site" }).click()
        const tab = await opened
        await expect
            .poll(async () => (await context.cookies(ORIGIN)).map(cookie => cookie.name))
            .toContain("gate_clearance")
        await tab.close()

        // Holding the cookie changes nothing until the user chooses: the check stays cookieless.
        const before = site.requests.length
        const stillGated = await runCheck(app)
        expect(fromChecks(site.requests.slice(before)).length).toBeGreaterThan(0)
        expect(fromChecks(site.requests).every(request => !request.hasCookie)).toBe(true)
        expect(stillGated.needsVerify).toHaveLength(1)

        const box = prompt.getByRole("checkbox")
        await expect(box).not.toBeChecked()
        await box.check()
        await expect(box).toBeChecked()

        const passed = await runCheck(app)
        const sent = fromChecks(site.requests).at(-1)
        expect(sent).toMatchObject({ method: "GET", hasCookie: true })
        expect(passed.needsVerify).toEqual([])
        expect(passed.checked).toBe(1)
        expect(passed.causesBySource).toEqual({})

        // The prompt is gone with the challenge, and the choice can still be undone.
        const sessions = app.locator("[data-site-sessions]")
        await expect(sessions).toBeVisible()
        await expect(sessions).toContainText(TITLE)
        expect((await sessions.innerText()).toLowerCase()).not.toContain(HOST)
        await sessions.getByRole("button", { name: "Turn off" }).click()
        await expect(sessions).toHaveCount(0)

        const afterRevoke = site.requests.length
        const revoked = await runCheck(app)
        const since = fromChecks(site.requests.slice(afterRevoke))
        expect(since.length).toBeGreaterThan(0)
        expect(since.every(request => !request.hasCookie)).toBe(true)
        expect(revoked.needsVerify).toHaveLength(1)
    })
})

test("a redirect from a site with a session on is followed without the cookie", async () => {
    await withApp(async ({ app, context, site }) => {
        await importLibrary(app, libraryEnvelope([{ slug: "moved", title: MOVED_TITLE }]))
        await runCheck(app)
        await app.reload()
        await goToUpdates(app)
        const opened = context.waitForEvent("page")
        await app.getByRole("button", { name: "Open the site" }).click()
        await opened
        await expect
            .poll(async () => (await context.cookies(ORIGIN)).map(cookie => cookie.name))
            .toContain("gate_clearance")
        await app.locator("[data-site-gate]").getByRole("checkbox").check()

        const before = site.requests.length
        const status = await runCheck(app)
        const since = fromChecks(site.requests.slice(before)).map(({ path: url, hasCookie }) => ({ url, hasCookie }))
        expect(since).toEqual([
            { url: "/manga/moved", hasCookie: true },
            { url: "/manga/moved", hasCookie: false },
            { url: "/manga/gated-demo", hasCookie: false }
        ])
        expect(status.needsVerify).toHaveLength(1)
    })
})

test("a normal 403 is a skip with its status as the cause, and shows no prompt", async () => {
    await withApp(async ({ app }) => {
        await importLibrary(app, libraryEnvelope([{ slug: "refused", title: REFUSED_TITLE }]))
        const status = await runCheck(app)
        expect(status.needsVerify).toEqual([])
        expect(status.skippedSources).toEqual({ [HOST]: 1 })
        expect(status.causesBySource).toEqual({ [HOST]: { "http-403": 1 } })
        await app.reload()
        await goToUpdates(app)
        await expect(app.getByText("Update check details")).toBeVisible()
        await expect(app.locator("[data-site-gate]")).toHaveCount(0)
    })
})

test("the setting is refused before any challenge was seen, and an import cannot set it", async () => {
    await withApp(async ({ app, context, site }) => {
        await context.addCookies([
            { name: "gate_clearance", value: "passed", domain: HOST, path: "/", secure: true, sameSite: "Lax" }
        ])
        const envelope = libraryEnvelope()
        envelope.data.siteSessions = { seen: { [ORIGIN]: { seenAt: 1 } }, enabled: { [ORIGIN]: 1 } }
        await importLibrary(app, envelope)

        const refused = await send(app, { type: "site-session:set", origin: ORIGIN, enabled: true })
        expect(refused.data).toEqual({ applied: false })
        expect((await send(app, { type: "site-session:list" })).data).toEqual([])

        await runCheck(app)
        const checks = fromChecks(site.requests)
        expect(checks.length).toBeGreaterThan(0)
        expect(checks.every(request => !request.hasCookie)).toBe(true)
    })
})
