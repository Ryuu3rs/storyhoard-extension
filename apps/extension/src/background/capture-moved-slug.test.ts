import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createAdapterFromProfile, parseProfile } from "@amr/source-engine"
import { db, type LibraryManga } from "../database"

const SOURCE_ID = "comics-example"
const ORIGIN = "https://comics.example"

const parsed = parseProfile({
    profileFormat: 2,
    id: SOURCE_ID,
    name: "Comics Example",
    engine: "generic",
    numberingKind: "chapter",
    origin: ORIGIN,
    domains: ["comics.example"],
    languages: ["en"],
    capabilities: ["manga"],
    requestRateLimit: { requests: 3, intervalMs: 1000 },
    origins: [`${ORIGIN}/*`],
    match: {
        manga: "^/comics/([a-zA-Z0-9][a-zA-Z0-9-]*)/?$",
        chapter: "^/comics/([a-zA-Z0-9][a-zA-Z0-9-]*)/chapter/(\\d+(?:[.-]\\d+)?)/?$"
    },
    series: { urlTemplate: "/comics/{slug}/", titlePattern: "<title>(?<title>[^<]+)</title>" }
})
if (!parsed.ok) throw new Error("test profile rejected")
const adapter = createAdapterFromProfile(parsed.profile)

const settings = vi.hoisted(() => ({ autoAdd: true, markReadOnVisit: true }))

vi.mock("../sources", () => ({
    findSource: (url: URL) => (adapter.match(url) === "none" ? undefined : adapter),
    resolveChapterUrl: async (url: string) =>
        adapter.resolveChapter(
            { url: new URL(url) },
            {
                request: {} as never,
                now: () => Date.now(),
                logger: { debug: () => undefined, warn: () => undefined }
            }
        ),
    resolveMangaMetadata: vi.fn(async () => undefined),
    resolveCoverFor: vi.fn(async () => undefined)
}))
vi.mock("../arch-sources", () => ({ isProfileSource: () => true }))
vi.mock("../settings", () => ({ getSettings: async () => settings }))
vi.mock("./chapter-cache", () => ({ scheduleChapterListRefresh: vi.fn() }))
vi.mock("./covers", () => ({ fetchCoverBlob: vi.fn() }))
vi.mock("../live", () => ({ publishLive: vi.fn() }))

const { captureChapter } = await import("./capture")

const STORED_SLUG = "night-walker-1a2b3c4d"
const LIVE_SLUG = "night-walker-9f8e7d6c"
const TRACKED_ID = `${SOURCE_ID}:manga:${STORED_SLUG}`
const chapterAt = (slug: string, n: number) => `${ORIGIN}/comics/${slug}/chapter/${n}`

// A title tracked before the site moved its series address: the update check lists its chapters at the
// series' current address, so the library shows the latest chapter, while the entry keeps the slug it was
// added under.
async function seedTrackedTitle(): Promise<void> {
    const manga: LibraryManga = {
        id: TRACKED_ID,
        title: "Night Walker",
        normalizedTitle: "night walker",
        sourceId: SOURCE_ID,
        sourceMangaId: STORED_SLUG,
        mangaUrl: `${ORIGIN}/comics/${STORED_SLUG}/`,
        sourceUrl: chapterAt(LIVE_SLUG, 101),
        authors: [],
        status: "unknown",
        addedAt: 1,
        updatedAt: 1,
        latestChapterId: `${SOURCE_ID}:chapter:${STORED_SLUG}:101`,
        latestChapterNumber: 101,
        lastReadChapterId: `${SOURCE_ID}:chapter:${STORED_SLUG}:99`,
        lastReadChapterNumber: 99
    }
    await db.manga.put(manga)
    await db.sourceLinks.put({
        mangaId: TRACKED_ID,
        sourceId: SOURCE_ID,
        sourceMangaId: STORED_SLUG,
        url: manga.mangaUrl!,
        title: manga.title,
        addedAt: 1,
        updatedAt: 1
    })
    for (const n of [99, 100, 101]) {
        await db.chapters.put({
            id: `${SOURCE_ID}:chapter:${STORED_SLUG}:${n}`,
            mangaId: TRACKED_ID,
            sourceId: SOURCE_ID,
            title: `Ch.${n}`,
            url: chapterAt(LIVE_SLUG, n),
            sortKey: n
        })
    }
}

beforeEach(async () => {
    settings.autoAdd = true
    settings.markReadOnVisit = true
    vi.stubGlobal("browser", {
        action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
        alarms: { create: vi.fn() }
    })
    await Promise.all(db.tables.map(table => table.clear()))
    await seedTrackedTitle()
})

describe("reading a tracked title after its site moved the series address", () => {
    it("advances the tracked title's read position instead of starting a second title", async () => {
        await captureChapter(chapterAt(LIVE_SLUG, 100))

        expect(await db.manga.count()).toBe(1)
        const tracked = await db.manga.get(TRACKED_ID)
        expect(tracked?.lastReadChapterNumber).toBe(100)
        expect(await db.progress.get(`${SOURCE_ID}:chapter:${STORED_SLUG}:100`)).toMatchObject({ completed: true })
    })

    it("finds the title by its listed chapter when nothing else on it names the new address", async () => {
        await db.manga.update(TRACKED_ID, { sourceUrl: chapterAt(STORED_SLUG, 98) })

        await captureChapter(chapterAt(LIVE_SLUG, 100))

        expect(await db.manga.count()).toBe(1)
        expect((await db.manga.get(TRACKED_ID))?.lastReadChapterNumber).toBe(100)
    })

    it("keeps following the title for a chapter its list does not hold yet", async () => {
        await captureChapter(chapterAt(LIVE_SLUG, 100))
        await captureChapter(chapterAt(LIVE_SLUG, 102))

        expect(await db.manga.count()).toBe(1)
        expect((await db.manga.get(TRACKED_ID))?.lastReadChapterNumber).toBe(102)
    })

    it("advances the tracked title with auto-add off too", async () => {
        settings.autoAdd = false

        await captureChapter(chapterAt(LIVE_SLUG, 101))

        expect(await db.manga.count()).toBe(1)
        expect((await db.manga.get(TRACKED_ID))?.lastReadChapterNumber).toBe(101)
    })

    it("still starts a new title for a series no tracked title lists", async () => {
        await captureChapter(chapterAt("day-runner-5e6f7a8b", 3))

        expect(await db.manga.count()).toBe(2)
        expect((await db.manga.get(TRACKED_ID))?.lastReadChapterNumber).toBe(99)
    })
})
