import { describe, expect, it } from "vitest"
import { DISCOVER_CACHE_BUDGET, createWeebDiscoverSource } from "./weeb-discover"

// The 256 KB budget is UTF-8 bytes, not UTF-16 code units.
describe("Discover cache budget", () => {
    it("does not write a cache entry larger than 256 KB of UTF-8 to storage", async () => {
        const cjk = (seed: number, n: number) =>
            Array.from({ length: n }, (_, i) => String.fromCodePoint(0x4e00 + ((seed * 131 + i * 7) % 20000))).join("")
        const items = (rail: number) =>
            Array.from({ length: 16 }, (_, i) => ({
                anilistId: rail * 100 + i + 1,
                workId: null,
                title: cjk(rail * 1000 + i, 300),
                altTitles: Array.from({ length: 8 }, (_, k) => cjk(rail * 1000 + i * 10 + k + 500, 300)),
                genres: []
            }))
        const fetch = (async (input: string) => {
            const rail = new URL(input).searchParams.get("rail")!
            const n = ["trending", "seasonal", "staff", "community"].indexOf(rail) + 1
            return new Response(JSON.stringify({ rail, items: items(n) }), { status: 200 })
        }) as unknown as typeof globalThis.fetch
        const writes: unknown[] = []
        const source = createWeebDiscoverSource({
            siteBase: "https://weeb.example",
            fetch,
            now: () => 1_000_000,
            store: { read: async () => undefined, write: async entry => void writes.push(entry) }
        })
        const value = await source.get()
        expect(value.rails).toHaveLength(4)
        const chars = JSON.stringify({ value, checkedAt: 1_000_000 }).length
        const bytes = new TextEncoder().encode(JSON.stringify({ value, checkedAt: 1_000_000 })).length
        expect(chars).toBeLessThanOrEqual(DISCOVER_CACHE_BUDGET)
        expect(bytes).toBeGreaterThan(DISCOVER_CACHE_BUDGET)
        expect(writes).toHaveLength(0)
    })
})
