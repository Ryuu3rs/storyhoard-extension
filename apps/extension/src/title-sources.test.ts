import "fake-indexeddb/auto"
import { sourceRegistry } from "@amr/sources"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChapterRecord } from "@amr/contracts"
import type { HandlerContext } from "./background/handler-types"
import { runtimeRequestSchema } from "./runtime"

vi.stubGlobal("browser", fakeBrowser)

const known = new Set(["alpha", "beta"])
const sourcesMock = vi.hoisted(() => ({
    findSource: vi.fn(),
    getSourceById: vi.fn(),
    listChaptersForSource: vi.fn(),
    resolveChapterUrl: vi.fn(),
    resolveMangaUrl: vi.fn()
}))
vi.mock("./sources", async () => {
    const actual = await vi.importActual<typeof import("./sources")>("./sources")
    return { ...actual, ...sourcesMock }
})
vi.mock("./live", () => ({ publishLive: vi.fn() }))
vi.mock("./diag-log", () => ({ diag: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock("./background/chapter-cache", () => ({ scheduleChapterListRefresh: vi.fn() }))
vi.mock("./settings", () => ({ getSettings: vi.fn().mockResolvedValue({ language: "en" }) }))

const { db, listBackups } = await import("./database")
import type { LibraryManga, VersionRecord } from "./database"
const { listTitleSources, setPreferredSource, removeTitleVersion, linkAnotherSite, previewChange, isUnresolvedTitle } =
    await import("./title-sources")
const { titleSourcesHandlers } = await import("./handlers/title-sources")
const { rankWorkVersions } = await import("./work-ranking")
const { beginUserSourcesInit } = await import("./background/user-sources-ready")

const ctx: HandlerContext = { sender: {} as HandlerContext["sender"] }

const adapterStub = (id: string) =>
    ({ manifest: { id, name: id, domains: [`${id}.example`], capabilities: ["chapters"] } }) as unknown as ReturnType<
        typeof sourceRegistry.list
    >[number]

function title(over: Partial<LibraryManga> = {}): LibraryManga {
    return {
        id: "m1",
        sourceId: "alpha",
        sourceMangaId: "a1",
        sourceUrl: "https://alpha.example/a1/ch-10",
        mangaUrl: "https://alpha.example/a1",
        title: "Moon Garden",
        normalizedTitle: "moon garden",
        authors: [],
        status: "ongoing",
        addedAt: 1,
        updatedAt: 1,
        latestChapterNumber: 10,
        lastReadChapterNumber: 5,
        rating: 4,
        ...over
    }
}

function version(over: Partial<VersionRecord> & { sourceId: string; sourceMangaId: string }): VersionRecord {
    return {
        id: `${over.sourceId}:${over.sourceMangaId}`,
        workKey: "title:moon garden",
        url: `https://${over.sourceId}.example/${over.sourceMangaId}`,
        languages: ["en"],
        health: "unknown",
        numberingKind: "chapter",
        lastSeenAt: 1,
        observedVia: "mirror-check",
        ...over
    }
}

function chapters(sourceId: string, numbers: number[]): ChapterRecord[] {
    return numbers.map(n => ({
        id: `${sourceId}:ch:${n}`,
        mangaId: "m1",
        sourceId,
        title: `Chapter ${n}`,
        url: `https://${sourceId}.example/ch-${n}`,
        sortKey: n
    })) as ChapterRecord[]
}

const BETA = { sourceId: "beta", sourceMangaId: "b1", mangaUrl: "https://beta.example/b1" }

async function seed() {
    await db.manga.put(title())
    await db.sourceLinks.put({
        mangaId: "m1",
        sourceId: "alpha",
        sourceMangaId: "a1",
        url: "https://alpha.example/a1",
        addedAt: 1,
        updatedAt: 1
    })
    await db.chapters.bulkPut(chapters("alpha", [1, 2, 3, 4, 5, 10]))
}

async function snapshot() {
    return JSON.stringify([
        await db.manga.toArray(),
        await db.chapters.toArray(),
        await db.versions.toArray(),
        await db.backups.toArray()
    ])
}

beforeEach(async () => {
    fakeBrowser.reset()
    vi.clearAllMocks()
    sourcesMock.getSourceById.mockImplementation((id: string) => (known.has(id) ? { manifest: { id } } : undefined))
    vi.spyOn(sourceRegistry, "list").mockReturnValue([adapterStub("alpha"), adapterStub("beta")])
    beginUserSourcesInit(async () => undefined)
    await Promise.all([
        db.manga.clear(),
        db.sourceLinks.clear(),
        db.chapters.clear(),
        db.versions.clear(),
        db.workOverrides.clear(),
        db.sourcePrefs.clear(),
        db.backups.clear(),
        db.progress.clear(),
        db.historyEvents.clear()
    ])
})

describe("title sources list", () => {
    it("lists the main source and every known version of the work with neutral labels", async () => {
        await seed()
        await db.versions.bulkPut([
            version({ sourceId: "beta", sourceMangaId: "b1", latestChapterNumber: 12, isOfficialAtObservation: true }),
            version({ sourceId: "other", sourceMangaId: "x", workKey: "title:something else" })
        ])
        const result = await listTitleSources("m1")
        expect(result.rows.map(r => [r.sourceId, r.isMain])).toEqual([
            ["alpha", true],
            ["beta", false]
        ])
        for (const row of result.rows) expect(row.label).toMatch(/^Source \d+$/)
        const beta = result.rows.find(r => r.sourceId === "beta")!
        expect(beta.official).toBe(true)
        expect(beta.latestChapterNumber).toBe(12)
        expect(result.rows[0]!.latestChapterNumber).toBe(10)
    })

    it("shows a version whose adapter is gone as needing a relink", async () => {
        await seed()
        await db.versions.put(version({ sourceId: "gone", sourceMangaId: "g1" }))
        const rows = (await listTitleSources("m1")).rows
        expect(rows.find(r => r.sourceId === "gone")!.needsRelink).toBe(true)
        expect(rows.find(r => r.isMain)!.needsRelink).toBe(false)
    })
})

describe("unresolved detection", () => {
    it("flags a gone adapter or a missing source link, but not a followed (detected) site", () => {
        expect(isUnresolvedTitle({ sourceId: "alpha" }, true)).toBe(false)
        expect(isUnresolvedTitle({ sourceId: "alpha" }, false)).toBe(true)
        expect(isUnresolvedTitle({ sourceId: "gone" }, true)).toBe(true)
        expect(isUnresolvedTitle({ sourceId: "detected:site.example" }, false)).toBe(false)
    })

    it("title:unresolved lists such titles with only an http(s) reopen address", async () => {
        await db.manga.bulkPut([
            title(),
            title({ id: "m2", sourceId: "gone", mangaUrl: "https://old.example/s/1", title: "Two" }),
            title({ id: "m3", sourceId: "gone", mangaUrl: "javascript:alert(1)", sourceUrl: "data:x", title: "Three" })
        ])
        await db.sourceLinks.put({
            mangaId: "m1",
            sourceId: "alpha",
            url: "https://alpha.example/a1",
            addedAt: 1,
            updatedAt: 1
        })
        const list = (await titleSourcesHandlers["title:unresolved"]!({ type: "title:unresolved" }, ctx)) as Array<{
            mangaId: string
            reopenUrl?: string
        }>
        expect(list).toEqual([{ mangaId: "m2", reopenUrl: "https://old.example/s/1" }, { mangaId: "m3" }])
    })
})

describe("prefer for this title", () => {
    it("writes the pin, shows it, is honoured by the ranker, and can be cleared", async () => {
        await seed()
        await db.versions.put(version({ sourceId: "beta", sourceMangaId: "b1", latestChapterNumber: 99 }))
        const pinned = await setPreferredSource("m1", "alpha")
        expect(pinned.preferredSourceId).toBe("alpha")
        expect(pinned.rows.find(r => r.sourceId === "alpha")!.isPreferred).toBe(true)

        const overrides = await db.workOverrides.toArray()
        expect(overrides).toHaveLength(1)
        expect(overrides[0]!.preferredSourceId).toBe("alpha")
        const versions = [
            ...(await db.versions.toArray()),
            version({ sourceId: "alpha", sourceMangaId: "a1", latestChapterNumber: 10 })
        ]
        const rankCtx = { preferredLanguages: new Set<string>(), now: Date.now(), lastReadNumber: 5 }
        expect(rankWorkVersions(versions, rankCtx, undefined, []).best?.sourceId).toBe("beta")
        expect(rankWorkVersions(versions, rankCtx, overrides[0]!.preferredSourceId, []).best?.sourceId).toBe("alpha")

        const cleared = await setPreferredSource("m1", null)
        expect(cleared.preferredSourceId).toBeUndefined()
        expect(await db.workOverrides.count()).toBe(0)
    })

    it("refuses a source the title does not have", async () => {
        await seed()
        await expect(setPreferredSource("m1", "beta")).rejects.toThrow("not one of this title's sources")
    })
})

describe("remove a version", () => {
    it("deletes only that version record, never the main source", async () => {
        await seed()
        await db.versions.put(version({ sourceId: "beta", sourceMangaId: "b1" }))
        const after = await removeTitleVersion("m1", "beta:b1")
        expect(after.rows.map(r => r.sourceId)).toEqual(["alpha"])
        expect(await db.versions.get("beta:b1")).toBeUndefined()
        expect(await db.manga.get("m1")).toBeDefined()
        await expect(removeTitleVersion("m1", "alpha:a1")).rejects.toThrow("main source cannot be removed")
        await expect(removeTitleVersion("m1", "nope:1")).rejects.toThrow("not listed")
    })
})

describe("link another site", () => {
    it("rejects a non-http address, an unreadable site and the main source", async () => {
        await seed()
        await expect(linkAnotherSite("m1", "javascript:alert(1)")).rejects.toThrow("http://")
        await expect(linkAnotherSite("m1", "ftp://x.example/s")).rejects.toThrow("http://")
        sourcesMock.findSource.mockReturnValue(undefined)
        await expect(linkAnotherSite("m1", "https://detected.example/series/x")).rejects.toThrow(
            "extension cannot read that site"
        )
        sourcesMock.findSource.mockReturnValue({ manifest: { id: "alpha" }, match: () => "manga" })
        sourcesMock.resolveMangaUrl.mockResolvedValue("a1")
        await expect(linkAnotherSite("m1", "https://alpha.example/a1")).rejects.toThrow("already this title's main")
    })

    it("records a series address on another site as a version of the work", async () => {
        await seed()
        sourcesMock.findSource.mockReturnValue({ manifest: { id: "beta" }, match: () => "manga" })
        sourcesMock.resolveMangaUrl.mockResolvedValue("b9")
        const result = await linkAnotherSite("m1", "https://beta.example/series/b9")
        expect(result.rows.map(r => [r.sourceId, r.sourceMangaId, r.isMain])).toContainEqual(["beta", "b9", false])
        expect((await db.versions.get("beta:b9"))?.workKey).toBe("title:moon garden")
    })

    it("resolves a chapter address to its series", async () => {
        await seed()
        sourcesMock.findSource.mockReturnValue({ manifest: { id: "beta" }, match: () => "chapter" })
        sourcesMock.resolveChapterUrl.mockResolvedValue({
            manga: { sourceId: "beta", sourceMangaId: "b7", url: "https://beta.example/series/b7" },
            chapter: {}
        })
        await linkAnotherSite("m1", "https://beta.example/series/b7/ch-3")
        expect(await db.versions.get("beta:b7")).toBeDefined()
    })
})

describe("change preview", () => {
    it("returns counts and progress mapping and writes nothing", async () => {
        await seed()
        sourcesMock.listChaptersForSource.mockResolvedValue(chapters("beta", [1, 2, 3, 4, 5, 6, 7, 8]))
        const before = await snapshot()
        const preview = await previewChange("m1", BETA)
        expect(preview).toMatchObject({
            chapterCount: 8,
            latestChapterNumber: 8,
            currentLatestChapterNumber: 10,
            readChapterNumber: 5,
            progressMapped: true,
            behindProgress: false
        })
        expect(preview.currentLabel).toMatch(/^Source \d+$/)
        expect(preview.newLabel).toMatch(/^Source \d+$/)
        expect(await snapshot()).toBe(before)
    })

    it("warns when the read chapter cannot be mapped", async () => {
        await seed()
        sourcesMock.listChaptersForSource.mockResolvedValue(chapters("beta", [20, 21, 22]))
        expect((await previewChange("m1", BETA)).progressMapped).toBe(false)
    })

    it("flags a new source that is behind the user's progress", async () => {
        await seed()
        sourcesMock.listChaptersForSource.mockResolvedValue(chapters("beta", [1, 2, 3]))
        const preview = await previewChange("m1", BETA)
        expect(preview.behindProgress).toBe(true)
        expect(preview.progressMapped).toBe(true)
    })

    it("still answers when the chapter list cannot be read", async () => {
        await seed()
        sourcesMock.listChaptersForSource.mockRejectedValue(new Error("Request failed with status 403"))
        const preview = await previewChange("m1", BETA)
        expect(preview.chapterCount).toBeNull()
        expect(preview.previewError).toBeTruthy()
    })

    it("refuses a source the extension cannot read", async () => {
        await seed()
        await expect(
            previewChange("m1", { sourceId: "gone", sourceMangaId: "g", mangaUrl: "https://gone.example/g" })
        ).rejects.toThrow("cannot read that site")
    })
})

describe("make main and undo", () => {
    const switchTo = () => ({ type: "title:source-change" as const, mangaId: "m1", ...BETA })

    it("switches the source keeping progress, keeps the old source as a version, and takes a restore point", async () => {
        await seed()
        sourcesMock.listChaptersForSource.mockResolvedValue(chapters("beta", [1, 2, 3, 4, 5, 6, 7, 8]))
        const out = (await titleSourcesHandlers["title:source-change"]!(switchTo(), ctx)) as { backupId: number }
        const row = await db.manga.get("m1")
        expect(row).toMatchObject({ sourceId: "beta", sourceMangaId: "b1", lastReadChapterNumber: 5, rating: 4 })
        expect(row?.lastReadChapterId).toBe("beta:ch:5")
        const backups = await listBackups()
        expect(backups.map(b => b.reason)).toContain("pre-source-change")
        expect(backups.some(b => b.id === out.backupId)).toBe(true)
        const rows = (await listTitleSources("m1")).rows
        expect(rows.map(r => [r.sourceId, r.isMain])).toEqual([
            ["beta", true],
            ["alpha", false]
        ])
    })

    it("undo puts the title back on its old source and chapter list without touching other titles", async () => {
        await seed()
        await db.manga.put(title({ id: "other", title: "Other", normalizedTitle: "other", rating: 1 }))
        sourcesMock.listChaptersForSource.mockResolvedValue(chapters("beta", [1, 2, 3, 4, 5, 6, 7, 8]))
        const out = (await titleSourcesHandlers["title:source-change"]!(switchTo(), ctx)) as { backupId: number }
        await db.manga.update("other", { rating: 5 })
        expect((await db.manga.get("m1"))?.sourceId).toBe("beta")

        await titleSourcesHandlers["title:source-undo"]!(
            { type: "title:source-undo", mangaId: "m1", backupId: out.backupId },
            ctx
        )
        const restored = await db.manga.get("m1")
        expect(restored).toMatchObject({ sourceId: "alpha", sourceMangaId: "a1", lastReadChapterNumber: 5 })
        expect((await db.sourceLinks.get("m1"))?.sourceId).toBe("alpha")
        const sourceIds = (await db.chapters.where("mangaId").equals("m1").toArray()).map(c => c.sourceId)
        expect(new Set(sourceIds)).toEqual(new Set(["alpha"]))
        expect((await db.manga.get("other"))?.rating).toBe(5)
    })

    it("fails clearly when the restore point is gone", async () => {
        await seed()
        await expect(
            titleSourcesHandlers["title:source-undo"]!(
                { type: "title:source-undo", mangaId: "m1", backupId: 9999 },
                ctx
            )
        ).rejects.toThrow("no longer available")
    })
})

describe("message schemas", () => {
    it("accept the new messages and reject malformed ones", () => {
        const parse = (v: unknown) => runtimeRequestSchema.safeParse(v).success
        expect(parse({ type: "title:sources", mangaId: "m1" })).toBe(true)
        expect(parse({ type: "title:source-prefer", mangaId: "m1", sourceId: null })).toBe(true)
        expect(parse({ type: "title:source-prefer", mangaId: "", sourceId: "a" })).toBe(false)
        expect(
            parse({ type: "title:source-change", mangaId: "m1", sourceId: "a", sourceMangaId: "1", mangaUrl: "nope" })
        ).toBe(false)
        expect(parse({ type: "title:source-undo", mangaId: "m1", backupId: -1 })).toBe(false)
    })
})
