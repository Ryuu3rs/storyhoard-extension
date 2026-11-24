import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { HandlerContext } from "./handler-types"
import type { RuntimeRequest } from "../runtime"
import { assertSenderMayRequest, fromExtensionOrigin } from "./sender-gate"

vi.mock("../live", () => ({ publishLive: vi.fn() }))
vi.mock("../source-resolver", () => ({
    resolveSource: vi.fn(async () => {
        throw new Error("offline")
    })
}))
const tabsCreate = vi.hoisted(() => vi.fn(async (_: { url: string }) => ({ id: 1 })))
vi.stubGlobal("browser", {
    runtime: { getURL: (p: string) => `chrome-extension://ext${p.startsWith("/") ? p : `/${p}`}` },
    tabs: { create: tabsCreate },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    action: { setBadgeText: vi.fn(async () => undefined), setBadgeBackgroundColor: vi.fn(async () => undefined) }
})
vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("no network in this test")))
)

const BASE = "chrome-extension://ext/"
const appPage = { url: `${BASE}app.html`, tab: { id: 1 } }
const popup = { url: `${BASE}popup.html` }
const readerTab = { url: "https://reader.example/series/x/chapter-2", tab: { id: 9, url: "https://reader.example/" } }
const weebTab = { url: "https://weeb.ltd/welcome", tab: { id: 4 } }

const req = (r: unknown) => r as RuntimeRequest
const check = (request: unknown, sender: unknown) => () =>
    assertSenderMayRequest(req(request), sender as Parameters<typeof assertSenderMayRequest>[1], BASE)

describe("fromExtensionOrigin", () => {
    it("is true only for a url under the extension's own base", () => {
        expect(fromExtensionOrigin(appPage, BASE)).toBe(true)
        expect(fromExtensionOrigin(popup, BASE)).toBe(true)
        expect(fromExtensionOrigin(readerTab, BASE)).toBe(false)
        expect(fromExtensionOrigin({ url: "chrome-extension://other/app.html" }, BASE)).toBe(false)
        expect(fromExtensionOrigin({}, BASE)).toBe(false)
        expect(fromExtensionOrigin(undefined, BASE)).toBe(false)
    })
})

describe("assertSenderMayRequest", () => {
    it("lets the extension's own pages send anything", () => {
        expect(check({ type: "library:clear" }, appPage)).not.toThrow()
        expect(check({ type: "data:export" }, popup)).not.toThrow()
        expect(check({ type: "settings:update", settings: { usageAnalytics: false } }, appPage)).not.toThrow()
    })

    it("lets a content script send the panel's and the bridge's own messages", () => {
        expect(check({ type: "analytics:record", event: "panel_action" }, readerTab)).not.toThrow()
        for (const type of [
            "chapter:siblings",
            "chapter:track",
            "library:get",
            "library:reading-prefs",
            "panel:resolve-mode",
            "work:best-for-url",
            "work:chapter-list",
            "work:record-chapter-list",
            "work:track-detected"
        ]) {
            expect(check({ type }, readerTab), type).not.toThrow()
        }
        for (const type of ["account:status", "site:open", "handoff:hello", "handoff:code"]) {
            expect(check({ type }, weebTab), type).not.toThrow()
        }
    })

    it("lets only the weeb.ltd bridge send the bridge's messages", () => {
        for (const type of ["account:status", "site:open", "handoff:hello", "handoff:code"]) {
            expect(check({ type }, readerTab), type).toThrow(/not allowed/)
            expect(check({ type }, { url: "https://weeb.ltd.evil.example/", tab: { id: 3 } }), type).toThrow(
                /not allowed/
            )
            expect(check({ type }, { url: "http://weeb.ltd/", tab: { id: 3 } }), type).toThrow(/not allowed/)
        }
    })

    it("lets a content script record only the panel's own button presses", () => {
        for (const event of ["account_linked", "install", "first_title_added", "capture_ok"]) {
            expect(check({ type: "analytics:record", event }, readerTab), event).toThrow(/not allowed/)
            expect(check({ type: "analytics:record", event }, appPage), event).not.toThrow()
        }
    })

    it("refuses every other message from a content script", () => {
        for (const type of [
            "data:export",
            "library:clear",
            "library:remove",
            "sync:config",
            "account:link",
            "account:unlink",
            "handoff:confirm",
            "import:reader",
            "source:add-from-tab",
            "source:turn-on"
        ]) {
            expect(check({ type }, readerTab), type).toThrow(/not allowed/)
            expect(check({ type }, weebTab), type).toThrow(/not allowed/)
        }
    })

    it("treats a sender with no extension url as a content script", () => {
        expect(check({ type: "library:clear" }, {})).toThrow(/not allowed/)
        expect(check({ type: "library:clear" }, undefined)).toThrow(/not allowed/)
    })

    it("lets the panel save only its reading-view defaults through settings:update", () => {
        expect(
            check(
                {
                    type: "settings:update",
                    settings: {
                        readerContinuousScroll: true,
                        readerFitWidth: false,
                        readerNoGap: true,
                        readerTheme: "dark"
                    }
                },
                readerTab
            )
        ).not.toThrow()
        expect(check({ type: "settings:update", settings: { usageAnalytics: false } }, readerTab)).toThrow(
            /not allowed/
        )
        expect(check({ type: "settings:update", settings: { readerNoGap: true, autoAdd: true } }, readerTab)).toThrow(
            /not allowed/
        )
    })
})

