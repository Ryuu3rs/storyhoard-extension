import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("browser", fakeBrowser)

const { db, recordFirstTitleAdded, trackExternalChapter, _resetFirstTitleGuardForTests } = await import("./database")

beforeEach(async () => {
    await Promise.all([
        db.manga.clear(),
        db.sourceLinks.clear(),
        db.chapters.clear(),
        db.progress.clear(),
        db.historyEvents.clear(),
        db.analyticsEvents.clear()
    ])
    await fakeBrowser.storage.local.clear()
    _resetFirstTitleGuardForTests()
})

async function firstTitleCount(): Promise<number> {
    return db.analyticsEvents.where("event").equals("first_title_added").count()
}

describe("recordFirstTitleAdded once-guard under concurrency", () => {
    it("emits first_title_added exactly once when two adds race", async () => {
        // Two genuine first-adds land at the same time (two source tabs each firing an
        // external-track on a fresh install). Both read the storage flag as unset before
        // either writes it, so the once-guard passes twice.
        await Promise.all([recordFirstTitleAdded(), recordFirstTitleAdded()])
        expect(await firstTitleCount()).toBe(1)
    })

    it("emits first_title_added exactly once via two concurrent created trackExternalChapter adds", async () => {
        // Model the real extension: chrome.storage.local is a cross-process async API with IPC
        // latency, whereas the Dexie add() that gates the second track is a fast in-process IDB
        // write. Add a small delay to storage so the second track's guard get() lands before the
        // first track's guard set() resolves - exactly what happens in production. (With no delay
        // the in-memory fake storage is fast enough that the first set() always wins, masking the
        // race - the very IndexedDB-ordering masking the brief warns about.)
        const realGet = fakeBrowser.storage.local.get.bind(fakeBrowser.storage.local)
        const realSet = fakeBrowser.storage.local.set.bind(fakeBrowser.storage.local)
        const delay = () => new Promise(r => setTimeout(r, 5))
        vi.spyOn(fakeBrowser.storage.local, "get").mockImplementation(async (...a: unknown[]) => {
            await delay()
            // @ts-expect-error passthrough
            return realGet(...a)
        })
        vi.spyOn(fakeBrowser.storage.local, "set").mockImplementation(async (...a: unknown[]) => {
            await delay()
            // @ts-expect-error passthrough
            return realSet(...a)
        })

        const [a, b] = await Promise.all([
            trackExternalChapter({ url: "https://example.com/manga/alpha/chapter-1", sourceId: "src" }),
            trackExternalChapter({ url: "https://example.com/manga/beta/chapter-1", sourceId: "src" })
        ])
        expect(a.created).toBe(true)
        expect(b.created).toBe(true)
        // Let the fire-and-forget recordFirstTitleAdded() calls settle.
        await new Promise(r => setTimeout(r, 50))
        expect(await firstTitleCount()).toBe(1)
    })
})
