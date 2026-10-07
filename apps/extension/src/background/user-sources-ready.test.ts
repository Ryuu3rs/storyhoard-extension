import { afterEach, describe, expect, it, vi } from "vitest"
import { beginUserSourcesInit, userSourcesReady } from "./user-sources-ready"

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe("user-sources-ready gate", () => {
    it("stays closed until registration finishes, then opens", async () => {
        let finish!: () => void
        const registration = new Promise<void>(resolve => {
            finish = resolve
        })
        let opened = false
        beginUserSourcesInit(() => registration)
        void userSourcesReady().then(() => (opened = true))

        await Promise.resolve()
        await Promise.resolve()
        expect(opened).toBe(false)

        finish()
        await userSourcesReady()
        expect(opened).toBe(true)
    })

    it("opens (and logs) when registration fails, so handlers are never wedged", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
        await beginUserSourcesInit(() => Promise.reject(new Error("db unavailable")))
        await expect(userSourcesReady()).resolves.toBeUndefined()
        expect(error).toHaveBeenCalled()
    })

    it("opens after a timeout when registration never settles", async () => {
        vi.useFakeTimers()
        beginUserSourcesInit(() => new Promise<void>(() => undefined))
        let opened = false
        void userSourcesReady().then(() => (opened = true))

        await vi.advanceTimersByTimeAsync(4000)
        expect(opened).toBe(false)
        await vi.advanceTimersByTimeAsync(2000)
        expect(opened).toBe(true)
    })
})
