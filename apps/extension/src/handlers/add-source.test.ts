import "fake-indexeddb/auto"
import { sourceRegistry } from "@amr/sources"
import type { CaptureSignals, SiteProfile } from "@amr/source-engine"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { HandlerContext } from "../background/handler-types"
import { db } from "../database"

const captureTabSignalsMock = vi.fn()
vi.mock("../arch-sources", async importOriginal => ({
    ...(await importOriginal<typeof import("../arch-sources")>()),
    captureTabSignals: (...args: unknown[]) => captureTabSignalsMock(...args)
}))

const probeSourceMock = vi.fn()
vi.mock("@amr/source-engine", async importOriginal => ({
    ...(await importOriginal<typeof import("@amr/source-engine")>()),
    probeSource: (...args: unknown[]) => probeSourceMock(...args)
}))

vi.mock("../background/chapter-cache", () => ({ scheduleChapterListRefresh: vi.fn() }))
vi.mock("../settings", () => ({ getSettings: async () => ({ language: "en" }) }))

const injectPanelForTabMock = vi.fn()
vi.mock("../background/panel-injection", () => ({
    injectPanelForTab: (...args: unknown[]) => injectPanelForTabMock(...args)
}))

// Only the hand-made recognition-only fixture below counts as a committed seed profile.
vi.mock("../migration/seed-profiles", async importOriginal => ({
    ...(await importOriginal<typeof import("../migration/seed-profiles")>()),
    isCommittedSeedProfile: (profile: { id?: string }) => profile?.id === "seed.example"
}))

const permissions = { contains: vi.fn(), request: vi.fn(), remove: vi.fn() }
const tabs = { get: vi.fn(), query: vi.fn() }
vi.stubGlobal("browser", { permissions, tabs })

const { addSourceHandlers, addSourceFromTab, detectSource } = await import("./add-source")
const { isAddableUrl } = await import("../source-scope")
const { beginUserSourcesInit } = await import("../background/user-sources-ready")
const { isTrackingOnlySource, registerProfile } = await import("../arch-sources")
const { putArchProfile } = await import("../database")
const { parseProfile } = await import("@amr/source-engine")

const ctx: HandlerContext = { sender: {} as HandlerContext["sender"] }
const CHAPTER_URL = "https://reader.example/manga/demo-title/chapter-2"
const PROFILE_ID = "reader.example"
const SEED_ID = "seed.example"
const WWW_CHAPTER_URL = "https://www.reader.example/manga/demo-title/chapter-2"
const SEED_CHAPTER_URL = "https://seed.example/manga/demo-title/chapter-2"

const signals: CaptureSignals = {
    url: CHAPTER_URL,
    ogTitle: "Demo Title Chapter 2 | Example Reader",
    ogSiteName: "Example Reader",
    links: [
        { href: "/manga/demo-title/chapter-1", text: "Prev" },
        { href: "/manga/demo-title/chapter-3", text: "Next" }
    ],
    images: []
}

function acceptingProbe(): void {
    probeSourceMock.mockImplementation(async (profile: SiteProfile) => ({
        ok: true,
        effectiveOrigin: profile.origin,
        originCorrected: false,
        profile,
        stages: [{ stage: "chapters", ok: true, detail: "2 chapter(s)" }]
    }))
}

beforeEach(async () => {
    vi.clearAllMocks()
    beginUserSourcesInit(async () => undefined)
    injectPanelForTabMock.mockResolvedValue(true)
    sourceRegistry.unregister(PROFILE_ID)
    sourceRegistry.unregister(SEED_ID)
    await db.archProfiles.clear()
    tabs.get.mockResolvedValue({ id: 7, url: CHAPTER_URL })
    tabs.query.mockResolvedValue([{ id: 7, url: CHAPTER_URL }])
    permissions.contains.mockResolvedValue(false)
    permissions.request.mockResolvedValue(true)
    permissions.remove.mockResolvedValue(true)
    captureTabSignalsMock.mockResolvedValue(signals)
    acceptingProbe()
})

