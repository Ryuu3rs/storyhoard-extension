import "fake-indexeddb/auto"
import { sourceRegistry } from "@amr/sources"
import { fakeBrowser } from "wxt/testing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { HandlerContext } from "../background/handler-types"
import type { LibraryManga } from "../database"

vi.stubGlobal("browser", fakeBrowser)

const { db } = await import("../database")
const { updatesSourcesHandlers } = await import("./updates-sources")
const { beginUserSourcesInit } = await import("../background/user-sources-ready")

const ctx: HandlerContext = { sender: {} as HandlerContext["sender"] }

const adapter = (id: string, domains: string[]) =>
    ({ manifest: { id, name: id, domains, capabilities: ["chapters"] } }) as unknown as ReturnType<
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

const answered = (finalUrl?: string) =>
    vi.fn(async (_url: string, _init?: RequestInit) => {
        const res = new Response(null, { status: 200 })
        if (finalUrl) Object.defineProperty(res, "url", { value: finalUrl })
        return res
    })

const ping = () =>
    updatesSourcesHandlers["sources:ping"]!({ type: "sources:ping" }, ctx) as Promise<
        Array<{ id: string; status: string }>
    >

beforeEach(async () => {
    fakeBrowser.reset()
    vi.spyOn(sourceRegistry, "list").mockReturnValue([])
    void beginUserSourcesInit(async () => undefined)
    await db.sourcePrefs.clear()
    await db.manga.clear()
    await db.versions.clear()
    await db.archProfiles.clear()
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.stubGlobal("browser", fakeBrowser)
    vi.useRealTimers()
})

describe("sources:ping only reaches public hosts the source itself answers on", () => {
    it("never requests a loopback, private-network or link-local host taken from a saved title", async () => {
        await db.manga.bulkPut([
            title("t1", "lan-a", "http://192.168.1.1/admin"),
            title("t2", "lan-b", "http://localhost:3000/x"),
            title("t3", "lan-c", "https://[::1]/x"),
            title("t4", "lan-d", "https://169.254.169.254/latest/meta-data/"),
            title("t5", "lan-e", "https://intranet/x"),
            title("t6", "lan-f", "https://10.0.0.7/x")
        ])
        const fetchMock = answered()
        vi.stubGlobal("fetch", fetchMock)

        const result = new Map((await ping()).map(r => [r.id, r.status]))

        expect(fetchMock.mock.calls.map(c => c[0])).toEqual([])
        for (const id of ["lan-a", "lan-b", "lan-c", "lan-d", "lan-e", "lan-f"]) expect(result.get(id)).toBe("unknown")
    })

    it("pings a detected site on its own domain, not on a title address outside it", async () => {
        await db.manga.put(title("t1", "detected:reader.example", "https://reader.example/s/1", "http://10.0.0.5/s/1"))
        const fetchMock = answered()
        vi.stubGlobal("fetch", fetchMock)

        await ping()

        expect(fetchMock.mock.calls.map(c => c[0])).toEqual(["https://reader.example"])
    })

    it("never pings a title host that is not one of a bundled source's domains", async () => {
        vi.mocked(sourceRegistry.list).mockReturnValue([adapter("alpha", ["alpha.example"])])
        await db.manga.put(title("t1", "alpha", "https://alpha.example/a", "https://elsewhere.example/a"))
        const fetchMock = answered()
        vi.stubGlobal("fetch", fetchMock)

        await ping()

        expect(fetchMock.mock.calls.map(c => c[0])).toEqual(["https://alpha.example"])
    })

    it("pings the domain of a source the user's titles actually use", async () => {
        vi.mocked(sourceRegistry.list).mockReturnValue([adapter("alpha", ["alpha.example", "alpha-mirror.example"])])
        await db.manga.put(title("t1", "alpha", "https://alpha-mirror.example/a"))
        const fetchMock = answered()
        vi.stubGlobal("fetch", fetchMock)

        await ping()

        expect(fetchMock.mock.calls.map(c => c[0])).toEqual(["https://alpha-mirror.example"])
    })
})

describe("sources:ping keeps the address the user's titles use", () => {
    it("pings the scheme and port of the user's title, not https on 443", async () => {
        await db.manga.put(title("t1", "gone", "http://reader.example:8080/series/1"))
        const fetchMock = answered()
        vi.stubGlobal("fetch", fetchMock)

        await ping()

        expect(fetchMock.mock.calls.map(c => c[0])).toEqual(["http://reader.example:8080"])
    })
})

describe("sources:ping treats www and the bare domain as one site", () => {
    it("a source whose titles live on www. pings that host and is live when it answers there", async () => {
        await db.manga.put(title("t1", "gone-reader", "https://www.reader-x.example/series/1"))
        const fetchMock = answered("https://www.reader-x.example/")
        vi.stubGlobal("fetch", fetchMock)

        const result = new Map((await ping()).map(r => [r.id, r.status]))

        expect(fetchMock.mock.calls.map(c => c[0])).toEqual(["https://www.reader-x.example"])
        expect(result.get("gone-reader")).toBe("live")
    })

    it("a bundled source whose bare domain redirects to its own www. host is live, not moved", async () => {
        vi.mocked(sourceRegistry.list).mockReturnValue([adapter("alpha", ["alpha-reader.example"])])
        vi.stubGlobal("fetch", answered("https://www.alpha-reader.example/"))

        const result = new Map((await ping()).map(r => [r.id, r.status]))

        expect(result.get("alpha")).toBe("live")
    })

    it("a www. domain that redirects to the bare domain is live", async () => {
        vi.mocked(sourceRegistry.list).mockReturnValue([adapter("alpha", ["www.alpha-reader.example"])])
        vi.stubGlobal("fetch", answered("https://alpha-reader.example/"))

        const result = new Map((await ping()).map(r => [r.id, r.status]))

        expect(result.get("alpha")).toBe("live")
    })

    it("still reports a redirect to an unrelated domain as moved", async () => {
        vi.mocked(sourceRegistry.list).mockReturnValue([adapter("alpha", ["alpha-reader.example"])])
        vi.stubGlobal("fetch", answered("https://www.parked.example/"))

        const result = new Map((await ping()).map(r => [r.id, r.status]))

        expect(result.get("alpha")).toBe("moved")
    })
})

describe("sources:ping network use", () => {
    it("cancels the body of the GET retry once the status is read", async () => {
        vi.mocked(sourceRegistry.list).mockReturnValue([adapter("alpha", ["alpha.example"])])
        let cancelled = false
        const body = new ReadableStream({
            cancel() {
                cancelled = true
            }
        })
        vi.stubGlobal(
            "fetch",
            vi.fn(async (_url: string, init?: RequestInit) =>
                init?.method === "HEAD" ? new Response(null, { status: 405 }) : new Response(body, { status: 200 })
            )
        )

        const result = new Map((await ping()).map(r => [r.id, r.status]))

        expect(result.get("alpha")).toBe("live")
        expect(cancelled).toBe(true)
    })

    it("checks at most four sources at a time", async () => {
        vi.mocked(sourceRegistry.list).mockReturnValue(
            Array.from({ length: 10 }, (_, i) => adapter(`s${i}`, [`s${i}.example`]))
        )
        let active = 0
        let peak = 0
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                active += 1
                peak = Math.max(peak, active)
                await new Promise(resolve => setTimeout(resolve, 5))
                active -= 1
                return new Response(null, { status: 200 })
            })
        )

        const checks = await ping()

        expect(checks).toHaveLength(10)
        expect(checks.every(c => c.status === "live")).toBe(true)
        expect(peak).toBeLessThanOrEqual(4)
    })
})
