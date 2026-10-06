import "fake-indexeddb/auto"
import { sourceRegistry } from "@amr/sources"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { db, putArchProfile, type LibraryManga } from "./database"

const scheduleChapterListRefreshMock = vi.fn()
vi.mock("./background/chapter-cache", () => ({
    scheduleChapterListRefresh: (...args: unknown[]) => scheduleChapterListRefreshMock(...args)
}))

vi.mock("./settings", () => ({
    getSettings: async () => ({ language: "en" })
}))

const { chapterListForUrl, deleteImportedProfile, initUserSources, registerStoredArchProfiles } =
    await import("./arch-sources")
const { listMangaChapters } = await import("./sources")

const ORIGIN = "https://example-scans.test"
const SLUG = "demo-title"
const PROFILE_ID = "example-scans"

const profileV2 = {
    profileFormat: 2,
    id: PROFILE_ID,
    name: "Example Scans",
    engine: "generic",
    origin: ORIGIN,
    domains: ["example-scans.test"],
    languages: ["en"],
    capabilities: ["chapters", "manga"],
    numberingKind: "chapter",
    requestRateLimit: { requests: 50, intervalMs: 1000 },
    origins: [`${ORIGIN}/*`],
    match: {
        manga: "^/manga/([a-z0-9-]+)/?$",
        chapter: "^/manga/([a-z0-9-]+)/ch-([0-9.]+)/?$"
    },
    series: {
        urlTemplate: "/manga/{slug}",
        titlePattern: '<meta property="og:title" content="(?<title>[^"]+)"'
    },
    list: {
        itemPattern:
            '<a href="(?<chapterUrl>/manga/[a-z0-9-]+/ch-(?<chapterNumber>[0-9.]+))">(?<chapterTitle>[^<]*)</a>'
    }
}

const seriesHtml = `<html><head><meta property="og:title" content="Demo Title" /></head><body>
<a href="/manga/${SLUG}/ch-1">First</a>
<a href="/manga/${SLUG}/ch-2">Second</a>
<a href="/manga/${SLUG}/ch-3">Third</a>
</body></html>`

function libraryManga(sourceId: string): LibraryManga {
    return {
        id: `${sourceId}:manga:${SLUG}`,
        title: "Demo Title",
        normalizedTitle: "demo title",
        authors: [],
        status: "ongoing",
        addedAt: 1,
        updatedAt: 1,
        sourceId,
        sourceUrl: `${ORIGIN}/manga/${SLUG}/ch-1`,
        sourceMangaId: SLUG,
        mangaUrl: `${ORIGIN}/manga/${SLUG}`
    }
}

async function seedTrackedChapter(sourceId: string): Promise<string> {
    const manga = libraryManga(sourceId)
    const url = `${ORIGIN}/manga/${SLUG}/ch-1`
    await db.manga.put(manga)
    await db.chapters.put({
        id: `${sourceId}:chapter:${SLUG}:1`,
        mangaId: manga.id,
        sourceId,
        title: "First",
        url,
        sortKey: 1,
        language: "en"
    })
    return url
}

beforeEach(async () => {
    scheduleChapterListRefreshMock.mockReset()
    await Promise.all([db.manga.clear(), db.chapters.clear(), db.archProfiles.clear()])
})

afterEach(async () => {
    sourceRegistry.unregister(PROFILE_ID)
    vi.unstubAllGlobals()
})

describe("profile-backed sources register at startup without the arch flag", () => {
    it("initUserSources registers a persisted format-2 profile and leaves bundled adapters in place", async () => {
        await putArchProfile(PROFILE_ID, profileV2)
        const bundledBefore = sourceRegistry.list().length

        await initUserSources()

        expect(sourceRegistry.get(PROFILE_ID)).toBeDefined()
        expect(sourceRegistry.get("mangafreak")).toBeDefined()
        expect(sourceRegistry.list().length).toBe(bundledBefore + 1)
    })

    it("registerStoredArchProfiles skips an invalid stored profile instead of throwing", async () => {
        await putArchProfile("broken", { id: "broken" })
        await expect(registerStoredArchProfiles()).resolves.toBeUndefined()
        expect(sourceRegistry.get("broken")).toBeUndefined()
    })
})

describe("chapterListForUrl background refresh for profile-backed sources", () => {
    it("schedules a refresh for a profile-backed source even though it has no getChapterListUrl", async () => {
        await putArchProfile(PROFILE_ID, profileV2)
        await registerStoredArchProfiles()
        expect(sourceRegistry.get(PROFILE_ID)?.getChapterListUrl).toBeUndefined()
        const url = await seedTrackedChapter(PROFILE_ID)

        const list = await chapterListForUrl(url)

        expect(list.map(c => c.sortKey)).toEqual([1])
        expect(scheduleChapterListRefreshMock).toHaveBeenCalledTimes(1)
        const [source, sourceMangaId, mangaUrl, mangaId] = scheduleChapterListRefreshMock.mock.calls[0]!
        expect((source as { manifest: { id: string } }).manifest.id).toBe(PROFILE_ID)
        expect(sourceMangaId).toBe(SLUG)
        expect(mangaUrl).toBe(`${ORIGIN}/manga/${SLUG}`)
        expect(mangaId).toBe(`${PROFILE_ID}:manga:${SLUG}`)
    })

    it("does not schedule a refresh for a bundled adapter that has no getChapterListUrl", async () => {
        const bundled = sourceRegistry.get("mangafreak")
        expect(bundled?.getChapterListUrl).toBeUndefined()
        const url = await seedTrackedChapter("mangafreak")

        await chapterListForUrl(url)

        expect(scheduleChapterListRefreshMock).not.toHaveBeenCalled()
    })

    it("stops scheduling once the profile is deleted", async () => {
        await putArchProfile(PROFILE_ID, profileV2)
        await registerStoredArchProfiles()
        const url = await seedTrackedChapter(PROFILE_ID)

        await deleteImportedProfile(PROFILE_ID)
        await chapterListForUrl(url)

        expect(scheduleChapterListRefreshMock).not.toHaveBeenCalled()
    })
})

describe("update-check path for a registered format-2 profile source", () => {
    it("listMangaChapters (what checkUpdates calls) fetches and parses the chapter list through the engine", async () => {
        await putArchProfile(PROFILE_ID, profileV2)
        await registerStoredArchProfiles()
        const fetchMock = vi.fn(async (input: unknown) => ({
            ok: true,
            status: 200,
            url: String(input),
            text: async () => seriesHtml
        }))
        vi.stubGlobal("fetch", fetchMock)
        const manga = libraryManga(PROFILE_ID)

        const chapters = await listMangaChapters(
            manga,
            {
                mangaId: manga.id,
                sourceId: PROFILE_ID,
                sourceMangaId: SLUG,
                url: manga.mangaUrl!,
                language: "en"
            } as never,
            "en"
        )

        expect(chapters.map(c => c.sortKey)).toEqual([1, 2, 3])
        expect(fetchMock).toHaveBeenCalled()
        expect(String(fetchMock.mock.calls[0]![0])).toContain(`${ORIGIN}/manga/${SLUG}`)
    })
})
