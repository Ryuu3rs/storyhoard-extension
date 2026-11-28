import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import path from "node:path"
import { artifactsDirectory, chromiumExtension } from "../../src/paths.js"

// A title kept from a source whose adapter is gone is listed as "Source N". Without its address the user
// had no way to tell which site it was, and the reachability check skipped it, so it read "Not checked yet"
// forever. The row now shows the host the title points at, the check covers it, and the rename box comes
// prefilled with that host without saving it.

const HOST = "old-reader.invalid"

function seedTitle(worker) {
    return worker.evaluate(
        host =>
            new Promise((resolve, reject) => {
                const open = indexedDB.open("all-mangas-reader")
                open.onerror = () => reject(open.error)
                open.onsuccess = () => {
                    const tx = open.result.transaction(["manga"], "readwrite")
                    tx.objectStore("manga").put({
                        id: "retired-site:manga:demo",
                        sourceId: "retired-site",
                        sourceUrl: `https://${host}/series/demo`,
                        title: "Demo Series",
                        normalizedTitle: "demo series",
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

function storedName(worker) {
    return worker.evaluate(
        () =>
            new Promise((resolve, reject) => {
                const open = indexedDB.open("all-mangas-reader")
                open.onerror = () => reject(open.error)
                open.onsuccess = () => {
                    const req = open.result.transaction(["sourcePrefs"]).objectStore("sourcePrefs").get("retired-site")
                    req.onsuccess = () => {
                        open.result.close()
                        resolve(req.result?.name ?? null)
                    }
                }
            })
    )
}

test("a source with no adapter shows its address, gets checked, and offers the address as a name", async () => {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
    })
    try {
        let [worker] = context.serviceWorkers()
        worker ??= await context.waitForEvent("serviceworker")
        await worker.evaluate(() => true)
        const extensionId = new URL(worker.url()).host

        const app = await context.newPage()
        await app.goto(`chrome-extension://${extensionId}/app.html`, { waitUntil: "domcontentloaded" })
        await seedTitle(worker)
        await app.reload({ waitUntil: "domcontentloaded" })
        await app
            .getByRole("navigation", { name: "Main navigation" })
            .getByRole("button", { name: "Sources", exact: true })
            .click()

        const row = app.locator(".source-row").filter({ hasText: HOST })
        await expect(row).toHaveCount(1, { timeout: 15_000 })
        await expect(row.locator(".source-name")).toHaveText(/^Source \d+$/)
        await expect(row.locator(".source-host")).toHaveText(HOST)
        await expect(row.locator(".source-health")).toHaveText("Not reachable", { timeout: 30_000 })

        await app.screenshot({ path: path.join(artifactsDirectory, "source-address-row.png"), fullPage: false })

        await row.locator(".source-name").click()
        await expect(app.getByRole("textbox", { name: /Name for source/ })).toHaveValue(HOST)
        await app.getByRole("button", { name: "Cancel", exact: true }).click()
        expect(await storedName(worker)).toBeNull()
    } finally {
        await context.close()
    }
})
