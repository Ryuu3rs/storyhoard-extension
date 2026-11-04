import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SourceChallengeError } from "@amr/source-sdk"
import { db, type LibraryManga } from "../database"

const mocks = vi.hoisted(() => ({
    findSource: vi.fn(),
    resolveChapterUrl: vi.fn(),
    resolveMangaMetadata: vi.fn(),
    resolveCoverFor: vi.fn()
}))

vi.mock("../sources", () => ({
    findSource: mocks.findSource,
    resolveChapterUrl: mocks.resolveChapterUrl,
    resolveMangaMetadata: mocks.resolveMangaMetadata,
    resolveCoverFor: mocks.resolveCoverFor
}))
vi.mock("../arch-sources", () => ({ isProfileSource: () => false }))
vi.mock("../settings", () => ({ getSettings: async () => ({ autoAdd: true, markReadOnVisit: true }) }))
vi.mock("./chapter-cache", () => ({ scheduleChapterListRefresh: vi.fn() }))
vi.mock("./covers", () => ({ fetchCoverBlob: vi.fn() }))
vi.mock("../live", () => ({ publishLive: vi.fn() }))

const { captureChapter, repairSiteWideStubs } = await import("./capture")

const ORIGIN = "https://reader.example"
const SOURCE_ID = "reader"
const uuid = (n: number) => `d4de9439-f8b7-44f2-9d50-8dc6ecc5${String(n).padStart(4, "0")}`
const pageUrl = (chapter: number, page: number) => `${ORIGIN}/chapter/${uuid(chapter)}/${page}`
const chapterUrl = (chapter: number) => `${ORIGIN}/chapter/${uuid(chapter)}`

function resolved(url: string) {
    const id = new URL(url).pathname.split("/")[2]!
    const mangaId = `${SOURCE_ID}:manga:real-title`
    return {
        manga: {
            sourceId: SOURCE_ID,
            sourceMangaId: "real-title",
            url: `${ORIGIN}/title/real-title`,
            manga: {
                id: mangaId,
                title: "Real Title",
                normalizedTitle: "real title",
                sourceId: SOURCE_ID,
                authors: [],
                status: "unknown" as const,
                addedAt: 1,
                updatedAt: 1
            }
        },
        chapter: {
            id: `${SOURCE_ID}:chapter:${id}`,
            mangaId,
            sourceId: SOURCE_ID,
            title: "Chapter 5",
            url,
            sortKey: 5
        },
        pages: []
    }
}

const stubUrl = ORIGIN
function stubManga(overrides: Partial<LibraryManga> = {}): LibraryManga {
    return {
        id: `${SOURCE_ID}:manga:/chapter/${uuid(900)}/1`,
        title: "reader.example",
        normalizedTitle: "reader.example",
        sourceId: SOURCE_ID,
        sourceUrl: `${ORIGIN}/chapter/${uuid(900)}/1`,
        mangaUrl: stubUrl,
        authors: [],
        status: "unknown",
        addedAt: 1,
        updatedAt: 1,
        ...overrides
    }
}

async function seedStub(manga: LibraryManga, chapter: number, pages: number) {
    await db.manga.put(manga)
    await db.sourceLinks.put({
        mangaId: manga.id,
        sourceId: SOURCE_ID,
        url: stubUrl,
        title: manga.title,
        addedAt: 1,
        updatedAt: 1
    })
    for (let page = 1; page <= pages; page += 1) {
        const id = `${manga.id}:ext:${page}`
        await db.chapters.put({
            id,
            mangaId: manga.id,
            sourceId: SOURCE_ID,
            title: "External chapter",
            url: pageUrl(chapter, page),
            sortKey: Number.POSITIVE_INFINITY
        })
        await db.progress.put({
            mangaId: manga.id,
            chapterId: id,
            pageIndex: 0,
            pageCount: 1,
            completed: true,
            updatedAt: page
        })
        await db.historyEvents.add({ mangaId: manga.id, chapterId: id, type: "started", occurredAt: page })
        await db.historyEvents.add({ mangaId: manga.id, chapterId: id, type: "completed", occurredAt: page })
    }
}

const storage = new Map<string, unknown>()

