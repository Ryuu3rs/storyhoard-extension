// H34 link handoff handlers. The weeb.ltd bridge content script (weeb-bridge.content.ts, the only
// web-page path into the extension, with no externally_connectable) relays exactly these two
// messages. The real sender origin comes from the browser as ctx.sender.url, which a page cannot
// forge, and is re-checked against https://weeb.ltd inside handleHandoffMessage; the whole path is
// also inert unless the linkHandoff flag is on. See ECO_EXT_HANDOFF_PROTOCOL.md.
import type { HandlerMap } from "../background/handler-types"
import { confirmPendingLink, discardPendingLink, handleHandoffMessage, pendingLinkHandle } from "../link-handoff"

function senderOrigin(ctx: { sender?: { url?: string } }): string {
    try {
        return ctx.sender?.url ? new URL(ctx.sender.url).origin : ""
    } catch {
        return ""
    }
}

// The confirm messages come from the extension's OWN trusted page (app.html), never the weeb.ltd
// bridge, which only ever relays hello/code. Gate them on the sender being an extension-origin page
// so a web page can never confirm or inspect a pending link even if it reached the dispatch.
function fromExtensionPage(ctx: { sender?: { url?: string } }): boolean {
    const base = browser.runtime.getURL("")
    return typeof ctx.sender?.url === "string" && ctx.sender.url.startsWith(base)
}

export const handoffHandlers: HandlerMap = {
    "handoff:hello": async (_request, ctx) =>
        (await handleHandoffMessage({ type: "handoff:hello" }, senderOrigin(ctx))) ?? null,
    "handoff:code": async (request, ctx) =>
        (await handleHandoffMessage(
            { type: "handoff:code", nonce: request.nonce, code: request.code },
            senderOrigin(ctx)
        )) ?? null,
    "handoff:pending": async (_request, ctx) =>
        fromExtensionPage(ctx) ? { handle: await pendingLinkHandle() } : { handle: null },
    "handoff:confirm": async (_request, ctx) =>
        fromExtensionPage(ctx) ? confirmPendingLink() : { linked: false, handle: "" },
    "handoff:cancel": async (_request, ctx) => {
        if (fromExtensionPage(ctx)) await discardPendingLink()
        return null
    }
}
