import "fake-indexeddb/auto"
import type { ChapterRecord, SourceLinkRecord } from "@amr/contracts"
import { sourceRegistry } from "@amr/sources"
import { fakeBrowser } from "wxt/testing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LibraryManga } from "../database"

// P4b safety gate for the one-time bundled-source migration seed. Each test pins one clause of the
// "additive-only, reversible, guarded" contract on a realistic library, against fake-indexeddb:
//   1. db.manga row count unchanged            4. re-run is a no-op (flag + per-id guard)
//   2. every row resolves or is tracking-only  5. the user's own archProfiles row is never overwritten
//   3. lastRead*/workId byte-identical         6. rollback-safe: rows read fine with archProfiles ignored
// The seed is wired in background.ts (onInstalled/onStartup), never in a Dexie .upgrade().

vi.stubGlobal("browser", fakeBrowser)

const { db } = await import("../database")
const { getSourceById } = await import("../sources")
const { MIGRATED_SOURCES_FLAG, registerSeededSources, rollbackSourceMigrationSeed, runSourceMigrationSeed } =
    await import("../migration/seed-register")

const OWN_PROFILE_MARKER = { userOwned: true, note: "captured by the user, must survive" }

function manga(id: string, sourceId: string, extra: Partial<LibraryManga> = {}): LibraryManga {
    return {
        id,
        title: `Title ${id}`,
        normalizedTitle: `title ${id}`,
        authors: [],
        status: "ongoing",
        addedAt: 1_600_000_000_000,
        updatedAt: 1_600_000_000_000,
        sourceId,
        sourceUrl: `https://example.test/${id}`,
        sourceMangaId: id,
        ...extra
    }
}

function link(mangaId: string, sourceId: string): SourceLinkRecord {
    return {
        mangaId,
        sourceId,
        sourceMangaId: mangaId,
        url: `https://example.test/${mangaId}`,
        addedAt: 1_600_000_000_000,
        updatedAt: 1_600_000_000_000
    }
}

function chapter(mangaId: string, sourceId: string, n: number): ChapterRecord {
    return {
        id: `${sourceId}:ch:${mangaId}:${n}`,
        mangaId,
        sourceId,
        title: `Ch.${n}`,
        url: `https://example.test/${mangaId}/${n}`,
        sortKey: n
    }
}

// A library with every interesting shape: Madara + MangaStream rows (list-capable seed), bespoke
// recognition-only rows, a Tier-1 official source, and a source id the seed knows nothing about.
const LIBRARY: Array<{ row: LibraryManga; sourceId: string }> = [
    {
        sourceId: "mangasushi",
        row: manga("m-sushi", "mangasushi", {
            lastReadChapterId: "mangasushi:chapter:m-sushi:chapter-7",
            lastReadChapterNumber: 7,
            lastReadAt: 1_700_000_000_123,
            workId: "work-aaa",
            latestChapterNumber: 9
        })
    },
    {
        sourceId: "tritinia",
        row: manga("m-trit", "tritinia", {
            lastReadChapterId: "tritinia:chapter:m-trit:ch-2",
            lastReadChapterNumber: 2.5,
            lastReadAt: 1_700_000_000_456,
            workId: "work-bbb"
        })
    },
    {
        sourceId: "thunderscans",
        row: manga("m-thunder", "thunderscans", { lastReadChapterNumber: 41, lastReadAt: 1_700_000_000_789 })
    },
    {
        sourceId: "kagane",
        row: manga("m-kagane", "kagane", {
            lastReadChapterId: "kagane:chapter:abc",
            lastReadChapterNumber: 0,
            lastReadAt: 1_700_000_001_000,
            workId: "work-ccc"
        })
    },
    { sourceId: "roliascan", row: manga("m-rolia", "roliascan", { lastReadChapterNumber: 120 }) },
    { sourceId: "mangadex", row: manga("m-dex", "mangadex", { lastReadChapterNumber: 3, workId: "work-ddd" }) },
    { sourceId: "webtoons", row: manga("m-toons", "webtoons", { lastReadChapterNumber: 11 }) },
    // A source the seed has never heard of (an already-retired adapter): stays tracking-only.
    {
        sourceId: "long-gone-scans",
        row: manga("m-gone", "long-gone-scans", {
            lastReadChapterId: "long-gone-scans:chapter:5",
            lastReadChapterNumber: 5,
            lastReadAt: 1_699_000_000_000,
            workId: "work-eee"
        })
    }
]

