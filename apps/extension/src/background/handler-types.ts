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

// True for a content script: a sender in a tab that is not one of the extension's own pages.
export function fromContentScript(
    ctx: { sender?: { url?: string | undefined; tab?: unknown } | undefined } | undefined
): boolean {
    if (!ctx?.sender?.tab) return false
    const url = ctx.sender.url
    return !(typeof url === "string" && url.startsWith(browser.runtime.getURL("")))
}

type StampedSender = {
    url?: string | undefined
    origin?: string | undefined
    documentLifecycle?: string | undefined
    tab?: { url?: string | undefined } | undefined
}

function parsedUrl(raw: string | undefined): URL | undefined {
    if (!raw) return undefined
    try {
        return new URL(raw)
    } catch {
        return undefined
    }
}

// The page a content script runs on, as the browser stamped it on this message (never the request's own
// word). The sending document is sender.url (and sender.origin on Chromium); the tab's url is only what the
// tab shows now, which moves ahead of a document that is being navigated away from. So the document must
// still be the tab's active one and on the tab's origin, or no page is vouched for at all.
export function contentScriptPage(ctx: { sender?: StampedSender | undefined } | undefined): URL | undefined {
    const sender = ctx?.sender
    if (!sender) return undefined
    if (sender.documentLifecycle !== undefined && sender.documentLifecycle !== "active") return undefined
    const own = parsedUrl(sender.url)
    const tab = parsedUrl(sender.tab?.url)
    if (sender.url !== undefined && !own) return undefined
    const page = own ?? tab
    if (!page) return undefined
    if (own && tab && own.origin !== tab.origin) return undefined
    if (sender.origin !== undefined && sender.origin !== page.origin) return undefined
    return page
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
