// "Add site": let the user turn a reader page the extension does not recognise into a tracked
// source with one click. Detect infers a source from the page; add-from-tab health-checks it and
// registers it. Nothing is stored or registered unless the user grants the site's host access.

import { matchesSourceDomain } from "@amr/source-sdk"
import { sourceRegistry } from "@amr/sources"
import {
    draftProfileFromChapterPage,
    looksLikeChapterUrl,
    parseProfile,
    probeSource,
    type CaptureSignals
} from "@amr/source-engine"
import {
    buildProbeContext,
    captureTabSignals,
    deleteImportedProfile,
    isProfileSource,
    listImportedProfiles,
    registerProfile,
    type AddedSource
} from "../arch-sources"
import { clearAddAvailableBadge } from "../background/capture"
import { putArchProfile } from "../database"
import { findSource } from "../sources"
import type { HandlerMap } from "../background/handler-types"

export type SourceDetectResult =
    | { status: "none" }
    | { status: "known"; name: string }
    | {
          status: "found"
          name: string
          domain: string
          origin: string
          // False when the page was inspected and its own links do not support the inferred shape.
          matchOk: boolean
          // The host patterns the add needs; the popup requests these from the user's click.
          permissionOrigins: string[]
      }

export type SourceAddFailure = "permission" | "unreadable" | "not-reader" | "unsupported" | "unverified" | "tab"

export type SourceAddResult =
    | { ok: true; id: string; name: string; domain: string }
    | { ok: false; reason: SourceAddFailure; message: string }

// Hosts that are the extension's own services or accounts, never a reader to add.
const RESERVED_HOSTS = ["weeb.ltd", "anilist.co", "myanimelist.net", "github.com"]
const LOCAL_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".test", ".home.arpa"]

// Only a public https site with a real hostname can be added: no loopback, private-network,
// IP-literal or explicit-port origins, and none of the extension's own services.
export function isAddableUrl(url: URL): boolean {
    if (url.protocol !== "https:" || url.port !== "") return false
    const host = url.hostname.toLowerCase().replace(/\.$/, "")
    if (!host.includes(".") || host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) return false
    if (host === "localhost" || LOCAL_SUFFIXES.some(s => host.endsWith(s))) return false
    return !RESERVED_HOSTS.some(r => host === r || host.endsWith(`.${r}`))
}

// The supported source this URL belongs to, by page match or, failing that, by host (a supported
// site's non-chapter pages still belong to it).
export function knownSourceFor(url: URL): { manifest: { name: string } } | undefined {
    return findSource(url) ?? sourceRegistry.list().find(a => matchesSourceDomain(url.hostname, a.manifest.domains))
}

function parseUrl(raw: string): URL | undefined {
    try {
        return new URL(raw)
    } catch {
        return undefined
    }
}

async function resolveTab(url: string, tabId: number | undefined): Promise<{ id: number } | undefined> {
    try {
        const tab =
            tabId !== undefined
                ? await browser.tabs.get(tabId)
                : (await browser.tabs.query({ active: true, currentWindow: true }))[0]
        // The page must still be the one the user was looking at when they clicked.
        if (tab?.id === undefined || tab.url !== url) return undefined
        return { id: tab.id }
    } catch {
        return undefined
    }
}

async function hasAccess(origins: string[]): Promise<boolean> {
    try {
        return await browser.permissions.contains({ origins })
    } catch {
        return false
    }
}

// "already" when the access is held, "granted" when the user just granted it, else "denied".
async function ensureAccess(origins: string[]): Promise<"already" | "granted" | "denied"> {
    if (await hasAccess(origins)) return "already"
    try {
        return (await browser.permissions.request({ origins })) ? "granted" : "denied"
    } catch {
        return "denied"
    }
}

async function revokeAccess(origins: string[]): Promise<void> {
    try {
        await browser.permissions.remove({ origins })
    } catch {
        // best effort: a leftover grant is harmless without a registered source
    }
}