beforeEach(async () => {
    vi.clearAllMocks()
    storage.clear()
    vi.stubGlobal("browser", {
        action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
        alarms: { create: vi.fn() },
        storage: {
            local: {
                get: async (key: string) => (storage.has(key) ? { [key]: storage.get(key) } : {}),
                set: async (items: Record<string, unknown>) => {
                    for (const [key, value] of Object.entries(items)) storage.set(key, value)
                }
            }
        }
    })
    await Promise.all(db.tables.map(table => table.clear()))
    mocks.findSource.mockReturnValue({
        manifest: { id: SOURCE_ID, name: "Reader" },
        match: () => "chapter",
        parseMangaUrl: () => null
    })
    mocks.resolveChapterUrl.mockImplementation(async (url: string) => resolved(url))
})

describe("a reader that puts the page in its address", () => {
    it("records one chapter for every page turn and resolves it once", async () => {
        for (const page of [1, 2, 3, 4]) await captureChapter(pageUrl(1, page))

        expect(mocks.resolveChapterUrl).toHaveBeenCalledTimes(1)
        expect(mocks.resolveChapterUrl).toHaveBeenCalledWith(chapterUrl(1))
        expect(await db.manga.count()).toBe(1)
        expect(await db.chapters.count()).toBe(1)
        expect((await db.historyEvents.toArray()).filter(event => event.type === "completed")).toHaveLength(1)
    })

    it("records nothing, and logs why, when the chapter cannot be resolved and the address names no title", async () => {
        mocks.resolveChapterUrl.mockRejectedValue(new SourceChallengeError("https://reader.example"))

        for (const page of [1, 2, 3]) await captureChapter(pageUrl(2, page))

        expect(await db.manga.count()).toBe(0)
        expect(await db.chapters.count()).toBe(0)
        expect(await db.historyEvents.count()).toBe(0)
        expect(mocks.resolveChapterUrl).toHaveBeenCalledTimes(1)
        await vi.waitFor(async () => {
            const logs = await db.logs.toArray()
            const entry = logs.find(log => log.scope === "capture" && log.level === "warn")
            expect(entry?.message).toMatch(/not recorded/i)
            expect(entry?.detail).toContain("bot-block")
            expect(entry?.detail).toContain(SOURCE_ID)
        })
    })

    it("tries a failed chapter again once the short wait has passed", async () => {
        vi.useFakeTimers({ toFake: ["Date"] })
        try {
            mocks.resolveChapterUrl.mockRejectedValueOnce(new SourceChallengeError("https://reader.example"))
            await captureChapter(pageUrl(3, 1))
            vi.setSystemTime(Date.now() + 61_000)
            await captureChapter(pageUrl(3, 2))

            expect(mocks.resolveChapterUrl).toHaveBeenCalledTimes(2)
            expect(await db.chapters.count()).toBe(1)
        } finally {
            vi.useRealTimers()
        }
    })

    it("keeps resolving an address with no page in it on every visit", async () => {
        await captureChapter(chapterUrl(4))
        await captureChapter(chapterUrl(4))

        expect(mocks.resolveChapterUrl).toHaveBeenCalledTimes(2)
    })

    it("leaves a last number after a readable slug alone, because that can be the chapter", async () => {
        const url = `${ORIGIN}/chapter/some-series/12`
        mocks.resolveChapterUrl.mockImplementation(async () => resolved(url))

        await captureChapter(url)

        expect(mocks.resolveChapterUrl).toHaveBeenCalledWith(url)
    })
})

