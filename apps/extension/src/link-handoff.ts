// H34 Phase A: the device-token link handoff from the weeb.ltd welcome flow to this extension.
// See ECO_EXT_HANDOFF_PROTOCOL.md. The long-lived device token never crosses the web page: the
// page delivers only a one-time, short-TTL code bound to a nonce this install generated, and the
// background redeems that code for the token directly (server to extension).
//
// Security invariants enforced here:
// - every inbound message is dropped unless its origin is exactly https://weeb.ltd;
// - only the two handoff message types are handled - this module never routes into the internal
//   dispatch, so no existing handler is reachable from a web page;
// - the nonce is install-generated, single-use, and short-lived; a code only redeems once its
//   nonce matches the one this install issued (replay is also blocked server-side by single-use
//   codes);
// - the whole path is inert unless settings.linkHandoff is on, so declaring externally_connectable
//   grants a web page nothing until the feature is turned on.

import { SITE_BASE, apiRedeemHandoff } from "./account"
import { recordAnalyticsEvent } from "./database"
import { linkAccountWithToken } from "./handlers/account"
import { getSettings } from "./settings"

export const WEEB_ORIGIN = "https://weeb.ltd"

const NONCES_KEY = "handoffNonces"
// The nonce is issued at handoff:hello (after sign-in, just before the code is minted) and spent
// when the code comes back, so it only needs to outlive one request round-trip. Kept short.
const NONCE_TTL_MS = 5 * 60 * 1000
// Several nonces can be live at once (two welcome tabs, a refresh), so they are stored as a map
// nonce -> issuedAt rather than a single value a second hello would overwrite. Bounded so a page
// spamming hello cannot grow storage without limit.
const MAX_STORED_NONCES = 8

type StoredNonces = Record<string, number>

export type HandoffMessage =
    | { type: "handoff:hello"; client?: string }
    | { type: "handoff:code"; nonce: string; code: string }

export type HandoffReply =
    | { type: "handoff:nonce"; nonce: string }
    | { type: "handoff:done"; ok: true }
    | { type: "handoff:error" }

// A URL-safe nonce of 43 chars (32 random bytes, base64url, no padding) - inside the server's
// accepted 22-64 range, 256 bits of entropy.
function generateNonce(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    let binary = ""
    for (const b of bytes) binary += String.fromCharCode(b)
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

// Constant-time string compare, so a nonce check never leaks position information by timing.
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
    return diff === 0
}

async function readNonces(): Promise<StoredNonces> {
    const raw = (await browser.storage.local.get(NONCES_KEY))[NONCES_KEY]
    return raw !== null && typeof raw === "object" ? (raw as StoredNonces) : {}
}

// Keep only unexpired nonces, newest first, capped - so an abandoned hello and a hello-spamming
// page both self-limit.
function prune(map: StoredNonces): StoredNonces {
    const now = Date.now()
    const live = Object.entries(map)
        .filter(([, at]) => typeof at === "number" && now - at <= NONCE_TTL_MS)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_STORED_NONCES)
    return Object.fromEntries(live)
}

async function issueNonce(): Promise<string> {
    const nonce = generateNonce()
    const map = prune(await readNonces())
    map[nonce] = Date.now()
    await browser.storage.local.set({ [NONCES_KEY]: prune(map) })
    return nonce
}

// True when the candidate is one of this install's live, unexpired nonces. It does NOT remove the
// nonce: removal happens only after a successful redeem (see redeem), so a transient redeem failure
// leaves the nonce usable for a retry with the same still-valid server code. Constant-time compare
// against each key so the check never leaks which nonce matched by timing.
async function nonceIsLive(candidate: string, map: StoredNonces): Promise<boolean> {
    const now = Date.now()
    for (const [nonce, at] of Object.entries(map)) {
        if (timingSafeEqual(nonce, candidate)) return typeof at === "number" && now - at <= NONCE_TTL_MS
    }
    return false
}

async function removeNonce(candidate: string): Promise<void> {
    const map = await readNonces()
    if (candidate in map) {
        delete map[candidate]
        await browser.storage.local.set({ [NONCES_KEY]: map })
    }
}

// Redeems in flight, keyed by nonce. The service worker is single-threaded, so this synchronous
// check-and-add (no await between) serialises two concurrent redeems of the SAME nonce without a
// storage round-trip, closing the read-check-remove TOCTOU that would otherwise let both redeem and
// link. Cleared in a finally so a failed attempt can be retried.
const redeemInFlight = new Set<string>()

function isHandoffMessage(value: unknown): value is HandoffMessage {
    if (typeof value !== "object" || value === null) return false
    const t = (value as { type?: unknown }).type
    if (t === "handoff:hello") return true
    if (t === "handoff:code") {
        const m = value as { nonce?: unknown; code?: unknown }
        return typeof m.nonce === "string" && typeof m.code === "string"
    }
    return false
}

// The build target, used only to name the device token on the site ("Browser extension (Chrome)"
// etc). Edge ships the Chrome build, so it is reported as chrome; a cosmetic label, not a check.
const BROWSER_NAME = import.meta.env.BROWSER === "firefox" ? "firefox" : "chrome"

async function redeem(nonce: string, code: string): Promise<boolean> {
    // Serialise concurrent redeems of this nonce (see redeemInFlight) before any await.
    if (redeemInFlight.has(nonce)) return false
    redeemInFlight.add(nonce)
    try {
        if (!(await nonceIsLive(nonce, await readNonces()))) return false
        const { deviceToken } = await apiRedeemHandoff(code, nonce, BROWSER_NAME)
        const profile = await linkAccountWithToken(deviceToken)
        // The link landed, so the one-time code is now spent server-side: retire the nonce. A throw
        // above skips this, keeping the nonce so the same still-valid code can be retried.
        await removeNonce(nonce)
        // Only count the conversion when the link is actually usable: a first sync that hit a revoked
        // token leaves the profile invalid without throwing, and that is not a successful link.
        if (!profile?.invalid) void recordAnalyticsEvent({ event: "account_linked", ts: Date.now() })
        return true
    } catch {
        return false
    } finally {
        redeemInFlight.delete(nonce)
    }
}

// The one entry point for an inbound handoff message, shared by the Chrome onMessageExternal
// listener and the Firefox content-script bridge. `origin` is the sender's real origin (Chrome:
// from sender.url; Firefox: the content script's verified event.origin). Returns undefined for
// anything it will not act on, so the transport can stay silent.
export async function handleHandoffMessage(message: unknown, origin: string): Promise<HandoffReply | undefined> {
    if (origin !== WEEB_ORIGIN) return undefined
    if (!(await getSettings()).linkHandoff) return undefined
    if (!isHandoffMessage(message)) return undefined
    if (message.type === "handoff:hello") {
        return { type: "handoff:nonce", nonce: await issueNonce() }
    }
    return (await redeem(message.nonce, message.code)) ? { type: "handoff:done", ok: true } : { type: "handoff:error" }
}

// Open the site-hosted welcome flow on a fresh install, only when the feature is on and the user
// is not already linked (so a reinstall over an existing profile is never re-onboarded).
export async function openWelcomeOnInstall(): Promise<void> {
    const settings = await getSettings()
    if (!settings.linkHandoff) return
    const { getAccountProfile } = await import("./account")
    if ((await getAccountProfile()).token) return
    await browser.tabs.create({ url: `${SITE_BASE}/welcome?client=ext` }).catch(() => {})
}
