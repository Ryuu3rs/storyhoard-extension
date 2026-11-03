import { SourceError } from "@amr/source-sdk"
import type { RuntimeRequest, RuntimeResponse } from "../runtime"

// Threaded to every handler so the few that need sender info (e.g. page:current,
// which classifies the sending tab's URL) don't need a bespoke signature. Derived
// from the actual listener signature rather than named directly, since the exact
// ambient type name depends on WXT's generated browser polyfill types.
type OnMessageListener = Parameters<typeof browser.runtime.onMessage.addListener>[0]
export type HandlerContext = {
    sender: Parameters<OnMessageListener>[1]
}

// One entry per RuntimeRequest variant. Handlers return raw data and throw on
// error - the dispatcher in background.ts wraps in success()/failure() centrally,
// matching every case's original "return success(...)" + the one shared catch.
export type HandlerMap = {
    [K in RuntimeRequest["type"]]?: (
        request: Extract<RuntimeRequest, { type: K }>,
        ctx: HandlerContext
    ) => Promise<unknown>
}

// True only for the extension's own pages. A content script's sender.url is the web page it runs on.
export function fromExtensionPage(ctx: { sender?: { url?: string } }): boolean {
    const base = browser.runtime.getURL("")
    return typeof ctx.sender?.url === "string" && ctx.sender.url.startsWith(base)
}

export function success<T>(data: T): RuntimeResponse<T> {
    return { ok: true, data }
}

export function failure(error: unknown): RuntimeResponse {
    let message = error instanceof Error ? error.message : "The request failed"
    if (error instanceof SourceError && error.details) {
        const cause = error.details["cause"]
        const url = error.details["url"]
        const extra = [url ? String(url) : null, cause ? String(cause) : null].filter(Boolean).join(" - ")
        if (extra) message += ` [${extra}]`
    }
    return {
        ok: false,
        error: { code: "REQUEST_FAILED", message }
    }
}

export function delay(ms: number): Promise<void> {
    return new Promise<void>(resolve => setTimeout(resolve, ms))
}
