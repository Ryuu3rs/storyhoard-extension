import "fake-indexeddb/auto"
import { parseProfile } from "@amr/source-engine"
import { SourceError } from "@amr/source-sdk"
import { sourceRegistry } from "@amr/sources"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { db, putArchProfile } from "./database"
import { loadSeedProfiles } from "./migration/seed-profiles"

vi.mock("./background/chapter-cache", () => ({ scheduleChapterListRefresh: vi.fn() }))
vi.mock("./settings", () => ({ getSettings: async () => ({ language: "en" }) }))

const {
    buildProbeContext,
    deleteImportedProfile,
    initUserSources,
    listImportedProfiles,
    registerProfile,
    registerStoredArchProfiles
} = await import("./arch-sources")
const { getSourceById, resolveMangaMetadata } = await import("./sources")

const ORIGIN = "https://example-scans.net"
const SLUG = "demo-title"
const PROFILE_ID = "example-scans.net"

const permissions = { contains: vi.fn(), remove: vi.fn() }

const profileV2 = {
    profileFormat: 2,
    id: PROFILE_ID,
    name: "Example Scans",
    engine: "generic",
    origin: ORIGIN,
    domains: ["example-scans.net"],
    languages: ["en"],
    capabilities: ["chapters", "manga"],
    numberingKind: "chapter",
    requestRateLimit: { requests: 50, intervalMs: 1000 },
    origins: [`${ORIGIN}/*`],
    match: {
        manga: "^/manga/([a-z0-9-]+)/?$",
        chapter: "^/manga/([a-z0-9-]+)/ch-([0-9.]+)/?$"
    },
    series: {
        urlTemplate: "/manga/{slug}",
        titlePattern: '<meta property="og:title" content="(?<title>[^"]+)"'
    },
    list: {
        itemPattern:
            '<a href="(?<chapterUrl>/manga/[a-z0-9-]+/ch-(?<chapterNumber>[0-9.]+))">(?<chapterTitle>[^<]*)</a>'
    }
}

function parsedProfile(overrides: Record<string, unknown> = {}) {
    const parsed = parseProfile({ ...profileV2, ...overrides })
    if (!parsed.ok) throw new Error(parsed.error)
    return parsed.profile
}

beforeEach(async () => {
    await db.archProfiles.clear()
    permissions.contains.mockReset().mockResolvedValue(true)
    permissions.remove.mockReset().mockResolvedValue(true)
    vi.stubGlobal("browser", { permissions })
})