describe("isAddableUrl", () => {
    it("accepts a public https site", () => {
        expect(isAddableUrl(new URL(CHAPTER_URL))).toBe(true)
    })

    it.each([
        "http://reader.example/manga/a/chapter-1",
        "https://localhost/manga/a/chapter-1",
        "https://192.168.1.5/manga/a/chapter-1",
        "https://[::1]/manga/a/chapter-1",
        "https://reader.example:8443/manga/a/chapter-1",
        "https://printer.local/manga/a/chapter-1",
        "https://singlelabel/manga/a/chapter-1",
        "https://weeb.ltd/manga/a/chapter-1",
        "https://www.weeb.ltd/manga/a/chapter-1"
    ])("rejects %s", raw => {
        expect(isAddableUrl(new URL(raw))).toBe(false)
    })
})

describe("source:detect", () => {
    it("reports nothing for a page that does not look like a chapter", async () => {
        expect(await detectSource({ url: "https://reader.example/about" })).toEqual({ status: "none" })
    })

    it("reports an already-supported site as known", async () => {
        const result = await detectSource({ url: "https://mangadex.org/chapter/3f1a5c8e-7b2d-4c1a-9e3f-0a1b2c3d4e5f" })
        expect(result.status).toBe("known")
    })

    it("infers the site from the url alone when host access is not held yet", async () => {
        const result = await detectSource({ url: CHAPTER_URL, tabId: 7 })
        expect(captureTabSignalsMock).not.toHaveBeenCalled()
        expect(result).toMatchObject({
            status: "found",
            domain: "reader.example",
            origin: "https://reader.example",
            matchOk: true,
            upgrade: false,
            permissionOrigins: ["https://reader.example/*", "https://www.reader.example/*"]
        })
    })

    it("inspects the page when host access is already held", async () => {
        permissions.contains.mockResolvedValue(true)
        const result = await detectSource({ url: CHAPTER_URL, tabId: 7 })
        expect(captureTabSignalsMock).toHaveBeenCalledWith(7)
        expect(result).toMatchObject({ status: "found", name: "Example Reader", matchOk: true })
    })

    it("flags matchOk false when the inspected page does not support the inferred shape", async () => {
        permissions.contains.mockResolvedValue(true)
        captureTabSignalsMock.mockResolvedValue({ ...signals, links: [{ href: "/about", text: "About" }] })
        const result = await detectSource({ url: CHAPTER_URL, tabId: 7 })
        expect(result).toMatchObject({ status: "found", matchOk: false })
    })
})