function fail(reason: SourceAddFailure, message: string): SourceAddResult {
    return { ok: false, reason, message }
}

export async function detectSource(request: { url: string; tabId?: number | undefined }): Promise<SourceDetectResult> {
    const url = parseUrl(request.url)
    if (!url || !isAddableUrl(url)) return { status: "none" }
    const known = knownSourceFor(url)
    if (known) return { status: "known", name: known.manifest.name }
    if (!looksLikeChapterUrl(request.url)) return { status: "none" }

    // Inspect the page only when host access is already held; otherwise infer from the URL alone
    // and let the user's click request access.
    const pattern = `${url.origin}/*`
    let signals: CaptureSignals = { url: request.url, links: [], images: [] }
    const tab = await resolveTab(request.url, request.tabId)
    if (tab && (await hasAccess([pattern]))) {
        const captured = await captureTabSignals(tab.id)
        if (captured) signals = captured
    }
    const draft = draftProfileFromChapterPage(signals)
    if (!draft) return { status: "none" }
    const profile = draft.profile as { name: string; domains: string[]; origin: string; origins: string[] }
    return {
        status: "found",
        name: profile.name,
        domain: profile.domains[0] ?? url.hostname,
        origin: profile.origin,
        matchOk: draft.matchOk,
        permissionOrigins: profile.origins
    }
}

export async function addSourceFromTab(request: { url: string; tabId?: number | undefined }): Promise<SourceAddResult> {
    const url = parseUrl(request.url)
    if (!url || !isAddableUrl(url)) return fail("unsupported", "This page can't be added as a site.")
    if (knownSourceFor(url)) return fail("unsupported", "This site is already supported.")
    const tab = await resolveTab(request.url, request.tabId)
    if (!tab) return fail("tab", "Open the page you want to add and try again.")

    // Reading the page and checking the site both need host access, so it is requested first,
    // from the user's click. Without it nothing is captured, probed, stored or registered.
    const pattern = `${url.origin}/*`
    const access = await ensureAccess([pattern])
    if (access === "denied") return fail("permission", "Permission is needed to read this site.")
    const abort = async (result: SourceAddResult): Promise<SourceAddResult> => {
        if (access === "granted") await revokeAccess([pattern])
        return result
    }

    const signals = await captureTabSignals(tab.id)
    if (!signals) return abort(fail("unreadable", "Couldn't read this page. Reload it and try again."))
    const draft = draftProfileFromChapterPage(signals)
    if (!draft) return abort(fail("not-reader", "This doesn't look like a chapter page."))
    const parsed = parseProfile(draft.profile)
    if (!parsed.ok) return abort(fail("unsupported", "This site can't be added."))
    const draftProfile = parsed.profile
    if (sourceRegistry.get(draftProfile.id) && !isProfileSource(draftProfile.id)) {
        return abort(fail("unsupported", "This site is already supported."))
    }

    const report = await probeSource(draftProfile, buildProbeContext(draftProfile), {
        seriesUrl: draft.seriesUrl
    }).catch(() => undefined)
    if (!report?.ok) {
        return abort(fail("unverified", "Couldn't read this site's chapter list, so it can't be added yet."))
    }

    const profile = report.profile
    const needed = [...profile.origins, ...(profile.imageOrigins ?? [])]
    if (!(await hasAccess(needed)) && (await ensureAccess(needed)) === "denied") {
        return abort(fail("permission", "Permission is needed to read this site."))
    }

    registerProfile(profile)
    await putArchProfile(profile.id, profile)
    await clearAddAvailableBadge(tab.id).catch(() => undefined)
    return { ok: true, id: profile.id, name: profile.name, domain: profile.domains[0] ?? url.hostname }
}

export const addSourceHandlers: HandlerMap = {
    "source:detect": async request => detectSource(request),
    "source:add-from-tab": async request => addSourceFromTab(request),
    "source:list": async (): Promise<AddedSource[]> => listImportedProfiles(),
    "source:remove": async request => ({ removed: await deleteImportedProfile(request.id) })
}
