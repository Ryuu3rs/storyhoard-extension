import { SourceChallengeError, SourceError, SourceRequestError } from "@amr/source-sdk"
import { describe, expect, it } from "vitest"
import { updateCheckCause } from "./update-check-cause"

describe("updateCheckCause", () => {
    it("names each cause with a short fixed label", () => {
        expect(updateCheckCause(new SourceChallengeError("https://reader.example", 403))).toBe("challenge")
        expect(updateCheckCause(new SourceRequestError("Request failed with status 500", 500))).toBe("http-500")
        expect(updateCheckCause(new SourceRequestError("Request failed with status 403", 403))).toBe("http-403")
        expect(updateCheckCause(new SourceRequestError("Request timed out after 15000ms"))).toBe("timeout")
        expect(updateCheckCause(new SourceRequestError("Request failed"))).toBe("network")
        expect(updateCheckCause(new SourceRequestError("blocked"))).toBe("blocked")
        expect(updateCheckCause(new SourceError("invalid-response", "Response was not valid JSON"))).toBe("parse")
        expect(updateCheckCause(new SourceError("invalid-input", "redirected"))).toBe("disallowed-origin")
        expect(updateCheckCause(new SourceError("request-limit", "too many"))).toBe("request-limit")
        expect(updateCheckCause(new TypeError("x is undefined"))).toBe("parse")
        expect(updateCheckCause(new Error("anything else"))).toBe("other")
        expect(updateCheckCause("not an error")).toBe("other")
    })

    it("never echoes response or error text", () => {
        const secret = "Cookie: session=abc https://reader.example"
        for (const error of [
            new SourceRequestError(secret),
            new SourceError("invalid-response", secret),
            new Error(secret)
        ]) {
            expect(updateCheckCause(error)).not.toMatch(/cookie|session|reader/i)
        }
    })
})
