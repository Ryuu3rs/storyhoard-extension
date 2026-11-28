import { describe, it, expect } from "vitest"
import { isNewerVersion } from "./update-check"

describe("isNewerVersion", () => {
    it("detects newer major", () => expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true))
    it("detects newer minor", () => expect(isNewerVersion("1.1.0", "1.0.9")).toBe(true))
    it("detects newer patch", () => expect(isNewerVersion("1.0.1", "1.0.0")).toBe(true))
    it("returns false for same version", () => expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false))
    it("returns false for older major", () => expect(isNewerVersion("0.9.9", "1.0.0")).toBe(false))
    it("returns false for older minor", () => expect(isNewerVersion("1.0.9", "1.1.0")).toBe(false))
    it("returns false for older patch", () => expect(isNewerVersion("1.0.0", "1.0.1")).toBe(false))
    it("handles missing patch segment", () => expect(isNewerVersion("1.1", "1.0.0")).toBe(true))
    it("treats non-numeric segments as 0", () => expect(isNewerVersion("1.0.0", "1.0.alpha")).toBe(false))
    it("compares numerically, not as text", () => {
        expect(isNewerVersion("0.34.10", "0.34.9")).toBe(true)
        expect(isNewerVersion("0.34.9", "0.34.10")).toBe(false)
    })
    it("treats a missing segment as 0", () => {
        expect(isNewerVersion("0.34", "0.34.0")).toBe(false)
        expect(isNewerVersion("0.34.0", "0.34")).toBe(false)
    })
    it("compares a fourth segment", () => {
        expect(isNewerVersion("0.34.0.1", "0.34.0")).toBe(true)
        expect(isNewerVersion("0.34.0", "0.34.0.1")).toBe(false)
        expect(isNewerVersion("0.34.1", "0.34.0.9")).toBe(true)
    })
    it("never treats an absurd version as newer", () => {
        expect(isNewerVersion("0.34.1234567", "0.34.0")).toBe(false)
        expect(isNewerVersion(`0.${"9".repeat(400)}`, "0.34.0")).toBe(false)
    })
})
