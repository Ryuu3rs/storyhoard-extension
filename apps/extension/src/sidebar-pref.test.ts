import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("browser", fakeBrowser)

const {
    SIDEBAR_COLLAPSED_KEY,
    isNarrowWindow,
    isSidebarCollapsed,
    primeSidebarCollapsed,
    primedSidebarCollapsed,
    saveSidebarCollapsed,
    toggleSidebar
} = await import("./sidebar-pref")

beforeEach(async () => {
    await fakeBrowser.storage.local.clear()
    vi.stubGlobal("browser", fakeBrowser)
})

describe("sidebar preference storage", () => {
    it("defaults to expanded when nothing is stored", async () => {
        expect(await primeSidebarCollapsed()).toBe(false)
        expect(primedSidebarCollapsed()).toBe(false)
    })

    it("round-trips the remembered choice", async () => {
        await saveSidebarCollapsed(true)
        expect((await fakeBrowser.storage.local.get(SIDEBAR_COLLAPSED_KEY))[SIDEBAR_COLLAPSED_KEY]).toBe(true)
        expect(await primeSidebarCollapsed()).toBe(true)
        await saveSidebarCollapsed(false)
        expect(await primeSidebarCollapsed()).toBe(false)
    })

    it("ignores a stored value that is not a boolean true", async () => {
        await fakeBrowser.storage.local.set({ [SIDEBAR_COLLAPSED_KEY]: "yes" })
        expect(await primeSidebarCollapsed()).toBe(false)
    })

    it("falls back to expanded when storage throws", async () => {
        vi.stubGlobal("browser", {
            storage: {
                local: {
                    get: () => Promise.reject(new Error("no storage")),
                    set: () => Promise.reject(new Error("no storage"))
                }
            }
        })
        expect(await primeSidebarCollapsed()).toBe(false)
        await expect(saveSidebarCollapsed(true)).resolves.toBeUndefined()
        expect(primedSidebarCollapsed()).toBe(true)
    })
})

describe("sidebar collapse state", () => {
    it("follows the remembered choice on a wide window", () => {
        expect(isSidebarCollapsed({ remembered: true, narrow: false, narrowExpanded: false })).toBe(true)
        expect(isSidebarCollapsed({ remembered: false, narrow: false, narrowExpanded: false })).toBe(false)
    })

    it("auto-collapses a narrow window whatever was remembered", () => {
        expect(isSidebarCollapsed({ remembered: false, narrow: true, narrowExpanded: false })).toBe(true)
        expect(isSidebarCollapsed({ remembered: true, narrow: true, narrowExpanded: false })).toBe(true)
    })

    it("expands a narrow window for now without touching the remembered choice", () => {
        const next = toggleSidebar({ remembered: true, narrow: true, narrowExpanded: false })
        expect(next).toEqual({ remembered: true, narrow: true, narrowExpanded: true })
        expect(isSidebarCollapsed(next)).toBe(false)
        expect(toggleSidebar(next).narrowExpanded).toBe(false)
    })

    it("flips the remembered choice on a wide window", () => {
        expect(toggleSidebar({ remembered: false, narrow: false, narrowExpanded: false }).remembered).toBe(true)
        expect(toggleSidebar({ remembered: true, narrow: false, narrowExpanded: false }).remembered).toBe(false)
    })

    it("treats windows under 900px as narrow", () => {
        expect(isNarrowWindow(899)).toBe(true)
        expect(isNarrowWindow(900)).toBe(false)
        expect(isNarrowWindow(1280)).toBe(false)
    })
})
