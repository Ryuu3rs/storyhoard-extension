import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("browser", fakeBrowser)

vi.mock("@amr/sources", () => ({
    sourceRegistry: {
        get: vi.fn((id: string) => (id === "webtoons" ? { manifest: { languages: ["en"] } } : undefined))
    }
}))

const { db, exportDatabase, importDatabase, listAllVersions, putWorkOverride, listWorkOverrides } =
    await import("./database")
const { ensureOwnSourceVersions, versionIdFor, ownSourceVersion } = await import("./work-versions")
import type { LibraryManga } from "./database"

function row(over: Partial<LibraryManga> = {}): LibraryManga {
    return {
        id: "webtoons:manga:tower",
        sourceId: "webtoons",
        sourceUrl: "https://www.webtoons.com/en/fantasy/tower-of-god/list?title_no=95",
        sourceMangaId: "95",
        title: "Tower of God",
        normalizedTitle: "tower of god",
        authors: [],
        status: "ongoing",
        addedAt: 1,
        updatedAt: 1,
        latestChapterNumber: 600,
        ...over
    }
}

beforeEach(async () => {
    await fakeBrowser.storage.local.clear()
    await db.versions.clear()
    await db.workOverrides.clear()
    await db.manga.clear()
})

describe("ownSourceVersion", () => {
    it("builds a version from a library row, flagging official by real host", () => {
        const v = ownSourceVersion(row(), [{ domain: "webtoons.com", name: "WEBTOON", verified: true }], 123)
        expect(v).toMatchObject({
            id: "webtoons:95",
            sourceId: "webtoons",
            sourceMangaId: "95",
            languages: ["en"],
            latestChapterNumber: 600,
            isOfficialAtObservation: true,
            health: "unknown",
            numberingKind: "chapter",
            observedVia: "own-source"
        })
        expect(v.workKey).toBe("title:tower of god")
    })

    it("marks numberingKind unreliable when the row is flagged", () => {
        const v = ownSourceVersion(row({ chapterNumberingUnreliable: true }), [], 1)
        expect(v.numberingKind).toBe("unreliable")
        expect(v.isOfficialAtObservation).toBe(false)
    })

    it("omits a non-finite latest chapter number", () => {
        const v = ownSourceVersion(row({ latestChapterNumber: Infinity }), [], 1)
        expect(v.latestChapterNumber).toBeUndefined()
    })
})

describe("ensureOwnSourceVersions", () => {
    it("creates exactly one own-source version per row and is idempotent", async () => {
        const rows = [row(), row({ id: "webtoons:manga:sss", sourceMangaId: "222", title: "Solo" })]
        await ensureOwnSourceVersions(rows)
        let all = await listAllVersions()
        expect(all.map(v => v.id).sort()).toEqual(["webtoons:222", "webtoons:95"])

        // second call writes nothing new
        await ensureOwnSourceVersions(rows)
        all = await listAllVersions()
        expect(all).toHaveLength(2)
    })

    it("does nothing for an empty library", async () => {
        await ensureOwnSourceVersions([])
        expect(await listAllVersions()).toHaveLength(0)
    })
})

describe("versions + overrides survive export/import", () => {
    it("round-trips both stores", async () => {
        await ensureOwnSourceVersions([row()])
        await putWorkOverride({ id: "ov1", type: "split", members: ["webtoons:95"], updatedAt: 10 })

        const envelope = await exportDatabase()
        expect(envelope.data.versions).toHaveLength(1)
        expect(envelope.data.workOverrides).toHaveLength(1)

        await db.versions.clear()
        await db.workOverrides.clear()
        await importDatabase(envelope)

        expect(await listAllVersions()).toHaveLength(1)
        expect(await listWorkOverrides()).toEqual([
            { id: "ov1", type: "split", members: ["webtoons:95"], updatedAt: 10 }
        ])
    })

    it("import merges a version by the fresher lastSeenAt", async () => {
        const base = ownSourceVersion(row(), [], 100)
        await db.versions.put({ ...base, latestChapterNumber: 100, lastSeenAt: 100 })
        const envelope = await exportDatabase()
        // make the stored one newer than the envelope's copy
        await db.versions.put({ ...base, latestChapterNumber: 999, lastSeenAt: 500 })

        await importDatabase(envelope) // envelope copy is older (100) -> must not clobber
        const v = (await listAllVersions()).find(x => x.id === versionIdFor("webtoons", "95", "x"))
        expect(v?.latestChapterNumber).toBe(999)
        expect(v?.lastSeenAt).toBe(500)
    })
})
