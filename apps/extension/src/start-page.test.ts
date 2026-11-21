import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("browser", fakeBrowser)

const { primeStartSection, primedStartSection } = await import("./start-page")

beforeEach(async () => {
    await fakeBrowser.storage.local.clear()
    vi.stubGlobal("browser", fakeBrowser)
})

describe("start page read before the app mounts", () => {
    it("opens on Discover when nothing is stored", async () => {
        expect(await primeStartSection()).toBe("Discover")
        expect(primedStartSection()).toBe("Discover")
    })

    it("opens on Library when that is the chosen start page", async () => {
        await fakeBrowser.storage.local.set({ settings: { startPage: "library" } })
        expect(await primeStartSection()).toBe("Library")
        expect(primedStartSection()).toBe("Library")
    })

    it("falls back to Discover when the settings cannot be read", async () => {
        vi.stubGlobal("browser", {
            storage: { local: { get: () => Promise.reject(new Error("no storage")) } }
        })
        expect(await primeStartSection()).toBe("Discover")
    })
})
