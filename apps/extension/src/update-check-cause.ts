import { SourceChallengeError, SourceError, SourceRequestError } from "@amr/source-sdk"

// Why a title's update check did not produce a chapter list. Always one of a fixed set of short labels,
// never text taken from a response or an error, so nothing a site sent can end up in the exported log.
export function updateCheckCause(error: unknown): string {
    if (error instanceof SourceChallengeError) return "challenge"
    if (error instanceof SourceRequestError) {
        if (error.status !== undefined) return `http-${error.status}`
        if (error.message === "blocked") return "blocked"
        return /timed out/i.test(error.message) ? "timeout" : "network"
    }
    if (error instanceof SourceError) {
        if (error.code === "invalid-response") return "parse"
        if (error.code === "invalid-input") return "disallowed-origin"
        if (error.code === "request-limit") return "request-limit"
        return "other"
    }
    return error instanceof SyntaxError || error instanceof TypeError ? "parse" : "other"
}

// Why a title needs relinking: no stored link, a site with no working source behind it, or a link the source cannot read.
export type RelinkReason = "no-link" | "site-off" | "bad-link"
