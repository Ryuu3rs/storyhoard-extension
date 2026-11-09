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
