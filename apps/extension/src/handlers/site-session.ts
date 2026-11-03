import { fromExtensionPage, type HandlerMap } from "../background/handler-types"
import { listSiteSessions, setSiteSession } from "../site-session"
import { clearSourceResponseCaches } from "../sources"

// Only the extension's own pages. The user's choice must never be readable or settable from a content
// script running on a page.
export const siteSessionHandlers: HandlerMap = {
    "site-session:list": async (_request, ctx) => (fromExtensionPage(ctx) ? listSiteSessions() : []),
    "site-session:set": async (request, ctx) => {
        if (!fromExtensionPage(ctx)) return { applied: false }
        const applied = await setSiteSession(request.origin, request.enabled)
        if (applied) clearSourceResponseCaches()
        return { applied }
    }
}
