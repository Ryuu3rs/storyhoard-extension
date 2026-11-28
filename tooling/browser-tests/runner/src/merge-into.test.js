import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { artifactsDirectory, chromiumExtension } from "../../src/paths.js"

// A site moved a series to a new address (it changed the hash on the end of the slug) and a visit there
// started a second copy of a tracked title, with its own read chapter and history. The Library lists the two
// as duplicates, and the copy's options dialog can merge it into the tracked title, moving its history there
// instead of deleting it. The host is made up.

const SHOTS = process.env.JOURNEY_SHOTS ?? path.join(artifactsDirectory, "journey-shots")
mkdirSync(SHOTS, { recursive: true })

const HOST = "moved-demo.net"
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

test("a second copy started at a moved address merges into the tracked title with its history", async () => {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        viewport: { width: 1280, height: 900 },
        args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
    })
    try {
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

        await page.getByRole("button", { name: /^Tools/ }).click()
        await expect(page.getByRole("menuitem", { name: /Duplicates \(1\)/ })).toBeVisible()
        await page.getByRole("button", { name: /^Tools/ }).click()

        await page.locator("article", { hasText: copy.title }).getByRole("button", { name: "Options" }).click()
        const dialog = page.getByRole("dialog", { name: copy.title })
        await expect(dialog).toBeVisible()
        await dialog.getByRole("button", { name: "Merge into…" }).click()
        const picker = dialog.getByRole("group", { name: "Merge into another title" })
        await expect(picker).toBeVisible()
        const target = picker.getByRole("button", { name: /^Night Walker\b/ })
        await expect(target).toHaveCount(1)
        await page.screenshot({ path: path.join(SHOTS, "merge-into-picker.png") })

        page.once("dialog", prompt => {
            expect(prompt.message()).toContain(`into "${tracked.title}"`)
            void prompt.accept()
        })
        await target.click()

        await expect
            .poll(() => page.evaluate(readState, { copy: copy.id, tracked: tracked.id }))
            .toEqual({ copyGone: true, trackedRead: 102, historyOwners: [tracked.id] })
        await expect(page.getByRole("dialog", { name: tracked.title })).toBeVisible()
    } finally {
        await context.close()
    }
})

test("Remove on the options dialog asks first, since it deletes the reading history", async () => {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        viewport: { width: 1280, height: 900 },
        args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
    })
    try {
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

        page.once("dialog", prompt => {
            expect(prompt.message()).toContain("reading history goes with it")
            void prompt.dismiss()
        })
        await dialog.getByRole("button", { name: "Remove", exact: true }).click()
        await page.waitForTimeout(500)
        const state = await page.evaluate(readState, { copy: copy.id, tracked: tracked.id })
        expect(state.copyGone).toBe(false)
        expect(state.historyOwners).toEqual([copy.id])
    } finally {
        await context.close()
    }
})
