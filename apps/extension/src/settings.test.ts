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

describe("updateIntervalMinutes", () => {
    it("defaults to 12 hours", async () => {
        stubStorage()
        expect((await getSettings()).updateIntervalMinutes).toBe(720)
    })

    it.each([
        [0, 0],
        [6, 360],
        [12, 720],
        [24, 1440]
    ])("migrates a stored %i hour schedule to %i minutes", async (hours, minutes) => {
        stubStorage({ settings: { updateIntervalHours: hours, theme: "light" } })
        const settings = await getSettings()
        expect(settings.updateIntervalMinutes).toBe(minutes)
        expect(settings.theme).toBe("light")
        expect("updateIntervalHours" in settings).toBe(false)
    })

    it("prefers the minutes value when both are stored", async () => {
        stubStorage({ settings: { updateIntervalHours: 24, updateIntervalMinutes: 15 } })
        expect((await getSettings()).updateIntervalMinutes).toBe(15)
    })

    it("falls back to the default for a value that is not a choice", async () => {
        stubStorage({ settings: { updateIntervalMinutes: 7, updateIntervalHours: 5 } })
        expect((await getSettings()).updateIntervalMinutes).toBe(720)
    })

    it("drops the legacy key the next time settings are saved", async () => {
        stubStorage({ settings: { updateIntervalHours: 6 } })
        const saved = await updateSettings({ autoAdd: false })
        expect(saved.updateIntervalMinutes).toBe(360)
        expect("updateIntervalHours" in saved).toBe(false)
    })

    it("accepts every choice through settings:update and rejects anything else", () => {
        for (const minutes of [0, 5, 10, 15, 30, 60, 180, 360, 720, 1440]) {
            expect(
                runtimeRequestSchema.safeParse({
                    type: "settings:update",
                    settings: { updateIntervalMinutes: minutes }
                }).success
            ).toBe(true)
        }
        for (const bad of [1, 7, 45, 2880, -5, "5", null]) {
            expect(
                runtimeRequestSchema.safeParse({ type: "settings:update", settings: { updateIntervalMinutes: bad } })
                    .success
            ).toBe(false)
        }
    })
})
