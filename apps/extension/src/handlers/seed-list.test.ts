import "fake-indexeddb/auto"
import { sourceRegistry } from "@amr/sources"
import { parseProfile, type CaptureSignals, type SiteProfile } from "@amr/source-engine"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { db, putArchProfile } from "../database"

// G2 with the real engine: a recognition-only seed gets its chapter list from the user's own chapter page.
// The seed id is deliberately not a host, and its domain list is wider than one address, as real seeds are.
// Only the network and the tab capture are stubbed.

const SEED_ID = "seed-reader"
const HOST = "seed-reader.example"
const CHAPTER_URL = `https://${HOST}/series/demo-title/chapter-2`
const TITLE_PATH = "/series/demo-title"
const MANGA_ID = `${SEED_ID}:manga:demo-title`

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

const captureTabSignalsMock = vi.fn()
vi.mock("../arch-sources", async importOriginal => ({
    ...(await importOriginal<typeof import("../arch-sources")>()),
    captureTabSignals: (...args: unknown[]) => captureTabSignalsMock(...args)
}))
vi.mock("../migration/seed-profiles", async importOriginal => ({
    ...(await importOriginal<typeof import("../migration/seed-profiles")>()),
    isCommittedSeedProfile: (profile: unknown) => {
        const { canonical } = testSeed
        return canonical(profile) === canonical(testSeed.profile())
    }
}))
const testSeed = vi.hoisted(() => ({
    profile: (): unknown => undefined,
    canonical: (value: unknown): string => JSON.stringify(value)
}))
testSeed.profile = seedProfile

vi.mock("../settings", () => ({ getSettings: async () => ({ language: "en" }) }))
vi.mock("../live", () => ({ publishLive: vi.fn() }))
const notifyNewChaptersMock = vi.fn()
vi.mock("../notifications", () => ({ notifyNewChapters: (...args: unknown[]) => notifyNewChaptersMock(...args) }))
const fetchChapterHtmlViaTabMock = vi.fn()
vi.mock("../background/tab-fetch", () => ({
    fetchChapterHtmlViaTab: (...args: unknown[]) => fetchChapterHtmlViaTabMock(...args)
}))
vi.mock("../background/panel-injection", () => ({ injectPanelForTab: vi.fn(async () => true) }))

