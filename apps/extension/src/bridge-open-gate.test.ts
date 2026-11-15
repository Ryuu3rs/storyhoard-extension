import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { createOpenGate } from "./bridge-open-gate"

function gateAt(start = 100_000) {
    let now = start
    const gate = createOpenGate(() => now)
    return { gate, advance: (ms: number) => (now += ms) }
}

const one = { anilistId: 1, title: "One" }
const two = { anilistId: 2, title: "Two" }

describe("createOpenGate", () => {
    it("lets the first open through", () => {
        const { gate } = gateAt()
        expect(gate(one, true)).toBe(true)
    })

    it("drops an open the page fired without a recent user gesture", () => {
        const { gate } = gateAt()
        expect(gate(one, false)).toBe(false)
    })

    it("lets an open through where the browser cannot report user activation", () => {
        const { gate } = gateAt()
        expect(gate(one, undefined)).toBe(true)
    })

    it("allows at most one open per 3 seconds", () => {
        const { gate, advance } = gateAt()
        expect(gate(one, true)).toBe(true)
        advance(1000)
        expect(gate(two, true)).toBe(false)
        advance(2100)
        expect(gate(two, true)).toBe(true)
    })

    it("drops a repeat of the same title fired again shortly after", () => {
        const { gate, advance } = gateAt()
        expect(gate(one, true)).toBe(true)
        advance(5000)
        expect(gate({ ...one }, true)).toBe(false)
        advance(60_000)
        expect(gate(one, true)).toBe(true)
    })

    it("does not count a dropped open toward the throttle", () => {
        const { gate } = gateAt()
        expect(gate(one, false)).toBe(false)
        expect(gate(one, true)).toBe(true)
    })
})

describe("weeb bridge", () => {
    const bridge = readFileSync(
        fileURLToPath(new URL("../entrypoints/weeb-bridge.content.ts", import.meta.url)),
        "utf8"
    )

    it("gates storyhoard:open on the user-activation, dedupe and throttle check", () => {
        const start = bridge.indexOf('addEventListener("storyhoard:open"')
        expect(start).toBeGreaterThan(-1)
        const handler = bridge.slice(start, start + 900)
        expect(handler).toContain("navigator.userActivation?.isActive")
        expect(handler).toMatch(/allowOpen\(/)
    })

    it("reads linked from the non-secret flag, never the device token", () => {
        expect(bridge).not.toContain("token")
        expect(bridge).toContain("res.data.linked === true")
    })
})
