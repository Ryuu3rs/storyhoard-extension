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
    "work:best-for-url",
    "work:chapter-list",
    "work:record-chapter-list",
    "work:track-detected",
    "account:status",
    "site:open",
    "handoff:hello",
    "handoff:code"
])

// Only the weeb.ltd bridge sends these, and it runs only on weeb.ltd (and a dev origin when one is built
// in). From any other page they would add titles, open tabs or report the linked account.
const BRIDGE_TYPES: ReadonlySet<RuntimeRequest["type"]> = new Set<RuntimeRequest["type"]>([
    "account:status",
    "site:open",
    "handoff:hello",
    "handoff:code"
])

function bridgeOrigins(): string[] {
    const origins = ["https://weeb.ltd"]
    const dev = import.meta.env.VITE_WEEB_SITE_ORIGIN as string | undefined
    if (dev) {
        try {
            origins.push(new URL(dev.replace(/\*$/, "")).origin)
        } catch {
            // an unparseable dev origin adds nothing
        }
    }
    return origins
}

// The panel records its own button presses. Every other event (installs, account links, captures) is the
// extension's own to record, so a page cannot forge one.
const CONTENT_SCRIPT_EVENTS: ReadonlySet<string> = new Set(["panel_action"])

// The panel remembers its reading-view switches globally through settings:update (saveReaderDefault).
// Those are the only settings a content script may write.
const CONTENT_SCRIPT_SETTINGS = new Set(["readerContinuousScroll", "readerFitWidth", "readerNoGap", "readerTheme"])

export function fromExtensionOrigin(sender: Sender, extensionBase: string): boolean {
    return typeof sender?.url === "string" && sender.url.startsWith(extensionBase)
}

function senderOrigin(sender: Sender): string | undefined {
    try {
        return typeof sender?.url === "string" ? new URL(sender.url).origin : undefined
    } catch {
        return undefined
    }
}

function contentScriptMay(request: RuntimeRequest, sender: Sender): boolean {
    if (!CONTENT_SCRIPT_TYPES.has(request.type)) return false
    if (BRIDGE_TYPES.has(request.type)) {
        const origin = senderOrigin(sender)
        return origin !== undefined && bridgeOrigins().includes(origin)
    }
    if (request.type === "settings:update") {
        return Object.keys(request.settings).every(key => CONTENT_SCRIPT_SETTINGS.has(key))
    }
    if (request.type === "analytics:record") return CONTENT_SCRIPT_EVENTS.has(request.event)
    return true
}

// Throws for a request the sender may not make. Any sender that is not one of the extension's own pages
// is treated as a content script, since that is the only other way a message reaches the background.
export function assertSenderMayRequest(request: RuntimeRequest, sender: Sender, extensionBase: string): void {
    if (fromExtensionOrigin(sender, extensionBase)) return
    if (!contentScriptMay(request, sender)) throw new Error(`${request.type} is not allowed from a web page`)
}
