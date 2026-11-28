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

const chapterAt = (slug: string, n: number) => `${ORIGIN}/comics/${slug}/chapter/${n}`
const idOf = (slug: string) => `${SOURCE_ID}:manga:${slug}`

// A title tracked at its own, still-current address: the update check lists its chapters there.
async function seedTitle(slug: string, title: string, chapters: number[], lastRead: number): Promise<void> {
    const id = idOf(slug)
    const manga: LibraryManga = {
        id,
        title,
        normalizedTitle: title.toLocaleLowerCase("en"),
        sourceId: SOURCE_ID,
        sourceMangaId: slug,
        mangaUrl: `${ORIGIN}/comics/${slug}/`,
        sourceUrl: chapterAt(slug, lastRead),
        authors: [],
        status: "unknown",
        addedAt: 1,
        updatedAt: 1,
        latestChapterId: `${SOURCE_ID}:chapter:${slug}:${chapters.at(-1)}`,
        latestChapterNumber: chapters.at(-1)!,
        lastReadChapterId: `${SOURCE_ID}:chapter:${slug}:${lastRead}`,
        lastReadChapterNumber: lastRead
    }
    await db.manga.put(manga)
    await db.sourceLinks.put({
        mangaId: id,
        sourceId: SOURCE_ID,
        sourceMangaId: slug,
        url: manga.mangaUrl!,
        title,
        addedAt: 1,
        updatedAt: 1
    })
    for (const n of chapters) {
        await db.chapters.put({
            id: `${SOURCE_ID}:chapter:${slug}:${n}`,
            mangaId: id,
            sourceId: SOURCE_ID,
            title: `Ch.${n}`,
            url: chapterAt(slug, n),
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
})

describe("a site whose slugs are a generic word plus a hex id", () => {
    // "/comics/manga-aa951409/" and "/comics/manga-bb120934/" are two unrelated series. Both normalize to
    // "manga" because the hex id is taken for a rotating hash and "manga" counts as a real word.
    const TRACKED = "manga-aa951409"
    const OTHER = "manga-bb120934"

    it("records a visit to a different series as a new title, not on the tracked one", async () => {
        await seedTitle(TRACKED, "Night Walker", [1, 2, 3, 4, 5], 5)

        await captureChapter(chapterAt(OTHER, 3))

        expect(await db.manga.count()).toBe(2)
    })

    it("never repoints the tracked title at another series' address", async () => {
        await seedTitle(TRACKED, "Night Walker", [1, 2, 3, 4, 5], 5)

        await captureChapter(chapterAt(OTHER, 7))

        const tracked = await db.manga.get(idOf(TRACKED))
        expect(tracked?.sourceMangaId).toBe(TRACKED)
        expect(tracked?.mangaUrl).toBe(`${ORIGIN}/comics/${TRACKED}/`)
        expect((await db.sourceLinks.get(idOf(TRACKED)))?.url).toBe(`${ORIGIN}/comics/${TRACKED}/`)
        expect(tracked?.lastReadChapterNumber).toBe(5)
    })

    it("with auto-add off, does not mark a chapter of another series read on the tracked title", async () => {
        settings.autoAdd = false
        await seedTitle(TRACKED, "Night Walker", [1, 2, 3, 4, 5], 2)

        await captureChapter(chapterAt(OTHER, 4))

        const tracked = await db.manga.get(idOf(TRACKED))
        expect(tracked?.lastReadChapterNumber).toBe(2)
        expect(tracked?.sourceMangaId).toBe(TRACKED)
    })
})

describe("Merge into, for a second copy started at a moved address", () => {
    // The site renamed the series address (no hash involved): the tracked title T keeps its old slug, a visit
    // to the new address started copy C. The user opens C and picks "Merge into" T, as the PR intends.
    const OLD = "night-walker"
    const NEW = "the-night-walker"

    async function seedCopy(): Promise<void> {
        await seedTitle(OLD, "Night Walker", [97, 98, 99, 100, 101, 102, 103], 99)
        // T's update check now lists the chapters at the new address under T's own chapter ids.
        for (const n of [97, 98, 99, 100, 101, 102, 103]) {
            await db.chapters.update(`${SOURCE_ID}:chapter:${OLD}:${n}`, { url: chapterAt(NEW, n) })
        }
        await seedTitle(NEW, "The Night Walker", [102, 103], 103)
        for (const n of [102, 103]) {
            const chapterId = `${SOURCE_ID}:chapter:${NEW}:${n}`
            await db.progress.put({
                chapterId,
                mangaId: idOf(NEW),
                pageIndex: 0,
                pageCount: 1,
                completed: true,
                updatedAt: 10 + n
            })
            await db.historyEvents.add({
                mangaId: idOf(NEW),
                chapterId,
                type: "completed",
                occurredAt: 10 + n
            } as never)
        }
    }

    it("keeps the copy's per-chapter read marks on the kept title's matching chapters", async () => {
        const { mergeMangaRecords } = await import("../database")
        await seedCopy()

        await mergeMangaRecords(idOf(OLD), [idOf(NEW)])

        expect((await db.progress.get(`${SOURCE_ID}:chapter:${OLD}:102`))?.completed).toBe(true)
        expect((await db.progress.get(`${SOURCE_ID}:chapter:${OLD}:103`))?.completed).toBe(true)
    })

    it("leaves no progress or history row on the kept title pointing at a chapter that no longer exists", async () => {
        const { mergeMangaRecords } = await import("../database")
        await seedCopy()

        await mergeMangaRecords(idOf(OLD), [idOf(NEW)])

        const chapterIds = new Set(
            (await db.chapters.where("mangaId").equals(idOf(OLD)).toArray()).map(chapter => chapter.id)
        )
        const progress = await db.progress.where("mangaId").equals(idOf(OLD)).toArray()
        const history = await db.historyEvents.where("mangaId").equals(idOf(OLD)).toArray()
        expect(progress.filter(row => !chapterIds.has(row.chapterId)).map(row => row.chapterId)).toEqual([])
        expect(history.filter(row => !chapterIds.has(row.chapterId)).map(row => row.chapterId)).toEqual([])
    })

    it("the next visit to the new address lands on the kept title instead of starting the copy again", async () => {
        const { mergeMangaRecords } = await import("../database")
        await seedCopy()
        await mergeMangaRecords(idOf(OLD), [idOf(NEW)])

        await captureChapter(chapterAt(NEW, 104))

        expect(await db.manga.count()).toBe(1)
        expect((await db.manga.get(idOf(OLD)))?.lastReadChapterNumber).toBe(104)
    })
})

describe("two tracked titles share a base name on one site", () => {
    // Two distinct tracked series that differ only by the site's per-series hash (a manga and its novel, or
    // a re-upload). A visit to a third address with the same base cannot say which of them moved.
    const A = "night-walker-1a2b3c4d"
    const B = "night-walker-5e6f7a8b"
    const MOVED = "night-walker-77cc88dd"

    it("does not guess: neither tracked title is repointed at the ambiguous address", async () => {
        await seedTitle(A, "Night Walker", [1, 2, 3], 3)
        await seedTitle(B, "Night Walker (Novel)", [40, 41, 42], 42)

        await captureChapter(chapterAt(MOVED, 43))

        expect((await db.manga.get(idOf(A)))?.sourceMangaId).toBe(A)
        expect((await db.manga.get(idOf(B)))?.sourceMangaId).toBe(B)
        expect((await db.manga.get(idOf(A)))?.lastReadChapterNumber).toBe(3)
    })
})
