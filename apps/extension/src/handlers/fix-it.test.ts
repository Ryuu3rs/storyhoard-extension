import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("wxt/browser", () => ({ browser: { permissions: { contains: vi.fn(async () => true) } } }))
vi.mock("../source-resolver", () => ({ resolveSource: vi.fn() }))
vi.mock("../arch-sources", async importOriginal => ({
    ...(await importOriginal<typeof import("../arch-sources")>()),
    isProfileSource: vi.fn(() => false),
    lacksSiteAccess: vi.fn(async () => false),
    registerStoredArchProfiles: vi.fn()
}))
vi.mock("../site-approvals", () => ({ approveSiteOrigins: vi.fn(), holdsChosenAccess: vi.fn(async () => false) }))
vi.mock("../sources", async importOriginal => ({
    ...(await importOriginal<typeof import("../sources")>()),
    getSourceById: vi.fn(() => ({ manifest: { id: "site" } }))
}))
vi.mock("../background/capture", async importOriginal => ({
    ...(await importOriginal<typeof import("../background/capture")>()),
    refreshExternalMangaMetadata: vi.fn()
}))
vi.mock("./library", () => ({ libraryHandlers: { "library:switch": vi.fn(async () => ({})) } }))

const { db, exportDatabase, importDatabase } = await import("../database")
const { resolveSource } = await import("../source-resolver")
const { libraryHandlers } = await import("./library")
const { refreshExternalMangaMetadata } = await import("../background/capture")
const { approveSiteOrigins } = await import("../site-approvals")
const { validateProfileScope } = await import("../source-scope")
const { parseProfile } = await import("@amr/source-engine")
const { fixItHandlers } = await import("./fix-it")

const ctx = {} as never
const base = { normalizedTitle: "x", authors: [], status: "unknown" as const, addedAt: 1, updatedAt: 1 }

function siteProfile(host: string, origins: string[]) {
    return {
        profileFormat: 2,
        id: host,
        name: "Reader",
        engine: "generic",
        origin: `https://${host}`,
        domains: [host],
        languages: ["en"],
        capabilities: ["chapters", "manga"],
        numberingKind: "chapter",
        requestRateLimit: { requests: 50, intervalMs: 1000 },
        origins,
        match: { manga: "^/manga/([a-z0-9-]+)/?$", chapter: "^/manga/([a-z0-9-]+)/ch-([0-9.]+)/?$" },
        series: { urlTemplate: "/manga/{slug}", titlePattern: "<h1>(?<title>[^<]+)</h1>" }
    }
}

// What a hostile backup carries: a row named like an ordinary reader whose origins reach far wider.
const craftedProfile = siteProfile("manga-reader.net", [
    "https://*/*",
    "https://mail.google.com/*",
    "https://manga-reader.net/*"
])

async function restoreCraftedBackup() {
    const envelope = (await exportDatabase()) as { data: Record<string, unknown> }
    envelope.data["archProfiles"] = [{ id: craftedProfile.id, profile: craftedProfile, importedAt: 1, origin: "user" }]
    await importDatabase(envelope)
}

async function overview(sourceIds: string[]) {
    return (await fixItHandlers["fixit:overview"]!({ type: "fixit:overview", sourceIds } as never, ctx)) as {
        sites: Array<{ sourceId: string; canTurnOn: boolean; origins: string[] }>
        names: Array<{ mangaId: string; title: string }>
    }
}

beforeEach(async () => {
    await db.manga.clear()
    await db.archProfiles.clear()
    vi.mocked(resolveSource).mockReset()
    vi.mocked(libraryHandlers["library:switch"]!).mockClear()
    vi.mocked(refreshExternalMangaMetadata).mockReset()
    vi.mocked(approveSiteOrigins).mockClear()
})

