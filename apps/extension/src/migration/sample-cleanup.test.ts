import "fake-indexeddb/auto"
import { parseProfile } from "@amr/source-engine"
import { OFFICIAL_SOURCE_IDS } from "@amr/sources"
import seedJson from "@amr/sources/migration-seed.json"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createBackup, db, exportDatabase, linkMangaToUrl, putArchProfile, seedDatabase } from "../database"
import { sampleEntries } from "../lab/sample-library"

// 0.32.2 shipped the "Load samples" button in its store build, so real users can hold the sample library:
// manga rows "seed-*" with covers at "/sample-covers/*.jpg", plus the seed profile rows 0.32.2's seed-register
// wrote for every non-official sourceId they use. The store build ships neither the covers nor the button.
// Test files are not part of any build output, so the lab sample library and the real seed are the fixtures.
vi.mock("./seed-profiles", async importOriginal => ({
    ...(await importOriginal<typeof import("./seed-profiles")>()),
    loadSeedProfiles: () => new Map(),
    isCommittedSeedProfile: () => false,
    seedIsBundled: () => false
}))
vi.mock("../background/chapter-cache", () => ({ scheduleChapterListRefresh: vi.fn() }))
vi.mock("../settings", () => ({ getSettings: async () => ({ language: "en" }) }))
vi.mock("wxt/browser", () => ({ browser: { permissions: { contains: async () => false } } }))
const pullFromGistMock = vi.hoisted(() => vi.fn())
vi.mock("../sync", async importOriginal => ({
    ...(await importOriginal<typeof import("../sync")>()),
    pullFromGist: (...args: unknown[]) => pullFromGistMock(...args)
}))

const { initUserSources } = await import("../arch-sources")
const { runSourceMigrationSeed } = await import("./seed-register")
const { fixItHandlers } = await import("../handlers/fix-it")
const { isKeptSample, removeUntouchedSamples, SAMPLE_CLEANUP_FLAG } = await import("./sample-cleanup")
const { dataSyncSettingsHandlers } = await import("../handlers/data-sync-settings")
const { getTombstones, updateAccountProfile } = await import("../account")

const committedSeed = new Map(
    (seedJson as { profiles: unknown[] }).profiles
        .map(raw => parseProfile(raw))
        .flatMap(parsed => (parsed.ok ? [[parsed.profile.id, parsed.profile] as const] : []))
)
const sampleSourceIds = [...new Set(sampleEntries(0).map(entry => entry.sourceId))].filter(
    id => !OFFICIAL_SOURCE_IDS.includes(id)
)
const sampleIds = sampleEntries(0).map(entry => entry.manga.id)

let localStore: Record<string, unknown> = {}

