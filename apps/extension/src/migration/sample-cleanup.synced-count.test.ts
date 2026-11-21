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
const { toSyncItem } = await import("../account")
const { removeUntouchedSamples } = await import("./sample-cleanup")
const { isKeptSample } = await import("../sample-rows")
const { applyRemoteItem } = await import("../handlers/account")

const DAY = 86_400_000

beforeEach(async () => {
    fakeBrowser.reset()
    await Promise.all([db.manga.clear(), db.chapters.clear(), db.sourceLinks.clear(), db.progress.clear()])
})

describe("the sample cleanup and an available count pulled from another device", () => {
    it("removes a sample the user never touched on any device", async () => {
        const now = Date.now()
        const sample = sampleEntries(now - 30 * DAY)[0]!
        const id = sample.manga.id
        await seedDatabase(sampleEntries(now - 30 * DAY))

        // 0.32.2 on another linked device ran its update check on the sample (it stored the chapter list
        // there, so its count matches a chapter it holds) and pushed the row; this device pulled it.
        const local = (await db.manga.get(id))!
        const remote = toSyncItem({ ...local, latestChapterNumber: 150, updatedAt: now - DAY })
        expect(await applyRemoteItem(remote)).toBe(true)

        const result = await removeUntouchedSamples({ backedUp: true })
        const row = await db.manga.get(id)
        expect(row && isKeptSample(row)).toBeFalsy()
        expect(result?.removed).toContain(id)
    })
})