describe("source:add-from-tab", () => {
    it("requests access, then persists and registers the profile", async () => {
        const result = await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })

        expect(result).toEqual({ ok: true, id: PROFILE_ID, name: "Example Reader", domain: "reader.example" })
        expect(permissions.request).toHaveBeenCalledWith({ origins: ["https://reader.example/*"] })
        expect(sourceRegistry.get(PROFILE_ID)).toBeDefined()
        const stored = await db.archProfiles.get(PROFILE_ID)
        expect((stored?.profile as { name: string }).name).toBe("Example Reader")
        expect(probeSourceMock.mock.calls[0]![2]).toEqual({ seriesUrl: "https://reader.example/manga/demo-title" })
    })

    it("does not ask again when access is already held", async () => {
        permissions.contains.mockResolvedValue(true)
        const result = await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })
        expect(result.ok).toBe(true)
        expect(permissions.request).not.toHaveBeenCalled()
    })

    it("registers nothing when the user denies the permission", async () => {
        permissions.request.mockResolvedValue(false)

        const result = await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })

        expect(result).toMatchObject({ ok: false, reason: "permission" })
        expect(captureTabSignalsMock).not.toHaveBeenCalled()
        expect(probeSourceMock).not.toHaveBeenCalled()
        expect(sourceRegistry.get(PROFILE_ID)).toBeUndefined()
        expect(await db.archProfiles.count()).toBe(0)
    })

    it("registers nothing, and gives the access back, when the live check fails", async () => {
        probeSourceMock.mockResolvedValue({ ok: false, stages: [], profile: {} })

        const result = await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })

        expect(result).toMatchObject({ ok: false, reason: "unverified" })
        expect(sourceRegistry.get(PROFILE_ID)).toBeUndefined()
        expect(await db.archProfiles.count()).toBe(0)
        expect(permissions.remove).toHaveBeenCalledWith({ origins: ["https://reader.example/*"] })
    })

    it("keeps pre-existing access when the live check fails", async () => {
        permissions.contains.mockResolvedValue(true)
        probeSourceMock.mockResolvedValue({ ok: false, stages: [], profile: {} })
        await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })
        expect(permissions.remove).not.toHaveBeenCalled()
    })

    it("revokes what the popup granted, on any failed add, when the caller says it granted it", async () => {
        permissions.contains.mockResolvedValue(true)
        probeSourceMock.mockResolvedValue({ ok: false, stages: [], profile: {} })

        const result = await addSourceFromTab({ url: CHAPTER_URL, tabId: 7, grantedByCaller: true })

        expect(result).toMatchObject({ ok: false })
        expect(permissions.remove).toHaveBeenCalledWith({
            origins: ["https://reader.example/*", "https://www.reader.example/*"]
        })
    })

    it("revokes the caller's grant when the page cannot be read", async () => {
        permissions.contains.mockResolvedValue(true)
        captureTabSignalsMock.mockResolvedValue(undefined)

        await addSourceFromTab({ url: CHAPTER_URL, tabId: 7, grantedByCaller: true })

        expect(permissions.remove).toHaveBeenCalledWith({
            origins: ["https://reader.example/*", "https://www.reader.example/*"]
        })
    })

    it("never revokes access the caller did not grant, even when the add fails", async () => {
        permissions.contains.mockResolvedValue(true)
        probeSourceMock.mockResolvedValue({ ok: false, stages: [], profile: {} })

        await addSourceFromTab({ url: CHAPTER_URL, tabId: 7, grantedByCaller: false })

        expect(permissions.remove).not.toHaveBeenCalled()
    })

    it("keeps the caller's grant when the add succeeds", async () => {
        permissions.contains.mockResolvedValue(true)

        const result = await addSourceFromTab({ url: CHAPTER_URL, tabId: 7, grantedByCaller: true })

        expect(result.ok).toBe(true)
        expect(permissions.remove).not.toHaveBeenCalled()
    })

    it("refuses when the tab is no longer on the page the user clicked from", async () => {
        tabs.get.mockResolvedValue({ id: 7, url: "https://reader.example/manga/demo-title/chapter-9" })
        const result = await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })
        expect(result).toMatchObject({ ok: false, reason: "tab" })
        expect(permissions.request).not.toHaveBeenCalled()
    })

    it("refuses a page that is not a chapter page", async () => {
        tabs.get.mockResolvedValue({ id: 7, url: "https://reader.example/about" })
        captureTabSignalsMock.mockResolvedValue({ ...signals, url: "https://reader.example/about" })
        const result = await addSourceFromTab({ url: "https://reader.example/about", tabId: 7 })
        expect(result).toMatchObject({ ok: false, reason: "not-reader" })
        expect(await db.archProfiles.count()).toBe(0)
    })

    it("refuses a local or first-party origin before asking for any access", async () => {
        const result = await addSourceFromTab({ url: "https://localhost/manga/a/chapter-1", tabId: 7 })
        expect(result).toMatchObject({ ok: false, reason: "unsupported" })
        expect(permissions.request).not.toHaveBeenCalled()
    })

    it("refuses a site that is already supported", async () => {
        const url = "https://mangadex.org/chapter/3f1a5c8e-7b2d-4c1a-9e3f-0a1b2c3d4e5f"
        const result = await addSourceFromTab({ url, tabId: 7 })
        expect(result).toMatchObject({ ok: false, reason: "unsupported" })
        expect(permissions.request).not.toHaveBeenCalled()
    })

    it("fails cleanly when the page cannot be read", async () => {
        captureTabSignalsMock.mockResolvedValue(undefined)
        const result = await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })
        expect(result).toMatchObject({ ok: false, reason: "unreadable" })
        expect(permissions.remove).toHaveBeenCalled()
    })
})

