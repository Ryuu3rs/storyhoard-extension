import "fake-indexeddb/auto"
import { sourceRegistry } from "@amr/sources"
import type { CaptureSignals } from "@amr/source-engine"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { HandlerContext } from "../background/handler-types"
import { db, putArchProfile } from "../database"

// A user upgrading from a release that bundled their sites has a stored row for each of them, but the store
// build grants no site access, so the row does not register. Nothing recognised a chapter page of such a site:
// no panel, and the toolbar popup offered to add the page as a brand-new site, a second copy beside the titles
// already filed under the stored one. The popup now offers to turn the stored site back on instead.

vi.mock("../migration/seed-profiles", async importOriginal => ({
    ...(await importOriginal<typeof import("../migration/seed-profiles")>()),
    loadSeedProfiles: () => new Map(),
    isCommittedSeedProfile: () => false,
    seedIsBundled: () => false
}))
vi.mock("../background/chapter-cache", () => ({ scheduleChapterListRefresh: vi.fn() }))
vi.mock("../settings", () => ({ getSettings: async () => ({ language: "en" }) }))

const captureTabSignalsMock = vi.fn()
vi.mock("../arch-sources", async importOriginal => ({
    ...(await importOriginal<typeof import("../arch-sources")>()),
    captureTabSignals: (...args: unknown[]) => captureTabSignalsMock(...args)
}))

const injectPanelForTabMock = vi.fn()
vi.mock("../background/panel-injection", () => ({
    injectPanelForTab: (...args: unknown[]) => injectPanelForTabMock(...args)
}))

let granted: Set<string>
const permissions = {
    contains: vi.fn(async (request: { origins?: string[] }) =>
        (request.origins ?? []).every(origin => granted.has(origin))
    ),
    getAll: vi.fn(async () => ({ origins: [...granted] })),
    request: vi.fn(async () => true),
    remove: vi.fn(async () => true)
}
const tabs = { get: vi.fn(), query: vi.fn() }

const { addSourceFromTab, addSourceHandlers, detectSource, turnOnSiteFromTab } = await import("./add-source")
const { beginUserSourcesInit } = await import("../background/user-sources-ready")
const { isProfileSource } = await import("../arch-sources")
const { findSource } = await import("../sources")

const SITE_ID = "reader-demo"
const HOST = "reader-demo.net"
const CHAPTER_URL = `https://${HOST}/comics/demo-title-1a2b3c4d/chapter/1`
const SITE_PATTERN = `https://${HOST}/*`

const storedSite = {
    profileFormat: 2,
    id: SITE_ID,
    name: "Reader Demo",
    engine: "generic",
    numberingKind: "chapter",
    origin: `https://${HOST}`,
    domains: [HOST],
    languages: ["en"],
    capabilities: ["manga"],
    requestRateLimit: { requests: 3, intervalMs: 1000 },
    origins: [SITE_PATTERN],
    match: {
        manga: "^/comics/([a-zA-Z0-9][a-zA-Z0-9-]*)/?$",
        chapter: "^/comics/([a-zA-Z0-9][a-zA-Z0-9-]*)/chapter/(\\d+(?:[.-]\\d+)?)/?$"
    },
    series: {
        urlTemplate: "/comics/{slug}/",
        titlePattern: '<meta[^>]+property="og:title"[^>]+content="(?<title>[^"]+)"'
    }
}

const signals: CaptureSignals = {
    url: CHAPTER_URL,
    ogTitle: "Demo Title Chapter 1",
    links: [{ href: "/comics/demo-title-1a2b3c4d/chapter/2", text: "Next" }],
    images: []
}

const ctx: HandlerContext = { sender: {} as HandlerContext["sender"] }

