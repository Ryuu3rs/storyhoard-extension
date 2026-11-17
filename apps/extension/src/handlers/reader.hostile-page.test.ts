import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { HandlerContext } from "../background/handler-types"

vi.mock("../live", () => ({ publishLive: vi.fn() }))
vi.mock("../notifications", () => ({ notifyNewChapters: vi.fn() }))
const settings = vi.hoisted(() => ({ autoAdd: true, markReadOnVisit: true, language: "en" }))
vi.mock("../settings", () => ({ getSettings: async () => ({ ...settings }) }))
vi.mock("../background/tab-fetch", () => ({ fetchChapterHtmlViaTab: vi.fn() }))
const scheduleMock = vi.fn()
vi.mock("../background/chapter-cache", async importOriginal => ({
    ...(await importOriginal<typeof import("../background/chapter-cache")>()),
    scheduleChapterListRefresh: (...args: unknown[]) => scheduleMock(...args)
}))
vi.stubGlobal("browser", {
    action: {
        setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
        setBadgeText: vi.fn().mockResolvedValue(undefined)
    },
    scripting: { executeScript: vi.fn() },
    runtime: { getURL: (p: string) => `chrome-extension://amr-id/${p}` }
})
vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("no network in this test")))
)

const { db } = await import("../database")
const { handlers } = await import("../background/dispatch")
const { assertSenderMayRequest } = await import("../background/sender-gate")
const { MAX_AUTO_ADDED_PER_SITE_PER_HOUR } = await import("./reader")

const EXTENSION_BASE = "chrome-extension://amr-id/"
// A content script running on a page the attacker controls. sender.url and sender.tab.url are both the
// attacker's page, exactly as the browser stamps them.
const ATTACKER_PAGE = "https://attacker.example/manga/bait/chapter-1"
const fromAttacker = { url: ATTACKER_PAGE, tab: { id: 7, url: ATTACKER_PAGE } }
const attackerCtx = { sender: fromAttacker } as unknown as HandlerContext

// A title the user reads on a different site.
const VICTIM_SITE = "https://victim-reader.example"
const VICTIM_CHAPTER = `${VICTIM_SITE}/manga/private-title/chapter-12`
const VICTIM_MANGA_ID = "detected:victim-reader.example:manga:private-title"

async function seedVictimTitle() {
    const now = Date.now()
    await db.manga.put({
        id: VICTIM_MANGA_ID,
        title: "A Title The User Reads Privately",
        normalizedTitle: "a title the user reads privately",
        sourceId: "detected:victim-reader.example",
        sourceUrl: VICTIM_CHAPTER,
        mangaUrl: `${VICTIM_SITE}/manga/private-title`,
        authors: [],
        status: "unknown",
        addedAt: now,
        updatedAt: now
    } as never)
    await db.chapters.bulkPut(
        [11, 12, 13].map(n => ({
            id: `detected:victim-reader.example:chapter:private-title:${n}`,
            mangaId: VICTIM_MANGA_ID,
            sourceId: "detected:victim-reader.example",
            title: `Chapter ${n}`,
            url: `${VICTIM_SITE}/manga/private-title/chapter-${n}`,
            sortKey: n
        }))
    )
}

beforeEach(async () => {
    vi.clearAllMocks()
    settings.autoAdd = true
    await Promise.all([db.manga.clear(), db.chapters.clear(), db.progress.clear(), db.historyEvents.clear()])
})

describe("panel read requests from one site about another site's titles", () => {
    it("the sender gate lets a content script ask chapter:siblings and work:chapter-list about any address", () => {
        // Precondition for the two leaks below: nothing upstream of the handlers stops these requests.
        for (const request of [
            { type: "chapter:siblings" as const, url: VICTIM_CHAPTER },
            { type: "work:chapter-list" as const, url: VICTIM_CHAPTER }
        ]) {
            expect(() => assertSenderMayRequest(request, fromAttacker, EXTENSION_BASE)).not.toThrow()
        }
    })

    it("chapter:siblings does not tell attacker.example the title, id and chapters the user reads on another site", async () => {
        await seedVictimTitle()
        const result = (await handlers["chapter:siblings"]!(
            { type: "chapter:siblings", url: VICTIM_CHAPTER },
            attackerCtx
        )) as { mangaTitle: string | null; mangaId: string | null; nextUrl: string | null }
        expect(result.mangaTitle).toBeNull()
        expect(result.mangaId).toBeNull()
        expect(result.nextUrl).toBeNull()
    })

    it("work:chapter-list does not hand attacker.example another site's stored chapter list", async () => {
        await seedVictimTitle()
        const result = (await handlers["work:chapter-list"]!(
            { type: "work:chapter-list", url: VICTIM_CHAPTER },
            attackerCtx
        )) as unknown[]
        expect(result).toEqual([])
        expect(scheduleMock).not.toHaveBeenCalled()
    })

    it("work:best-for-url and panel:resolve-mode do not answer attacker.example about another site", async () => {
        await seedVictimTitle()
        expect(
            await handlers["work:best-for-url"]!({ type: "work:best-for-url", url: VICTIM_CHAPTER }, attackerCtx)
        ).toEqual({ hasBetter: false })
        expect(
            await handlers["panel:resolve-mode"]!({ type: "panel:resolve-mode", url: VICTIM_CHAPTER }, attackerCtx)
        ).toBeNull()
    })
})

