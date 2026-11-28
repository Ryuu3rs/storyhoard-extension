import "fake-indexeddb/auto"
import { sourceRegistry } from "@amr/sources"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { HandlerContext } from "../background/handler-types"

vi.stubGlobal("browser", fakeBrowser)

const { db } = await import("../database")
const { updatesSourcesHandlers } = await import("./updates-sources")
const { beginUserSourcesInit } = await import("../background/user-sources-ready")

const ctx: HandlerContext = { sender: {} as HandlerContext["sender"] }

const adapter = (id: string, name: string, domains: string[]) =>
    ({
        manifest: { id, name, domains, capabilities: ["chapters"] }
    }) as unknown as ReturnType<typeof sourceRegistry.list>[number]

beforeEach(async () => {
    fakeBrowser.reset()
    await db.sourcePrefs.clear()
    await db.manga.clear()
})

describe("sources:list", () => {
    it("returns labels and no manifest names, and waits for added sites to register", async () => {
        const registry = [adapter("alpha", "Alpha Scans", ["alpha.example"])]
        vi.spyOn(sourceRegistry, "list").mockImplementation(() => registry)
        let finish: () => void = () => undefined
        const gate = new Promise<void>(resolve => (finish = resolve))
        void beginUserSourcesInit(async () => {
            await gate
            registry.push(adapter("late", "Late Site", ["late.example"]))
        })

        const pending = updatesSourcesHandlers["sources:list"]!({ type: "sources:list" }, ctx) as Promise<
            Array<{ id: string; label: string; name?: string }>
        >
        finish()
        const list = await pending

        expect(list.map(s => s.id)).toEqual(["alpha", "late"])
        for (const entry of list) {
            expect(entry.label).toMatch(/^Source \d+$/)
            expect(entry).not.toHaveProperty("name")
        }
        expect(JSON.stringify(list)).not.toContain("Alpha Scans")
    })
})

describe("sources:ping", () => {
    const title = (id: string, sourceId: string, url: string) => ({
        id,
        sourceId,
        sourceUrl: url,
        title: id,
        normalizedTitle: id,
        authors: [],
        status: "ongoing" as const,
        addedAt: 1,
        updatedAt: 1
    })
    const ping = () =>
        updatesSourcesHandlers["sources:ping"]!({ type: "sources:ping" }, ctx) as Promise<
            Array<{ id: string; status: string }>
        >

    beforeEach(() => {
        void beginUserSourcesInit(async () => undefined)
        vi.spyOn(sourceRegistry, "list").mockReturnValue([adapter("alpha", "Alpha Scans", ["alpha.example"])])
    })

    it("checks a source the user has titles on even when no adapter is loaded for it", async () => {
        await db.manga.put(title("t1", "gone", "https://old-reader.example/series/1"))
        const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
        vi.stubGlobal("fetch", fetchMock)

        const result = new Map((await ping()).map(r => [r.id, r.status]))

        expect(result.get("alpha")).toBe("live")
        expect(result.get("gone")).toBe("live")
        expect(fetchMock).toHaveBeenCalledWith("https://old-reader.example", expect.anything())
    })

    it("tells a refused cross-origin request apart from a dead host", async () => {
        await db.manga.bulkPut([
            title("t1", "answers", "https://answers.example/a"),
            title("t2", "down", "https://down.example/a")
        ])
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init?: RequestInit) => {
                if (url.includes("down.example")) throw new TypeError("Failed to fetch")
                if (url.includes("answers.example") && init?.mode !== "no-cors") throw new TypeError("CORS")
                return new Response(null, { status: 200 })
            })
        )

        const result = new Map((await ping()).map(r => [r.id, r.status]))

        expect(result.get("answers")).toBe("live")
        expect(result.get("down")).toBe("dead")
    })

    it("still reports a moved site instead of leaving it unchecked", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                const res = new Response(null, { status: 200 })
                Object.defineProperty(res, "url", { value: "https://parked.example/" })
                return res
            })
        )
        const result = new Map((await ping()).map(r => [r.id, r.status]))
        expect(result.get("alpha")).toBe("moved")
    })
})
