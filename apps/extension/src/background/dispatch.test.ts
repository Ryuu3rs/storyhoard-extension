import { describe, expect, it } from "vitest"
import { runtimeRequestSchema } from "../runtime"
import { handlers, handlerGroups } from "./dispatch"

// Handled only in the local testing build (src/build-flavor.ts); the shipped build has no handler for them.
const LAB_ONLY_REQUESTS: readonly string[] = ["data:seed"]

describe("dispatch table exhaustiveness", () => {
    const allRequestTypes = runtimeRequestSchema.options.map(option => option.shape.type.value)

    it("has a handler for every RuntimeRequest type except the lab-only ones", () => {
        const missing = allRequestTypes.filter(type => !(type in handlers))
        expect(missing).toEqual(LAB_ONLY_REQUESTS)
    })

    it("has no handler for a type that isn't in RuntimeRequest", () => {
        const extra = Object.keys(handlers).filter(type => !allRequestTypes.includes(type as never))
        expect(extra).toEqual([])
    })

    it("has no type claimed by more than one handler group", () => {
        const seen = new Map<string, string[]>()
        for (const [groupName, group] of Object.entries(handlerGroups)) {
            for (const type of Object.keys(group)) {
                seen.set(type, [...(seen.get(type) ?? []), groupName])
            }
        }
        const duplicates = [...seen.entries()].filter(([, groups]) => groups.length > 1)
        expect(duplicates).toEqual([])
    })

    it("matches the total count of every group's keys with no overlap", () => {
        const totalKeysAcrossGroups = Object.values(handlerGroups).reduce(
            (sum, group) => sum + Object.keys(group).length,
            0
        )
        expect(totalKeysAcrossGroups).toBe(Object.keys(handlers).length)
        expect(Object.keys(handlers).length).toBe(allRequestTypes.length - LAB_ONLY_REQUESTS.length)
    })
})
