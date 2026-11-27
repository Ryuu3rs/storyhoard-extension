import "fake-indexeddb/auto"
import { parseProfile } from "@amr/source-engine"
import { sourceRegistry } from "@amr/sources"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { db, putVersions, type LibraryManga } from "./database"
import { _resetProtectedStoreForTests } from "./protected-store"

vi.mock("./background/chapter-cache", () => ({ scheduleChapterListRefresh: vi.fn() }))
vi.mock("./settings", () => ({ getSettings: async () => ({ language: "en" }) }))

const { registerProfile } = await import("./arch-sources")
const { clearSourceResponseCaches } = await import("./sources")
const { workKeyOf } = await import("./work-identity")
const { cancelFind, findTitlesOnSource, pageNamesTitle, slugFromName, slugGuesses } = await import("./find-on-source")
const { recordMirrorVersions } = await import("./work-versions")

const HOST = "new-reader.example"
const ORIGIN = `https://${HOST}`
const SITE_ID = HOST

const permissions = { contains: vi.fn(), remove: vi.fn(), getAll: vi.fn() }
const storage = { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } }

function profile(overrides: Record<string, unknown> = {}) {
    const parsed = parseProfile({
        profileFormat: 2,
        id: SITE_ID,
        name: "New Reader",
        engine: "generic",
        origin: ORIGIN,
        domains: [HOST],
        languages: ["en"],
        capabilities: ["chapters", "manga"],
        numberingKind: "chapter",
        requestRateLimit: { requests: 50, intervalMs: 1000 },
        origins: [`${ORIGIN}/*`],
        match: { manga: "^/series/([a-z0-9-]+)/?$", chapter: "^/series/([a-z0-9-]+)/chapter-(\\d+)/?$" },
        series: {
            urlTemplate: "/series/{slug}/",
            titlePattern: '<meta property="og:title" content="(?<title>[^"]+)"'
        },
        list: { itemPattern: '<a href="(?<chapterUrl>/series/[a-z0-9-]+/chapter-(?<chapterNumber>\\d+))">' },
        ...overrides
    })
    if (!parsed.ok) throw new Error(parsed.error)
    return parsed.profile
}

const page = (title: string) => `<html><head><meta property="og:title" content="${title}"></head></html>`

function respond(url: string, body: string, status: number): Response {
    const response = new Response(body, { status })
    Object.defineProperty(response, "url", { value: url })
    return response
}

function stubSite(pages: Record<string, string>, fail: Set<string> = new Set()) {
    const fetchMock = vi.fn(async (input: string | URL) => {
        const url = String(input)
        const path = new URL(url).pathname
        if (fail.has(path)) return respond(url, "blocked", 403)
        const body = pages[path]
        return body === undefined ? respond(url, "missing", 404) : respond(url, body, 200)
    })
    vi.stubGlobal("fetch", fetchMock)
    return fetchMock
}

function manga(id: string, title: string, extra: Partial<LibraryManga> = {}): LibraryManga {
    return {
        id,
        title,
        normalizedTitle: title.toLowerCase(),
        sourceId: "older-site.example",
        sourceUrl: `https://older-site.example/m/${id}`,
        status: "unknown",
        addedAt: 1,
        updatedAt: 1,
        ...extra
    } as LibraryManga
}

const instant = { pause: async () => undefined }

beforeEach(async () => {
    _resetProtectedStoreForTests()
    clearSourceResponseCaches()
    await db.manga.clear()
    await db.versions.clear()
    permissions.contains.mockReset().mockResolvedValue(true)
    permissions.getAll.mockReset().mockResolvedValue({ origins: [`${ORIGIN}/*`] })
    vi.stubGlobal("browser", { permissions, storage })
    registerProfile(profile())
})