beforeEach(async () => {
    vi.clearAllMocks()
    granted = new Set()
    vi.stubGlobal("browser", {
        permissions,
        tabs,
        runtime: {
            getManifest: () => ({ host_permissions: [] }),
            getURL: (p: string) => `chrome-extension://ext/${p}`
        },
        storage: {
            local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined), remove: vi.fn(async () => {}) }
        },
        action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) }
    })
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    beginUserSourcesInit(async () => undefined)
    injectPanelForTabMock.mockResolvedValue(true)
    captureTabSignalsMock.mockResolvedValue(signals)
    tabs.get.mockResolvedValue({ id: 7, url: CHAPTER_URL })
    tabs.query.mockResolvedValue([{ id: 7, url: CHAPTER_URL }])
    sourceRegistry.unregister(SITE_ID)
    sourceRegistry.unregister(HOST)
    await db.archProfiles.clear()
    await putArchProfile(SITE_ID, storedSite, "seed")
})

afterEach(() => {
    sourceRegistry.unregister(SITE_ID)
    sourceRegistry.unregister(HOST)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe("a chapter page of a site that is in the library but turned off", () => {
    it("is not recognised by any registered source while its access is missing", () => {
        expect(findSource(new URL(CHAPTER_URL))).toBeUndefined()
    })

    it("offers to turn the stored site back on, not to add the page as a new site", async () => {
        const result = await detectSource({ url: CHAPTER_URL, tabId: 7 })
        expect(result).toMatchObject({ status: "off", permissionOrigins: [SITE_PATTERN] })
        expect(result.status === "off" && result.name).toBeTruthy()
    })

    it("refuses to add a second copy of the site, before asking for any access", async () => {
        const result = await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })
        expect(result).toMatchObject({ ok: false, reason: "unsupported" })
        expect(permissions.request).not.toHaveBeenCalled()
        expect((await db.archProfiles.toArray()).map(row => row.id)).toEqual([SITE_ID])
    })

    it("turns nothing on without the user's grant", async () => {
        const result = await turnOnSiteFromTab({ url: CHAPTER_URL, tabId: 7 })
        expect(result).toMatchObject({ ok: false, reason: "permission" })
        expect(isProfileSource(SITE_ID)).toBe(false)
        expect(injectPanelForTabMock).not.toHaveBeenCalled()
    })

    it("once granted, registers the stored site under its own id and puts the panel on the page", async () => {
        granted.add(SITE_PATTERN)
        const result = await turnOnSiteFromTab({ url: CHAPTER_URL, tabId: 7 })
        expect(result).toMatchObject({ ok: true, id: SITE_ID, updateMode: "on-visit" })
        expect(findSource(new URL(CHAPTER_URL))?.manifest.id).toBe(SITE_ID)
        expect(injectPanelForTabMock).toHaveBeenCalledWith(7, CHAPTER_URL)
        expect((await db.archProfiles.toArray()).map(row => row.id)).toEqual([SITE_ID])
        expect(await detectSource({ url: CHAPTER_URL, tabId: 7 })).toMatchObject({ status: "known" })
    })

    it("reports a site that is not turned off without granting or registering anything", async () => {
        await db.archProfiles.clear()
        expect(await turnOnSiteFromTab({ url: CHAPTER_URL, tabId: 7 })).toMatchObject({ ok: false, reason: "not-off" })
        expect(await detectSource({ url: CHAPTER_URL, tabId: 7 })).toMatchObject({ status: "found" })
    })

    it("cannot be turned on from a web page", async () => {
        granted.add(SITE_PATTERN)
        const fromTab: HandlerContext = {
            sender: { tab: { id: 7 }, url: CHAPTER_URL } as unknown as HandlerContext["sender"]
        }
        await expect(
            addSourceHandlers["source:turn-on"]!({ type: "source:turn-on", url: CHAPTER_URL, tabId: 7 }, fromTab)
        ).rejects.toThrow(/not allowed/i)
        expect(isProfileSource(SITE_ID)).toBe(false)
        await expect(
            addSourceHandlers["source:turn-on"]!({ type: "source:turn-on", url: CHAPTER_URL, tabId: 7 }, ctx)
        ).resolves.toMatchObject({ ok: true })
    })
})
