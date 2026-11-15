import "fake-indexeddb/auto"
import { sourceRegistry } from "@amr/sources"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { HandlerContext } from "./background/handler-types"

vi.stubGlobal("browser", fakeBrowser)

const { db, exportDatabase, importDatabase, putArchProfile } = await import("./database")
const { getRankedSourceOrder, listSourceLabels, moveSource, setSourceName, labelForSource } =
    await import("./source-prefs")
const { addSourceHandlers } = await import("./handlers/add-source")
const { beginUserSourcesInit } = await import("./background/user-sources-ready")
import type { LibraryManga } from "./database"

const adapter = (id: string, name: string, domains: string[]) =>
    ({ manifest: { id, name, domains } }) as unknown as ReturnType<typeof sourceRegistry.list>[number]

const REGISTRY = [
    adapter("alpha", "Alpha Scans", ["alpha.example"]),
    adapter("mangadex", "MangaDex", ["mangadex.org"]),
    adapter("zeta", "Zeta Reader", ["zeta.example"])
]

function row(id: string, sourceId: string): LibraryManga {
    return {
        id,
        sourceId,
        sourceUrl: `https://${sourceId}.example/${id}`,
        title: id,
        normalizedTitle: id,
        authors: [],
        status: "ongoing",
        addedAt: 1,
        updatedAt: 1
    }
}

const extensionCtx = (): HandlerContext => ({
    sender: { url: fakeBrowser.runtime.getURL("/app.html") } as HandlerContext["sender"]
})

beforeEach(async () => {
    fakeBrowser.reset()
    vi.spyOn(sourceRegistry, "list").mockReturnValue(REGISTRY)
    beginUserSourcesInit(async () => undefined)
    await db.sourcePrefs.clear()
    await db.manga.clear()
    await db.versions.clear()
    await db.archProfiles.clear()
})

describe("listSourceLabels", () => {
    it("numbers the sources the user has, most used first, and never uses a manifest name as a label", async () => {
        await db.manga.bulkPut([row("t1", "zeta"), row("t2", "zeta"), row("t3", "alpha")])
        const infos = await listSourceLabels()
        const used = infos.filter(i => i.used)
        expect(used.map(i => [i.id, i.label])).toEqual([
            ["zeta", "Source 1"],
            ["alpha", "Source 2"]
        ])
        for (const info of infos) expect(info.label).toMatch(/^Source \d+$/)
        expect(infos.find(i => i.id === "alpha")?.suggestion).toBe("Alpha Scans")
    })

    it("flags an official site by its domain and not a normal one", async () => {
        await db.manga.bulkPut([row("t1", "mangadex"), row("t2", "alpha")])
        const infos = await listSourceLabels()
        expect(infos.find(i => i.id === "mangadex")?.official).toBe(true)
        expect(infos.find(i => i.id === "alpha")?.official).toBe(false)
    })

    it("appends a source seen later without renumbering the others", async () => {
        await db.manga.bulkPut([row("t1", "zeta"), row("t2", "alpha")])
        const before = await listSourceLabels()
        await db.manga.put(row("t3", "mangadex"))
        const after = await listSourceLabels()
        for (const info of before.filter(i => i.used)) {
            expect(after.find(i => i.id === info.id)?.label).toBe(info.label)
        }
        expect(after.find(i => i.id === "mangadex")?.label).toBe("Source 3")
    })

    it("is stable across repeated calls", async () => {
        await db.manga.bulkPut([row("t1", "zeta"), row("t2", "alpha")])
        const first = await listSourceLabels()
        const second = await listSourceLabels()
        expect(second).toEqual(first)
    })

    it("labels an added site that has no host access (not in the registry) and marks it", async () => {
        await putArchProfile("added.example", {
            id: "added.example",
            name: "Added Example",
            domains: ["added.example"]
        })
        const infos = await listSourceLabels()
        const added = infos.find(i => i.id === "added.example")
        expect(added).toMatchObject({ registered: false, used: true, suggestion: "Added Example" })
        expect(added?.label).toMatch(/^Source \d+$/)
    })

    it("labels a detected site from its host without registering anything", async () => {
        await db.manga.put(row("t1", "detected:reader.example"))
        const info = (await listSourceLabels()).find(i => i.id === "detected:reader.example")
        expect(info?.label).toBe("Source 1")
        expect(info?.domains).toEqual(["reader.example"])
    })

    it("hides a source nothing refers to any more but keeps its place if it returns", async () => {
        await db.manga.bulkPut([row("t1", "zeta"), row("t1b", "zeta"), row("t2", "alpha")])
        await listSourceLabels()
        await db.manga.bulkDelete(["t1", "t1b"])
        vi.spyOn(sourceRegistry, "list").mockReturnValue(REGISTRY.filter(a => a.manifest.id !== "zeta"))
        const gone = await listSourceLabels()
        expect(gone.some(i => i.id === "zeta")).toBe(false)
        expect(gone.find(i => i.id === "alpha")?.label).toBe("Source 1")
        vi.spyOn(sourceRegistry, "list").mockReturnValue(REGISTRY)
        await db.manga.put(row("t1", "zeta"))
        expect((await listSourceLabels()).find(i => i.id === "zeta")?.label).toBe("Source 1")
    })
})

