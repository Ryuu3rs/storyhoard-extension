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
    type CaptureSignals,
    type ProbeReport
} from "@amr/source-engine"
import {
    buildProbeContext,
    buildTabProbeContext,
    captureTabSignals,
    deleteImportedProfile,
    findUpgradeableSeed,
    isProfileSource,
    listImportedProfiles,
    registerProfile,
    trackingOnlySourceIds,
    type AddedSource
} from "../arch-sources"
import { clearAddAvailableBadge } from "../background/capture"
import { injectPanelForTab } from "../background/panel-injection"
import { userSourcesReady } from "../background/user-sources-ready"
import { putArchProfile } from "../database"
import { isAddableUrl, validateProfileScope } from "../source-scope"
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
          // True when the site is already present as a recognition-only (tracking-only) stand-in
          // that this add would replace with a working source.
          upgrade: boolean
          // The host patterns the add needs; the popup requests these from the user's click.
          permissionOrigins: string[]
      }

export type SourceAddFailure =
    | "permission"
    | "unreadable"
    | "not-reader"
    | "unsupported"
    | "unverified"
    | "blocked"
    | "tab"

export type SourceAddResult =
    | { ok: true; id: string; name: string; domain: string; upgraded?: true }
    | { ok: false; reason: SourceAddFailure; message: string }

