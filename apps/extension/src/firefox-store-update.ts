import { isNewerVersion } from "./update-check"

// Firefox installs from AMO update themselves, except when the new version asks for more
// (permissions, site access or required data types). Firefox then holds the update until the
// user approves a prompt that is easy to miss, and the copy stays behind for good. This module
// notices that case so the app can offer a one-click way through: the AMO listing, where
// Firefox shows the same approval prompt right away.

export const AMO_ADDON_ID = "amr-next@ryuu3rs.dev"
export const AMO_ADDON_API_URL = `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(AMO_ADDON_ID)}/?lang=en-US`

// Firefox checks add-ons for updates about once a day. A copy still behind after a day and a
// half is almost always waiting on the approval prompt (or has updates turned off).
export const FIREFOX_UPDATE_GRACE_MS = 36 * 60 * 60 * 1000

export function amoListingUrl(os: string | undefined): string {
    const app = os === "android" ? "android" : "firefox"
    return `https://addons.mozilla.org/${app}/addon/storyhoard/`
}

export type AmoPublicVersion = { version: string; publishedAt: number }

// Reads the public version from AMO's addon API answer. Anything unexpected gives null, so a
// changed or broken answer never shows a banner.
export function parseAmoAddon(json: unknown): AmoPublicVersion | null {
    const addon = json as { last_updated?: unknown; current_version?: { version?: unknown; reviewed?: unknown } } | null
    const version = addon?.current_version?.version
    if (typeof version !== "string" || !/^\d{1,6}(\.\d{1,6}){0,3}$/.test(version)) return null
    // `reviewed` is when AMO approved this version, which is when it went public and Firefox could
    // first fetch it. The file's `created` is its upload time, days earlier after a manual review.
    // The add-on's `last_updated` tracks the same approval and stands in if `reviewed` is missing.
    const wentPublic = addon?.current_version?.reviewed ?? addon?.last_updated
    if (typeof wentPublic !== "string") return null
    const publishedAt = Date.parse(wentPublic)
    if (!Number.isFinite(publishedAt)) return null
    return { version, publishedAt }
}

export type FirefoxStoreUpdate = {
    store: "amo"
    available: boolean
    latestVersion: string
    publishedAt: number
    releaseUrl: string
}

export function firefoxUpdateWaiting(
    update: Pick<FirefoxStoreUpdate, "available" | "latestVersion" | "publishedAt"> | null | undefined,
    installedVersion: string,
    now: number
): boolean {
    if (!update?.available) return false
    if (!isNewerVersion(update.latestVersion, installedVersion)) return false
    return now - update.publishedAt >= FIREFOX_UPDATE_GRACE_MS
}
