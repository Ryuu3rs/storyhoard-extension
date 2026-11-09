import "fake-indexeddb/auto"
import { parseProfile } from "@amr/source-engine"
import { sourceRegistry } from "@amr/sources"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing"
import { db, exportDatabase, importDatabase, putArchProfile, type LibraryManga } from "./database"
import {
    loadSiteSessions,
    listSiteSessions,
    recordChallengedSites,
    setSiteSession,
    siteSessionOrigins
} from "./site-session"

vi.mock("./background/chapter-cache", () => ({ scheduleChapterListRefresh: vi.fn() }))
vi.mock("./settings", () => ({ getSettings: async () => ({ language: "en" }) }))

const { deleteImportedProfile, registerStoredArchProfiles } = await import("./arch-sources")
const { listMangaChapters, listChaptersBySource } = await import("./sources")
const { siteSessionHandlers } = await import("./handlers/site-session")

const ORIGIN = "https://example-scans.net"
const PROFILE_ID = "example-scans.net"
const SITE = { origin: ORIGIN, openUrl: `${ORIGIN}/manga/demo`, sampleTitle: "Demo" }

const profile = {
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
    match: { manga: "^/manga/([a-z0-9-]+)/?$", chapter: "^/manga/([a-z0-9-]+)/ch-([0-9.]+)/?$" },
    series: { urlTemplate: "/manga/{slug}", titlePattern: '<meta property="og:title" content="(?<title>[^"]+)"' },
    list: {
        itemPattern:
            '<a href="(?<chapterUrl>/manga/[a-z0-9-]+/ch-(?<chapterNumber>[0-9.]+))">(?<chapterTitle>[^<]*)</a>'
    }
}

const manga = { id: "m1", title: "Demo", sourceId: PROFILE_ID, sourceUrl: `${ORIGIN}/manga/demo` } as LibraryManga
const link = {
    mangaId: "m1",
    sourceId: PROFILE_ID,
    sourceMangaId: "demo",
    url: `${ORIGIN}/manga/demo`,
    addedAt: 1,
    updatedAt: 1
}

const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    url,
    text: async () => '<a href="/manga/demo/ch-1">One</a>'
}))

// The client caches a response per source for a minute, so each call asks for its own title.
let titleCounter = 0
function freshLink() {
    titleCounter += 1
    return { ...link, sourceMangaId: `demo${titleCounter}`, url: `${ORIGIN}/manga/demo${titleCounter}` }
}

function lastCredentials() {
    return fetchMock.mock.calls.at(-1)?.[1]?.credentials
}

beforeEach(async () => {
    await fakeBrowser.storage.local.clear()
    await db.archProfiles.clear()
    await db.manga.clear()
    fetchMock.mockClear()
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("browser", {
        ...fakeBrowser,
        storage: fakeBrowser.storage,
        runtime: { ...fakeBrowser.runtime, getURL: (p: string) => `chrome-extension://self/${p}` },
        permissions: {
            getAll: vi.fn(async () => ({ origins: [] as string[] })),
            contains: vi.fn(async () => true),
            remove: vi.fn(async () => true)
        }
    })
    await loadSiteSessions()
})

afterEach(() => {
    sourceRegistry.unregister(PROFILE_ID)
    vi.unstubAllGlobals()
})

describe("the per-site session setting", () => {
    it("is off by default", async () => {
        await recordChallengedSites([SITE])
        expect(siteSessionOrigins()).toEqual([])
        expect(await listSiteSessions()).toEqual([{ ...SITE, enabled: false }])
    })

    it("cannot be turned on for a site no check saw a challenge from", async () => {
        expect(await setSiteSession(ORIGIN, true)).toBe(false)
        expect(siteSessionOrigins()).toEqual([])
    })

    it("turns on after a challenge and is revocable", async () => {
        await recordChallengedSites([SITE])
        expect(await setSiteSession(ORIGIN, true)).toBe(true)
        expect(siteSessionOrigins()).toEqual([ORIGIN])
        expect((await listSiteSessions())[0]?.enabled).toBe(true)
        expect(await setSiteSession(ORIGIN, false)).toBe(true)
        expect(siteSessionOrigins()).toEqual([])
        expect((await listSiteSessions())[0]?.enabled).toBe(false)
    })

    it("survives a worker restart", async () => {
        await recordChallengedSites([SITE])
        await setSiteSession(ORIGIN, true)
        await loadSiteSessions()
        expect(siteSessionOrigins()).toEqual([ORIGIN])
    })

    it("only ever names a canonical https origin", async () => {
        await recordChallengedSites([
            { ...SITE, origin: "http://plain.example" },
            { ...SITE, origin: "https://site.example/path" },
            { ...SITE, origin: "not a url" }
        ])
        expect(await listSiteSessions()).toEqual([])
        for (const origin of ["http://plain.example", "https://site.example/path", "not a url"]) {
            expect(await setSiteSession(origin, true)).toBe(false)
        }
    })

    it("ignores a stored choice for a site no check saw, so a tampered store does not switch it on", async () => {
        await browser.storage.local.set({ siteSessions: { seen: {}, enabled: { [ORIGIN]: 1 } } })
        await loadSiteSessions()
        expect(siteSessionOrigins()).toEqual([])
    })

    it("is dropped with the site when the user removes it", async () => {
        await putArchProfile(PROFILE_ID, profile, "user")
        await registerStoredArchProfiles()
        await recordChallengedSites([SITE])
        await setSiteSession(ORIGIN, true)
        expect(await deleteImportedProfile(PROFILE_ID)).toBe(true)
        expect(siteSessionOrigins()).toEqual([])
    })
})