describe("repairing a placeholder named after the site", () => {
    it("re-records each chapter once, removes the placeholder and its history, and keeps a backup", async () => {
        const stub = stubManga()
        await seedStub(stub, 10, 28)

        await repairSiteWideStubs()

        expect(await db.manga.get(stub.id)).toBeUndefined()
        expect(await db.sourceLinks.get(stub.id)).toBeUndefined()
        expect(await db.chapters.where("mangaId").equals(stub.id).count()).toBe(0)
        expect(await db.progress.where("mangaId").equals(stub.id).count()).toBe(0)
        expect(await db.historyEvents.where("mangaId").equals(stub.id).count()).toBe(0)
        expect(mocks.resolveChapterUrl).toHaveBeenCalledTimes(1)
        expect(mocks.resolveChapterUrl).toHaveBeenCalledWith(chapterUrl(10))
        expect((await db.manga.toArray()).map(manga => manga.title)).toEqual(["Real Title"])
        expect(await db.backups.count()).toBe(1)
    })

    it("still removes the placeholder when the chapter cannot be resolved", async () => {
        mocks.resolveChapterUrl.mockRejectedValue(new SourceChallengeError("https://reader.example"))
        const stub = stubManga()
        await seedStub(stub, 11, 5)

        await repairSiteWideStubs()

        expect(await db.manga.count()).toBe(0)
        expect(await db.historyEvents.count()).toBe(0)
    })

    it("runs once", async () => {
        await repairSiteWideStubs()
        const stub = stubManga()
        await seedStub(stub, 12, 3)

        await repairSiteWideStubs()

        expect(await db.manga.get(stub.id)).toBeDefined()
    })

    it("leaves a renamed entry, one with a real chapter and one with a real title address alone", async () => {
        const renamed = stubManga({ id: "reader:manga:renamed", title: "My own name", normalizedTitle: "my own name" })
        await seedStub(renamed, 13, 2)
        const numbered = stubManga({ id: "reader:manga:numbered" })
        await seedStub(numbered, 14, 1)
        await db.chapters.put({
            id: "reader:manga:numbered:ext:ch-3",
            mangaId: numbered.id,
            sourceId: SOURCE_ID,
            title: "Chapter 3",
            url: `${ORIGIN}/x/chapter-3`,
            sortKey: 3
        })
        const real = stubManga({ id: "reader:manga:real", mangaUrl: `${ORIGIN}/manga/real` })
        await seedStub(real, 15, 2)

        await repairSiteWideStubs()

        expect(await db.manga.get(renamed.id)).toBeDefined()
        expect(await db.manga.get(numbered.id)).toBeDefined()
        expect(await db.manga.get(real.id)).toBeDefined()
        expect(mocks.resolveChapterUrl).not.toHaveBeenCalled()
        expect(await db.backups.count()).toBe(0)
    })

    it("does not mark itself done when the library cannot be read", async () => {
        const spy = vi.spyOn(db.manga, "toArray").mockRejectedValueOnce(new Error("closing"))
        await repairSiteWideStubs()
        spy.mockRestore()
        const stub = stubManga()
        await seedStub(stub, 16, 2)

        await repairSiteWideStubs()

        expect(await db.manga.get(stub.id)).toBeUndefined()
    })
})

describe("a chapter page that carries no cover", () => {
    const COVER = `${ORIGIN}/cover.jpg`
    const source = { manifest: { id: SOURCE_ID, name: "Reader" }, match: () => "chapter" }
    const capture = async (url: string) => {
        mocks.findSource.mockReturnValue(source)
        mocks.resolveChapterUrl.mockResolvedValue(resolved(url))
        await captureChapter(url)
    }
    const mangaId = `${SOURCE_ID}:manga:real-title`

    beforeEach(async () => {
        mocks.resolveCoverFor.mockReset()
        await Promise.all(db.tables.map(table => table.clear()))
    })

    it("takes it from the series page, so a new title does not wait for the next restart", async () => {
        mocks.resolveCoverFor.mockResolvedValue(COVER)

        await capture(chapterUrl(1))

        await vi.waitFor(async () => expect((await db.manga.get(mangaId))?.coverUrl).toBe(COVER))
        expect(mocks.resolveCoverFor).toHaveBeenCalledWith({
            sourceId: SOURCE_ID,
            sourceMangaId: "real-title",
            mangaUrl: `${ORIGIN}/title/real-title`
        })
    })

    it("asks nothing when the title already has one", async () => {
        await capture(chapterUrl(1))
        await vi.waitFor(() => expect(mocks.resolveCoverFor).toHaveBeenCalledTimes(1))
        await db.manga.update(mangaId, { coverUrl: COVER, status: "completed" })
        mocks.resolveCoverFor.mockClear()

        await capture(chapterUrl(2))
        await new Promise(resolve => setTimeout(resolve, 20))

        expect(mocks.resolveCoverFor).not.toHaveBeenCalled()
        // Saving a chapter whose page knows neither must not forget them.
        expect(await db.manga.get(mangaId)).toMatchObject({ coverUrl: COVER, status: "completed" })
    })

    it("does not fail the capture when the series page gives none", async () => {
        mocks.resolveCoverFor.mockRejectedValue(new Error("gone"))

        await capture(chapterUrl(1))

        await vi.waitFor(() => expect(mocks.resolveCoverFor).toHaveBeenCalled())
        expect(await db.manga.get(mangaId)).toBeDefined()
    })
})