afterEach(() => {
    sourceRegistry.unregister(PROFILE_ID)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe("a stored profile can never displace a bundled adapter", () => {
    it("a seed row whose id is a bundled adapter leaves that adapter in place (initUserSources)", async () => {
        const seed = loadSeedProfiles().get("mangafreak")!
        const bundled = getSourceById("mangafreak")
        expect(bundled).toBeDefined()
        await putArchProfile("mangafreak", seed, "seed")

        await initUserSources()

        expect(getSourceById("mangafreak")).toBe(bundled)
    })

    it("a user row whose id collides with a bundled adapter is refused, with or without onlyUnresolved", async () => {
        const bundled = getSourceById("mangadex")
        const hostile = parsedProfile({ id: "mangadex" })
        await putArchProfile("mangadex", hostile, "user")
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

        await initUserSources()
        expect(getSourceById("mangadex")).toBe(bundled)
        await registerStoredArchProfiles()
        expect(getSourceById("mangadex")).toBe(bundled)
        expect(registerProfile(hostile)).toBe(false)
        expect(getSourceById("mangadex")).toBe(bundled)
        expect(warn).toHaveBeenCalled()
    })

    it("still replaces a profile-backed source when the stored profile is updated", async () => {
        await putArchProfile(PROFILE_ID, profileV2)
        await registerStoredArchProfiles({ onlyUnresolved: true })
        const first = getSourceById(PROFILE_ID)
        await putArchProfile(PROFILE_ID, { ...profileV2, name: "Renamed Scans" })
        await registerStoredArchProfiles({ onlyUnresolved: true })
        expect(getSourceById(PROFILE_ID)).not.toBe(first)
        expect(getSourceById(PROFILE_ID)?.manifest.name).toBe("Renamed Scans")
    })

    it("refuses a row whose key does not match the id inside the profile", async () => {
        await db.archProfiles.put({ id: "some-other-key", profile: profileV2, importedAt: 1, origin: "user" })
        vi.spyOn(console, "warn").mockImplementation(() => undefined)
        await registerStoredArchProfiles()
        expect(getSourceById(PROFILE_ID)).toBeUndefined()
    })
})

describe("seed rows are not user-added sites", () => {
    it("lists only user rows", async () => {
        await putArchProfile("mangafreak", loadSeedProfiles().get("mangafreak")!, "seed")
        await putArchProfile(PROFILE_ID, profileV2, "user")
        expect(await listImportedProfiles()).toEqual([
            { id: PROFILE_ID, name: "Example Scans", domains: ["example-scans.net"] }
        ])
    })

    it("a row with no origin field is a seed row only when it is byte-equal to the committed seed", async () => {
        await db.archProfiles.put({ id: "mangafreak", profile: loadSeedProfiles().get("mangafreak"), importedAt: 1 })
        await db.archProfiles.put({ id: PROFILE_ID, profile: profileV2, importedAt: 1 })
        expect((await listImportedProfiles()).map(p => p.id)).toEqual([PROFILE_ID])
    })

    it("refuses to remove a seed row and keeps the bundled adapter registered", async () => {
        const bundled = getSourceById("mangafreak")
        await putArchProfile("mangafreak", loadSeedProfiles().get("mangafreak")!, "seed")

        expect(await deleteImportedProfile("mangafreak")).toBe(false)

        expect(getSourceById("mangafreak")).toBe(bundled)
        expect(await db.archProfiles.get("mangafreak")).toBeDefined()
    })

    it("refuses to remove a user-origin row that collides with a bundled adapter", async () => {
        const bundled = getSourceById("mangadex")
        await putArchProfile("mangadex", parsedProfile({ id: "mangadex" }), "user")

        expect(await deleteImportedProfile("mangadex")).toBe(false)

        expect(getSourceById("mangadex")).toBe(bundled)
        expect(await db.archProfiles.get("mangadex")).toBeDefined()
    })

    it("a row labelled seed whose profile was altered is not registered and cannot be removed", async () => {
        await putArchProfile(PROFILE_ID, profileV2, "seed")
        vi.spyOn(console, "warn").mockImplementation(() => undefined)

        await registerStoredArchProfiles()

        expect(getSourceById(PROFILE_ID)).toBeUndefined()
        expect(await deleteImportedProfile(PROFILE_ID)).toBe(false)
    })

    it("removes a user-added source", async () => {
        await putArchProfile(PROFILE_ID, profileV2, "user")
        await registerStoredArchProfiles()
        expect(await deleteImportedProfile(PROFILE_ID)).toBe(true)
        expect(getSourceById(PROFILE_ID)).toBeUndefined()
        expect(await db.archProfiles.get(PROFILE_ID)).toBeUndefined()
    })
})

describe("restore / pull cannot register an out-of-scope profile", () => {
    const hostile: Array<[string, Record<string, unknown>]> = [
        ["a wildcard TLD", { domains: ["*.com"], origins: ["https://*.com/*"] }],
        ["a match-everything origin", { origins: ["*://*/*"] }],
        [
            "a loopback origin",
            { origin: "https://127.0.0.1", domains: ["127.0.0.1"], origins: ["https://127.0.0.1/*"] }
        ],
        ["a private-network host", { origin: "https://nas.lan", domains: ["nas.lan"], origins: ["https://nas.lan/*"] }],
        ["a domain on someone else's site", { domains: ["example-scans.net", "victim-bank.com"] }],
        ["an image host elsewhere", { imageOrigins: ["https://tracker.evil.net/*"] }],
        ["a first-party host", { origin: "https://weeb.ltd", domains: ["weeb.ltd"], origins: ["https://weeb.ltd/*"] }]
    ]

    it.each(hostile)("drops a user row with %s", async (_name, overrides) => {
        await putArchProfile(PROFILE_ID, { ...profileV2, ...overrides }, "user")
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

        await registerStoredArchProfiles()

        expect(getSourceById(PROFILE_ID)).toBeUndefined()
        expect(warn).toHaveBeenCalled()
    })

    it("registers a conforming user row", async () => {
        await putArchProfile(PROFILE_ID, profileV2, "user")
        await registerStoredArchProfiles()
        expect(getSourceById(PROFILE_ID)).toBeDefined()
    })

    it.each([
        ["an id that is not its origin's host", { id: "something-else" }],
        [
            "a public-suffix origin",
            { origin: "https://pages.dev", domains: ["pages.dev"], origins: ["https://pages.dev/*"], id: "pages.dev" }
        ],
        ["a foreign url template", { series: { ...profileV2.series, urlTemplate: "//evil.example/{slug}" } }]
    ])("drops a user row with %s", async (_name, overrides) => {
        const row = { ...profileV2, ...overrides }
        await db.archProfiles.put({ id: row.id, profile: row, importedAt: 1, origin: "user" })
        vi.spyOn(console, "warn").mockImplementation(() => undefined)

        await registerStoredArchProfiles()

        expect(getSourceById(row.id)).toBeUndefined()
    })
})

describe("a user row is registered only when its host access is already held", () => {
    it("does not register a user row whose origins were never granted", async () => {
        permissions.contains.mockResolvedValue(false)
        await putArchProfile(PROFILE_ID, profileV2, "user")
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

        await initUserSources()
        await registerStoredArchProfiles()

        expect(permissions.contains).toHaveBeenCalledWith({ origins: [`${ORIGIN}/*`] })
        expect(getSourceById(PROFILE_ID)).toBeUndefined()
        expect(await db.archProfiles.get(PROFILE_ID)).toBeDefined()
        expect(warn).toHaveBeenCalled()
    })

    it("registers the same row once its origins are granted", async () => {
        permissions.contains.mockResolvedValue(false)
        await putArchProfile(PROFILE_ID, profileV2, "user")
        vi.spyOn(console, "warn").mockImplementation(() => undefined)
        await registerStoredArchProfiles()
        expect(getSourceById(PROFILE_ID)).toBeUndefined()

        permissions.contains.mockResolvedValue(true)
        await registerStoredArchProfiles()

        expect(getSourceById(PROFILE_ID)).toBeDefined()
    })

    it("fails closed when the permission check itself throws", async () => {
        permissions.contains.mockRejectedValue(new Error("no permissions api"))
        await putArchProfile(PROFILE_ID, profileV2, "user")
        vi.spyOn(console, "warn").mockImplementation(() => undefined)

        await registerStoredArchProfiles()

        expect(getSourceById(PROFILE_ID)).toBeUndefined()
    })

    it("never reads or fetches the origin of a tampered row before it is granted", async () => {
        permissions.contains.mockResolvedValue(false)
        const fetchMock = vi.fn()
        vi.stubGlobal("fetch", fetchMock)
        await putArchProfile(PROFILE_ID, profileV2, "user")
        vi.spyOn(console, "warn").mockImplementation(() => undefined)

        await registerStoredArchProfiles()

        expect(getSourceById(PROFILE_ID)).toBeUndefined()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("does not ask for access for a committed seed row", async () => {
        permissions.contains.mockResolvedValue(false)
        await putArchProfile("mangafreak", loadSeedProfiles().get("mangafreak")!, "seed")
        await registerStoredArchProfiles()
        expect(permissions.contains).not.toHaveBeenCalled()
    })
})

describe("removing a user source gives back its host access", () => {
    it("revokes the origins of a removed source", async () => {
        await putArchProfile(PROFILE_ID, profileV2, "user")
        await registerStoredArchProfiles()

        expect(await deleteImportedProfile(PROFILE_ID)).toBe(true)

        expect(permissions.remove).toHaveBeenCalledWith({ origins: [`${ORIGIN}/*`] })
    })

    it("keeps an origin that another registered profile still uses", async () => {
        const other = {
            ...profileV2,
            id: "second.example-scans.net",
            origin: "https://second.example-scans.net",
            domains: ["second.example-scans.net"],
            origins: [`${ORIGIN}/*`]
        }
        await putArchProfile(PROFILE_ID, profileV2, "user")
        registerProfile(parsedProfile())
        await db.archProfiles.put({ id: other.id, profile: other, importedAt: 1, origin: "user" })
        registerProfile(parsedProfile(other))

        expect(await deleteImportedProfile(PROFILE_ID)).toBe(true)

        expect(permissions.remove).not.toHaveBeenCalled()
        sourceRegistry.unregister(other.id)
    })

    it("does not revoke anything for a row that is out of scope (a tampered row cannot pull a bundled source's access)", async () => {
        const hostile = { ...profileV2, origins: ["https://mangadex.org/*"] }
        await db.archProfiles.put({ id: PROFILE_ID, profile: hostile, importedAt: 1, origin: "user" })

        expect(await deleteImportedProfile(PROFILE_ID)).toBe(true)

        expect(permissions.remove).not.toHaveBeenCalled()
    })

    it("does not revoke when nothing was removed", async () => {
        expect(await deleteImportedProfile("missing.example")).toBe(false)
        expect(permissions.remove).not.toHaveBeenCalled()
    })
})

describe("a shipped build never scrapes page images, even for a restored format-1 profile", () => {
    const format1 = {
        ...profileV2,
        profileFormat: 1,
        capabilities: ["pages", "chapters"],
        imageOrigins: [`${ORIGIN}/*`],
        pages: { imagePatterns: ['<img class="page" src="(?<url>[^"]+)"'] }
    }

    it("strips pages, imageOrigins and the pages capability on register", async () => {
        await putArchProfile(PROFILE_ID, format1, "user")
        await registerStoredArchProfiles()
        const adapter = getSourceById(PROFILE_ID)!
        expect(adapter).toBeDefined()
        expect(adapter.manifest.capabilities).toEqual(["chapters"])
        expect(adapter.manifest.imageOrigins).toBeUndefined()
    })

    it("resolveChapter returns no pages and fetches nothing", async () => {
        await putArchProfile(PROFILE_ID, format1, "user")
        await registerStoredArchProfiles()
        const fetchMock = vi.fn()
        vi.stubGlobal("fetch", fetchMock)
        const adapter = getSourceById(PROFILE_ID)!

        const resolved = await adapter.resolveChapter(
            { url: new URL(`${ORIGIN}/manga/${SLUG}/ch-1`) },
            { request: {} as never, now: () => 1, logger: { debug: () => undefined, warn: () => undefined } }
        )

        expect(resolved.pages).toEqual([])
        expect(fetchMock).not.toHaveBeenCalled()
    })
})

describe("a profile source reaches only its own origins", () => {
    function stubFetch() {
        const fetchMock = vi.fn(async (input: unknown) => ({
            ok: true,
            status: 200,
            url: String(input),
            text: async () => '<meta property="og:title" content="Demo Title" />'
        }))
        vi.stubGlobal("fetch", fetchMock)
        return fetchMock
    }

    it("does not fetch a bundled source's origin on its behalf", async () => {
        await putArchProfile(PROFILE_ID, profileV2, "user")
        await registerStoredArchProfiles()
        const fetchMock = stubFetch()

        const result = await resolveMangaMetadata({
            sourceId: PROFILE_ID,
            mangaUrl: "https://mangadex.org/manga/demo-title"
        })

        expect(result).toBeUndefined()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("still fetches its own origin", async () => {
        await putArchProfile(PROFILE_ID, profileV2, "user")
        await registerStoredArchProfiles()
        const fetchMock = stubFetch()

        const result = await resolveMangaMetadata({ sourceId: PROFILE_ID, mangaUrl: `${ORIGIN}/manga/${SLUG}` })

        expect(result?.title).toBe("Demo Title")
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it("a bundled adapter keeps the bundled origin list", async () => {
        const fetchMock = stubFetch()
        await resolveMangaMetadata({
            sourceId: "mangadex",
            mangaUrl: "https://mangadex.org/title/3f1a5c8e-7b2d-4c1a-9e3f-0a1b2c3d4e5f"
        })
        expect(fetchMock).toHaveBeenCalled()
    })
})

describe("probe context redirect handling", () => {
    const profile = parsedProfile()

    it("blocks a response that was redirected to a loopback address", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                ok: true,
                status: 200,
                url: "https://127.0.0.1/admin",
                headers: new Headers(),
                body: null,
                text: async () => "secret"
            }))
        )
        await expect(buildProbeContext(profile).request.getText(new URL(`${ORIGIN}/manga/x`))).rejects.toBeInstanceOf(
            SourceError
        )
    })

    it("blocks a response redirected to a different public host", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({ ok: true, status: 200, url: "https://elsewhere.net/x", text: async () => "x" }))
        )
        await expect(buildProbeContext(profile).request.getText(new URL(`${ORIGIN}/manga/x`))).rejects.toMatchObject({
            code: "invalid-input"
        })
    })

    it("allows a same-origin response", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({ ok: true, status: 200, url: `${ORIGIN}/manga/y`, text: async () => "fine" }))
        )
        await expect(buildProbeContext(profile).request.getText(new URL(`${ORIGIN}/manga/x`))).resolves.toBe("fine")
    })
})