describe("an imported profile can never turn the session on", () => {
    it("rejects a profile that carries any such field", () => {
        for (const field of ["sendCredentials", "useBrowserSession", "credentials", "cookies", "sessionOrigins"]) {
            expect(parseProfile({ ...profile, [field]: true }).ok).toBe(false)
        }
    })

    it("has no such field in the profile format at all", () => {
        const here = path.dirname(fileURLToPath(import.meta.url))
        const schema = readFileSync(path.join(here, "../../../packages/source-engine/src/profile-schema.ts"), "utf8")
        const fields = [...schema.matchAll(/^\s*([a-zA-Z]+)\s*:/gm)].map(match => match[1] ?? "")
        expect(fields.filter(field => /session|credential|cookie/i.test(field))).toEqual([])
    })

    it("stays cookieless after importing and registering a profile, and writes no choice", async () => {
        await putArchProfile(PROFILE_ID, profile, "user")
        await registerStoredArchProfiles()

        await listMangaChapters(manga, freshLink(), "en", { onChallenge: () => undefined })

        expect(lastCredentials()).toBe("omit")
        expect(siteSessionOrigins()).toEqual([])
        expect(await fakeBrowser.storage.local.get("siteSessions")).toEqual({})
    })

    it("a restored backup that names the setting changes nothing", async () => {
        const envelope = (await exportDatabase()) as unknown as { data: Record<string, unknown> }
        const hostile = { seen: { [ORIGIN]: SITE }, enabled: { [ORIGIN]: 1 } }
        await importDatabase({ ...envelope, siteSessions: hostile, data: { ...envelope.data, siteSessions: hostile } })
        await loadSiteSessions()
        expect(siteSessionOrigins()).toEqual([])
        expect(await fakeBrowser.storage.local.get("siteSessions")).toEqual({})
    })
})

describe("what a turned-on session reaches", () => {
    beforeEach(async () => {
        await putArchProfile(PROFILE_ID, profile, "user")
        await registerStoredArchProfiles()
    })

    it("is off for an update check until the user turns it on, then on, then off again", async () => {
        const check = { onChallenge: () => undefined }
        await listMangaChapters(manga, freshLink(), "en", check)
        expect(lastCredentials()).toBe("omit")

        await recordChallengedSites([SITE])
        await setSiteSession(ORIGIN, true)
        await listMangaChapters(manga, freshLink(), "en", check)
        expect(lastCredentials()).toBe("include")

        await setSiteSession(ORIGIN, false)
        await listMangaChapters(manga, freshLink(), "en", check)
        expect(lastCredentials()).toBe("omit")
    })

    it("is never used outside an update check", async () => {
        await recordChallengedSites([SITE])
        await setSiteSession(ORIGIN, true)
        await listMangaChapters(manga, freshLink(), "en")
        expect(lastCredentials()).toBe("omit")
        await listChaptersBySource(PROFILE_ID, "demo5", `${ORIGIN}/manga/demo5`)
        expect(lastCredentials()).toBe("omit")
    })
})

describe("the site-session messages", () => {
    const fromPage = { sender: { url: "https://some-site.example/page", tab: { id: 1 } } } as never
    const fromApp = { sender: { url: "chrome-extension://self/app.html" } } as never
    const set = siteSessionHandlers["site-session:set"]!
    const list = siteSessionHandlers["site-session:list"]!

    it("refuses a content script, whatever it claims", async () => {
        await recordChallengedSites([SITE])
        await expect(set({ type: "site-session:set", origin: ORIGIN, enabled: true }, fromPage)).resolves.toEqual({
            applied: false
        })
        await expect(list({ type: "site-session:list" }, fromPage)).resolves.toEqual([])
        expect(siteSessionOrigins()).toEqual([])
    })

    it("works from the extension's own page", async () => {
        await recordChallengedSites([SITE])
        await expect(set({ type: "site-session:set", origin: ORIGIN, enabled: true }, fromApp)).resolves.toEqual({
            applied: true
        })
        await expect(list({ type: "site-session:list" }, fromApp)).resolves.toEqual([{ ...SITE, enabled: true }])
    })
})
