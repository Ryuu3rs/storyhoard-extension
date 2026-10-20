import { describe, it, expect } from "vitest"
import { formatUpdateFailureLog } from "./updates-failure-log"

const meta = { version: "0.19.0", checkedAt: Date.parse("2026-10-17T00:00:00Z"), checked: 10, updated: 7, failed: 1 }

// The stated goal of the host-free log (updates-failure-log.ts lines 121-125) is that the
// copyable support log "never names the source hosts". The per-title failure body keeps the
// chapter error message verbatim on the assumption it is "generic status, not hosts". That
// assumption is not enforced: a real source error message can embed a host.
describe("input/boundary: host leak via the per-title error message", () => {
    it("does not leak a host embedded in a real source error message (redirect-to-disallowed-origin)", () => {
        // Verbatim shape produced by packages/source-sdk/src/request.ts:
        //   throw new SourceError("invalid-input", `Request was redirected to a disallowed origin: ${finalOrigin}`)
        // SourceError extends Error, so checkUpdates captures error.message with the origin in it.
        const log = formatUpdateFailureLog(
            [
                {
                    mangaId: "asurascans:manga:a",
                    title: "Solo Leveling",
                    message: "Request was redirected to a disallowed origin: https://asurascans.gg"
                }
            ],
            meta
        )
        expect(log).not.toContain("asurascans.gg")
        expect(log).not.toContain("asurascans")
    })

    it("does not leak a host embedded in a generic fetch/network error message", () => {
        const log = formatUpdateFailureLog(
            [
                {
                    mangaId: "s:manga:b",
                    title: "Omniscient Reader",
                    message: "fetch failed for https://natomanga.com/manga/x"
                }
            ],
            meta
        )
        expect(log).not.toContain("natomanga.com")
    })
})
