export type SourceErrorCode =
    | "invalid-input"
    | "invalid-response"
    | "not-found"
    | "request-failed"
    | "request-limit"
    | "unsupported-url"

export class SourceError extends Error {
    readonly code: SourceErrorCode
    readonly details?: Readonly<Record<string, unknown>>

    constructor(code: SourceErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
        super(message)
        this.name = "SourceError"
        this.code = code
        if (details !== undefined) {
            this.details = details
        }
    }
}

export class SourceRequestError extends SourceError {
    readonly status?: number

    constructor(message: string, status?: number, details?: Readonly<Record<string, unknown>>) {
        super(status === 404 ? "not-found" : "request-failed", message, details)
        this.name = "SourceRequestError"
        if (status !== undefined) {
            this.status = status
        }
    }
}

// A response that was a bot challenge instead of the requested content. The message is the same "blocked"
// an adapter throws, so every existing block check (tab fallback included) treats the two alike. `origin`
// is the origin the request went to, which is the one a user session would have to be sent to.
export class SourceChallengeError extends SourceRequestError {
    readonly origin: string

    constructor(origin: string, status?: number, details?: Readonly<Record<string, unknown>>) {
        super("blocked", status, details)
        this.name = "SourceChallengeError"
        this.origin = origin
    }
}