const storage = new Map<string, unknown>()
const permissions = {
    getAll: vi.fn(async () => ({ origins: [] as string[] })),
    contains: vi.fn(),
    request: vi.fn(),
    remove: vi.fn()
}
const tabs = { get: vi.fn(), query: vi.fn() }
vi.stubGlobal("browser", {
    permissions,
    tabs,
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
const { checkUpdates } = await import("./updates-sources")
const { beginUserSourcesInit } = await import("../background/user-sources-ready")
const { findUpgradeableSeed, isTrackingOnlySource, registerProfile, resyncStoredArchProfiles, updateModeOf } =
    await import("../arch-sources")

const readerSignals: CaptureSignals = {
    url: CHAPTER_URL,
    links: [],
    images: [],
    largeImages: 5,
    readerContainer: true
}

function seriesPage(latest: number, extra = ""): string {
    const rows = Array.from({ length: latest }, (_, index) => {
        const n = latest - index
        return `<li><a href="${TITLE_PATH}/chapter-${n}">Chapter ${n}</a></li>`
    }).join("")
    return `<html><head><title>Demo Title</title></head><body><ul>${rows}</ul>${extra}</body></html>`
}

let titlePage: string | undefined
// Only ever moves forward: the response cache every source has outlives a test.
let now = Date.now()
let fetched: string[] = []
let onFetch: (() => Promise<void>) | undefined

async function installSeed(): Promise<void> {
    const profile = seedProfile()
    await putArchProfile(SEED_ID, profile, "seed")
    expect(registerProfile(profile)).toBe(true)
}

// A title the bundled adapter used to list, with a visit recorded on it.
async function installTitle(): Promise<void> {
    await db.manga.put({
        id: MANGA_ID,
        title: "Demo Title",
        normalizedTitle: "demo title",
        authors: [],
        status: "ongoing",
        addedAt: 1,
        updatedAt: 1,
        sourceId: SEED_ID,
        sourceUrl: CHAPTER_URL,
        mangaUrl: `https://${HOST}${TITLE_PATH}`,
        sourceMangaId: "demo-title",
        latestChapterNumber: 2,
        latestChapterId: `${MANGA_ID}:ext:ch-2`,
        lastReadChapterNumber: 2,
        lastReadChapterId: `${MANGA_ID}:ext:ch-2`
    })
    await db.sourceLinks.put({
        mangaId: MANGA_ID,
        sourceId: SEED_ID,
        url: `https://${HOST}${TITLE_PATH}`,
        sourceMangaId: "demo-title",
        title: "Demo Title",
        addedAt: 1,
        updatedAt: 1
    })
    await db.chapters.put({
        id: `${MANGA_ID}:ext:ch-2`,
        mangaId: MANGA_ID,
        sourceId: SEED_ID,
        title: "Chapter 2",
        url: CHAPTER_URL,
        sortKey: 2
    })
    await db.progress.put({
        mangaId: MANGA_ID,
        chapterId: `${MANGA_ID}:ext:ch-2`,
        pageIndex: 7,
        pageCount: 20,
        completed: true,
        updatedAt: 5
    })
}

async function check() {
    now += 60 * 60 * 1000
    await checkUpdates()
    return storage.get("updateStatus") as {
        checked: number
        updated: number
        emptyLists: Record<string, number>
        trackingOnly: Record<string, number>
    }
}

beforeEach(async () => {
    vi.clearAllMocks()
    storage.clear()
    now += 60 * 60 * 1000
    vi.spyOn(Date, "now").mockImplementation(() => now)
    beginUserSourcesInit(async () => undefined)
    sourceRegistry.unregister(SEED_ID)
    await Promise.all([
        db.archProfiles.clear(),
        db.manga.clear(),
        db.chapters.clear(),
        db.progress.clear(),
        db.historyEvents.clear(),
        db.sourceLinks.clear()
    ])
    permissions.contains.mockResolvedValue(true)
    permissions.request.mockResolvedValue(false)
    tabs.get.mockResolvedValue({ id: 7, url: CHAPTER_URL })
    captureTabSignalsMock.mockResolvedValue(readerSignals)
    fetchChapterHtmlViaTabMock.mockRejectedValue(new Error("no tab"))
    titlePage = seriesPage(5)
    fetched = []
    onFetch = undefined
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            fetched.push(url)
            await onFetch?.()
            const { pathname } = new URL(url)
            const served = titlePage !== undefined && pathname === TITLE_PATH
            const response = served ? new Response(titlePage, { status: 200 }) : new Response("gone", { status: 404 })
            return Object.defineProperty(response, "url", { value: url })
        })
    )
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe("a visit gives a recognition-only seed its chapter list", () => {
    it("adds the list and leaves the seed's own identity exactly as committed", async () => {
        await installSeed()
        expect(isTrackingOnlySource(SEED_ID)).toBe(true)

        await deriveSeedListOnVisit(7, CHAPTER_URL)

        const row = await db.archProfiles.get(SEED_ID)
        expect(row?.origin).toBe("seed")
        expect(row?.profile).toEqual(seedProfile())
        expect((row?.derivedList as { list: { itemPattern: string } }).list.itemPattern).toContain("{slug}")
        expect(isTrackingOnlySource(SEED_ID)).toBe(false)
        expect(updateModeOf(SEED_ID)).toBe("auto")
        expect(sourceRegistry.get(SEED_ID)?.manifest.domains).toEqual([HOST, `*.${HOST}`])
    })

    it("keeps the list after a worker restart, though the seed's id and wildcard domain are not a user-added shape", async () => {
        await installSeed()
        await deriveSeedListOnVisit(7, CHAPTER_URL)

        sourceRegistry.unregister(SEED_ID)
        await resyncStoredArchProfiles()

        expect(sourceRegistry.get(SEED_ID)).toBeDefined()
        expect(isTrackingOnlySource(SEED_ID)).toBe(false)
    })

    it("makes the first check a silent baseline, then finds exactly one new chapter, then none", async () => {
        await installSeed()
        await installTitle()
        await deriveSeedListOnVisit(7, CHAPTER_URL)

        const baseline = await check()
        expect(baseline).toMatchObject({ checked: 1, updated: 0, trackingOnly: {}, emptyLists: {} })
        expect(notifyNewChaptersMock).not.toHaveBeenCalledWith(["Demo Title"])
        expect((await db.manga.get(MANGA_ID))?.latestChapterNumber).toBe(5)

        titlePage = seriesPage(6)
        expect((await check()).updated).toBe(1)
        expect(notifyNewChaptersMock).toHaveBeenCalledWith(["Demo Title"])

        expect((await check()).updated).toBe(0)
    })

    it("keeps the same library row and the progress on it, folded onto the list's own chapter", async () => {
        await installSeed()
        await installTitle()
        await deriveSeedListOnVisit(7, CHAPTER_URL)
        await check()

        expect(await db.manga.count()).toBe(1)
        const title = await db.manga.get(MANGA_ID)
        expect(title?.lastReadChapterNumber).toBe(2)
        const chapters = await db.chapters.where("mangaId").equals(MANGA_ID).toArray()
        expect(chapters.map(c => c.sortKey).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
        expect((await db.chapters.get(title!.lastReadChapterId!))?.sortKey).toBe(2)
        const progress = await db.progress.toArray()
        expect(progress).toHaveLength(1)
        expect(progress[0]).toMatchObject({ mangaId: MANGA_ID, pageIndex: 7, completed: true })
        expect((await db.chapters.get(progress[0]!.chapterId))?.sortKey).toBe(2)
    })

    it("takes no chapters from other series on the page", async () => {
        await installSeed()
        await installTitle()
        titlePage = seriesPage(
            5,
            `<a href="/series/other-title/chapter-900">Other</a><a href="/series/demo-title-extra/chapter-901">Extra</a>`
        )
        await deriveSeedListOnVisit(7, CHAPTER_URL)
        await check()

        const chapters = await db.chapters.where("mangaId").equals(MANGA_ID).toArray()
        expect(Math.max(...chapters.map(c => c.sortKey))).toBe(5)
    })

    it("reports a list that later comes back empty, and does not announce", async () => {
        await installSeed()
        await installTitle()
        await deriveSeedListOnVisit(7, CHAPTER_URL)
        await check()

        titlePage = "<html><head><title>Demo Title</title></head><body>Gone</body></html>"
        expect(await check()).toMatchObject({ updated: 0, emptyLists: { [SEED_ID]: 1 } })
    })

    it("uses a rendered tab when a plain fetch finds no list", async () => {
        await installSeed()
        titlePage = "<html><head><title>Demo Title</title></head><body>Loading</body></html>"
        fetchChapterHtmlViaTabMock.mockResolvedValue(seriesPage(5))

        await deriveSeedListOnVisit(7, CHAPTER_URL)

        const row = await db.archProfiles.get(SEED_ID)
        expect(row?.derivedList).toMatchObject({ listSource: "tab" })
        expect(updateModeOf(SEED_ID)).toBe("auto")
    })
})

describe("running it again changes nothing", () => {
    it("makes no request once the seed has its list", async () => {
        await installSeed()
        await deriveSeedListOnVisit(7, CHAPTER_URL)
        const stored = await db.archProfiles.get(SEED_ID)
        now += 48 * 60 * 60 * 1000
        fetched = []

        await deriveSeedListOnVisit(7, CHAPTER_URL)

        expect(fetched).toEqual([])
        expect(await db.archProfiles.get(SEED_ID)).toEqual(stored)
        expect(await findUpgradeableSeed(new URL(CHAPTER_URL))).toBeUndefined()
    })

    it("leaves a site whose list could not be worked out alone for a day, then tries again", async () => {
        await installSeed()
        titlePage = "<html><head><title>Demo Title</title></head><body>No list</body></html>"
        fetchChapterHtmlViaTabMock.mockResolvedValue(titlePage)

        await deriveSeedListOnVisit(7, CHAPTER_URL)
        expect(fetched.length).toBeGreaterThan(0)
        expect((await db.archProfiles.get(SEED_ID))?.derivedList).toBeUndefined()

        fetched = []
        now += 60 * 60 * 1000
        await deriveSeedListOnVisit(7, CHAPTER_URL)
        expect(fetched).toEqual([])

        now += 24 * 60 * 60 * 1000
        titlePage = seriesPage(5)
        await deriveSeedListOnVisit(7, CHAPTER_URL)
        expect(fetched.length).toBeGreaterThan(0)
        expect((await db.archProfiles.get(SEED_ID))?.derivedList).toBeDefined()
    })
})

describe("the user's own profile always wins", () => {
    it("never touches a row the user added under the seed's id", async () => {
        const mine = { ...seedProfile(), name: "Mine" }
        await putArchProfile(SEED_ID, mine, "user")
        expect(registerProfile(mine)).toBe(true)

        await deriveSeedListOnVisit(7, CHAPTER_URL)

        expect(fetched).toEqual([])
        expect(await db.archProfiles.get(SEED_ID)).toMatchObject({ origin: "user", profile: mine })
        expect((await db.archProfiles.get(SEED_ID))?.derivedList).toBeUndefined()
    })

    it("does not overwrite a profile imported while the live check was running", async () => {
        await installSeed()
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
})

describe("nothing is derived without good evidence", () => {
    it("does nothing without host access, and asks for none", async () => {
        await installSeed()
        permissions.contains.mockResolvedValue(false)

        await deriveSeedListOnVisit(7, CHAPTER_URL)

        expect(fetched).toEqual([])
        expect(permissions.request).not.toHaveBeenCalled()
        expect(captureTabSignalsMock).not.toHaveBeenCalled()
    })

    it("does nothing on a page that does not look like a reader", async () => {
        await installSeed()
        captureTabSignalsMock.mockResolvedValue({ ...readerSignals, largeImages: 0, readerContainer: false })

        await deriveSeedListOnVisit(7, CHAPTER_URL)

        expect(fetched).toEqual([])
    })

    it("does nothing when the tab has moved on from the page being asked about", async () => {
        await installSeed()
        captureTabSignalsMock.mockResolvedValue({ ...readerSignals, url: `https://${HOST}${TITLE_PATH}/chapter-3` })

        await deriveSeedListOnVisit(7, CHAPTER_URL)

        expect(fetched).toEqual([])
    })

    it("stores nothing when the seed cannot name the title from this page", async () => {
        const profile = seedProfile()
        const parsed = parseProfile({ ...profile, match: { manga: profile.match.manga, chapter: "^/read/[^/]+/?$" } })
        if (!parsed.ok) throw new Error(parsed.error)
        testSeed.profile = () => parsed.profile
        try {
            await putArchProfile(SEED_ID, parsed.profile, "seed")
            registerProfile(parsed.profile)
            const url = `https://${HOST}/read/chapter-2`
            captureTabSignalsMock.mockResolvedValue({ ...readerSignals, url })

            await deriveSeedListOnVisit(7, url)

            expect(fetched).toEqual([])
            expect((await db.archProfiles.get(SEED_ID))?.derivedList).toBeUndefined()
        } finally {
            testSeed.profile = seedProfile
        }
    })

    it("stores nothing when the address's series is not the one the seed reads from it", async () => {
        const profile = seedProfile()
        const parsed = parseProfile({
            ...profile,
            match: {
                manga: "^/series/([^/]+)/?$",
                chapter: "^/series/(?:extra-)?([^/]+)/chapter-(\\d+)/?$"
            }
        })
        if (!parsed.ok) throw new Error(parsed.error)
        testSeed.profile = () => parsed.profile
        try {
            await putArchProfile(SEED_ID, parsed.profile, "seed")
            registerProfile(parsed.profile)
            const url = `https://${HOST}/series/extra-demo-title/chapter-2`
            captureTabSignalsMock.mockResolvedValue({ ...readerSignals, url })

            await deriveSeedListOnVisit(7, url)

            expect(fetched).toEqual([])
            expect((await db.archProfiles.get(SEED_ID))?.derivedList).toBeUndefined()
        } finally {
            testSeed.profile = seedProfile
        }
    })

    it("stores nothing when the list holds only one chapter", async () => {
        await installSeed()
        titlePage = `<html><head><title>Demo Title</title></head><body><a href="${TITLE_PATH}/chapter-2">Chapter 2</a></body></html>`

        await deriveSeedListOnVisit(7, CHAPTER_URL)

        expect((await db.archProfiles.get(SEED_ID))?.derivedList).toBeUndefined()
        expect(isTrackingOnlySource(SEED_ID)).toBe(true)
    })

    it("stores nothing when the list does not include the chapter the user is on", async () => {
        await installSeed()
        titlePage = `<html><head><title>Demo Title</title></head><body><a href="${TITLE_PATH}/chapter-8">8</a><a href="${TITLE_PATH}/chapter-9">9</a></body></html>`

        await deriveSeedListOnVisit(7, CHAPTER_URL)

        expect((await db.archProfiles.get(SEED_ID))?.derivedList).toBeUndefined()
    })

    it("stores nothing when the list numbers the chapter differently from the seed", async () => {
        await installSeed()
        const url = `https://${HOST}/series/demo-title/chapter-2-5`
        const profile = seedProfile()
        const parsed = parseProfile({
            ...profile,
            match: { manga: profile.match.manga, chapter: "^/series/([^/]+)/chapter-(\\d+)-\\d+/?$" }
        })
        if (!parsed.ok) throw new Error(parsed.error)
        testSeed.profile = () => parsed.profile
        try {
            await putArchProfile(SEED_ID, parsed.profile, "seed")
            registerProfile(parsed.profile)
            captureTabSignalsMock.mockResolvedValue({ ...readerSignals, url })
            titlePage = `<html><head><title>Demo Title</title></head><body><a href="${TITLE_PATH}/chapter-2-5">x</a><a href="${TITLE_PATH}/chapter-3-1">y</a></body></html>`

            await deriveSeedListOnVisit(7, url)

            expect((await db.archProfiles.get(SEED_ID))?.derivedList).toBeUndefined()
        } finally {
            testSeed.profile = seedProfile
        }
    })
})

describe("a stored list is re-checked on every registration, because a restore can write anything", () => {
    async function storeRow(derivedList: unknown): Promise<void> {
        await db.archProfiles.put({
            id: SEED_ID,
            profile: seedProfile(),
            importedAt: 1,
            origin: "seed",
            derivedList
        })
        await resyncStoredArchProfiles()
    }
    const goodList = { itemPattern: `href="(?<chapterUrl>/series/{slug}/chapter-(?<chapterNumber>[0-9]+))"` }

    it("registers a valid one", async () => {
        await storeRow({ list: goodList })
        expect(isTrackingOnlySource(SEED_ID)).toBe(false)
    })

    it.each([
        ["no {slug} token, so it would read other series", { list: { itemPattern: `href="(?<chapterUrl>/x)"` } }],
        ["a list address of its own", { list: { ...goodList, urlTemplate: "https://elsewhere.example/{slug}" } }],
        ["a field the list format does not have", { list: { ...goodList, recipe: "token" } }],
        ["a catastrophic regex", { list: { itemPattern: "{slug}(a+)+$" } }],
        ["a list source it could not have chosen", { list: goodList, listSource: "on-visit" }],
        ["not a list at all", "nonsense"]
    ])("stays recognition-only, and still resolves, on %s", async (_name, derived) => {
        await storeRow(derived)
        expect(sourceRegistry.get(SEED_ID)).toBeDefined()
        expect(isTrackingOnlySource(SEED_ID)).toBe(true)
    })

    it("ignores anything but the list fields, so a restore cannot rewrite the site's identity", async () => {
        await storeRow({ list: goodList, origin: "https://elsewhere.example", domains: ["elsewhere.example"] })
        expect(sourceRegistry.get(SEED_ID)?.manifest.domains).toEqual([HOST, `*.${HOST}`])
        expect(isTrackingOnlySource(SEED_ID)).toBe(false)
    })

    it("stays recognition-only without host access, and still resolves", async () => {
        permissions.contains.mockResolvedValue(false)
        await storeRow({ list: goodList })
        expect(sourceRegistry.get(SEED_ID)).toBeDefined()
        expect(isTrackingOnlySource(SEED_ID)).toBe(true)
    })

    it("a seed row that was tampered with is not registered, list or no list", async () => {
        await db.archProfiles.put({
            id: SEED_ID,
            profile: { ...seedProfile(), domains: ["elsewhere.example"] },
            importedAt: 1,
            origin: "seed",
            derivedList: { list: goodList }
        })
        await resyncStoredArchProfiles()
        expect(sourceRegistry.get(SEED_ID)).toBeUndefined()
    })
})

describe("the toolbar popup's upgrade uses the same path", () => {
    it("offers the upgrade and carries it out on a seed whose id is not a host", async () => {
        await installSeed()
        await installTitle()

        expect(await detectSource({ url: CHAPTER_URL, tabId: 7 })).toMatchObject({
            status: "found",
            upgrade: true,
            name: "Seed Reader"
        })
        const result = await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })

        expect(result).toMatchObject({ ok: true, id: SEED_ID, upgraded: true, updateMode: "auto" })
        expect((await db.archProfiles.get(SEED_ID))?.origin).toBe("seed")
        expect(isTrackingOnlySource(SEED_ID)).toBe(false)
    })

    it("says so, and writes nothing, when no list can be worked out", async () => {
        await installSeed()
        titlePage = "<html><head><title>Demo Title</title></head><body>No list</body></html>"
        fetchChapterHtmlViaTabMock.mockResolvedValue(titlePage)

        const result = await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })

        expect(result).toMatchObject({ ok: false, reason: "unverified" })
        expect((await db.archProfiles.get(SEED_ID))?.derivedList).toBeUndefined()
        expect(isTrackingOnlySource(SEED_ID)).toBe(true)
    })
})
