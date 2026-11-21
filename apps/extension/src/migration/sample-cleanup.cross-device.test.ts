import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("browser", fakeBrowser)
vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
        throw new Error("no network in this test")
    })
)

const { db, seedDatabase } = await import("../database")
const { sampleEntries } = await import("../lab/sample-library")
const { getTombstones, toSyncItem, updateAccountProfile } = await import("../account")
const { removeUntouchedSamples } = await import("./sample-cleanup")
const { applyRemoteItem } = await import("../handlers/account")

const DAY = 86_400_000

const clearLibrary = () =>
    Promise.all([db.manga.clear(), db.chapters.clear(), db.sourceLinks.clear(), db.progress.clear()])

beforeEach(async () => {
    fakeBrowser.reset()
    await clearLibrary()
})

describe("the sample cleanup on two linked devices", () => {
    it("keeps a sample the user read on one device when the other removed its own untouched copy", async () => {
        const now = Date.now()
        const sample = sampleEntries(now - 30 * DAY)[0]!
        const id = sample.manga.id

        // Device B: linked, still holds the untouched sample (it has not pulled A's read yet), then updates.
        await updateAccountProfile({ token: "tok", userId: "u1" })
        await seedDatabase(sampleEntries(now - 30 * DAY))
        const result = await removeUntouchedSamples({ backedUp: true })
        expect(result?.removed).toContain(id)
        const tombstoneAt = (await getTombstones())[id]!
        expect(tombstoneAt).toBe(sample.manga.updatedAt + 1)

        // Device A: same account, the user read that sample two days ago (a kept sample there).
        fakeBrowser.reset()
        await clearLibrary()
        await updateAccountProfile({ token: "tok", userId: "u1" })
        await seedDatabase(sampleEntries(now - 30 * DAY))
        await db.manga.update(id, {
            coverUrl: undefined,
            lastReadChapterNumber: sample.sortKey,
            lastReadChapterId: sample.manga.latestChapterId!,
            lastReadAt: now - 2 * DAY,
            updatedAt: now - 2 * DAY
        })
        await db.progress.put({
            chapterId: sample.manga.latestChapterId!,
            mangaId: id,
            pageIndex: 0,
            pageCount: 1,
            updatedAt: now - 2 * DAY,
            completed: true
        })

        // A pulls B's removal: older than A's read, so A keeps its title and progress.
        await applyRemoteItem({
            clientId: id,
            title: id,
            normalizedTitle: id,
            deleted: true,
            clientUpdatedAt: tombstoneAt
        })
        const onA = await db.manga.get(id)
        expect(onA).toBeDefined()
        expect(await db.progress.where("mangaId").equals(id).count()).toBe(1)

        // The account keeps A's newer copy over B's removal, and B adopts it back as the user's title.
        const fromA = toSyncItem(onA!)
        expect(fromA.clientUpdatedAt).toBeGreaterThan(tombstoneAt)
        await clearLibrary()
        expect(await applyRemoteItem(fromA)).toBe(true)
        const onB = await db.manga.get(id)
        expect(onB?.lastReadChapterNumber).toBe(sample.sortKey)
        expect(onB?.coverUrl).toBeUndefined()
    })
})