describe("fixit:overview", () => {
    it("offers to turn a known site back on and lists titles named after their address", async () => {
        await db.archProfiles.put({
            id: "known-reader.net",
            profile: siteProfile("known-reader.net", ["https://known-reader.net/*"]),
            importedAt: 1,
            origin: "user"
        } as never)
        await db.manga.bulkPut([
            {
                ...base,
                id: "a",
                title: "019c2921 C7b9",
                sourceId: "s",
                sourceMangaId: "019c2921-c7b9",
                sourceUrl: "https://s.example/a"
            },
            { ...base, id: "b", title: "mangadex.org", sourceId: "s", sourceUrl: "https://mangadex.org/title/b" },
            {
                ...base,
                id: "c",
                title: "Real Name",
                sourceId: "s",
                sourceMangaId: "real",
                sourceUrl: "https://s.example/c"
            }
        ] as never)

        const result = await overview(["known-reader.net", "gone"])

        expect(result.sites).toEqual([
            { sourceId: "known-reader.net", canTurnOn: true, origins: ["https://known-reader.net/*"] },
            { sourceId: "gone", canTurnOn: false, origins: [] }
        ])
        expect(result.names.map(n => n.mangaId).sort()).toEqual(["a", "b"])
    })

    it("does not list a title whose real name matches its address slug or is a dotted name", async () => {
        await db.manga.bulkPut([
            {
                ...base,
                id: "site:manga:solo-leveling",
                title: "Solo Leveling",
                sourceId: "site",
                sourceMangaId: "solo-leveling",
                mangaUrl: "https://site.example/manga/solo-leveling",
                sourceUrl: "https://site.example/manga/solo-leveling"
            },
            {
                ...base,
                id: "site:manga:86",
                title: "86",
                sourceId: "site",
                sourceMangaId: "86",
                mangaUrl: "https://site.example/manga/86",
                sourceUrl: "https://site.example/manga/86"
            },
            {
                ...base,
                id: "site:manga:dr-stone",
                title: "Dr.STONE",
                sourceId: "site",
                sourceMangaId: "dr-stone",
                sourceUrl: "https://site.example/manga/dr-stone"
            },
            { ...base, id: "elsewhere", title: "other.example", sourceId: "site", sourceUrl: "https://site.example/x" }
        ] as never)

        expect((await overview([])).names).toEqual([])
    })

    it("still lists a new title named after its title number or its own site", async () => {
        await db.manga.bulkPut([
            {
                ...base,
                id: "old",
                title: "Title No:5656",
                sourceId: "w",
                sourceMangaId: "5656",
                sourceUrl: "https://w.example/a"
            },
            {
                ...base,
                id: "number",
                title: "5656",
                sourceId: "w",
                sourceMangaId: "5656",
                sourceUrl: "https://w.example/b"
            },
            { ...base, id: "host", title: "www.w.example", sourceId: "w", sourceUrl: "https://w.example/c" }
        ] as never)

        expect((await overview([])).names.map(n => n.mangaId).sort()).toEqual(["host", "number", "old"])
    })

    it("never hands the page a restored row's host patterns outside its own validated scope", async () => {
        await restoreCraftedBackup()
        expect(await db.archProfiles.get(craftedProfile.id)).toBeDefined()
        const parsed = parseProfile(craftedProfile)
        expect(parsed.ok && validateProfileScope(parsed.profile)).toBe(false)
        expect(parsed.ok).toBe(true)

        const site = (await overview([craftedProfile.id])).sites[0]!

        expect(site.origins).not.toContain("https://*/*")
        expect(site.origins).not.toContain("https://mail.google.com/*")
        expect(site.canTurnOn).toBe(false)
    })
})

describe("fixit:enable-site", () => {
    it("never records an out-of-scope pattern of a restored row as user-approved", async () => {
        await restoreCraftedBackup()

        const result = await fixItHandlers["fixit:enable-site"]!(
            { type: "fixit:enable-site", sourceId: craftedProfile.id } as never,
            ctx
        )

        const approved = vi.mocked(approveSiteOrigins).mock.calls.flatMap(call => [...call[0]])
        expect(approved).not.toContain("https://*/*")
        expect(approved).not.toContain("https://mail.google.com/*")
        expect(result).toEqual({ enabled: false })
    })

    it("approves exactly the patterns of a row that is in scope", async () => {
        await db.archProfiles.put({
            id: "known-reader.net",
            profile: siteProfile("known-reader.net", ["https://known-reader.net/*"]),
            importedAt: 1,
            origin: "user"
        } as never)

        const result = await fixItHandlers["fixit:enable-site"]!(
            { type: "fixit:enable-site", sourceId: "known-reader.net" } as never,
            ctx
        )

        expect(approveSiteOrigins).toHaveBeenCalledWith(["https://known-reader.net/*"])
        expect(result).toEqual({ enabled: true })
    })
})