describe("source:add-from-tab revalidates what was actually captured", () => {
    it.each([
        ["another site", "https://other-reader.example/manga/demo-title/chapter-2"],
        ["a loopback address", "https://127.0.0.1/manga/demo-title/chapter-2"],
        ["a first-party origin", "https://weeb.ltd/manga/demo-title/chapter-2"],
        ["a supported source", "https://mangadex.org/chapter/3f1a5c8e-7b2d-4c1a-9e3f-0a1b2c3d4e5f"],
        ["a different scheme", "http://reader.example/manga/demo-title/chapter-2"]
    ])("aborts when the tab navigated to %s between the click and the capture", async (_name, navigated) => {
        captureTabSignalsMock.mockResolvedValue({ ...signals, url: navigated })

        const result = await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })

        expect(result).toMatchObject({ ok: false, reason: "tab" })
        expect(probeSourceMock).not.toHaveBeenCalled()
        expect(sourceRegistry.get(PROFILE_ID)).toBeUndefined()
        expect(await db.archProfiles.count()).toBe(0)
        expect(permissions.remove).toHaveBeenCalledWith({ origins: ["https://reader.example/*"] })
    })

    it("does not trust captured signals from another origin when only detecting", async () => {
        permissions.contains.mockResolvedValue(true)
        captureTabSignalsMock.mockResolvedValue({
            ...signals,
            url: "https://other-reader.example/manga/demo-title/chapter-2",
            ogSiteName: "Other Reader"
        })
        const result = await detectSource({ url: CHAPTER_URL, tabId: 7 })
        expect(result).toMatchObject({ status: "found", origin: "https://reader.example" })
        expect((result as { name: string }).name).not.toBe("Other Reader")
    })

    it("refuses a profile the probe moved outside the validated origin", async () => {
        probeSourceMock.mockImplementation(async (profile: SiteProfile) => ({
            ok: true,
            effectiveOrigin: "https://127.0.0.1",
            originCorrected: true,
            profile: {
                ...profile,
                origin: "https://127.0.0.1",
                domains: ["127.0.0.1"],
                origins: ["https://127.0.0.1/*"]
            },
            stages: [{ stage: "chapters", ok: true, detail: "2 chapter(s)" }]
        }))

        const result = await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })

        expect(result).toMatchObject({ ok: false, reason: "unsupported" })
        expect(sourceRegistry.get(PROFILE_ID)).toBeUndefined()
        expect(await db.archProfiles.count()).toBe(0)
    })

    it("marks the stored row as user-added", async () => {
        await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })
        expect((await db.archProfiles.get(PROFILE_ID))?.origin).toBe("user")
    })

    it("a site is never treated as addable once it matches a bundled source", async () => {
        expect(
            await detectSource({ url: "https://mangadex.org/chapter/3f1a5c8e-7b2d-4c1a-9e3f-0a1b2c3d4e5f" })
        ).toMatchObject({
            status: "known"
        })
    })
})

describe("source:list and source:remove", () => {
    it("lists added sources and removes one", async () => {
        await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })

        const list = await addSourceHandlers["source:list"]!({ type: "source:list" }, ctx)
        expect(list).toEqual([
            { id: PROFILE_ID, name: "Example Reader", domains: ["reader.example", "www.reader.example"] }
        ])

        const removed = await addSourceHandlers["source:remove"]!({ type: "source:remove", id: PROFILE_ID }, ctx)
        expect(removed).toEqual({ removed: true })
        expect(sourceRegistry.get(PROFILE_ID)).toBeUndefined()
        expect(await db.archProfiles.count()).toBe(0)
        expect(permissions.remove).toHaveBeenCalledWith({
            origins: ["https://reader.example/*", "https://www.reader.example/*"]
        })
    })

    it("never unregisters a bundled source through source:remove", async () => {
        expect(sourceRegistry.get("mangadex")).toBeDefined()
        const removed = await addSourceHandlers["source:remove"]!({ type: "source:remove", id: "mangadex" }, ctx)
        expect(removed).toEqual({ removed: false })
        expect(sourceRegistry.get("mangadex")).toBeDefined()
    })
})

describe("cold start: the added sites are re-registered before a decision", () => {
    it("holds source:detect and source:add-from-tab until registration has finished", async () => {
        let release!: () => void
        beginUserSourcesInit(
            () =>
                new Promise<void>(resolve => {
                    release = resolve
                })
        )
        let detected = false
        const detecting = detectSource({ url: CHAPTER_URL, tabId: 7 }).then(result => {
            detected = true
            return result
        })
        let added = false
        const adding = addSourceFromTab({ url: CHAPTER_URL, tabId: 7 }).then(result => {
            added = true
            return result
        })

        await new Promise(resolve => setTimeout(resolve, 20))
        expect(detected).toBe(false)
        expect(added).toBe(false)
        expect(permissions.request).not.toHaveBeenCalled()

        release()
        expect((await detecting).status).toBe("found")
        expect((await adding).ok).toBe(true)
    })

    it("sees an already-added site as known once registration is done, and refuses to add it again", async () => {
        await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })
        expect(await detectSource({ url: CHAPTER_URL, tabId: 7 })).toMatchObject({ status: "known" })
        const again = await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })
        expect(again).toMatchObject({ ok: false, reason: "unsupported", message: "This site is already added." })
    })
})

