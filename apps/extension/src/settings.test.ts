import { afterEach, describe, expect, it, vi } from "vitest"
import { runtimeRequestSchema } from "./runtime"
import { defaultSettings, getSettings, updateSettings } from "./settings"

function stubStorage(initial: Record<string, unknown> = {}) {
    const store = new Map<string, unknown>(Object.entries(initial))
    vi.stubGlobal("browser", {
        storage: {
            local: {
                get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
                set: async (items: Record<string, unknown>) => {
                    for (const [k, v] of Object.entries(items)) store.set(k, v)
                }
            }
        }
    })
}

afterEach(() => vi.unstubAllGlobals())

describe("autoFollowDetected", () => {
    it("ships off: a recognised reader site is only offered the Track button until the user opts in", async () => {
        expect(defaultSettings.autoFollowDetected).toBe(false)
        stubStorage()
        expect((await getSettings()).autoFollowDetected).toBe(false)
    })

    it("stays off for a user whose stored settings predate it", async () => {
        stubStorage({ settings: { autoAdd: false } })
        expect((await getSettings()).autoFollowDetected).toBe(false)
    })

    it("is only on once the user turns it on", async () => {
        stubStorage()
        await updateSettings({ autoFollowDetected: true })
        expect((await getSettings()).autoFollowDetected).toBe(true)
    })

    it("can be set through settings:update", () => {
        const parsed = runtimeRequestSchema.safeParse({
            type: "settings:update",
            settings: { autoFollowDetected: true }
        })
        expect(parsed.success).toBe(true)
        expect(
            runtimeRequestSchema.safeParse({ type: "settings:update", settings: { autoFollowDetected: "yes" } }).success
        ).toBe(false)
    })
})