describe("setSourceName", () => {
    beforeEach(async () => {
        await db.manga.bulkPut([row("t1", "zeta"), row("t1b", "zeta"), row("t2", "alpha")])
    })

    it("shows the typed name and returns to the number when cleared", async () => {
        await setSourceName("alpha", "  My   mirror ")
        expect(await labelForSource("alpha")).toBe("My mirror")
        await setSourceName("alpha", "   ")
        expect(await labelForSource("alpha")).toBe("Source 2")
        await setSourceName("alpha", "Again")
        await setSourceName("alpha", null)
        expect(await labelForSource("alpha")).toBe("Source 2")
    })

    it("stores a name as plain text and caps it", async () => {
        await setSourceName("alpha", `<b>${"x".repeat(100)}</b>`)
        const label = await labelForSource("alpha")
        expect(label).not.toMatch(/[<>]/)
        expect(label.length).toBeLessThanOrEqual(40)
    })

    it("rejects an unknown source", async () => {
        await expect(setSourceName("nope", "x")).rejects.toThrow("Unknown source")
    })

    it("lets the user name a source they have not used yet", async () => {
        await setSourceName("mangadex", "Official one")
        expect(await labelForSource("mangadex")).toBe("Official one")
        expect((await listSourceLabels()).find(i => i.id === "mangadex")?.position).toBe(3)
    })
})

describe("moveSource and the ranker order", () => {
    beforeEach(async () => {
        await db.manga.bulkPut([row("t1", "zeta"), row("t2", "zeta"), row("t3", "alpha"), row("t4", "mangadex")])
    })

    it("has no ranked order until the user moves something", async () => {
        await listSourceLabels()
        expect(await getRankedSourceOrder()).toEqual([])
    })

    it("moves a source, renumbers the rest, and then ranks in the user's order", async () => {
        await moveSource("mangadex", 1)
        const used = (await listSourceLabels()).filter(i => i.used)
        expect(used.map(i => [i.id, i.label])).toEqual([
            ["mangadex", "Source 1"],
            ["zeta", "Source 2"],
            ["alpha", "Source 3"]
        ])
        expect((await getRankedSourceOrder()).slice(0, 3)).toEqual(["mangadex", "zeta", "alpha"])
    })

    it("keeps a typed name on the source as it moves", async () => {
        await setSourceName("alpha", "Mine")
        await moveSource("alpha", 1)
        expect(await labelForSource("alpha")).toBe("Mine")
        expect((await listSourceLabels())[0]?.id).toBe("alpha")
    })

    it("does not rank a source seen after the user's order was set", async () => {
        await moveSource("alpha", 1)
        await db.manga.put(row("t5", "detected:new.example"))
        await listSourceLabels()
        expect(await getRankedSourceOrder()).not.toContain("detected:new.example")
    })

    it("rejects an unknown source", async () => {
        await expect(moveSource("nope", 1)).rejects.toThrow("Unknown source")
    })
})