// The supported source this URL belongs to, by page match or, failing that, by host (a supported
// site's non-chapter pages still belong to it).
export function knownSourceFor(url: URL): { manifest: { id: string; name: string } } | undefined {
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

// True when the captured page is still on the origin the user clicked from and is still addable and
// unknown (or known only as the tracking-only stand-in being upgraded). The tab can navigate between
// the click and the capture, and everything validated up to then was validated against the URL the
// click carried, not against what was actually read.
function stillOnValidatedOrigin(signalsUrl: string, validated: URL, upgradeId?: string): boolean {
    const captured = parseUrl(signalsUrl)
    if (!captured || captured.origin !== validated.origin || !isAddableUrl(captured)) return false
    const known = knownSourceFor(captured)
    return !known || (upgradeId !== undefined && known.manifest.id === upgradeId)
}

// Draft from a chapter page, taking over the id and name of the tracking-only stand-in when one is
// being upgraded so the library rows that point at it keep resolving.
function draftFor(signals: CaptureSignals, upgrade: { id: string; name: string } | undefined) {
    const draft = draftProfileFromChapterPage(signals)
    if (!draft || !upgrade) return draft
    return { ...draft, profile: { ...draft.profile, id: upgrade.id, name: upgrade.name } }
}

const BLOCKED_DETAIL = /status (?:401|403|429|5\d\d)|request failed|timed out|redirected|\btab\b|disallowed/i

// A specific reason for a failed live check, so the user knows whether to retry, try another page,
// or give up on the site.
function describeProbeFailure(report: ProbeReport | undefined): SourceAddResult {
    const failed = report?.stages.filter(stage => !stage.ok) ?? []
    if (!report || failed.some(stage => BLOCKED_DETAIL.test(stage.detail))) {
        return fail(
            "blocked",
            "This site blocks background reading (it may be behind a bot check), so it can't be added yet. Reload the page, let it finish loading, and try again."
        )
    }
    if (failed.some(stage => stage.stage === "series")) {
        return fail(
            "unverified",
            "Couldn't open this title's page to read its details, so the site can't be added yet."
        )
    }
    return fail(
        "unverified",
        failed.length === 0
            ? "Couldn't verify this site's chapter list, so it can't be added yet."
            : "Found this title's page but no chapter list in it, so new chapters couldn't be detected and the site can't be added yet."
    )
}

export async function detectSource(request: { url: string; tabId?: number | undefined }): Promise<SourceDetectResult> {
    // A worker woken by this very message has not necessarily re-registered the added sites yet.
    await userSourcesReady()
    const url = parseUrl(request.url)
    if (!url) return { status: "none" }
    const known = knownSourceFor(url)
    const upgrade = known ? await findUpgradeableSeed(url) : undefined
    if (known && !upgrade) return { status: "known", name: known.manifest.name }
    const knownResult: SourceDetectResult = known ? { status: "known", name: known.manifest.name } : { status: "none" }
    if (!isAddableUrl(url)) return { status: "none" }
    if (!looksLikeChapterUrl(request.url)) return knownResult

    // Inspect the page only when host access is already held; otherwise infer from the URL alone
    // and let the user's click request access.
    const pattern = `${url.origin}/*`
    let signals: CaptureSignals = { url: request.url, links: [], images: [] }
    const tab = await resolveTab(request.url, request.tabId)
    if (tab && (await hasAccess([pattern]))) {
        const captured = await captureTabSignals(tab.id)
        if (captured && stillOnValidatedOrigin(captured.url, url, upgrade?.id)) signals = captured
    }
    const draft = draftFor(signals, upgrade)
    if (!draft) return knownResult
    const profile = draft.profile as { name: string; domains: string[]; origin: string; origins: string[] }
    return {
        status: "found",
        name: profile.name,
        domain: profile.domains[0] ?? url.hostname,
        origin: profile.origin,
        matchOk: draft.matchOk,
        upgrade: upgrade !== undefined,
        permissionOrigins: profile.origins
    }
}

export async function addSourceFromTab(request: { url: string; tabId?: number | undefined }): Promise<SourceAddResult> {
    await userSourcesReady()
    const url = parseUrl(request.url)
    if (!url) return fail("unsupported", "This page can't be added as a site.")
    const known = knownSourceFor(url)
    // A recognition-only seeded stand-in may be replaced by a working source; nothing else known may.
    const upgrade = known ? await findUpgradeableSeed(url) : undefined
    if (known && !upgrade) {
        return fail(
            "unsupported",
            isProfileSource(known.manifest.id) ? "This site is already added." : "This site is already supported."
        )
    }
    if (!isAddableUrl(url)) return fail("unsupported", "This page can't be added as a site.")
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
    if (!signals) {
        return abort(fail("unreadable", "Couldn't read this page. Reload it, let it finish loading, and try again."))
    }
    if (!stillOnValidatedOrigin(signals.url, url, upgrade?.id)) {
        return abort(fail("tab", "The page changed while it was being read. Open it again and try again."))
    }
    const draft = draftFor(signals, upgrade)
    if (!draft) {
        return abort(
            fail("not-reader", "This doesn't look like a chapter page. Open a chapter you are reading and try again.")
        )
    }
    const parsed = parseProfile(draft.profile)
    if (!parsed.ok) return abort(fail("unsupported", "This site can't be added."))
    const draftProfile = parsed.profile
    // The id is the host without "www.", so a second add of the same site from its other address
    // (with or without www) lands on an id that is already taken and must not overwrite that source.
    if (sourceRegistry.get(draftProfile.id) && draftProfile.id !== upgrade?.id) {
        return abort(
            fail(
                "unsupported",
                isProfileSource(draftProfile.id)
                    ? "This site is already added under its other address (with or without www). Open it from there."
                    : "This site is already supported."
            )
        )
    }
    if (draftProfile.origin !== url.origin || !validateProfileScope(draftProfile)) {
        return abort(fail("unsupported", "This site can't be added."))
    }

    // First the plain background fetch. A site that gates scripted requests (a bot check) or builds
    // its chapter list in the browser fails that, so the same check is retried reading the one series
    // page through a real tab before the site is given up on.
    const probeOptions = { seriesUrl: draft.seriesUrl }
    let report = await probeSource(draftProfile, buildProbeContext(draftProfile), probeOptions).catch(() => undefined)
    if (!report?.ok) {
        const viaTab = await probeSource(
            draftProfile,
            buildTabProbeContext(draftProfile, draft.seriesUrl),
            probeOptions
        ).catch(() => undefined)
        report = viaTab?.ok ? viaTab : (report ?? viaTab)
    }
    if (!report?.ok) return abort(describeProbeFailure(report))

    // The probe may swap in a mirror origin; whatever it settled on is held to the same scope.
    const profile = report.profile
    if (!validateProfileScope(profile)) return abort(fail("unsupported", "This site can't be added."))
    const needed = [...profile.origins, ...(profile.imageOrigins ?? [])]
    if (!(await hasAccess(needed)) && (await ensureAccess(needed)) === "denied") {
        return abort(fail("permission", "Permission is needed to read this site."))
    }

    if (!registerProfile(profile)) return abort(fail("unsupported", "This site is already supported."))
    await putArchProfile(profile.id, profile, "user")
    await clearAddAvailableBadge(tab.id).catch(() => undefined)
    // The page is already open and finished loading, so no navigation event will bring the panel up.
    await injectPanelForTab(tab.id, request.url).catch(() => false)
    return {
        ok: true,
        id: profile.id,
        name: profile.name,
        domain: profile.domains[0] ?? url.hostname,
        ...(upgrade ? { upgraded: true as const } : {})
    }
}

export const addSourceHandlers: HandlerMap = {
    "source:detect": async request => detectSource(request),
    "source:add-from-tab": async request => addSourceFromTab(request),
    "source:list": async (): Promise<AddedSource[]> => {
        await userSourcesReady()
        return listImportedProfiles()
    },
    // Profile sources that keep a title tracked but cannot list chapters, so the library and Updates
    // pages can say new chapters are not auto-detected for them.
    "source:tracking-only": async (): Promise<string[]> => {
        await userSourcesReady()
        return trackingOnlySourceIds()
    },
    "source:remove": async request => ({ removed: await deleteImportedProfile(request.id) })
}
