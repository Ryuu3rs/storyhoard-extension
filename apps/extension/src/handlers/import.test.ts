import "fake-indexeddb/auto"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("browser", fakeBrowser)

const { db } = await import("../database")
const { importHandlers } = await import("./import")

const ctx = { sender: {} as never }

// minimal protobuf encoder (matches the wire format the reader decodes) - raw (not gzipped),
// so the handler's maybeGunzip falls through without needing DecompressionStream in the test env.
function varint(n: number): number[] {
    let v = BigInt(n)
    const out: number[] = []
    do {
        let b = Number(v & 0x7fn)
        v >>= 7n
        if (v) b |= 0x80
        out.push(b)
    } while (v)
    return out
}
const tag = (f: number, w: number) => varint((f << 3) | w)
const lenDelim = (f: number, b: number[]) => [...tag(f, 2), ...varint(b.length), ...b]
const strF = (f: number, s: string) => lenDelim(f, [...new TextEncoder().encode(s)])
const varF = (f: number, n: number) => [...tag(f, 0), ...varint(n)]
function f32F(f: number, n: number): number[] {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setFloat32(0, n, true)
    return [...tag(f, 5), ...b]
}

function backupB64(): string {
    const tracked = [
        ...strF(3, "Solo Leveling"),
        ...varF(8, 2),
        ...lenDelim(16, [...varF(4, 1), ...f32F(9, 7)]), // one read chapter, number 7
        ...lenDelim(18, [...varF(1, 2), ...varF(100, 222)]) // AniList tracker, media id 222
    ]
    const trackingOnly = [...strF(3, "Some Manhwa With No Tracker")]
    const bytes = new Uint8Array([...lenDelim(1, tracked), ...lenDelim(1, trackingOnly)])
    let bin = ""
    for (const b of bytes) bin += String.fromCharCode(b)
    return btoa(bin)
}

beforeEach(async () => {
    fakeBrowser.reset()
    await db.manga.clear()
})

describe("import:reader (mihon)", () => {
    it("previews without writing", async () => {
        const res = (await importHandlers["import:reader"]!(
            { type: "import:reader", format: "mihon", dataB64: backupB64(), preview: true },
            ctx
        )) as { preview: boolean; total: number; withAniList: number; trackingOnly: number }
        expect(res).toMatchObject({ preview: true, total: 2, withAniList: 1, trackingOnly: 1 })
        expect(await db.manga.count()).toBe(0)
    })

    it("imports tracked + tracking-only rows and dedups on re-import", async () => {
        const dataB64 = backupB64()
        const first = (await importHandlers["import:reader"]!(
            { type: "import:reader", format: "mihon", dataB64, preview: false },
            ctx
        )) as { imported: number; skipped: number }
        expect(first.imported).toBe(2)

        const tracked = await db.manga.get("anilist:manga:222")
        expect(tracked?.title).toBe("Solo Leveling")
        expect(tracked?.anilistId).toBe(222)
        expect(tracked?.lastReadChapterNumber).toBe(7)
        expect(tracked?.status).toBe("completed")
        const trackingOnly = await db.manga.get("import:manga:some manhwa with no tracker")
        expect(trackingOnly).toBeTruthy()

        // Re-importing the same backup adds nothing (dedup by anilistId + normalized title).
        const second = (await importHandlers["import:reader"]!(
            { type: "import:reader", format: "mihon", dataB64, preview: false },
            ctx
        )) as { imported: number; skipped: number }
        expect(second.imported).toBe(0)
        expect(second.skipped).toBe(2)
        expect(await db.manga.count()).toBe(2)
    })

    it("rejects an unknown format", async () => {
        await expect(
            importHandlers["import:reader"]!({ type: "import:reader", format: "nope", dataB64: "AA==" }, ctx)
        ).rejects.toThrow(/Unknown import format/)
    })
})

describe("import:reader keeps rows restorable", () => {
    it("drops a fractional AniList id and a file cover so the row survives backup and restore", async () => {
        const doc = {
            manga: [
                { id: 1, name: "Fraction Id", imageUrl: "file:///sdcard/c.jpg" },
                { id: 2, name: "Good One", imageUrl: "https://x.test/c.jpg" }
            ],
            tracks: [{ mangaId: 1, syncId: 2, mediaId: 12.5, lastChapterRead: 3 }]
        }
        const dataB64 = btoa(JSON.stringify(doc))
        await importHandlers["import:reader"]!(
            { type: "import:reader", format: "mangayomi", dataB64, preview: false },
            ctx
        )
        const rows = await db.manga.toArray()
        const frac = rows.find(r => r.title === "Fraction Id")!
        expect(frac.id).toBe("import:manga:fraction id")
        expect(frac.anilistId).toBeUndefined()
        expect(frac.sourceUrl.startsWith("amr:import:")).toBe(true)
        expect(frac.coverUrl).toBeUndefined()
        expect(frac.lastReadChapterNumber).toBe(3)
        expect(rows.find(r => r.title === "Good One")!.coverUrl).toBe("https://x.test/c.jpg")
    })
})
