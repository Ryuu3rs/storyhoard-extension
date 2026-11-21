import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { chromiumExtension } from "../../src/paths.js"

// An upgrade from a 0.32.2 profile in the built store extension: the library holds sample rows 0.32.2 could
// load (ids seed-*, covers under /sample-covers/), titles on a site the store build no longer bundles, and the
// seed profile rows for both. The update is a real one: the same unpacked folder is loaded again through CDP
// Extensions.loadUnpacked with a higher manifest version, which Chromium reports to runtime.onInstalled as
// reason "update". Every host is made up and every request is stubbed.

const OLD_SITE = "oldreader-demo.net"
const SAMPLE_SITE = "samplesite-demo.net"
const profile = (id, host) => ({
    profileFormat: 2,
    id,
    name: id,
    engine: "generic",
    numberingKind: "chapter",
    origin: `https://${host}`,
    domains: [host],
    languages: ["en"],
    capabilities: ["manga"],
    requestRateLimit: { requests: 3, intervalMs: 1000 },
    origins: [`https://${host}/*`],
    match: { manga: "^/series/([a-z0-9-]+)/?$", chapter: "^/series/([a-z0-9-]+)/chapter-([0-9]+)/?$" },
    series: { urlTemplate: "/series/{slug}", titlePattern: "<title>(?<title>[^<]+)</title>" }
})
const now = Date.now()
const manga = (id, title, sourceId, host, extra = {}) => ({
    id,
    title,
    normalizedTitle: title.toLowerCase(),
    authors: [],
    status: "ongoing",
    sourceId,
    sourceUrl: `https://${host}/series/${id}/chapter-1`,
    sourceMangaId: id,
    mangaUrl: `https://${host}/series/${id}`,
    addedAt: now - 86400000,
    updatedAt: now - 3600000,
    ...extra
})
const SEED = {
    manga: [
        manga("seed-a-001", "Sample Untouched", "samplesite", SAMPLE_SITE, { coverUrl: "/sample-covers/a.jpg" }),
        manga("seed-a-002", "Sample Touched", "sampletwo", "sampletwo-demo.net", {
            coverUrl: "/sample-covers/b.jpg",
            lastReadChapterNumber: 1,
            readingStatus: "planning"
        }),
        manga("user-001", "Own Title On Old Site", "oldreader", OLD_SITE, { lastReadChapterNumber: 4 }),
        manga("user-002", "Own Second Title", "oldreader", OLD_SITE)
    ],
    chapters: [
        {
            id: "seed-a-001-ch",
            mangaId: "seed-a-001",
            sourceId: "samplesite",
            title: "Chapter 1",
            url: `https://${SAMPLE_SITE}/series/seed-a-001/chapter-1`,
            sortKey: 1
        },
        {
            id: "user-001-ch4",
            mangaId: "user-001",
            sourceId: "oldreader",
            title: "Chapter 4",
            url: `https://${OLD_SITE}/series/user-001/chapter-4`,
            sortKey: 4
        }
    ],
    historyEvents: [
        { id: 9001, mangaId: "user-001", chapterId: "user-001-ch4", type: "completed", occurredAt: now - 7200000 }
    ],
    archProfiles: [
        { id: "samplesite", profile: profile("samplesite", SAMPLE_SITE), importedAt: now - 86400000, origin: "seed" },
        { id: "oldreader", profile: profile("oldreader", OLD_SITE), importedAt: now - 86400000, origin: "seed" }
    ]
}

const seedDb = seed =>
    new Promise((resolve, reject) => {
        const open = indexedDB.open("all-mangas-reader")
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
            const db = open.result
            const stores = Object.keys(seed)
            const tx = db.transaction(stores, "readwrite")
            for (const store of stores) for (const row of seed[store]) tx.objectStore(store).put(row)
            tx.oncomplete = () => {
                db.close()
                resolve()
            }
            tx.onerror = () => reject(tx.error)
        }
    })

const readDb = () =>
    new Promise((resolve, reject) => {
        const open = indexedDB.open("all-mangas-reader")
        open.onerror = () => reject(open.error)
        open.onsuccess = async () => {
            const db = open.result
            const all = store =>
                new Promise((res, rej) => {
                    const r = db.transaction(store).objectStore(store).getAll()
                    r.onsuccess = () => res(r.result)
                    r.onerror = () => rej(r.error)
                })
            const out = {}
            for (const store of ["manga", "chapters", "historyEvents", "archProfiles", "backups"])
                out[store] = db.objectStoreNames.contains(store) ? await all(store) : null
            db.close()
            resolve(out)
        }
    })

