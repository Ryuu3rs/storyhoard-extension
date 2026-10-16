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

const NONCE_KEY = "handoffNonce"
// The nonce is issued at handoff:hello (after sign-in, just before the code is minted) and spent
// when the code comes back, so it only needs to outlive one request round-trip. Kept short.
const NONCE_TTL_MS = 5 * 60 * 1000

type StoredNonce = { nonce: string; issuedAt: number }

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

async function issueNonce(): Promise<string> {
    const nonce = generateNonce()
    await browser.storage.local.set({ [NONCE_KEY]: { nonce, issuedAt: Date.now() } satisfies StoredNonce })
    return nonce
}

// Single-use: a successful match clears the nonce so the same (nonce, code) pair cannot be
// replayed from this side. A miss leaves nothing to brute-force (256-bit, unguessable) and the
// server's single-use code is the backstop regardless.
async function matchAndConsumeNonce(candidate: string): Promise<boolean> {
    const stored = (await browser.storage.local.get(NONCE_KEY))[NONCE_KEY] as StoredNonce | undefined
    if (!stored) return false
    if (Date.now() - stored.issuedAt > NONCE_TTL_MS) {
        await browser.storage.local.remove(NONCE_KEY)
        return false
    }
    if (!timingSafeEqual(stored.nonce, candidate)) return false
    await browser.storage.local.remove(NONCE_KEY)
    return true
}

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

async function redeem(nonce: string, code: string): Promise<boolean> {
    if (!(await matchAndConsumeNonce(nonce))) return false
    try {
        const { deviceToken } = await apiRedeemHandoff(code, nonce)
        await linkAccountWithToken(deviceToken)
        void recordAnalyticsEvent({ event: "account_linked", ts: Date.now() })
        return true
    } catch {
        return false
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