async function loadLibrary(): Promise<void> {
    await db.manga.bulkPut(LIBRARY.map(l => l.row))
    await db.sourceLinks.bulkPut(LIBRARY.map(l => link(l.row.id, l.sourceId)))
    await db.chapters.bulkPut(LIBRARY.map(l => chapter(l.row.id, l.sourceId, 1)))
}

// Every table except archProfiles, serialised, so "nothing but archProfiles changed" is one equality.
async function snapshotEverythingButArchProfiles(): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const table of db.tables) {
        if (table.name === "archProfiles") continue
        out[table.name] = JSON.stringify(await table.toArray())
    }
    return out
}

async function seededIds(): Promise<string[]> {
    return (await db.archProfiles.toArray()).map(r => r.id).sort()
}

const originalAdapters = sourceRegistry.list()

beforeEach(async () => {
    await Promise.all(db.tables.map(t => t.clear()))
    await fakeBrowser.storage.local.clear()
    for (const adapter of originalAdapters) sourceRegistry.upsert(adapter)
})

afterEach(() => {
    vi.restoreAllMocks()
    for (const adapter of originalAdapters) sourceRegistry.upsert(adapter)
})

describe("migration seed safety (P4b)", () => {
    it("1. db.manga row count is unchanged and no other table is touched", async () => {
        await loadLibrary()
        const beforeCount = await db.manga.count()
        const before = await snapshotEverythingButArchProfiles()

        await runSourceMigrationSeed()

        expect(await db.manga.count()).toBe(beforeCount)
        expect(await db.manga.count()).toBe(LIBRARY.length)
        expect(await snapshotEverythingButArchProfiles()).toEqual(before)
    })

    it("seeds only the sources in THIS library, never Tier-1 official sources, never unknown ids", async () => {
        await loadLibrary()
        const result = await runSourceMigrationSeed()

        const expected = ["kagane", "mangasushi", "roliascan", "thunderscans", "tritinia"]
        expect(result.seeded.slice().sort()).toEqual(expected)
        expect(await seededIds()).toEqual(expected)
        // Not in this library -> not seeded, even though the seed knows them.
        expect(await db.archProfiles.get("asurascans")).toBeUndefined()
        expect(await db.archProfiles.get("fanfox")).toBeUndefined()
        // Tier-1 official sources stay bundled for good.
        expect(await db.archProfiles.get("mangadex")).toBeUndefined()
        expect(await db.archProfiles.get("webtoons")).toBeUndefined()
        // Unknown to the seed.
        expect(await db.archProfiles.get("long-gone-scans")).toBeUndefined()
    })

    it("marks every row it writes as a seed row, so it is never listed or removable as a user-added site", async () => {
        await loadLibrary()
        await runSourceMigrationSeed()

        const rows = await db.archProfiles.toArray()
        expect(rows.length).toBeGreaterThan(0)
        expect(rows.every(r => r.origin === "seed")).toBe(true)
    })

    it("2. every row resolves, or is tracking-only - never deleted (also after the adapters are removed)", async () => {
        await loadLibrary()
        await runSourceMigrationSeed()

        const ids = LIBRARY.map(l => l.row.id).sort()
        expect((await db.manga.toArray()).map(r => r.id).sort()).toEqual(ids)
        const bundled = new Map(LIBRARY.map(l => [l.sourceId, getSourceById(l.sourceId)]))
        // Today every seeded id still resolves through its bundled adapter (nothing displaced).
        for (const id of ["mangasushi", "tritinia", "thunderscans", "kagane", "roliascan", "mangadex", "webtoons"]) {
            expect(getSourceById(id), id).toBe(bundled.get(id))
            expect(getSourceById(id), id).toBeDefined()
        }
        expect(getSourceById("long-gone-scans")).toBeUndefined()

        // Simulate the LATER release: the bundled scraper adapters are gone.
        const removable = ["mangasushi", "tritinia", "thunderscans", "kagane", "roliascan"]
        for (const id of removable) expect(sourceRegistry.unregister(id)).toBe(true)
        for (const id of removable) expect(getSourceById(id), `${id} unresolved before register`).toBeUndefined()

        await registerSeededSources()

        for (const id of removable) {
            const adapter = getSourceById(id)
            expect(adapter, `${id} resolves via its seeded profile`).toBeDefined()
            expect(adapter!.manifest.id).toBe(id)
        }
        // A seeded recognition-only source lists nothing (tracking-only) but still recognises its URLs.
        const kagane = getSourceById("kagane")!
        expect(kagane.match(new URL("https://kagane.to/series/0b6c7a1e-1c3d-4e5f-8a9b-0c1d2e3f4a5b"))).toBe("manga")
        // A source nobody seeded stays unresolved: tracking-only, and its row is still there.
        expect(getSourceById("long-gone-scans")).toBeUndefined()
        expect(await db.manga.get("m-gone")).toBeDefined()
        expect((await db.manga.toArray()).map(r => r.id).sort()).toEqual(ids)
    })

    it("3. lastReadChapterId/Number, lastReadAt and workId are byte-identical before and after", async () => {
        await loadLibrary()
        const before = new Map((await db.manga.toArray()).map(r => [r.id, JSON.stringify(r)]))

        await runSourceMigrationSeed()
        // ... and after a (simulated) adapter removal + register pass.
        sourceRegistry.unregister("mangasushi")
        await registerSeededSources()

        for (const row of await db.manga.toArray()) {
            expect(JSON.stringify(row), row.id).toBe(before.get(row.id))
            const original = LIBRARY.find(l => l.row.id === row.id)!.row
            expect(row.lastReadChapterId).toBe(original.lastReadChapterId)
            expect(Object.is(row.lastReadChapterNumber, original.lastReadChapterNumber)).toBe(true)
            expect(Object.is(row.lastReadAt, original.lastReadAt)).toBe(true)
            expect(row.workId).toBe(original.workId)
        }
    })

    it("4. re-running is a no-op: flag set, rows byte-identical, nothing re-written", async () => {
        await loadLibrary()
        const first = await runSourceMigrationSeed()
        expect(first.alreadyDone).toBe(false)
        const flag = (await fakeBrowser.storage.local.get(MIGRATED_SOURCES_FLAG))[MIGRATED_SOURCES_FLAG]
        expect(flag).toBeDefined()
        const rowsAfterFirst = JSON.stringify(await db.archProfiles.toArray())

        const putSpy = vi.spyOn(db.archProfiles, "put")
        const second = await runSourceMigrationSeed()
        expect(second).toEqual({ seeded: [], alreadyDone: true })
        expect(putSpy).not.toHaveBeenCalled()
        expect(JSON.stringify(await db.archProfiles.toArray())).toBe(rowsAfterFirst)
        expect((await fakeBrowser.storage.local.get(MIGRATED_SOURCES_FLAG))[MIGRATED_SOURCES_FLAG]).toEqual(flag)

        // Even with the flag lost (cleared storage), the per-id "only if no archProfiles row" guard
        // makes the retry write nothing.
        await fakeBrowser.storage.local.remove(MIGRATED_SOURCES_FLAG)
        const third = await runSourceMigrationSeed()
        expect(third.seeded).toEqual([])
        expect(putSpy).not.toHaveBeenCalled()
        expect(JSON.stringify(await db.archProfiles.toArray())).toBe(rowsAfterFirst)
    })

    it("5. a user's OWN archProfiles row is never overwritten by the seed", async () => {
        await loadLibrary()
        await db.archProfiles.put({ id: "mangasushi", profile: OWN_PROFILE_MARKER, importedAt: 42 })
        // Even a corrupt/garbage row of the user's is theirs and is left alone.
        await db.archProfiles.put({ id: "tritinia", profile: "not-a-profile", importedAt: 43 })

        const result = await runSourceMigrationSeed()

        expect(await db.archProfiles.get("mangasushi")).toEqual({
            id: "mangasushi",
            profile: OWN_PROFILE_MARKER,
            importedAt: 42
        })
        expect(await db.archProfiles.get("tritinia")).toEqual({
            id: "tritinia",
            profile: "not-a-profile",
            importedAt: 43
        })
        expect(result.seeded).not.toContain("mangasushi")
        expect(result.seeded).not.toContain("tritinia")
        expect(result.seeded.slice().sort()).toEqual(["kagane", "roliascan", "thunderscans"])
        // The recorded flag never claims ownership of a row it did not write.
        const flag = (await fakeBrowser.storage.local.get(MIGRATED_SOURCES_FLAG))[MIGRATED_SOURCES_FLAG] as {
            seeded: string[]
        }
        expect(flag.seeded).not.toContain("mangasushi")
    })

    it("6. rollback-safe: every row reads identically with archProfiles ignored, cleared, or rolled back", async () => {
        await loadLibrary()
        const before = await snapshotEverythingButArchProfiles()

        await runSourceMigrationSeed()
        expect(await snapshotEverythingButArchProfiles()).toEqual(before)

        // An older build that does not know archProfiles simply never reads it.
        await db.archProfiles.clear()
        expect(await snapshotEverythingButArchProfiles()).toEqual(before)
        expect(await db.manga.count()).toBe(LIBRARY.length)
    })

    it("rollbackSourceMigrationSeed removes exactly the rows the seed wrote and keeps a user's replacement", async () => {
        await loadLibrary()
        await runSourceMigrationSeed()
        // The user later replaces one seeded profile with their own: it must survive a rollback.
        await db.archProfiles.put({ id: "kagane", profile: OWN_PROFILE_MARKER, importedAt: 99 })
        const before = await snapshotEverythingButArchProfiles()

        const { removed, kept } = await rollbackSourceMigrationSeed()

        expect(removed.slice().sort()).toEqual(["mangasushi", "roliascan", "thunderscans", "tritinia"])
        expect(kept).toEqual(["kagane"])
        expect(await seededIds()).toEqual(["kagane"])
        expect((await fakeBrowser.storage.local.get(MIGRATED_SOURCES_FLAG))[MIGRATED_SOURCES_FLAG]).toBeUndefined()
        expect(await snapshotEverythingButArchProfiles()).toEqual(before)
    })

    it("an empty library seeds nothing and leaves the flag unset, so rows added later are still seeded", async () => {
        const first = await runSourceMigrationSeed()
        expect(first.seeded).toEqual([])
        expect((await fakeBrowser.storage.local.get(MIGRATED_SOURCES_FLAG))[MIGRATED_SOURCES_FLAG]).toBeUndefined()

        await loadLibrary()
        const second = await runSourceMigrationSeed()
        expect(second.seeded.length).toBeGreaterThan(0)
        expect((await fakeBrowser.storage.local.get(MIGRATED_SOURCES_FLAG))[MIGRATED_SOURCES_FLAG]).toBeDefined()
    })

    it("a write failure mid-run leaves the library untouched and the flag unset; the retry completes", async () => {
        await loadLibrary()
        const before = await snapshotEverythingButArchProfiles()
        vi.spyOn(db.archProfiles, "put").mockRejectedValueOnce(new Error("quota"))

        await expect(runSourceMigrationSeed()).rejects.toThrow("quota")
        expect((await fakeBrowser.storage.local.get(MIGRATED_SOURCES_FLAG))[MIGRATED_SOURCES_FLAG]).toBeUndefined()
        expect(await snapshotEverythingButArchProfiles()).toEqual(before)

        vi.restoreAllMocks()
        const retry = await runSourceMigrationSeed()
        expect(retry.alreadyDone).toBe(false)
        expect(await seededIds()).toEqual(["kagane", "mangasushi", "roliascan", "thunderscans", "tritinia"])
        expect(await snapshotEverythingButArchProfiles()).toEqual(before)
    })

    it("registration never displaces a bundled adapter", async () => {
        await loadLibrary()
        const bundled = getSourceById("mangasushi")
        await runSourceMigrationSeed()
        await registerSeededSources()
        expect(getSourceById("mangasushi")).toBe(bundled)
    })

    it("concurrent callers share one run (no double write)", async () => {
        await loadLibrary()
        const putSpy = vi.spyOn(db.archProfiles, "put")
        const [a, b] = await Promise.all([runSourceMigrationSeed(), runSourceMigrationSeed()])
        expect(a).toBe(b)
        expect(putSpy).toHaveBeenCalledTimes(5)
    })
})