describe("the per-site auto-add cap and a page that walks through its own subdomains", () => {
    const track = (url: string) =>
        handlers["work:track-detected"]!({ type: "work:track-detected", url }, {
            sender: { url, tab: { url } }
        } as unknown as HandlerContext) as Promise<{ created?: boolean }>

    it("caps auto-added titles for one attacker domain, not per throwaway subdomain", async () => {
        // A hostile reader page (with "Detect on all sites" granted) redirects itself through wildcard
        // subdomains of one domain it owns, walking its own address on each. Every host is a fresh
        // "detected:<host>" source with its own allowance, so the cap meant to stop "one page walking through
        // made-up series addresses" from filling the library is multiplied by the number of subdomains.
        const hosts = ["s1", "s2", "s3", "s4", "s5"].map(s => `${s}.attacker.example`)
        for (const host of hosts) {
            for (let i = 0; i < MAX_AUTO_ADDED_PER_SITE_PER_HOUR; i++) {
                await track(`https://${host}/manga/spam-${i}/chapter-1`)
            }
        }
        const added = await db.manga.filter(row => row.sourceId.endsWith("attacker.example")).count()
        expect(added).toBeLessThanOrEqual(MAX_AUTO_ADDED_PER_SITE_PER_HOUR)
    })
})

describe("the sender's own frame url against the tab's url", () => {
    // The browser stamps sender.url per message with the sending document's url; sender.tab.url is whatever
    // the tab shows now. They disagree when the tab has already committed a navigation to another site while
    // the old document (and its content script) is still alive, e.g. a cross-site navigation whose old
    // renderer runs its unload handlers after the new page commits. urlFromOtherSite, work:track-detected and
    // contentScriptPage all prefer tab.url, so the old attacker document speaks for the new site.
    const VICTIM_PAGE = `${VICTIM_SITE}/manga/private-title/chapter-12`
    const leaving = { sender: { url: ATTACKER_PAGE, tab: { id: 7, url: VICTIM_PAGE } } } as unknown as HandlerContext

    it("a document on attacker.example cannot write chapters onto a victim-site title once the tab moved there", async () => {
        await seedVictimTitle()
        const items = [500, 501, 502].map(n => ({
            url: `${VICTIM_SITE}/manga/private-title/chapter-${n}`,
            text: `Chapter ${n}`
        }))
        const result = (await handlers["work:record-chapter-list"]!(
            { type: "work:record-chapter-list", url: VICTIM_PAGE, items },
            leaving
        )) as { recorded: number; advanced: boolean }
        expect(result).toEqual({ recorded: 0, advanced: false })
        expect((await db.manga.get(VICTIM_MANGA_ID))!.latestChapterNumber).toBeUndefined()
    })

    it("a document on attacker.example cannot add titles to the victim site's detected source", async () => {
        const url = `${VICTIM_SITE}/manga/injected-title/chapter-1`
        const result = (await handlers["work:track-detected"]!({ type: "work:track-detected", url, markRead: true }, {
            sender: { url: ATTACKER_PAGE, tab: { id: 7, url } }
        } as unknown as HandlerContext)) as { tracked?: boolean }
        expect(result.tracked).not.toBe(true)
    })

    it("a document the browser reports as no longer active speaks for no page, even its own", async () => {
        const url = `${VICTIM_SITE}/manga/injected-title/chapter-1`
        const result = (await handlers["work:track-detected"]!({ type: "work:track-detected", url }, {
            sender: { url, tab: { id: 7, url }, documentLifecycle: "pending_deletion" }
        } as unknown as HandlerContext)) as { tracked?: boolean }
        expect(result.tracked).not.toBe(true)
        expect(await db.manga.count()).toBe(0)
    })

    it("a sender whose stamped origin disagrees with its url speaks for no page", async () => {
        await seedVictimTitle()
        const result = (await handlers["chapter:siblings"]!({ type: "chapter:siblings", url: VICTIM_CHAPTER }, {
            sender: { url: VICTIM_CHAPTER, origin: "https://attacker.example", tab: { id: 7, url: VICTIM_CHAPTER } }
        } as unknown as HandlerContext)) as { mangaTitle: string | null }
        expect(result.mangaTitle).toBeNull()
    })

    it("the active document of the site still gets its own answers", async () => {
        await seedVictimTitle()
        const result = (await handlers["chapter:siblings"]!({ type: "chapter:siblings", url: VICTIM_CHAPTER }, {
            sender: {
                url: VICTIM_CHAPTER,
                origin: VICTIM_SITE,
                documentLifecycle: "active",
                tab: { id: 7, url: VICTIM_CHAPTER }
            }
        } as unknown as HandlerContext)) as { mangaTitle: string | null; nextUrl: string | null }
        expect(result.mangaTitle).toBe("A Title The User Reads Privately")
        expect(result.nextUrl).toBe(`${VICTIM_SITE}/manga/private-title/chapter-13`)
    })
})