// The background's onMessage path end to end (schema parse, then the gate, then the handler) for a content
// script on an unrelated site: what a compromised page renderer, or a bug in how the panel builds a message,
// could send.
describe("a content script on an arbitrary site, through the whole dispatch", () => {
    const evilSender = {
        url: "https://evil-reader.example/manga/x/chapter-1",
        tab: { id: 7, url: "https://evil-reader.example/manga/x/chapter-1" }
    }

    async function deliver(message: unknown, sender: unknown) {
        const { runtimeRequestSchema } = await import("../runtime")
        const { handlers } = await import("./dispatch")
        const request = runtimeRequestSchema.parse(message)
        assertSenderMayRequest(request, sender as Parameters<typeof assertSenderMayRequest>[1], BASE)
        const handler = handlers[request.type] as (r: unknown, c: HandlerContext) => Promise<unknown>
        return handler(request, { sender } as unknown as HandlerContext)
    }
    const outcomeOf = (pending: Promise<unknown>) =>
        pending.then(
            () => "accepted",
            () => "refused"
        )

    beforeEach(async () => {
        vi.clearAllMocks()
        const { db } = await import("../database")
        await Promise.all([db.manga.clear(), db.analyticsEvents.clear(), db.sourceLinks.clear()])
    })

    it("cannot fire the weeb.ltd-only site:open, which adds a row, runs a search and opens a tab", async () => {
        const { db } = await import("../database")
        const outcome = await outcomeOf(
            deliver(
                { type: "site:open", anilistId: 30013, title: "A title", coverUrl: "https://x.example/c.png" },
                evilSender
            )
        )
        expect({ outcome, rows: await db.manga.count(), tabsOpened: tabsCreate.mock.calls.length }).toEqual({
            outcome: "refused",
            rows: 0,
            tabsOpened: 0
        })
    })

    it("refuses an unbounded site:open title even from weeb.ltd, and cleans the one it keeps", async () => {
        const { db } = await import("../database")
        const weeb = { url: "https://weeb.ltd/title/30013", tab: { id: 4, url: "https://weeb.ltd/title/30013" } }
        expect(
            await outcomeOf(deliver({ type: "site:open", anilistId: 30013, title: "A".repeat(100_000) }, weeb))
        ).toBe("refused")
        expect(await db.manga.count()).toBe(0)

        const spoof = `Real${String.fromCharCode(0x202e)}gnp.exe${String.fromCharCode(10)}Title`
        expect(await outcomeOf(deliver({ type: "site:open", anilistId: 30013, title: spoof }, weeb))).toBe("accepted")
        expect((await db.manga.get("anilist:manga:30013"))?.title).toBe("Real gnp.exe Title")
        expect(tabsCreate).toHaveBeenCalledTimes(1)
    })

    it("cannot store unbounded analytics rows or forge an event only the extension records", async () => {
        const { db } = await import("../database")
        const big = "x".repeat(1_000_000)
        for (let i = 0; i < 5; i++) {
            await deliver({ type: "analytics:record", event: "account_linked", detail: big }, evilSender).catch(
                () => {}
            )
            await deliver({ type: "analytics:record", event: "account_linked" }, evilSender).catch(() => {})
            await deliver({ type: "analytics:record", event: "panel_action", detail: big }, evilSender).catch(() => {})
        }
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(await db.analyticsEvents.count()).toBe(0)

        await deliver({ type: "analytics:record", event: "panel_action", detail: '{"action":"next"}' }, evilSender)
        await new Promise(resolve => setTimeout(resolve, 50))
        expect((await db.analyticsEvents.toArray()).map(row => row.event)).toEqual(["panel_action"])
    })

    it("cannot read another site's library row through library:get, and gets only the reading view of its own", async () => {
        const { db } = await import("../database")
        const row = {
            title: "Private title",
            normalizedTitle: "private title",
            authors: [],
            status: "unknown",
            notes: "the user's private note",
            pageWidthPct: 70,
            addedAt: 1,
            updatedAt: 1
        }
        await db.manga.put({
            ...row,
            id: "mangadex:manga:private",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/title/private"
        } as never)
        await db.manga.put({
            ...row,
            id: "detected:evil-reader.example:manga:x",
            sourceId: "detected:evil-reader.example",
            sourceUrl: "https://evil-reader.example/manga/x/chapter-1"
        } as never)

        expect(await deliver({ type: "library:get", mangaId: "mangadex:manga:private" }, evilSender)).toBeNull()
        expect(
            await deliver({ type: "library:get", mangaId: "detected:evil-reader.example:manga:x" }, evilSender)
        ).toEqual({ id: "detected:evil-reader.example:manga:x", pageWidthPct: 70 })
        const appPage = { url: `${BASE}app.html`, tab: { id: 1, url: `${BASE}app.html` } }
        expect(
            ((await deliver({ type: "library:get", mangaId: "mangadex:manga:private" }, appPage)) as { notes?: string })
                .notes
        ).toBe("the user's private note")
    })

    it("cannot change the reading view of another site's title", async () => {
        const { db } = await import("../database")
        await db.manga.put({
            id: "mangadex:manga:private",
            title: "Private title",
            normalizedTitle: "private title",
            sourceId: "mangadex",
            sourceUrl: "https://mangadex.org/title/private",
            authors: [],
            status: "unknown",
            addedAt: 1,
            updatedAt: 1
        } as never)
        await deliver(
            { type: "library:reading-prefs", mangaId: "mangadex:manga:private", pageWidthPct: 30 },
            evilSender
        )
        expect((await db.manga.get("mangadex:manga:private"))?.pageWidthPct).toBeUndefined()
    })
})
