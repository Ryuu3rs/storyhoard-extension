// H34 link handoff handlers. The weeb.ltd bridge content script (weeb-bridge.content.ts, the only
// web-page path into the extension, with no externally_connectable) relays exactly these two
// messages. The real sender origin comes from the browser as ctx.sender.url, which a page cannot
// forge, and is re-checked against https://weeb.ltd inside handleHandoffMessage; the whole path is
// also inert unless the linkHandoff flag is on. See ECO_EXT_HANDOFF_PROTOCOL.md.
import type { HandlerMap } from "../background/handler-types"
import { handleHandoffMessage } from "../link-handoff"

function senderOrigin(ctx: { sender?: { url?: string } }): string {
    try {
        return ctx.sender?.url ? new URL(ctx.sender.url).origin : ""
    } catch {
        return ""
    }
}

export const handoffHandlers: HandlerMap = {
    "handoff:hello": async (_request, ctx) =>
        (await handleHandoffMessage({ type: "handoff:hello" }, senderOrigin(ctx))) ?? null,
    "handoff:code": async (request, ctx) =>
        (await handleHandoffMessage(
            { type: "handoff:code", nonce: request.nonce, code: request.code },
            senderOrigin(ctx)
        )) ?? null
}
