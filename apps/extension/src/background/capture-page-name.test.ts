import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createAdapterFromProfile, parseProfile } from "@amr/source-engine"
import { db, type LibraryManga } from "../database"

const SOURCE_ID = "reader-demo.net"
const ORIGIN = "https://reader-demo.net"

const parsed = parseProfile({
    profileFormat: 2,
    id: SOURCE_ID,
    name: "Reader Demo",
    engine: "generic",
    numberingKind: "chapter",
    origin: ORIGIN,
    domains: ["reader-demo.net"],
    languages: ["en"],
    capabilities: ["manga"],
    requestRateLimit: { requests: 3, intervalMs: 1000 },
    origins: [`${ORIGIN}/*`],
    match: {
        manga: "^/comics/([a-zA-Z0-9][a-zA-Z0-9-]*)/?$",
        chapter: "^/comics/([a-zA-Z0-9][a-zA-Z0-9-]*)/chapter/(\\d+(?:[.-]\\d+)?)/?$"
    },
    series: { urlTemplate: "/comics/{slug}/", titlePattern: 'property="og:title" content="(?<title>[^"]+)"' }
})
if (!parsed.ok) throw new Error("test profile rejected")
const adapter = createAdapterFromProfile(parsed.profile)

const sources = vi.hoisted(() => ({ resolveMangaMetadata: vi.fn() }))

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
    resolveMangaMetadata: sources.resolveMangaMetadata,
    resolveCoverFor: vi.fn(async () => undefined)
}))
vi.mock("../arch-sources", () => ({ isProfileSource: () => true }))
vi.mock("../settings", () => ({ getSettings: async () => ({ autoAdd: true, markReadOnVisit: true }) }))
vi.mock("./chapter-cache", () => ({ scheduleChapterListRefresh: vi.fn() }))
vi.mock("./covers", () => ({ fetchCoverBlob: vi.fn() }))
vi.mock("../live", () => ({ publishLive: vi.fn() }))

const { captureChapter, nameTitleFromPage, nameTitleFromTab, refreshExternalMangaMetadata } = await import("./capture")

const TAB_ID = 7
const chapterAt = (slug: string, n: number) => `${ORIGIN}/comics/${slug}/chapter/${n}`
const mangaIdOf = (slug: string) => `${SOURCE_ID}:manga:${slug}`

type Page = { url: string; ogTitle?: string; docTitle?: string; heading?: string; siteName?: string }
const executeScript = vi.fn<(input: unknown) => Promise<Array<{ result: Page }>>>()

function showPage(page: Page): void {
    executeScript.mockResolvedValue([{ result: page }])
}

async function seedTitle(slug: string, title: string): Promise<void> {
    const manga: LibraryManga = {
        id: mangaIdOf(slug),
        title,
        normalizedTitle: title.toLocaleLowerCase("en"),
        sourceId: SOURCE_ID,
        sourceMangaId: slug,
        mangaUrl: `${ORIGIN}/comics/${slug}/`,
        sourceUrl: chapterAt(slug, 1),
        authors: [],
        status: "unknown",
        addedAt: 1,
        updatedAt: 1
    }
    await db.manga.put(manga)
}

beforeEach(async () => {
    vi.clearAllMocks()
    vi.stubGlobal("browser", {
        action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
        alarms: { create: vi.fn() },
        scripting: { executeScript }
    })
    sources.resolveMangaMetadata.mockRejectedValue(new Error("series page blocked"))
    executeScript.mockResolvedValue([])
    await Promise.all(db.tables.map(table => table.clear()))
})

describe("a title captured on a followed site whose series page cannot be fetched", () => {
    it("is named from the slug without its per-series hash, title cased", async () => {
        const slug = "lantern-keeper-3f9c2b71"
        await captureChapter(chapterAt(slug, 1))

        expect((await db.manga.get(mangaIdOf(slug)))?.title).toBe("Lantern Keeper")
    })

    it("takes the series name the reader's own page shows", async () => {
        const slug = "lantern-keeper-1f2e3d4c"
        showPage({
            url: chapterAt(slug, 1),
            ogTitle: "The Lantern Keeper's Oath Chapter 1",
            docTitle: "The Lantern Keeper's Oath Chapter 1 - Reader Demo"
        })
        await captureChapter(chapterAt(slug, 1))

        await nameTitleFromTab(TAB_ID, chapterAt(slug, 1))

        const stored = await db.manga.get(mangaIdOf(slug))
        expect(stored?.title).toBe("The Lantern Keeper's Oath")
        expect(stored?.normalizedTitle).toBe("the lantern keeper's oath")
        expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: TAB_ID } }))
    })

    it("keeps the page's name on the next chapter's capture", async () => {
        const slug = "lantern-keeper-2a3b4c5d"
        showPage({ url: chapterAt(slug, 1), docTitle: "Lantern Keeper: Embers - Chapter 1 | Reader Demo" })
        await captureChapter(chapterAt(slug, 1))
        await nameTitleFromTab(TAB_ID, chapterAt(slug, 1))

        await captureChapter(chapterAt(slug, 2))

        expect((await db.manga.get(mangaIdOf(slug)))?.title).toBe("Lantern Keeper: Embers")
    })
})

