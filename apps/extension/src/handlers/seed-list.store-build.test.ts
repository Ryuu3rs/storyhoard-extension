import "fake-indexeddb/auto"
import { sourceRegistry } from "@amr/sources"
import { parseProfile, type CaptureSignals, type SiteProfile } from "@amr/source-engine"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { db, putArchProfile } from "../database"

// The store build bundles no seed profiles, so the seed rows an older build wrote are the only record of
// those sites. A recognition-only one the user turned back on must still be able to get its chapter list from
// the user's own chapter page, through the popup's Upgrade or a visit, as it can in the local testing build.

const SEED_ID = "seed-reader"
const HOST = "reader-demo.net"
const CHAPTER_URL = `https://${HOST}/series/demo-title/chapter-2`
const TITLE_PATH = "/series/demo-title"

vi.mock("../migration/seed-profiles", async importOriginal => ({
    ...(await importOriginal<typeof import("../migration/seed-profiles")>()),
    loadSeedProfiles: () => new Map(),
    isCommittedSeedProfile: () => false,
    seedIsBundled: () => false
}))

const captureTabSignalsMock = vi.fn()
vi.mock("../arch-sources", async importOriginal => ({
    ...(await importOriginal<typeof import("../arch-sources")>()),
    captureTabSignals: (...args: unknown[]) => captureTabSignalsMock(...args)
}))
vi.mock("../settings", () => ({ getSettings: async () => ({ language: "en" }) }))
vi.mock("../background/tab-fetch", () => ({ fetchChapterHtmlViaTab: vi.fn(async () => Promise.reject(new Error())) }))
vi.mock("../background/panel-injection", () => ({ injectPanelForTab: vi.fn(async () => true) }))
vi.mock("../background/chapter-cache", () => ({ scheduleChapterListRefresh: vi.fn() }))

const storage = new Map<string, unknown>()
const permissions = {
    getAll: vi.fn(async () => ({ origins: [] as string[] })),
    contains: vi.fn(),
    request: vi.fn(),
    remove: vi.fn()
}
vi.stubGlobal("browser", {
    permissions,
    runtime: { getManifest: () => ({ host_permissions: [] }) },
    tabs: { get: vi.fn(async () => ({ id: 7, url: CHAPTER_URL })), query: vi.fn() },
    action: {
        setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
        setBadgeText: vi.fn().mockResolvedValue(undefined)
    },
    storage: {
        local: {
            get: vi.fn(async (key: string) => (storage.has(key) ? { [key]: storage.get(key) } : {})),
            set: vi.fn(async (items: Record<string, unknown>) => {
                for (const [key, value] of Object.entries(items)) storage.set(key, value)
            }),
            remove: vi.fn(async (key: string) => void storage.delete(key))
        }
    }
})

const { addSourceFromTab, deriveSeedListOnVisit, detectSource } = await import("./add-source")
const { beginUserSourcesInit } = await import("../background/user-sources-ready")
const { findUpgradeableSeed, isTrackingOnlySource, resyncStoredArchProfiles, updateModeOf } =
    await import("../arch-sources")

// A seed as 0.30.0 to 0.32.2 wrote it: an id that is not a host and a wildcard domain the store build narrows.
function seedProfile(): SiteProfile {
    const parsed = parseProfile({
        profileFormat: 2,
        id: SEED_ID,
        name: "Seed Reader",
        engine: "generic",
        numberingKind: "chapter",
        origin: `https://${HOST}`,
        domains: [HOST, `*.${HOST}`],
        languages: ["en"],
        capabilities: ["manga"],
        requestRateLimit: { requests: 3, intervalMs: 1000 },
        origins: [`https://${HOST}/*`, `*://*.${HOST}/*`],
        match: { manga: "^/series/([^/]+)/?$", chapter: "^/series/([^/]+)/chapter-(\\d+(?:\\.\\d+)?)/?$" },
        series: { urlTemplate: "/series/{slug}", titlePattern: "<title>(?<title>[^<]+)</title>" }
    })
    if (!parsed.ok) throw new Error(`fixture profile must parse: ${parsed.error}`)
    return parsed.profile
}

const readerSignals: CaptureSignals = { url: CHAPTER_URL, links: [], images: [], largeImages: 5, readerContainer: true }

function seriesPage(latest: number): string {
    const rows = Array.from({ length: latest }, (_, index) => {
        const n = latest - index
        return `<li><a href="${TITLE_PATH}/chapter-${n}">Chapter ${n}</a></li>`
    }).join("")
    return `<html><head><title>Demo Title</title></head><body><ul>${rows}</ul></body></html>`
}

