import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromiumExtension } from "../../src/paths.js"

// A user adds a site from one of its pages. The toolbar popup then offers to look for the rest of their library
// on that site; the app opens on Sources, finds the titles the site has at the addresses it builds from their
// names, and adds the ones the user keeps ticked: a title already on another site gets this one as another
// source, a title on no site yet is tracked here. A title the site does not have, and a page that does not name
// the title, are never offered. The site is a made-up host served through route interception, with the host
// grant written into a temp copy of the manifest, as in followed-site.test.js.

const HOST = "shelf-demo.net"
const CHAPTER_URL = `https://${HOST}/manga/demo-series/chapter-3`
const DETECTED = '#__amr-chapter-prompt__[data-amr-mode="detected"]'
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64"
)
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")
const CHAPTER_HTML = readFileSync(path.join(FIXTURES, "detected-chapter.html"), "utf8")

const seriesPage = (slug, title) => `<!doctype html><html><head><title>${title}</title>
<meta property="og:title" content="${title}"></head><body><h1>${title}</h1>
<a href="/manga/${slug}/chapter-1">Chapter 1</a><a href="/manga/${slug}/chapter-2">Chapter 2</a></body></html>`

const SERIES = {
    "lantern-keeper": seriesPage("lantern-keeper", "Lantern Keeper - Shelf Demo"),
    "quiet-orchard": seriesPage("quiet-orchard", "Quiet Orchard"),
    "glass-harbor": seriesPage("glass-harbor", "Shelf Demo - Read comics online")
}

const row = (id, title, extra) => ({
    id,
    title,
    normalizedTitle: title.toLowerCase(),
    authors: [],
    status: "ongoing",
    addedAt: 1,
    updatedAt: 1,
    ...extra
})
const LIBRARY = [
    row("older-site:manga:lantern-keeper", "Lantern Keeper", {
        sourceId: "older-site",
        sourceUrl: "https://older-site.example/series/lk/chapter-1",
        sourceMangaId: "lk",
        mangaUrl: "https://older-site.example/series/lk"
    }),
    row("anilist:9001", "Quiet Orchard", {
        sourceId: "anilist.co",
        sourceUrl: "https://anilist.co/manga/9001",
        anilistId: 9001,
        manualTracking: true
    }),
    row("older-site:manga:glass-harbor", "Glass Harbor", {
        sourceId: "older-site",
        sourceUrl: "https://older-site.example/series/gh/chapter-1",
        sourceMangaId: "gh",
        mangaUrl: "https://older-site.example/series/gh"
    }),
    row("older-site:manga:missing-thing", "Missing Thing", {
        sourceId: "older-site",
        sourceUrl: "https://older-site.example/series/mt/chapter-1",
        sourceMangaId: "mt",
        mangaUrl: "https://older-site.example/series/mt"
    })
]

function buildWithGrant() {
    const directory = mkdtempSync(path.join(tmpdir(), "amr-find-titles-"))
    cpSync(chromiumExtension, directory, { recursive: true })
    const manifestPath = path.join(directory, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    manifest.host_permissions = [...(manifest.host_permissions ?? []), `https://${HOST}/*`, `https://www.${HOST}/*`]
    writeFileSync(manifestPath, JSON.stringify(manifest))
    return directory
}

function serve(route) {
    const { pathname } = new URL(route.request().url())
    if (pathname.startsWith("/img/")) return route.fulfill({ status: 200, contentType: "image/png", body: PNG })
    if (pathname.startsWith("/manga/demo-series")) {
        return route.fulfill({ status: 200, contentType: "text/html", body: CHAPTER_HTML })
    }
    const slug = /^\/manga\/([^/]+)\/?$/.exec(pathname)?.[1]
    const body = slug ? SERIES[slug] : undefined
    return body
        ? route.fulfill({ status: 200, contentType: "text/html", body })
        : route.fulfill({ status: 404, contentType: "text/html", body: "<title>Not found</title>" })
}

const readDb = page =>
    page.evaluate(
        () =>
            new Promise((resolve, reject) => {
                const open = indexedDB.open("all-mangas-reader")
                open.onerror = () => reject(open.error)
                open.onsuccess = () => {
                    const db = open.result
                    const tx = db.transaction(["manga", "versions"])
                    const manga = tx.objectStore("manga").getAll()
                    const versions = tx.objectStore("versions").getAll()
                    tx.oncomplete = () => {
                        db.close()
                        resolve({ manga: manga.result, versions: versions.result })
                    }
                }
            })
    )

test("after adding a site, the popup offers to find the library's other titles there, and they get added", async () => {
    test.setTimeout(90_000)
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
        const extensionId = new URL(worker.url()).host
        await context.route(`https://${HOST}/**`, serve)

        const popup = await context.newPage()
        await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" })
        await popup.evaluate(
            manga =>
                new Promise((resolve, reject) => {
                    const open = indexedDB.open("all-mangas-reader")
                    open.onerror = () => reject(open.error)
                    open.onsuccess = () => {
                        const db = open.result
                        const tx = db.transaction("manga", "readwrite")
                        for (const m of manga) tx.objectStore("manga").put(m)
                        tx.oncomplete = () => {
                            db.close()
                            resolve()
                        }
                        tx.onerror = () => reject(tx.error)
                    }
                }),
            LIBRARY
        )

        const page = await context.newPage()
        await page.goto(CHAPTER_URL, { waitUntil: "load" })
        await expect(page.locator(DETECTED)).toBeAttached({ timeout: 15_000 })
        await page.bringToFront()
        await popup.reload({ waitUntil: "domcontentloaded" })
        await popup.getByRole("button", { name: "Add this site" }).click({ timeout: 15_000 })
        await popup.getByRole("button", { name: "Add site", exact: true }).click()
        await expect(popup.getByText(/^Site added\./)).toBeVisible({ timeout: 20_000 })

        const offer = popup.getByRole("button", { name: "Find my other titles here" })
        await expect(offer).toBeVisible({ timeout: 10_000 })
        const [app] = await Promise.all([context.waitForEvent("page"), offer.click()])
        await app.waitForLoadState("domcontentloaded")

        const panel = app.locator(".find-titles")
        await expect(panel).toContainText("Found 2 of your titles here", { timeout: 30_000 })
        const items = panel.locator(".find-titles-list li")
        await expect(items).toHaveCount(2)
        await expect(items.filter({ hasText: "Lantern Keeper" })).toContainText("Add as another source")
        await expect(items.filter({ hasText: "Quiet Orchard" })).toContainText("Track here")
        await expect(panel).not.toContainText("Glass Harbor")
        await expect(panel).not.toContainText("Missing Thing")

        await panel.getByRole("button", { name: "Add 2 titles" }).click()
        await expect(panel).toContainText("Added 2 titles", { timeout: 30_000 })

        const { manga, versions } = await readDb(app)
        expect(versions.some(v => v.sourceId === HOST && v.sourceMangaId === "lantern-keeper")).toBe(true)
        expect(manga.find(m => m.title === "Lantern Keeper")?.sourceId).toBe("older-site")
        expect(manga.find(m => m.title === "Quiet Orchard")?.sourceId).toBe(HOST)
        expect(manga.find(m => m.title === "Glass Harbor")?.sourceId).toBe("older-site")
    } finally {
        await context.close()
        rmSync(extension, { recursive: true, force: true })
    }
})