describe("upgrading a title still named after its address", () => {
    it("renames an existing row named from the slug and its hash on the next visit", async () => {
        const slug = "harbor-lights-3c4d5e6f"
        await seedTitle(slug, "harbor lights 3c4d5e6f")
        showPage({ url: chapterAt(slug, 4), ogTitle: "Harbor Lights at Dusk Chapter 4", siteName: "Reader Demo" })

        await nameTitleFromTab(TAB_ID, chapterAt(slug, 4))

        expect((await db.manga.get(mangaIdOf(slug)))?.title).toBe("Harbor Lights at Dusk")
    })

    it("never touches a title that is not a placeholder", async () => {
        const slug = "harbor-lights-4d5e6f7a"
        await seedTitle(slug, "My Harbor Book")
        showPage({ url: chapterAt(slug, 4), ogTitle: "Harbor Lights at Dusk Chapter 4" })

        await nameTitleFromTab(TAB_ID, chapterAt(slug, 4))

        expect((await db.manga.get(mangaIdOf(slug)))?.title).toBe("My Harbor Book")
        expect(executeScript).not.toHaveBeenCalled()
    })

    it("keeps the placeholder when the page does not name this series", async () => {
        const slug = "harbor-lights-5e6f7a8b"
        await seedTitle(slug, "Harbor Lights")
        showPage({ url: chapterAt(slug, 4), ogTitle: "Reader Demo", docTitle: "Just a moment..." })

        const result = await nameTitleFromPage({
            tabId: TAB_ID,
            pageUrl: chapterAt(slug, 4),
            mangaId: mangaIdOf(slug),
            sourceMangaId: slug
        })

        expect(result.outcome).toBe("unread")
        expect((await db.manga.get(mangaIdOf(slug)))?.title).toBe("Harbor Lights")
    })

    it("ignores a tab that has already moved to another page", async () => {
        const slug = "harbor-lights-6f7a8b9c"
        await seedTitle(slug, "Harbor Lights")
        showPage({ url: chapterAt("tide-singer-1a2b3c4d", 2), ogTitle: "Harbor Lights at Dusk Chapter 4" })

        const result = await nameTitleFromPage({
            tabId: TAB_ID,
            pageUrl: chapterAt(slug, 4),
            mangaId: mangaIdOf(slug),
            sourceMangaId: slug
        })

        expect(result.outcome).toBe("unread")
        expect((await db.manga.get(mangaIdOf(slug)))?.title).toBe("Harbor Lights")
    })
})

describe("the series page fetch after the page named the title", () => {
    it("does not trade the page's name for the slug fallback", async () => {
        const slug = "tide-singer-7a8b9c0d"
        await seedTitle(slug, "Tide Singer of the North")
        sources.resolveMangaMetadata.mockResolvedValue({ title: "Tide Singer" })

        await refreshExternalMangaMetadata(
            SOURCE_ID,
            { sourceMangaId: slug, mangaUrl: `${ORIGIN}/comics/${slug}/` },
            mangaIdOf(slug)
        )

        expect((await db.manga.get(mangaIdOf(slug)))?.title).toBe("Tide Singer of the North")
    })

    it("still fills a real series-page name over a placeholder", async () => {
        const slug = "tide-singer-8b9c0d1e"
        await seedTitle(slug, "tide singer 8b9c0d1e")
        sources.resolveMangaMetadata.mockResolvedValue({ title: "Tide Singer of the North" })

        await refreshExternalMangaMetadata(
            SOURCE_ID,
            { sourceMangaId: slug, mangaUrl: `${ORIGIN}/comics/${slug}/` },
            mangaIdOf(slug)
        )

        expect((await db.manga.get(mangaIdOf(slug)))?.title).toBe("Tide Singer of the North")
    })
})