describe("source:add-from-tab live check", () => {
    it("falls back to reading the series page through a tab when the plain fetch is blocked", async () => {
        probeSourceMock
            .mockResolvedValueOnce({
                ok: false,
                stages: [{ stage: "series", ok: false, detail: "Request failed with status 403" }],
                profile: {}
            })
            .mockImplementationOnce(async (profile: SiteProfile) => ({
                ok: true,
                effectiveOrigin: profile.origin,
                originCorrected: false,
                profile,
                stages: [{ stage: "chapters", ok: true, detail: "2 chapter(s)" }]
            }))

        const result = await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })

        expect(result).toMatchObject({ ok: true, id: PROFILE_ID })
        expect(probeSourceMock).toHaveBeenCalledTimes(2)
        expect(sourceRegistry.get(PROFILE_ID)).toBeDefined()
    })

    it("says the site blocks background reading when both the fetch and the tab are refused", async () => {
        probeSourceMock.mockResolvedValue({
            ok: false,
            stages: [{ stage: "series", ok: false, detail: "Request failed with status 403" }],
            profile: {}
        })

        const result = await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })

        expect(probeSourceMock).toHaveBeenCalledTimes(2)
        expect(result).toMatchObject({ ok: false, reason: "blocked" })
        expect((result as { message: string }).message).toContain("blocks background reading")
        expect(sourceRegistry.get(PROFILE_ID)).toBeUndefined()
        expect(permissions.remove).toHaveBeenCalled()
    })

    it("says no chapter list was found when the page loads but lists nothing", async () => {
        probeSourceMock.mockResolvedValue({
            ok: false,
            stages: [
                { stage: "series", ok: true, detail: "Demo" },
                { stage: "chapters", ok: false, detail: "0 chapter(s)" }
            ],
            profile: {}
        })

        const result = await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })

        expect(result).toMatchObject({ ok: false, reason: "unverified" })
        expect((result as { message: string }).message).toContain("no chapter list")
    })

    it("gives a specific message when the page is not a chapter or cannot be read", async () => {
        tabs.get.mockResolvedValue({ id: 7, url: "https://reader.example/about" })
        captureTabSignalsMock.mockResolvedValue({ ...signals, url: "https://reader.example/about" })
        const notReader = await addSourceFromTab({ url: "https://reader.example/about", tabId: 7 })
        expect((notReader as { message: string }).message).toContain("Open a chapter")

        captureTabSignalsMock.mockResolvedValue(undefined)
        tabs.get.mockResolvedValue({ id: 7, url: CHAPTER_URL })
        const unreadable = await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })
        expect((unreadable as { message: string }).message).toContain("finish loading")
    })

    it("puts the panel on the page straight after a successful add", async () => {
        await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })
        expect(injectPanelForTabMock).toHaveBeenCalledWith(7, CHAPTER_URL)
    })

    it("does not inject the panel when the add fails", async () => {
        probeSourceMock.mockResolvedValue({ ok: false, stages: [], profile: {} })
        await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })
        expect(injectPanelForTabMock).not.toHaveBeenCalled()
    })
})

describe("www and apex addresses of one site", () => {
    it("an apex add also covers its www twin", async () => {
        await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })
        const stored = await db.archProfiles.get(PROFILE_ID)
        expect((stored?.profile as { domains: string[] }).domains).toEqual(["reader.example", "www.reader.example"])

        tabs.get.mockResolvedValue({ id: 7, url: WWW_CHAPTER_URL })
        const fromWww = await addSourceFromTab({ url: WWW_CHAPTER_URL, tabId: 7 })
        expect(fromWww).toMatchObject({ ok: false, message: "This site is already added." })
        expect(await db.archProfiles.count()).toBe(1)
    })

    it("a site added from www is never overwritten by adding its apex address", async () => {
        tabs.get.mockResolvedValue({ id: 7, url: WWW_CHAPTER_URL })
        captureTabSignalsMock.mockResolvedValue({ ...signals, url: WWW_CHAPTER_URL })
        const first = await addSourceFromTab({ url: WWW_CHAPTER_URL, tabId: 7 })
        expect(first.ok).toBe(true)
        const before = await db.archProfiles.get(PROFILE_ID)

        tabs.get.mockResolvedValue({ id: 7, url: CHAPTER_URL })
        captureTabSignalsMock.mockResolvedValue(signals)
        const second = await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })

        expect(second).toMatchObject({ ok: false, reason: "unsupported" })
        expect((second as { message: string }).message).toContain("other address")
        expect(await db.archProfiles.get(PROFILE_ID)).toEqual(before)
        expect(sourceRegistry.get(PROFILE_ID)?.manifest.domains).toEqual(["www.reader.example"])
    })
})

