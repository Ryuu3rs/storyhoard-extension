import "fake-indexeddb/auto"
import { sourceRegistry } from "@amr/sources"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LibraryManga } from "./database"

vi.stubGlobal("browser", fakeBrowser)

const { db } = await import("./database")
const { listSourceLabels } = await import("./source-prefs")
const { siteSearchHosts } = await import("./search-view")
const { OFFICIAL_SITES_DEFAULT, isOfficialHost } = await import("./official-sources")

const adapter = (id: string, name: string, domains: string[]) =>
    ({ manifest: { id, name, domains, capabilities: ["chapters"] } }) as unknown as ReturnType<
        typeof sourceRegistry.list
    >[number]

function title(id: string, sourceId: string, sourceUrl: string, mangaUrl?: string): LibraryManga {
    return {
        id,
        sourceId,
        sourceUrl,
        ...(mangaUrl ? { mangaUrl } : {}),
        title: id,
        normalizedTitle: id,
        authors: [],
        status: "ongoing",
        addedAt: 1,
        updatedAt: 1
    }
}

const feedOfficial = (domain: string) =>
    fakeBrowser.storage.local.set({ officialSitesCache: { sites: [{ domain }], fetchedAt: Date.now() } })

beforeEach(async () => {
    fakeBrowser.reset()
    vi.spyOn(sourceRegistry, "list").mockReturnValue([adapter("alpha", "Alpha Scans", ["alpha.example"])])
    await db.sourcePrefs.clear()
    await db.manga.clear()
    await db.versions.clear()
    await db.archProfiles.clear()
})

describe("official sites are never named on the Sources page", () => {
    it("hides the address and name of an official site the weeb.ltd feed added", async () => {
        await feedOfficial("fresh-official.example")
        await db.manga.put(title("t1", "gone", "https://fresh-official.example/series/1"))

        const info = (await listSourceLabels()).find(i => i.id === "gone")!

        expect(info.official).toBe(true)
        expect(info.host).toBeUndefined()
        expect(info.suggestion).toBeUndefined()
    })

    it("does not show an official address saved on a title of a source that is not official", async () => {
        await feedOfficial("official.example")
        await db.manga.bulkPut([
            title("t1", "alpha", "https://alpha.example/a", "https://official.example/title/a"),
            title("t2", "alpha", "https://alpha.example/b", "https://official.example/title/b")
        ])

        const info = (await listSourceLabels()).find(i => i.id === "alpha")!

        expect(info.host).toBe("alpha.example")
    })

    it("hides the row's address when the host chosen for it is official", async () => {
        await feedOfficial("official.example")
        vi.mocked(sourceRegistry.list).mockReturnValue([
            adapter("alpha", "Alpha Scans", ["alpha.example", "*.official.example"])
        ])
        await db.manga.bulkPut([
            title("t1", "alpha", "https://read.official.example/a"),
            title("t2", "alpha", "https://read.official.example/b")
        ])

        const info = (await listSourceLabels()).find(i => i.id === "alpha")!

        expect(info.host).toBeUndefined()
        expect(info.suggestion).toBeUndefined()
    })
})

describe("Search a site yourself chips", () => {
    it("never offers an official site from the user's library or source domains", () => {
        const official = OFFICIAL_SITES_DEFAULT[0]!.domain
        const hosts = siteSearchHosts(
            [`https://${official}/title/a`, `https://www.${official}/title/b`, "https://reader.example/s/1"],
            [official, "late.example"]
        )

        expect(hosts.filter(h => isOfficialHost(h, OFFICIAL_SITES_DEFAULT))).toEqual([])
        expect(hosts).toEqual(["reader.example", "late.example"])
    })

    it("also leaves out an official site the weeb.ltd feed added", () => {
        const hosts = siteSearchHosts(
            ["https://fresh-official.example/a", "https://reader.example/s/1"],
            [],
            [...OFFICIAL_SITES_DEFAULT, { domain: "fresh-official.example", verified: false }]
        )

        expect(hosts).toEqual(["reader.example"])
    })
})
