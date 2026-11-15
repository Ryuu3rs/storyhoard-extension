import { describe, expect, it } from "vitest"
import { inflateCapped } from "./inflate"
import { unzipFirst } from "./zip"

async function compress(data: Uint8Array, format: CompressionFormat): Promise<Uint8Array> {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream(format))
    return new Uint8Array(await new Response(stream).arrayBuffer())
}

describe("inflateCapped", () => {
    it("round-trips data under the cap", async () => {
        const data = new TextEncoder().encode("hello hello hello")
        const out = await inflateCapped(await compress(data, "gzip"), "gzip", 1024)
        expect(new TextDecoder().decode(out)).toBe("hello hello hello")
    })

    it("stops with a clear error once output passes the cap", async () => {
        const bomb = await compress(new Uint8Array(200_000), "deflate-raw")
        await expect(inflateCapped(bomb, "deflate-raw", 10_000)).rejects.toThrow(/too large/i)
    })
})

describe("unzipFirst bad offsets", () => {
    it("reports a corrupt zip instead of a raw RangeError", async () => {
        const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff]
        const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
        const eocd = [
            ...u32(0x06054b50),
            ...u16(0),
            ...u16(0),
            ...u16(1),
            ...u16(1),
            ...u32(46),
            ...u32(0x7fffffff),
            ...u16(0)
        ]
        const err = await unzipFirst(new Uint8Array(eocd)).catch((e: unknown) => e)
        expect(err).toBeInstanceOf(Error)
        expect(err).not.toBeInstanceOf(RangeError)
        expect((err as Error).message).toMatch(/corrupt/i)
    })
})
