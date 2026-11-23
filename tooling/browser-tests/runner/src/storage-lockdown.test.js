import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { chromiumExtension } from "../../src/paths.js"
import { putProtected } from "./protected-store.js"

// A content-script world (here the weeb.ltd bridge) must reach none of the extension's secrets: the
// tokens live in the extension's own IndexedDB, and storage.local is limited to the extension's pages.

const DEVICE_TOKEN = "WEEB-DEVICE-TOKEN"

async function launch() {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
    })
    let [worker] = context.serviceWorkers()
    worker ??= await context.waitForEvent("serviceworker")
    return { context, worker, extId: new URL(worker.url()).host }
}

async function isolatedWorld(context) {
    await context.route("https://weeb.ltd/**", route =>
        route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>weeb</title><p>hi" })
    )
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    const contexts = []
    cdp.on("Runtime.executionContextCreated", e => contexts.push(e.context))
    await cdp.send("Runtime.enable")
    await page.goto("https://weeb.ltd/", { waitUntil: "load" })
    const isExt = c => c.auxData?.type === "isolated" && String(c.origin).startsWith("chrome-extension://")
    await expect.poll(() => contexts.filter(isExt).length).toBeGreaterThan(0)
    const contextId = contexts.filter(isExt).at(-1).id
    return async expression => {
        const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
            contextId,
            expression,
            awaitPromise: true,
            returnByValue: true
        })
        return exceptionDetails
            ? `ERR ${exceptionDetails.exception?.description ?? exceptionDetails.text}`
            : result.value
    }
}

test("a content script can neither read the tokens nor write the account", async () => {
    const { context, worker, extId } = await launch()
    try {
        await expect
            .poll(() => worker.evaluate(() => indexedDB.databases().then(dbs => dbs.map(db => db.name))))
            .toContain("storyhoard-protected")
        await worker.evaluate(putProtected, {
            account: { token: DEVICE_TOKEN, lastPushAt: 0, lastSyncAt: 0, invalid: false, autoSync: false },
            anilistConfig: { token: "ANILIST-TOKEN", autoSync: false, syncMembership: false },
            syncConfig: { token: "GITHUB-PAT", autoSync: false }
        })
        // A token planted in storage.local after the move at worker start is never read.
        await worker.evaluate(() => chrome.storage.local.set({ account: { token: "LEFTOVER-TOKEN" } }))

        const run = await isolatedWorld(context)
        const read = await run("chrome.storage.local.get(null).then(s => JSON.stringify(s), e => 'ERR ' + String(e))")
        expect(read).toMatch(/^ERR /)
        expect(read).not.toMatch(/TOKEN|PAT/)

        const stores = await run(
            "new Promise(r => { const q = indexedDB.open('storyhoard-protected'); q.onsuccess = () => { r([...q.result.objectStoreNames].join()); q.result.close() }; q.onerror = () => r('ERR') })"
        )
        expect(stores).not.toContain("kv")

        const write = await run(
            "chrome.storage.local.set({ account: { token: 'ATTACKER-TOKEN' }, settings: { autoAdd: true } }).then(() => 'written', e => 'ERR ' + String(e))"
        )
        expect(write).toMatch(/^ERR /)
        const local = await worker.evaluate(() => chrome.storage.local.get(["account", "settings"]))
        expect(JSON.stringify(local)).not.toContain("ATTACKER-TOKEN")

        const app = await context.newPage()
        await app.goto(`chrome-extension://${extId}/app.html`, { waitUntil: "domcontentloaded" })
        const status = await app.evaluate(() => chrome.runtime.sendMessage({ type: "account:status" }))
        expect(JSON.stringify(status)).toContain(DEVICE_TOKEN)
        expect(JSON.stringify(status)).not.toMatch(/ATTACKER-TOKEN|LEFTOVER-TOKEN/)
    } finally {
        await context.close()
    }
})