describe("source label handlers", () => {
    beforeEach(async () => {
        await db.manga.bulkPut([row("t1", "zeta"), row("t1b", "zeta"), row("t2", "alpha")])
    })

    it("source:labels lists the ordered labels", async () => {
        const infos = (await addSourceHandlers["source:labels"]!({ type: "source:labels" }, extensionCtx())) as {
            id: string
            label: string
        }[]
        expect(infos.filter(i => ["zeta", "alpha"].includes(i.id)).map(i => i.label)).toEqual(["Source 1", "Source 2"])
    })

    it("source:rename and source:move change the stored prefs and return the new list", async () => {
        await addSourceHandlers["source:rename"]!({ type: "source:rename", id: "alpha", name: "Mine" }, extensionCtx())
        const moved = (await addSourceHandlers["source:move"]!(
            { type: "source:move", id: "alpha", to: 1 },
            extensionCtx()
        )) as { id: string; label: string; position: number }[]
        expect(moved[0]).toMatchObject({ id: "alpha", label: "Mine", position: 1 })
    })

    it("refuses to change the order from anything but an extension page", async () => {
        const webPage = { sender: { url: "https://evil.example/" } } as HandlerContext
        await expect(
            addSourceHandlers["source:rename"]!({ type: "source:rename", id: "alpha", name: "x" }, webPage)
        ).rejects.toThrow("Not allowed")
        await expect(
            addSourceHandlers["source:move"]!({ type: "source:move", id: "alpha", to: 1 }, webPage)
        ).rejects.toThrow("Not allowed")
    })
})

describe("backup round trip", () => {
    beforeEach(async () => {
        await db.manga.bulkPut([row("t1", "zeta"), row("t1b", "zeta"), row("t2", "alpha")])
        await setSourceName("alpha", "Mine")
        await moveSource("alpha", 1)
    })

    it("exports the prefs and restores them after a wipe", async () => {
        const envelope = await exportDatabase()
        expect(envelope.data.sourcePrefs?.find(p => p.sourceId === "alpha")).toMatchObject({
            name: "Mine",
            position: 0,
            ranked: true
        })
        await db.sourcePrefs.clear()
        expect(await db.sourcePrefs.count()).toBe(0)
        await importDatabase(JSON.parse(JSON.stringify(envelope)))
        await db.manga.bulkPut([row("t1", "zeta"), row("t1b", "zeta"), row("t2", "alpha")])
        expect(await labelForSource("alpha")).toBe("Mine")
        expect((await listSourceLabels())[0]?.id).toBe("alpha")
    })

    it("sanitises imported names and drops malformed rows", async () => {
        const envelope = JSON.parse(JSON.stringify(await exportDatabase()))
        envelope.data.sourcePrefs = [
            { sourceId: "alpha", position: 0, name: "<script>alert(1)</script>" + "y".repeat(100), updatedAt: 99 },
            { sourceId: "zeta", position: -3, updatedAt: 99 },
            { sourceId: "", position: 1, updatedAt: 99 },
            { sourceId: "x", position: 1.5, updatedAt: 99 },
            "junk"
        ]
        await importDatabase(envelope)
        const rows = await db.sourcePrefs.toArray()
        const alpha = rows.find(r => r.sourceId === "alpha")!
        expect(alpha.name).not.toMatch(/[<>]/)
        expect(alpha.name!.length).toBeLessThanOrEqual(40)
        expect(rows.some(r => r.sourceId === "x" || r.sourceId === "")).toBe(false)
        expect(rows.find(r => r.sourceId === "zeta")?.position).not.toBe(-3)
    })

    it("keeps the fresher row when an import meets an existing one", async () => {
        const envelope = JSON.parse(JSON.stringify(await exportDatabase()))
        envelope.data.sourcePrefs = [{ sourceId: "alpha", position: 0, name: "Old", updatedAt: 1 }]
        await importDatabase(envelope)
        expect(await labelForSource("alpha")).toBe("Mine")
    })

    it("accepts an older backup that has no prefs", async () => {
        const envelope = JSON.parse(JSON.stringify(await exportDatabase()))
        delete envelope.data.sourcePrefs
        await expect(importDatabase(envelope)).resolves.toBeDefined()
    })
})