describe("fixit:find", () => {
    it("relinks only sure matches and leaves the rest for the user to pick", async () => {
        await db.manga.bulkPut([
            { ...base, id: "sure", title: "Sure", sourceId: "s", sourceUrl: "https://s.example/1" },
            { ...base, id: "unsure", title: "Unsure", sourceId: "s", sourceUrl: "https://s.example/2" }
        ] as never)
        vi.mocked(resolveSource).mockImplementation(async input =>
            input.title === "Sure"
                ? ({
                      confidence: "high",
                      best: { sourceId: "site", sourceMangaId: "sure", url: "https://site.example/sure", title: "Sure" }
                  } as never)
                : ({ confidence: "low", best: undefined } as never)
        )

        const result = (await fixItHandlers["fixit:find"]!(
            { type: "fixit:find", mangaIds: ["sure", "unsure", "missing"] } as never,
            ctx
        )) as { results: Array<{ mangaId: string; outcome: string }> }

        expect(result.results).toEqual([
            { mangaId: "sure", outcome: "relinked" },
            { mangaId: "unsure", outcome: "pick" },
            { mangaId: "missing", outcome: "missing" }
        ])
        expect(libraryHandlers["library:switch"]).toHaveBeenCalledTimes(1)
    })
})

describe("fixit:names", () => {
    it("re-reads the name of titles still named after their address", async () => {
        await db.manga.bulkPut([
            {
                ...base,
                id: "a",
                title: "019c2921 C7b9",
                sourceId: "s",
                sourceMangaId: "019c2921-c7b9",
                mangaUrl: "https://s.example/title/019c2921-c7b9",
                sourceUrl: "https://s.example/a"
            },
            {
                ...base,
                id: "c",
                title: "Real Name",
                sourceId: "s",
                sourceMangaId: "real",
                mangaUrl: "https://s.example/r",
                sourceUrl: "https://s.example/c"
            }
        ] as never)

        const result = await fixItHandlers["fixit:names"]!({ type: "fixit:names" } as never, ctx)

        expect(refreshExternalMangaMetadata).toHaveBeenCalledTimes(1)
        expect(refreshExternalMangaMetadata).toHaveBeenCalledWith(
            "s",
            { sourceMangaId: "019c2921-c7b9", mangaUrl: "https://s.example/title/019c2921-c7b9" },
            "a"
        )
        expect(result).toEqual({ tried: 1, remaining: 1 })
    })

    it("reaches a fixable title even when 40 earlier ones can never be named", async () => {
        const stuck = Array.from({ length: 40 }, (_, i) => {
            const slug = `0a${String(i).padStart(2, "0")}f-dead`
            return {
                ...base,
                id: `a-${String(i).padStart(2, "0")}`,
                title: slug,
                sourceId: "s",
                sourceMangaId: slug,
                mangaUrl: `https://dead.example/title/${slug}`,
                sourceUrl: `https://dead.example/title/${slug}`
            }
        })
        const fixable = {
            ...base,
            id: "z-fixable",
            title: "019c2921-c7b9",
            sourceId: "s",
            sourceMangaId: "019c2921-c7b9",
            mangaUrl: "https://live.example/title/019c2921-c7b9",
            sourceUrl: "https://live.example/title/019c2921-c7b9"
        }
        await db.manga.bulkPut([...stuck, fixable] as never)
        vi.mocked(refreshExternalMangaMetadata).mockImplementation(async (_sourceId, _info, mangaId) => {
            if (mangaId === "z-fixable") await db.manga.update(mangaId, { title: "The Real Name" })
        })

        // The loop FixIt.svelte's fixNames() runs.
        let after: string | undefined
        let rounds = 0
        for (; rounds < 10; rounds++) {
            const result = (await fixItHandlers["fixit:names"]!(
                { type: "fixit:names", ...(after !== undefined ? { after } : {}) } as never,
                ctx
            )) as { tried: number; remaining: number; next?: string }
            if (result.tried === 0 || result.next === undefined) break
            after = result.next
        }

        expect((await db.manga.get("z-fixable"))?.title).toBe("The Real Name")
        expect(rounds).toBe(1)
        expect(refreshExternalMangaMetadata).toHaveBeenCalledTimes(41)
    })
})
