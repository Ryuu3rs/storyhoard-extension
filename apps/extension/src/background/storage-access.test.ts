import { afterEach, describe, expect, it, vi } from "vitest"
import { lockStorageToExtension } from "./storage-access"

afterEach(() => vi.unstubAllGlobals())

describe("lockStorageToExtension", () => {
    it("limits storage.local to the extension's own pages where the browser allows it", async () => {
        const setAccessLevel = vi.fn(async () => undefined)
        vi.stubGlobal("browser", { storage: { local: { setAccessLevel } } })
        await lockStorageToExtension()
        expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" })
    })

    it("does nothing on a browser without an access level for storage.local", async () => {
        vi.stubGlobal("browser", { storage: { local: { get: vi.fn() } } })
        await expect(lockStorageToExtension()).resolves.toBeUndefined()
    })

    it("does not throw when the browser refuses", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {})
        vi.stubGlobal("browser", {
            storage: { local: { setAccessLevel: vi.fn(async () => Promise.reject(new Error("no"))) } }
        })
        await expect(lockStorageToExtension()).resolves.toBeUndefined()
        expect(error).toHaveBeenCalled()
        error.mockRestore()
    })
})
