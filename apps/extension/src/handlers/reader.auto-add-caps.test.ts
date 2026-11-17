import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { HandlerContext } from "../background/handler-types"

vi.mock("../live", () => ({ publishLive: vi.fn() }))
vi.mock("../notifications", () => ({ notifyNewChapters: vi.fn() }))
const settings = vi.hoisted(() => ({ autoAdd: true, markReadOnVisit: true, language: "en" }))
vi.mock("../settings", () => ({ getSettings: async () => ({ ...settings }) }))
vi.mock("../background/tab-fetch", () => ({ fetchChapterHtmlViaTab: vi.fn() }))
vi.stubGlobal("browser", {
    action: {
        setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
        setBadgeText: vi.fn().mockResolvedValue(undefined)
    },
    scripting: { executeScript: vi.fn() }
})
vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("no network")))
)

const { db } = await import("../database")
const { readerHandlers, MAX_AUTO_ADDED_PER_SITE_PER_HOUR, MAX_AUTO_ADDED_PER_SITE_PER_DAY, MAX_AUTO_ADDED_PER_HOUR } =
    await import("./reader")

const senderFor = (url: string) => ({ sender: { url, tab: { url } } }) as unknown as HandlerContext
const trackDetected = (url: string, extra: { markRead?: boolean } = {}) =>
    readerHandlers["work:track-detected"]!({ type: "work:track-detected", url, ...extra }, senderFor(url)) as Promise<{
        tracked?: boolean
        created?: boolean
        mangaId?: string
    }>

beforeEach(async () => {
    settings.autoAdd = true
    await Promise.all([db.manga.clear(), db.chapters.clear(), db.progress.clear(), db.historyEvents.clear()])
})

describe("auto-add caps across sites", () => {
    it("holds every detected site together to one hourly total", async () => {
        for (let i = 0; i < MAX_AUTO_ADDED_PER_HOUR + 10; i++) {
            await trackDetected(`https://reader-${i}.example/manga/series-${i}/chapter-1`)
        }
        expect(await db.manga.count()).toBe(MAX_AUTO_ADDED_PER_HOUR)
    })

    it("counts subdomains under a registry suffix by the owner's name, not by the suffix", async () => {
        for (let i = 0; i < 15; i++) await trackDetected(`https://s${i}.one-site.co.uk/manga/a-${i}/chapter-1`)
        await trackDetected("https://other-site.co.uk/manga/b/chapter-1")
        const rows = await db.manga.toArray()
        expect(rows.filter(m => m.sourceId.endsWith(".one-site.co.uk"))).toHaveLength(MAX_AUTO_ADDED_PER_SITE_PER_HOUR)
        expect(rows.filter(m => m.sourceId === "detected:other-site.co.uk")).toHaveLength(1)
    })

    it("marks what it auto-added, so only those rows count", async () => {
        const result = await trackDetected("https://reader.example/manga/new-one/chapter-1")
        expect(typeof (await db.manga.get(result.mangaId!))!.autoAddedAt).toBe("number")
    })
})

describe("Mark read from the page panel", () => {
    it("adds nothing with auto-add off", async () => {
        settings.autoAdd = false
        const result = await trackDetected("https://reader.example/manga/wanted/chapter-1", { markRead: true })
        expect(result.tracked).toBe(false)
        expect(await db.manga.count()).toBe(0)
    })

    it("adds nothing past the site's cap", async () => {
        for (let i = 0; i < MAX_AUTO_ADDED_PER_SITE_PER_HOUR; i++) {
            await trackDetected(`https://reader.example/manga/spam-${i}/chapter-1`)
        }
        const result = await trackDetected("https://reader.example/manga/one-more/chapter-1", { markRead: true })
        expect(result.tracked).toBe(false)
        expect(await db.manga.count()).toBe(MAX_AUTO_ADDED_PER_SITE_PER_HOUR)
    })

    it("still marks a chapter read on a title the library already keeps, caps reached or not", async () => {
        settings.autoAdd = true
        const first = await trackDetected("https://reader.example/manga/kept/chapter-1")
        settings.autoAdd = false
        const result = await trackDetected("https://reader.example/manga/kept/chapter-2", { markRead: true })
        expect(result).toMatchObject({ tracked: true, mangaId: first.mangaId })
        expect((await db.manga.get(first.mangaId!))!.lastReadChapterNumber).toBe(2)
    })
})

describe("auto-add cap per site", () => {
    it("is not reset by walking the site's own subdomains", async () => {
        // A wildcard-DNS site sends the tab through a1., a2., ... each a fresh "site" with its own allowance.
        for (let i = 0; i < 60; i++) await trackDetected(`https://a${i}.evil-reader.example/manga/spam-${i}/chapter-1`)
        const all = await db.manga.toArray()
        const fromEvil = all.filter(m => m.sourceId.endsWith(".evil-reader.example"))
        expect(fromEvil.length).toBeLessThanOrEqual(MAX_AUTO_ADDED_PER_SITE_PER_HOUR)
    })

    it("holds when several visits to the site arrive at once", async () => {
        // autoAddAllowed() reads the count outside the per-site promotion lock, so every concurrent visit
        // sees the same count below the cap and adds.
        await Promise.all(
            Array.from({ length: 30 }, (_, i) =>
                trackDetected(`https://evil-reader.example/manga/burst-${i}/chapter-1`)
            )
        )
        expect(await db.manga.where("sourceId").equals("detected:evil-reader.example").count()).toBeLessThanOrEqual(
            MAX_AUTO_ADDED_PER_SITE_PER_HOUR
        )
    })

    it("is not used up by titles the account sync pulled in today", async () => {
        // applyRemoteItem stamps addedAt: Date.now() on every pulled title, so linking a new device that has
        // 30 titles on this site leaves no auto-add allowance on it for 24 hours.
        const now = Date.now()
        await db.manga.bulkPut(
            Array.from({ length: MAX_AUTO_ADDED_PER_SITE_PER_DAY }, (_, i) => ({
                id: `detected:reader.example:manga:synced-${i}`,
                title: `Synced ${i}`,
                normalizedTitle: `synced ${i}`,
                sourceId: "detected:reader.example",
                sourceUrl: `https://reader.example/manga/synced-${i}`,
                mangaUrl: `https://reader.example/manga/synced-${i}`,
                authors: [],
                status: "unknown",
                addedAt: now - 60_000,
                updatedAt: now - 30 * 24 * 60 * 60 * 1000
            })) as never
        )
        const result = await trackDetected("https://reader.example/manga/brand-new/chapter-1")
        expect(result).toMatchObject({ tracked: true, created: true })
    })
})