beforeEach(async () => {
    await Promise.all([
        db.manga.clear(),
        db.sourceLinks.clear(),
        db.chapters.clear(),
        db.archProfiles.clear(),
        db.progress.clear(),
        db.historyEvents.clear(),
        db.workOverrides.clear(),
        db.backups.clear()
    ])
    localStore = {}
    vi.stubGlobal("browser", {
        permissions: { contains: vi.fn(async () => false), getAll: vi.fn(async () => ({ origins: [] })) },
        runtime: { getManifest: () => ({ host_permissions: [] }) },
        storage: {
            local: {
                get: vi.fn(async (key: string) => (key in localStore ? { [key]: localStore[key] } : {})),
                set: vi.fn(async (items: Record<string, unknown>) => {
                    localStore = { ...localStore, ...items }
                }),
                remove: vi.fn(async (keys: string | string[]) => {
                    for (const key of [keys].flat()) delete localStore[key]
                })
            }
        }
    })
    vi.spyOn(console, "warn").mockImplementation(() => undefined)

    await seedDatabase(sampleEntries(Date.now()))
    for (const id of sampleSourceIds) {
        const profile = committedSeed.get(id)
        if (profile) await putArchProfile(id, profile, "seed")
    }
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

// The update path: pre-update backup, sample cleanup, then the seed run and registration.
async function upgrade(backedUp = true): Promise<void> {
    await removeUntouchedSamples({ backedUp })
    await runSourceMigrationSeed()
    await initUserSources()
}

const sampleSiteOverview = async () =>
    (await fixItHandlers["fixit:overview"]!(
        { type: "fixit:overview", sourceIds: sampleSourceIds } as never,
        {} as never
    )) as { sites: Array<{ sourceId: string; canTurnOn: boolean }> }

const realTitle = {
    id: "real-site:manga:demo",
    title: "Demo",
    normalizedTitle: "demo",
    authors: [],
    status: "ongoing" as const,
    sourceId: "real-site",
    sourceUrl: "https://real-site.example/manga/demo/ch-1",
    mangaUrl: "https://real-site.example/manga/demo",
    coverUrl: "/sample-covers/not-a-sample.jpg",
    addedAt: 1,
    updatedAt: 1
}

describe("the 0.32.2 sample library on the first update to the store build", () => {
    it("leaves no library row pointing at a /sample-covers/ asset the store build no longer ships", async () => {
        await upgrade()
        const broken = (await db.manga.toArray()).filter(
            m => m.id.startsWith("seed-") && m.coverUrl?.startsWith("/sample-covers/")
        )
        expect(broken.map(m => m.id)).toEqual([])
    })

    it("removes untouched samples with their chapters, links and the seed rows only they used", async () => {
        await upgrade()
        expect(await db.manga.bulkGet(sampleIds)).toEqual(sampleIds.map(() => undefined))
        expect(await db.chapters.where("mangaId").anyOf(sampleIds).count()).toBe(0)
        expect(await db.sourceLinks.where("mangaId").anyOf(sampleIds).count()).toBe(0)
        expect(await db.archProfiles.bulkGet(sampleSourceIds)).toEqual(sampleSourceIds.map(() => undefined))
    })

    it("does not offer to turn on host access for sites the user only has because of the lab samples", async () => {
        await upgrade()
        expect((await sampleSiteOverview()).sites.filter(site => site.canTurnOn).length).toBe(0)
    })

    it("keeps a sample the user read, clears its sample cover, and keeps the seed row it uses", async () => {
        const read = sampleEntries(0).find(entry => !OFFICIAL_SOURCE_IDS.includes(entry.sourceId))!
        await db.progress.put({
            chapterId: read.manga.latestChapterId!,
            mangaId: read.manga.id,
            updatedAt: 5,
            completed: true
        } as never)
        await upgrade()
        const kept = await db.manga.get(read.manga.id)
        expect(kept).toBeDefined()
        expect(kept!.coverUrl).toBeUndefined()
        expect(await db.chapters.where("mangaId").equals(read.manga.id).count()).toBe(1)
        expect(await db.archProfiles.get(read.sourceId)).toBeDefined()
    })

    it.each([
        [
            "history",
            async (id: string) =>
                void (await db.historyEvents.add({
                    mangaId: id,
                    chapterId: `${id}-ch`,
                    type: "started",
                    occurredAt: 1
                }))
        ],
        ["a rating", async (id: string) => void (await db.manga.update(id, { rating: 4 }))],
        ["notes", async (id: string) => void (await db.manga.update(id, { notes: "mine" }))],
        ["a reading status", async (id: string) => void (await db.manga.update(id, { readingStatus: "planning" }))],
        ["categories", async (id: string) => void (await db.manga.update(id, { categories: ["fav"] }))]
    ])("keeps a sample with %s", async (_name, touch) => {
        const id = sampleIds[0]!
        await touch(id)
        await upgrade()
        expect(await db.manga.get(id)).toBeDefined()
    })

    it("never touches a non-sample row, even one with a sample-looking cover", async () => {
        await db.manga.put(realTitle)
        await upgrade()
        expect(await db.manga.get(realTitle.id)).toEqual(realTitle)
    })

    it("runs once: a later run changes nothing", async () => {
        await upgrade()
        expect(localStore[SAMPLE_CLEANUP_FLAG]).toBeDefined()
        await seedDatabase(sampleEntries(Date.now()))
        expect(await removeUntouchedSamples({ backedUp: true })).toBeUndefined()
        expect(await db.manga.count()).toBe(sampleIds.length)
    })

    it("takes a backup first when the pre-update one failed, and removes nothing when that fails too", async () => {
        const backup = vi.fn(async () => {
            throw new Error("disk full")
        })
        expect(await removeUntouchedSamples({ backedUp: false, backup })).toBeUndefined()
        expect(backup).toHaveBeenCalledTimes(1)
        expect(await db.manga.count()).toBe(sampleIds.length)
        expect(localStore[SAMPLE_CLEANUP_FLAG]).toBeUndefined()

        const working = vi.fn(async () => 1)
        const result = await removeUntouchedSamples({ backedUp: false, backup: working })
        expect(working).toHaveBeenCalledTimes(1)
        expect(result?.removed.length).toBe(sampleIds.length)
    })
})

describe("samples a restore, import or pull brings back after the cleanup", () => {
    const readSample = () => sampleEntries(0).find(entry => !OFFICIAL_SOURCE_IDS.includes(entry.sourceId))!

    async function readOneSampleThenUpgrade(): Promise<string> {
        const read = readSample()
        await db.progress.put({
            chapterId: read.manga.latestChapterId!,
            mangaId: read.manga.id,
            pageIndex: 0,
            pageCount: 1,
            updatedAt: 5,
            completed: true
        })
        await db.manga.update(read.manga.id, { notes: "mine" })
        return read.manga.id
    }

    async function expectSamplesCleaned(readId: string): Promise<void> {
        const rows = await db.manga.toArray()
        expect(rows.filter(m => m.id.startsWith("seed-") && m.coverUrl?.startsWith("/sample-covers/"))).toEqual([])
        expect(rows.filter(m => m.id.startsWith("seed-")).map(m => m.id)).toEqual([readId])
        const kept = await db.manga.get(readId)
        expect(kept).toMatchObject({ notes: "mine" })
        expect(kept!.coverUrl).toBeUndefined()
        expect(await db.progress.where("mangaId").equals(readId).count()).toBe(1)
    }

    it("removes them again after the pre-update backup is restored", async () => {
        const readId = await readOneSampleThenUpgrade()
        const backupId = await createBackup("pre-update")
        await upgrade()
        await dataSyncSettingsHandlers["data:backup:restore"]!(
            { type: "data:backup:restore", id: backupId } as never,
            {} as never
        )
        await expectSamplesCleaned(readId)
    })

    it("removes them again after an older export is imported", async () => {
        const readId = await readOneSampleThenUpgrade()
        const envelope = await exportDatabase()
        await upgrade()
        await dataSyncSettingsHandlers["data:import"]!({ type: "data:import", envelope } as never, {} as never)
        await expectSamplesCleaned(readId)
    })

    it("removes them again after a gist pull", async () => {
        const readId = await readOneSampleThenUpgrade()
        pullFromGistMock.mockResolvedValue(await exportDatabase())
        await upgrade()
        await dataSyncSettingsHandlers["sync:pull"]!({ type: "sync:pull" } as never, {} as never)
        await expectSamplesCleaned(readId)
    })

    it("leaves a non-sample row alone", async () => {
        await db.manga.put(realTitle)
        const envelope = await exportDatabase()
        await upgrade()
        await dataSyncSettingsHandlers["data:import"]!({ type: "data:import", envelope } as never, {} as never)
        expect(await db.manga.get(realTitle.id)).toEqual(realTitle)
    })
})

describe("what counts as touching a sample", () => {
    it.each([
        [
            "a series link set by hand",
            async (id: string) =>
                linkMangaToUrl(
                    id,
                    { mangaUrl: "https://own-site.example/manga/x", manualTracking: false, updatedAt: 9 },
                    {
                        mangaId: id,
                        sourceId: "own-site",
                        sourceMangaId: "x",
                        url: "https://own-site.example/manga/x",
                        title: "x",
                        addedAt: 1,
                        updatedAt: 9
                    }
                )
        ],
        [
            "a preferred source",
            async (id: string) =>
                void (await db.workOverrides.put({
                    id: "pref",
                    type: "merge",
                    members: [id],
                    preferredSourceId: "own-site",
                    updatedAt: 9
                }))
        ],
        [
            "an available count set by hand",
            async (id: string) => void (await db.manga.update(id, { latestChapterNumber: 500 }))
        ]
    ])("keeps a sample with %s", async (_name, touch) => {
        const id = sampleIds[0]!
        await touch(id)
        await upgrade()
        const kept = await db.manga.get(id)
        expect(kept).toBeDefined()
        expect(isKeptSample(kept!)).toBe(true)
    })

    it("still removes a sample whose available count matches a chapter it holds", async () => {
        const sample = sampleEntries(0)[0]!
        await db.manga.update(sample.manga.id, { latestChapterNumber: sample.sortKey })
        await upgrade()
        expect(await db.manga.get(sample.manga.id)).toBeUndefined()
    })

    it("treats a sample only as the user's once its sample cover is gone", () => {
        expect(isKeptSample({ id: "seed-a", coverUrl: "/sample-covers/a.jpg" })).toBe(false)
        expect(isKeptSample({ id: "seed-a" })).toBe(true)
        expect(isKeptSample({ id: "real-site:manga:a" })).toBe(false)
    })
})

describe("the cleanup and a linked account", () => {
    it("parks a removal for each removed sample so the account does not bring it back", async () => {
        await updateAccountProfile({ token: "linked" })
        await upgrade()
        expect(Object.keys(await getTombstones()).sort()).toEqual([...sampleIds].sort())
    })

    it("parks nothing for a device that was never linked", async () => {
        await upgrade()
        expect(await getTombstones()).toEqual({})
    })
})