function seedProfile(): SiteProfile {
    const parsed = parseProfile({
        profileFormat: 2,
        id: SEED_ID,
        name: "Seed Reader",
        engine: "generic",
        numberingKind: "chapter",
        origin: "https://seed.example",
        domains: ["seed.example"],
        languages: ["en"],
        capabilities: ["manga"],
        requestRateLimit: { requests: 3, intervalMs: 1000 },
        origins: ["https://seed.example/*"],
        match: { manga: "^/manga/([^/]+)/?$" },
        series: { titlePattern: "<title>(?<title>[^<]+)</title>" }
    })
    if (!parsed.ok) throw new Error("fixture profile must parse")
    return parsed.profile
}

describe("upgrading a tracking-only seeded stand-in", () => {
    async function installSeed(origin: "seed" | "user" = "seed"): Promise<void> {
        const profile = seedProfile()
        await putArchProfile(SEED_ID, profile, origin)
        expect(registerProfile(profile)).toBe(true)
        tabs.get.mockResolvedValue({ id: 7, url: SEED_CHAPTER_URL })
        captureTabSignalsMock.mockResolvedValue({
            ...signals,
            url: SEED_CHAPTER_URL,
            ogSiteName: "Seed Site"
        })
    }

    it("flags a list-less profile source as tracking only", async () => {
        await installSeed()
        expect(isTrackingOnlySource(SEED_ID)).toBe(true)
    })

    it("offers the upgrade on detect instead of reporting the site as already supported", async () => {
        await installSeed()
        const result = await detectSource({ url: SEED_CHAPTER_URL, tabId: 7 })
        expect(result).toMatchObject({ status: "found", upgrade: true, name: "Seed Reader" })
    })

    it("replaces the seed row with a working user profile under the same id, keeping library rows resolving", async () => {
        await installSeed()

        const result = await addSourceFromTab({ url: SEED_CHAPTER_URL, tabId: 7 })

        expect(result).toMatchObject({ ok: true, id: SEED_ID, name: "Seed Reader", upgraded: true })
        const row = await db.archProfiles.get(SEED_ID)
        expect(row?.origin).toBe("user")
        expect((row?.profile as { list?: unknown }).list).toBeDefined()
        expect(isTrackingOnlySource(SEED_ID)).toBe(false)
        expect(sourceRegistry.get(SEED_ID)).toBeDefined()
        expect(await db.archProfiles.count()).toBe(1)
    })

    it("never replaces a user-added profile, even one without a chapter list", async () => {
        await installSeed("user")
        const result = await addSourceFromTab({ url: SEED_CHAPTER_URL, tabId: 7 })
        expect(result).toMatchObject({ ok: false, message: "This site is already added." })
        expect((await db.archProfiles.get(SEED_ID))?.origin).toBe("user")
        expect(probeSourceMock).not.toHaveBeenCalled()
    })

    it("never replaces a bundled adapter", async () => {
        const result = await addSourceFromTab({
            url: "https://mangadex.org/chapter/3f1a5c8e-7b2d-4c1a-9e3f-0a1b2c3d4e5f",
            tabId: 7
        })
        expect(result).toMatchObject({ ok: false, reason: "unsupported" })
        expect(sourceRegistry.get("mangadex")).toBeDefined()
    })
})

describe("source:tracking-only", () => {
    it("lists the profile sources that cannot list chapters", async () => {
        registerProfile(seedProfile())

        const ids = await addSourceHandlers["source:tracking-only"]!({ type: "source:tracking-only" }, ctx)

        expect(ids).toContain(SEED_ID)
        expect(ids).not.toContain("mangadex")
    })
})
