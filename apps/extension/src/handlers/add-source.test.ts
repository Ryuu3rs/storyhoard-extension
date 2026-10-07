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

const permissions = { contains: vi.fn(), request: vi.fn(), remove: vi.fn() }
const tabs = { get: vi.fn(), query: vi.fn() }
vi.stubGlobal("browser", { permissions, tabs })

const { addSourceHandlers, addSourceFromTab, detectSource, isAddableUrl } = await import("./add-source")

const ctx: HandlerContext = { sender: {} as HandlerContext["sender"] }
const CHAPTER_URL = "https://reader.example/manga/demo-title/chapter-2"
const PROFILE_ID = "reader.example"

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
    sourceRegistry.unregister(PROFILE_ID)
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
            permissionOrigins: ["https://reader.example/*"]
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

describe("source:list and source:remove", () => {
    it("lists added sources and removes one", async () => {
        await addSourceFromTab({ url: CHAPTER_URL, tabId: 7 })

        const list = await addSourceHandlers["source:list"]!({ type: "source:list" }, ctx)
        expect(list).toEqual([{ id: PROFILE_ID, name: "Example Reader", domains: ["reader.example"] }])

        const removed = await addSourceHandlers["source:remove"]!({ type: "source:remove", id: PROFILE_ID }, ctx)
        expect(removed).toEqual({ removed: true })
        expect(sourceRegistry.get(PROFILE_ID)).toBeUndefined()
        expect(await db.archProfiles.count()).toBe(0)
    })

    it("never unregisters a bundled source through source:remove", async () => {
        expect(sourceRegistry.get("mangadex")).toBeDefined()
        const removed = await addSourceHandlers["source:remove"]!({ type: "source:remove", id: "mangadex" }, ctx)
        expect(removed).toEqual({ removed: false })
        expect(sourceRegistry.get("mangadex")).toBeDefined()
    })
})
