import { describe, expect, it } from "vitest"
import { runtimeRequestSchema } from "./runtime"

const config = (gistId: string) => ({ type: "sync:config", config: { gistId } })

describe("sync:config gistId", () => {
    it("accepts a hex gist id and an empty value (cleared, auto-create)", () => {
        expect(runtimeRequestSchema.safeParse(config("aa5a315d61ae9438b18d")).success).toBe(true)
        expect(runtimeRequestSchema.safeParse(config("")).success).toBe(true)
    })

    it("rejects path and query injection into the GitHub API path", () => {
        for (const bad of ["../user", "abc/comments", "abc?x=1", "abc#x", "g".repeat(10), "a".repeat(65)]) {
            expect(runtimeRequestSchema.safeParse(config(bad)).success).toBe(false)
        }
    })
})
