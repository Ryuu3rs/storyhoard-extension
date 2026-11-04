import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { chromiumExtension } from "../../src/paths.js"

// A reader that keeps the page in its address: /chapter/<id>/1, /chapter/<id>/2. The saved chapter has no
// page in its address, so the panel has to look it up without one, and a page turn is not a new chapter.
// The title is seeded, and the page is served through route interception, so the panel's own part is tested
// without depending on a live site.

const CHAPTER = "00000000-0000-4000-8000-000000000002"
const CHAPTER_ADDRESS = `https://mangadex.org/chapter/${CHAPTER}`
const MANGA_ID = "mangadex:manga:00000000-0000-4000-8000-00000000000a"
const PANEL = "#__amr-chapter-prompt__"

const seed = ({ chapterAddress, mangaId, chapterId }) =>
    new Promise((resolve, reject) => {
        const open = indexedDB.open("all-mangas-reader")
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
            const db = open.result
            const tx = db.transaction(["manga", "sourceLinks", "chapters"], "readwrite")
            tx.objectStore("manga").put({
                id: mangaId,
                title: "Seeded Series",
                normalizedTitle: "seeded series",
                authors: [],
                status: "unknown",
                addedAt: 1,
                updatedAt: 1,
                sourceId: "mangadex",
                sourceUrl: chapterAddress,
                mangaUrl: "https://mangadex.org/title/00000000-0000-4000-8000-00000000000a"
            })
            tx.objectStore("sourceLinks").put({
                mangaId,
                sourceId: "mangadex",
                url: "https://mangadex.org/title/00000000-0000-4000-8000-00000000000a",
                title: "Seeded Series",
                addedAt: 1,
                updatedAt: 1
            })
            for (const [number, id] of [
                [1, "00000000-0000-4000-8000-000000000001"],
                [2, chapterId],
                [3, "00000000-0000-4000-8000-000000000003"]
            ]) {
                tx.objectStore("chapters").put({
                    id: `mangadex:chapter:${id}`,
                    mangaId,
                    sourceId: "mangadex",
                    title: `Chapter ${number}`,
                    url: `https://mangadex.org/chapter/${id}`,
                    sortKey: number
                })
            }
            tx.oncomplete = () => {
                db.close()
                resolve()
            }
            tx.onerror = () => reject(tx.error)
        }
    })

const readPanel = page =>
    page.evaluate(selector => {
        const host = document.querySelector(selector)
        if (!host) return null
        const shadow = host.shadowRoot
        const select = shadow.querySelector("select.chapsel")
        return {
            title: shadow.querySelector(".title")?.textContent?.trim(),
            options: select?.options.length ?? 0,
            selected: select?.selectedOptions[0]?.textContent?.trim(),
            marked: host.getAttribute("data-test-same-panel")
        }
    }, PANEL)

test("the panel finds a chapter whose address carries the page, and survives a page turn", async () => {
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        args: [`--disable-extensions-except=${chromiumExtension}`, `--load-extension=${chromiumExtension}`]
    })
    try {
        let [worker] = context.serviceWorkers()
        worker ??= await context.waitForEvent("serviceworker")
        const app = await context.newPage()
        await app.goto(`chrome-extension://${new URL(worker.url()).host}/app.html`, { waitUntil: "domcontentloaded" })
        await app.waitForTimeout(1500)
        await app.evaluate(seed, {
            chapterAddress: CHAPTER_ADDRESS,
            mangaId: MANGA_ID,
            chapterId: CHAPTER
        })

        await context.route("https://mangadex.org/chapter/**", route =>
            route.fulfill({
                contentType: "text/html",
                body: "<!doctype html><html><head><title>Reader</title></head><body><div style='height:3000px'>page</div></body></html>"
            })
        )
        const page = await context.newPage()
        await page.goto(`${CHAPTER_ADDRESS}/1`)

        await expect
            .poll(() => readPanel(page), { timeout: 20_000 })
            .toMatchObject({
                title: "Seeded Series",
                options: 3,
                selected: "Chapter 2"
            })

        await page.evaluate(selector => {
            document.querySelector(selector).setAttribute("data-test-same-panel", "1")
            history.pushState({}, "", location.pathname.replace(/\/1$/, "/2"))
        }, PANEL)
        // Longer than the panel's own address poll, so a rebuild would have happened by now.
        await page.waitForTimeout(3000)

        expect(await readPanel(page)).toMatchObject({ title: "Seeded Series", marked: "1", options: 3 })
    } finally {
        await context.close()
    }
})
