import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { chromiumExtension } from "../../src/paths.js"

// Races around the title dialog's "Merge into…" picker. library:merge first writes a full
// restore point (createBackup), which takes real time on a big library; the stub below stands in
// for that by holding the merge message before passing it on. The host is made up.

const HOST = "moved-demo.example"
const base = {
    normalizedTitle: "",
    authors: [],
    status: "ongoing",
    sourceId: "moveddemo",
    manualTracking: true,
    addedAt: 1,
    updatedAt: 1
}
const tracked = {
    ...base,
    id: "moveddemo:manga:night-walker-1a2b3c4d",
    title: "Night Walker",
    normalizedTitle: "night walker",
    sourceMangaId: "night-walker-1a2b3c4d",
    mangaUrl: `https://${HOST}/comics/night-walker-1a2b3c4d/`,
    sourceUrl: `https://${HOST}/comics/night-walker-1a2b3c4d/chapter/99`,
    lastReadChapterNumber: 99,
    latestChapterNumber: 99
}
const copy = {
    ...base,
    id: "moveddemo:manga:night-walker-9f8e7d6c",
    title: "Night Walker Chapter 102",
    normalizedTitle: "night walker chapter 102",
    sourceMangaId: "night-walker-9f8e7d6c",
    mangaUrl: `https://${HOST}/comics/night-walker-9f8e7d6c/`,
    sourceUrl: `https://${HOST}/comics/night-walker-9f8e7d6c/chapter/102`,
    lastReadChapterNumber: 102,
    latestChapterNumber: 102,
    addedAt: 2
}
const copyChapter = {
    id: "moveddemo:chapter:night-walker-9f8e7d6c:102",
    mangaId: copy.id,
    sourceId: "moveddemo",
    title: "Ch.102",
    url: copy.sourceUrl,
    sortKey: 102
}
const copyHistory = { mangaId: copy.id, chapterId: copyChapter.id, type: "completed", occurredAt: 1000 }

const seed = ({ titles, chapter, event }) =>
    new Promise((resolve, reject) => {
        const open = indexedDB.open("all-mangas-reader")
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
            const db = open.result
            const tx = db.transaction(["manga", "chapters", "historyEvents"], "readwrite")
            for (const manga of titles) tx.objectStore("manga").put(manga)
            tx.objectStore("chapters").put(chapter)
            tx.objectStore("historyEvents").put(event)
            tx.oncomplete = () => {
                db.close()
                resolve()
            }
            tx.onerror = () => reject(tx.error)
        }
    })

const readState = ids =>
    new Promise((resolve, reject) => {
        const open = indexedDB.open("all-mangas-reader")
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
            const db = open.result
            const tx = db.transaction(["manga", "historyEvents"], "readonly")
            const titles = tx.objectStore("manga").getAll()
            const events = tx.objectStore("historyEvents").getAll()
            tx.oncomplete = () => {
                db.close()
                const byId = new Map(titles.result.map(m => [m.id, m]))
                resolve({
                    copyGone: !byId.has(ids.copy),
                    trackedRead: byId.get(ids.tracked)?.lastReadChapterNumber,
                    historyOwners: events.result.map(e => e.mangaId)
                })
            }
            tx.onerror = () => reject(tx.error)
        }
    })

async function openCopyDialog() {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        viewport: { width: 1280, height: 900 },
        args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
    })
    await context.route(/^https?:\/\//, route => route.fulfill({ status: 404, body: "" }))
    let [worker] = context.serviceWorkers()
    worker ??= await context.waitForEvent("serviceworker")
    const page = await context.newPage()
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/app.html`, { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(1500)
    await page.evaluate(seed, { titles: [tracked, copy], chapter: copyChapter, event: copyHistory })
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Library" }).click()
    await page.locator(".filter-chips .chip", { hasText: /^\s*All/ }).click()
    await page.locator("article", { hasText: copy.title }).getByRole("button", { name: "Options" }).click()
    const dialog = page.getByRole("dialog", { name: copy.title })
    await expect(dialog).toBeVisible()
    return { context, page, dialog }
}

// Holds library:merge for `ms` before passing it to the background, like a slow restore point.
const slowMerge = (page, ms) =>
    page.evaluate(delay => {
        const original = chrome.runtime.sendMessage.bind(chrome.runtime)
        chrome.runtime.sendMessage = (message, ...rest) => {
            if (message && message.type === "library:merge") {
                return new Promise(resolve => setTimeout(resolve, delay)).then(() => original(message, ...rest))
            }
            return original(message, ...rest)
        }
    }, ms)

test("Remove on the same dialog is blocked while a merge of that title is still running", async () => {
    const { context, page, dialog } = await openCopyDialog()
    try {
        await slowMerge(page, 2000)
        await dialog.getByRole("button", { name: "Merge into…" }).click()
        const picker = dialog.getByRole("group", { name: "Merge into another title" })
        page.on("dialog", prompt => void prompt.accept())
        await picker.getByRole("button", { name: /^Night Walker\b/ }).click()
        // The merge is now in flight. The user, unsure it worked, presses Remove on the same copy.
        await dialog
            .getByRole("button", { name: "Remove", exact: true })
            .click({ timeout: 1000 })
            .catch(() => {})
        await page.waitForTimeout(3500)
        const state = await page.evaluate(readState, { copy: copy.id, tracked: tracked.id })
        console.log("after merge + remove race:", JSON.stringify(state))
        // The merge was confirmed first: its history must end up on the tracked title.
        expect(state.historyOwners).toEqual([tracked.id])
        expect(state.trackedRead).toBe(102)
    } finally {
        await context.close()
    }
})

test("the dialog stays put while a merge runs, then shows the kept title", async () => {
    const { context, page, dialog } = await openCopyDialog()
    try {
        await slowMerge(page, 1500)
        await dialog.getByRole("button", { name: "Merge into…" }).click()
        const picker = dialog.getByRole("group", { name: "Merge into another title" })
        page.on("dialog", prompt => void prompt.accept())
        await picker.getByRole("button", { name: /^Night Walker\b/ }).click()
        await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeDisabled()
        await page.keyboard.press("Escape")
        await expect(dialog).toBeVisible()
        await expect(page.getByRole("dialog", { name: tracked.title, exact: true })).toBeVisible({ timeout: 5000 })
        const state = await page.evaluate(readState, { copy: copy.id, tracked: tracked.id })
        expect(state.copyGone).toBe(true)
        expect(state.historyOwners).toEqual([tracked.id])
    } finally {
        await context.close()
    }
})

test("the merge picker does not stay open with the old search after the dialog is closed", async () => {
    const { context, page, dialog } = await openCopyDialog()
    try {
        await dialog.getByRole("button", { name: "Merge into…" }).click()
        await dialog.getByRole("searchbox", { name: /Search your library/ }).fill("zzz")
        await page.keyboard.press("Escape")
        await expect(page.getByRole("dialog")).toHaveCount(0)
        await page.locator("article", { hasText: copy.title }).getByRole("button", { name: "Options" }).click()
        const again = page.getByRole("dialog", { name: copy.title })
        await expect(again).toBeVisible()
        await expect(again.getByRole("group", { name: "Merge into another title" })).toHaveCount(0)
    } finally {
        await context.close()
    }
})
