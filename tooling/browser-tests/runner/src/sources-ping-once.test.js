import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { chromiumExtension } from "../../src/paths.js"

// Opening Sources checks every source once. A check that fails must not start the next one straight away:
// the page used to re-run it as fast as the background could answer for as long as Sources stayed open.

const HOST = "ping-loop.example"

function seedTitle(worker) {
    return worker.evaluate(
        host =>
            new Promise((resolve, reject) => {
                const open = indexedDB.open("all-mangas-reader")
                open.onerror = () => reject(open.error)
                open.onsuccess = () => {
                    const tx = open.result.transaction(["manga"], "readwrite")
                    tx.objectStore("manga").put({
                        id: "ping-loop-site:manga:demo",
                        sourceId: "ping-loop-site",
                        sourceUrl: `https://${host}/series/demo`,
                        title: "Ping Loop Demo",
                        normalizedTitle: "ping loop demo",
                        authors: [],
                        status: "ongoing",
                        addedAt: 1,
                        updatedAt: 1
                    })
                    tx.oncomplete = () => {
                        open.result.close()
                        resolve(true)
                    }
                    tx.onerror = () => reject(tx.error)
                }
            }),
        HOST
    )
}

test("a failing reachability check is not re-run in a loop while Sources is open", async () => {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
    })
    try {
        await context.route(/^https?:\/\//, route => route.fulfill({ status: 404, body: "" }))
        let [worker] = context.serviceWorkers()
        worker ??= await context.waitForEvent("serviceworker")
        await worker.evaluate(() => true)
        const extensionId = new URL(worker.url()).host

        const app = await context.newPage()
        await app.goto(`chrome-extension://${extensionId}/app.html`, { waitUntil: "domcontentloaded" })
        await seedTitle(worker)
        await app.reload({ waitUntil: "domcontentloaded" })

        await app.evaluate(() => {
            const original = chrome.runtime.sendMessage.bind(chrome.runtime)
            window.__pingCalls = 0
            chrome.runtime.sendMessage = (message, ...rest) => {
                if (message && message.type === "sources:ping") {
                    window.__pingCalls += 1
                    return new Promise(resolve =>
                        setTimeout(() => resolve({ ok: false, error: { code: "x", message: "ping failed" } }), 20)
                    )
                }
                return original(message, ...rest)
            }
        })

        await app
            .getByRole("navigation", { name: "Main navigation" })
            .getByRole("button", { name: "Sources", exact: true })
            .click()
        await expect(app.locator(".source-row").filter({ hasText: HOST })).toHaveCount(1, { timeout: 15_000 })
        await expect.poll(() => app.evaluate(() => window.__pingCalls), { timeout: 10_000 }).toBeGreaterThan(0)
        await app.waitForTimeout(3000)

        expect(await app.evaluate(() => window.__pingCalls)).toBe(1)
    } finally {
        await context.close()
    }
})