function setVersion(dir, version) {
    const file = path.join(dir, "manifest.json")
    const manifest = JSON.parse(readFileSync(file, "utf8"))
    manifest.version = version
    writeFileSync(file, JSON.stringify(manifest))
}

// Launches a copy of the build at version 0.0.1. update() loads the same folder at the shipped version.
async function launchOld() {
    const ext = mkdtempSync(path.join(tmpdir(), "amr-upgrade-ext-"))
    cpSync(chromiumExtension, ext, { recursive: true })
    const shipped = JSON.parse(readFileSync(path.join(chromiumExtension, "manifest.json"), "utf8")).version
    setVersion(ext, "0.0.1")
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--enable-unsafe-extension-debugging"]
    })
    await context.route(/^https?:\/\//, route => route.fulfill({ status: 404, contentType: "text/html", body: "" }))
    let [worker] = context.serviceWorkers()
    worker ??= await context.waitForEvent("serviceworker")
    const appUrl = `chrome-extension://${new URL(worker.url()).host}/app.html`
    const update = async () => {
        setVersion(ext, shipped)
        const cdp = await context.browser().newBrowserCDPSession()
        await cdp.send("Extensions.loadUnpacked", { path: ext })
    }
    const close = async () => {
        await context.close()
        rmSync(ext, { recursive: true, force: true })
    }
    return { context, appUrl, update, close }
}

async function openApp(context, appUrl) {
    const page = await context.newPage()
    await page.goto(appUrl, { waitUntil: "domcontentloaded" })
    return page
}

const storage = (page, key) => page.evaluate(async k => (await chrome.storage.local.get(k))[k], key)

async function seedThenUpdate(context, appUrl, update) {
    const page = await openApp(context, appUrl)
    await page.waitForTimeout(1500)
    await page.evaluate(seedDb, SEED)
    await page.evaluate(() => chrome.storage.local.remove("sampleCleanupV1"))
    await page.close()
    await update()
    const app = await openApp(context, appUrl)
    await expect.poll(() => storage(app, "sampleCleanupV1"), { timeout: 20_000 }).toBeTruthy()
    return app
}

test("a 0.32.2 library upgrades: untouched samples go, everything else stays", async () => {
    test.setTimeout(90_000)
    const { context, appUrl, update, close } = await launchOld()
    try {
        const app = await seedThenUpdate(context, appUrl, update)
        const after = await app.evaluate(readDb)
        expect(after.manga.map(m => m.id).sort()).toEqual(["seed-a-002", "user-001", "user-002"])
        expect(after.manga.find(m => m.id === "seed-a-002").coverUrl).toBeUndefined()
        expect(after.manga.find(m => m.id === "user-001")).toMatchObject({ lastReadChapterNumber: 4 })
        expect(after.chapters.map(c => c.id)).toEqual(["user-001-ch4"])
        expect(after.historyEvents.map(h => h.id)).toEqual([9001])
        expect(after.archProfiles.map(p => p.id).sort()).toEqual(["oldreader"])
        expect(after.backups.map(b => b.reason)).toContain("pre-update")
    } finally {
        await close()
    }
})

test("restoring the pre-update backup does not bring the removed samples back", async () => {
    test.setTimeout(90_000)
    const { context, appUrl, update, close } = await launchOld()
    try {
        const app = await seedThenUpdate(context, appUrl, update)
        const { backups } = await app.evaluate(readDb)
        const preUpdate = backups.find(b => b.reason === "pre-update")
        expect(preUpdate).toBeTruthy()

        const restored = await app.evaluate(
            id => chrome.runtime.sendMessage({ type: "data:backup:restore", id }),
            preUpdate.id
        )
        expect(restored).toMatchObject({ ok: true })
        const after = await app.evaluate(readDb)
        expect(after.manga.filter(m => m.coverUrl?.startsWith("/sample-covers/")).map(m => m.id)).toEqual([])
        expect(after.manga.map(m => m.id).sort()).toEqual(["seed-a-002", "user-001", "user-002"])
        expect(after.manga.find(m => m.id === "seed-a-002")).toMatchObject({
            lastReadChapterNumber: 1,
            readingStatus: "planning"
        })
    } finally {
        await close()
    }
})