let titlePage: string
let onFetch: (() => Promise<void>) | undefined

// The seed row an older build wrote, turned back on in this one.
async function turnedOnSeed(): Promise<void> {
    await putArchProfile(SEED_ID, seedProfile(), "seed")
    await resyncStoredArchProfiles()
}

beforeEach(async () => {
    vi.clearAllMocks()
    storage.clear()
    beginUserSourcesInit(async () => undefined)
    sourceRegistry.unregister(SEED_ID)
    await db.archProfiles.clear()
    await resyncStoredArchProfiles()
    permissions.contains.mockResolvedValue(true)
    permissions.request.mockResolvedValue(false)
    captureTabSignalsMock.mockResolvedValue(readerSignals)
    titlePage = seriesPage(5)
    onFetch = undefined
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            await onFetch?.()
            const served = new URL(url).pathname === TITLE_PATH
            const response = served ? new Response(titlePage, { status: 200 }) : new Response("gone", { status: 404 })
            return Object.defineProperty(response, "url", { value: url })
        })
    )
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe("a recognition-only seed row from an older build, in the store build", () => {
    it("is offered as upgradeable, in the narrowed shape it registers with", async () => {
        await turnedOnSeed()
        expect(isTrackingOnlySource(SEED_ID)).toBe(true)

        const seed = await findUpgradeableSeed(new URL(CHAPTER_URL))

        expect(seed?.id).toBe(SEED_ID)
        expect(seed?.domains).toEqual([HOST, `www.${HOST}`])
        expect(await detectSource({ url: CHAPTER_URL, tabId: 7 })).toMatchObject({
            status: "found",
            upgrade: true,
            name: "Seed Reader"
        })
    })

    it("the popup's Upgrade gives it a list and keeps the stored row as written", async () => {
        await turnedOnSeed()

        const result = await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })

        expect(result).toMatchObject({ ok: true, id: SEED_ID, upgraded: true, updateMode: "auto" })
        const row = await db.archProfiles.get(SEED_ID)
        expect(row?.origin).toBe("seed")
        expect(row?.profile).toEqual(seedProfile())
        expect((row?.derivedList as { list: { itemPattern: string } }).list.itemPattern).toContain("{slug}")
        expect(updateModeOf(SEED_ID)).toBe("auto")
        expect(sourceRegistry.get(SEED_ID)?.manifest.domains).toEqual([HOST, `www.${HOST}`])
        expect(await findUpgradeableSeed(new URL(CHAPTER_URL))).toBeUndefined()
    })

    it("a visit does the same, and the list survives a worker restart", async () => {
        await turnedOnSeed()

        await deriveSeedListOnVisit(7, CHAPTER_URL)
        expect(updateModeOf(SEED_ID)).toBe("auto")

        sourceRegistry.unregister(SEED_ID)
        await resyncStoredArchProfiles()
        expect(sourceRegistry.get(SEED_ID)).toBeDefined()
        expect(isTrackingOnlySource(SEED_ID)).toBe(false)
    })

    it("is not offered while the site is still off, and asks for nothing on a visit", async () => {
        permissions.contains.mockResolvedValue(false)
        await turnedOnSeed()

        expect(sourceRegistry.get(SEED_ID)).toBeUndefined()
        expect(await findUpgradeableSeed(new URL(CHAPTER_URL))).toBeUndefined()
        await deriveSeedListOnVisit(7, CHAPTER_URL)
        expect(permissions.request).not.toHaveBeenCalled()
        expect((await db.archProfiles.get(SEED_ID))?.derivedList).toBeUndefined()
    })

    it("never writes onto a profile imported while the live check was running", async () => {
        await turnedOnSeed()
        const imported = { ...seedProfile(), name: "Imported" }
        onFetch = async () => {
            onFetch = undefined
            await putArchProfile(SEED_ID, imported, "user")
        }

        await deriveSeedListOnVisit(7, CHAPTER_URL)

        const row = await db.archProfiles.get(SEED_ID)
        expect(row).toMatchObject({ origin: "user", profile: imported })
        expect(row?.derivedList).toBeUndefined()
    })

    it("never offers a list-less site the user added on that host", async () => {
        const mine = { ...seedProfile(), id: HOST, domains: [HOST], origins: [`https://${HOST}/*`] }
        await putArchProfile(HOST, mine, "user")
        await resyncStoredArchProfiles()

        expect(await findUpgradeableSeed(new URL(CHAPTER_URL))).toBeUndefined()
        sourceRegistry.unregister(HOST)
    })
})