afterEach(() => {
    sourceRegistry.unregister(SITE_ID)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe("address guesses", () => {
    it("turns a name into the address shape reader sites use", () => {
        expect(slugFromName("The Lantern Keeper's Daughter: Part II!")).toBe("the-lantern-keepers-daughter-part-ii")
        expect(slugFromName("Café  Déjà Vu")).toBe("cafe-deja-vu")
    })

    it("tries the name, then another site's address, then other names, at most three", () => {
        expect(
            slugGuesses(["Lantern Keeper", "Keeper of Lanterns", "Fourth Name"], ["lantern-keeper-a1b2c3d4", "12345"])
        ).toEqual(["lantern-keeper", "keeper-of-lanterns", "fourth-name"])
        expect(slugGuesses(["Lantern Keeper"], ["the-lantern-keeper"])).toEqual([
            "lantern-keeper",
            "the-lantern-keeper"
        ])
    })

    it("matches a page only on one of the title's names, with the site's name taken off", () => {
        const context = { slug: "lantern-keeper", host: HOST }
        expect(pageNamesTitle("Lantern Keeper - New Reader", context, ["Lantern Keeper"])).toBe(true)
        expect(pageNamesTitle("Read Lantern Keeper Online", context, ["Lantern Keeper"])).toBe(true)
        expect(pageNamesTitle("Lantern Keeper Returns", context, ["Lantern Keeper"])).toBe(false)
        expect(pageNamesTitle("New Reader - Home", context, ["Lantern Keeper"])).toBe(false)
    })
})

describe("findTitlesOnSource", () => {
    it("finds library titles the site has and leaves the ones it does not", async () => {
        await db.manga.bulkPut([
            manga("a", "Lantern Keeper"),
            manga("b", "Quiet Orchard"),
            manga("c", "Glass Harbor", { sourceId: "anilist.co", sourceUrl: "https://anilist.co/manga/1" })
        ])
        stubSite({
            "/series/lantern-keeper/": page("Lantern Keeper - New Reader"),
            "/series/glass-harbor/": page("Glass Harbor")
        })

        const result = await findTitlesOnSource(SITE_ID, instant)

        expect(result.found).toEqual([
            {
                mangaId: "a",
                title: "Lantern Keeper",
                sourceMangaId: "lantern-keeper",
                url: `${ORIGIN}/series/lantern-keeper/`,
                noSiteYet: false
            },
            {
                mangaId: "c",
                title: "Glass Harbor",
                sourceMangaId: "glass-harbor",
                url: `${ORIGIN}/series/glass-harbor/`,
                noSiteYet: true
            }
        ])
        expect(result).toMatchObject({ checked: 3, total: 3 })
        expect(result.next).toBeUndefined()
    })

    it("does not take a page that answers every address for a match", async () => {
        await db.manga.bulkPut([manga("a", "Lantern Keeper")])
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: string | URL) => respond(String(input), page("New Reader - Read comics online"), 200))
        )
        expect((await findTitlesOnSource(SITE_ID, instant)).found).toEqual([])
    })

    it("uses the address another site files the title under when the name alone misses", async () => {
        await db.manga.bulkPut([manga("a", "Lantern Keeper", { sourceMangaId: "the-lantern-keeper" })])
        stubSite({ "/series/the-lantern-keeper/": page("Lantern Keeper") })
        const result = await findTitlesOnSource(SITE_ID, instant)
        expect(result.found.map(f => f.sourceMangaId)).toEqual(["the-lantern-keeper"])
    })

    it("skips titles already on the site or still samples", async () => {
        await db.manga.bulkPut([
            manga("a", "Lantern Keeper"),
            manga(`${SITE_ID}:manga:quiet-orchard`, "Quiet Orchard", { sourceId: SITE_ID })
        ])
        await putVersions([
            {
                id: `${SITE_ID}:lantern-keeper`,
                workKey: workKeyOf({ title: "Lantern Keeper" }),
                sourceId: SITE_ID,
                sourceMangaId: "lantern-keeper",
                url: `${ORIGIN}/series/lantern-keeper/`,
                languages: [],
                isOfficialAtObservation: false,
                health: "unknown",
                numberingKind: "chapter",
                lastSeenAt: 1,
                observedVia: "mirror-check"
            }
        ])
        const fetchMock = stubSite({})
        const result = await findTitlesOnSource(SITE_ID, instant)
        expect(result.total).toBe(0)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("stops when the site refuses a request and says where to carry on", async () => {
        await db.manga.bulkPut([manga("a", "Lantern Keeper"), manga("b", "Quiet Orchard")])
        stubSite({ "/series/lantern-keeper/": page("Lantern Keeper") }, new Set(["/series/quiet-orchard/"]))
        const result = await findTitlesOnSource(SITE_ID, instant)
        expect(result.found.map(f => f.mangaId)).toEqual(["a"])
        expect(result).toMatchObject({ checked: 1, total: 2, next: "a", stopped: "site-error" })
    })

    it("tells a fault in the extension apart from the site refusing", async () => {
        await db.manga.bulkPut([manga("a", "Lantern Keeper")])
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new TypeError("Failed to fetch")
            })
        )
        expect((await findTitlesOnSource(SITE_ID, instant)).stopped).toBe("site-error")

        const adapter = sourceRegistry.get(SITE_ID)!
        vi.spyOn(adapter, "findSeriesBySlug").mockRejectedValue(new RangeError("a bug, not the site"))
        const result = await findTitlesOnSource(SITE_ID, instant)
        expect(result.stopped).toBe("failed")
        expect(result.next).toBe("")
    })

    it("checks the rest after titles from the first run were added, skipping none", async () => {
        const titles = Array.from({ length: 45 }, (_, i) => `Title ${String(i).padStart(2, "0")}`)
        await db.manga.bulkPut(titles.map((title, i) => manga(`m${String(i).padStart(2, "0")}`, title)))
        const pages: Record<string, string> = {}
        for (const title of titles) pages[`/series/${slugFromName(title)}/`] = page(title)
        const fetchMock = stubSite(pages)

        const first = await findTitlesOnSource(SITE_ID, instant)
        expect(first).toMatchObject({ checked: 40, total: 45, next: "m39", stopped: "batch" })
        for (const hit of first.found.slice(0, 10)) {
            await recordMirrorVersions(hit.mangaId, [
                { sourceId: SITE_ID, sourceMangaId: hit.sourceMangaId, url: hit.url }
            ])
        }

        fetchMock.mockClear()
        const rest = await findTitlesOnSource(SITE_ID, { ...instant, after: first.next! })
        expect(rest.found.map(f => f.mangaId)).toEqual(["m40", "m41", "m42", "m43", "m44"])
        expect(rest).toMatchObject({ checked: 5, total: 5 })
        expect(rest.next).toBeUndefined()
    })

    it("stops before a request once its time is used, so a slow site cannot hold it past the budget", async () => {
        await db.manga.bulkPut([manga("a", "Lantern Keeper"), manga("b", "Quiet Orchard")])
        stubSite({ "/series/lantern-keeper/": page("Lantern Keeper") })
        let clock = 0
        const result = await findTitlesOnSource(SITE_ID, {
            pause: async () => {
                clock += 50_000
            },
            now: () => clock
        })
        expect(result).toMatchObject({ checked: 1, next: "a", stopped: "time" })
    })

    it("stops when the panel is closed", async () => {
        await db.manga.bulkPut([manga("a", "Lantern Keeper"), manga("b", "Quiet Orchard")])
        stubSite({ "/series/lantern-keeper/": page("Lantern Keeper") })
        const result = await findTitlesOnSource(SITE_ID, {
            pause: async () => cancelFind(SITE_ID)
        })
        expect(result).toMatchObject({ checked: 1, next: "a", stopped: "cancelled" })
    })

    it("refuses a site that is only read from the user's own tab", async () => {
        sourceRegistry.unregister(SITE_ID)
        registerProfile(profile({ listSource: "on-visit" }))
        await expect(findTitlesOnSource(SITE_ID, instant)).rejects.toThrow("can't be searched")
    })
})
