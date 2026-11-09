import type { RuntimeRequest } from "../runtime"

type Sender = { url?: string; tab?: unknown } | undefined

// Everything a content script may ask of the background. The on-page reader panel
// (inject-chapter-prompt.ts) and the weeb.ltd bridge (weeb-bridge.content.ts) send exactly these; the
// rest of the dispatch (export, clear, sync and account config, imports) is for the extension's own
// pages only, so a content script running in a hostile page can never reach it.
const CONTENT_SCRIPT_TYPES: ReadonlySet<RuntimeRequest["type"]> = new Set<RuntimeRequest["type"]>([
    "analytics:record",
    "chapter:siblings",
    "chapter:track",
    "library:get",
    "library:reading-prefs",
    "panel:resolve-mode",
    "settings:update",
    "source:add-from-tab",
    "work:best-for-url",
    "work:chapter-list",
    "work:record-chapter-list",
    "work:track-detected",
    "account:status",
    "site:open",
    "handoff:hello",
    "handoff:code"
])

// The panel remembers its reading-view switches globally through settings:update (saveReaderDefault).
// Those are the only settings a content script may write.
const CONTENT_SCRIPT_SETTINGS = new Set(["readerContinuousScroll", "readerFitWidth", "readerNoGap", "readerTheme"])

export function fromExtensionOrigin(sender: Sender, extensionBase: string): boolean {
    return typeof sender?.url === "string" && sender.url.startsWith(extensionBase)
}

// Throws for a request the sender may not make. Any sender that is not one of the extension's own pages
// is treated as a content script, since that is the only other way a message reaches the background.
export function assertSenderMayRequest(request: RuntimeRequest, sender: Sender, extensionBase: string): void {
    if (fromExtensionOrigin(sender, extensionBase)) return
    const allowed =
        CONTENT_SCRIPT_TYPES.has(request.type) &&
        (request.type !== "settings:update" ||
            Object.keys(request.settings).every(key => CONTENT_SCRIPT_SETTINGS.has(key)))
    if (!allowed) throw new Error(`${request.type} is not allowed from a web page`)
}
