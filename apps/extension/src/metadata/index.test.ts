import { afterEach, describe, expect, it, vi } from "vitest"
import type { MetadataProvider } from "./provider"

// The provider chain in index.ts is built at module load from
// VITE_METADATA_API_ORIGIN, so each case resets modules and re-imports after
// stubbing the env: a truthy origin yields [vps, anilist], an empty one [anilist].
const mockVpsResolve = vi.fn()
const mockAnilistResolve = vi.fn()
const mockVpsSearchTitles = vi.fn((): Promise<string[]> => Promise.resolve([]))
const mockAnilistSearchTitles = vi.fn((): Promise<string[]> => Promise.resolve([]))

// The mock factory result is cached and shared across re-imports, so vpsProvider is
// a stable object; the "skips" case deletes its method to model a provider that
// does not implement resolveSearchTitles, and it is restored in afterEach.
vi.mock("./vps", () => {
    const vpsProvider: MetadataProvider = {
        name: "vps",
        resolve: mockVpsResolve,
        resolveSearchTitles: mockVpsSearchTitles
    }
    return { vpsProvider }
})

vi.mock("./anilist", () => {
    const anilistProvider: MetadataProvider = {
        name: "anilist",
        resolve: mockAnilistResolve,
        resolveSearchTitles: mockAnilistSearchTitles
    }
    return { anilistProvider }
})

async function loadResolveSearchTitles(origin: string) {
    vi.resetModules()
    vi.stubEnv("VITE_METADATA_API_ORIGIN", origin)
    const mod = await import("./index")
    return mod.resolveSearchTitles
}

afterEach(async () => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    const { vpsProvider } = await import("./vps")
    vpsProvider.resolveSearchTitles = mockVpsSearchTitles
})

describe("resolveSearchTitles (chain)", () => {
    it("returns the first provider's non-empty result, VPS ahead of AniList", async () => {
        mockVpsSearchTitles.mockResolvedValue(["Vps Title", "Vps Alt"])
        mockAnilistSearchTitles.mockResolvedValue(["Anilist Title"])
        const resolveSearchTitles = await loadResolveSearchTitles("https://catalog.example.com")

        expect(await resolveSearchTitles(123)).toEqual(["Vps Title", "Vps Alt"])
        expect(mockVpsSearchTitles).toHaveBeenCalledWith(123)
        expect(mockAnilistSearchTitles).not.toHaveBeenCalled()
    })

    it("falls through to AniList when VPS returns an empty list", async () => {
        mockVpsSearchTitles.mockResolvedValue([])
        mockAnilistSearchTitles.mockResolvedValue(["Anilist Title"])
        const resolveSearchTitles = await loadResolveSearchTitles("https://catalog.example.com")

        expect(await resolveSearchTitles(123)).toEqual(["Anilist Title"])
        expect(mockVpsSearchTitles).toHaveBeenCalledWith(123)
        expect(mockAnilistSearchTitles).toHaveBeenCalledWith(123)
    })

    it("falls through to AniList when the VPS provider throws", async () => {
        mockVpsSearchTitles.mockRejectedValue(new Error("catalog down"))
        mockAnilistSearchTitles.mockResolvedValue(["Anilist Title"])
        const resolveSearchTitles = await loadResolveSearchTitles("https://catalog.example.com")

        expect(await resolveSearchTitles(123)).toEqual(["Anilist Title"])
        expect(mockAnilistSearchTitles).toHaveBeenCalledWith(123)
    })

    it("skips a provider that does not implement the method", async () => {
        const { vpsProvider } = await import("./vps")
        delete vpsProvider.resolveSearchTitles
        mockAnilistSearchTitles.mockResolvedValue(["Anilist Title"])
        const resolveSearchTitles = await loadResolveSearchTitles("https://catalog.example.com")

        expect(await resolveSearchTitles(123)).toEqual(["Anilist Title"])
        expect(mockVpsSearchTitles).not.toHaveBeenCalled()
        expect(mockAnilistSearchTitles).toHaveBeenCalledWith(123)
    })

    it("resolves through AniList alone when no VPS origin is configured", async () => {
        mockAnilistSearchTitles.mockResolvedValue(["Anilist Title"])
        const resolveSearchTitles = await loadResolveSearchTitles("")

        expect(await resolveSearchTitles(123)).toEqual(["Anilist Title"])
        expect(mockVpsSearchTitles).not.toHaveBeenCalled()
        expect(mockAnilistSearchTitles).toHaveBeenCalledWith(123)
    })

    it("returns an empty list when no provider yields variants", async () => {
        mockAnilistSearchTitles.mockResolvedValue([])
        const resolveSearchTitles = await loadResolveSearchTitles("")

        expect(await resolveSearchTitles(123)).toEqual([])
    })
})

describe("resolveMetadata output", () => {
    it("passes on only well-typed fields and a public https cover", async () => {
        vi.resetModules()
        vi.stubEnv("VITE_METADATA_API_ORIGIN", "")
        mockAnilistResolve.mockResolvedValue({
            anilistId: 1.5,
            title: "T",
            status: "rebooting",
            coverUrl: "http://192.168.1.1/x.jpg",
            genres: "Action",
            tags: ["ok", 3]
        })
        const { resolveMetadata } = await import("./index")
        expect(await resolveMetadata({ title: "T" })).toEqual({ title: "T", tags: ["ok"] })
        mockAnilistResolve.mockResolvedValue({ anilistId: 2, coverUrl: "https://s4.anilist.co/c.jpg", genres: ["A"] })
        expect(await resolveMetadata({ title: "T" })).toEqual({
            anilistId: 2,
            coverUrl: "https://s4.anilist.co/c.jpg",
            genres: ["A"]
        })
    })
})
