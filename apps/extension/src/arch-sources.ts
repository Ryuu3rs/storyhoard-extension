// ARCHITECTURE TRACK A (experimental, dev-demo only). User-supplied source import: disables a
// bundled adapter and lets the user paste that site's profile instead, so we can test the
// user-added path against a source we know works. Gated behind VITE_ARCH_TRACK=A; branch-only,
// never ships. Profiles persist in the Dexie `archProfiles` store, so they survive restarts and
// flow into backup/export like real data; re-registered on startup.

import { createBoundedRequestClient, type FetchFunction, type SourceContext } from "@amr/source-sdk"
import { sourceRegistry } from "@amr/sources"
import {
    createAdapterFromProfile,
    draftProfileFromSignals,
    parseProfile,
    probeSource,
    type CaptureSignals,
    type SiteProfile
} from "@amr/source-engine"
import { deleteArchProfile, listArchProfiles, putArchProfile } from "./database"

export const ARCH_ENABLED = import.meta.env.VITE_ARCH_TRACK === "A"

// Bundled adapters handed over to the user-supplied-profile path for the demo. Disabled at
// startup so the only version of these sources is whatever the user imports.
const DISABLED_BUNDLED_IDS = ["mangafreak"]

// Register every persisted imported profile into the live registry. Exported so a backup
// restore can re-apply profiles without a full restart.
export async function registerStoredArchProfiles(): Promise<void> {
    for (const raw of await listArchProfiles()) {
        const parsed = parseProfile(raw)
        if (parsed.ok) sourceRegistry.upsert(createAdapterFromProfile(parsed.profile))
    }
}

// Run once at background startup: disable the handed-over bundled adapters, then re-register any
// profiles the user imported in a previous session.
export async function initArchSources(): Promise<void> {
    if (!ARCH_ENABLED) return
    for (const id of DISABLED_BUNDLED_IDS) sourceRegistry.unregister(id)
    await registerStoredArchProfiles()
}

// Injected into the target tab to capture DOM signals. Self-contained (no closures) so it can
// be serialized by scripting.executeScript. Reads og metadata + candidate links/images.
function captureInspector(): CaptureSignals {
    const meta = (p: string): string | undefined =>
        document.querySelector(`meta[property="${p}"]`)?.getAttribute("content") ?? undefined
    const links = Array.from(document.querySelectorAll("a[href]"))
        .slice(0, 500)
        .map(a => ({ href: a.getAttribute("href") ?? "", text: (a.textContent ?? "").trim().slice(0, 40) }))
    const images = Array.from(document.querySelectorAll("img"))
        .slice(0, 500)
        .flatMap(img => {
            const out: string[] = []
            const src = img.getAttribute("src")
            const data = img.getAttribute("data-url") ?? img.getAttribute("data-src")
            if (src) out.push(src)
            if (data) out.push(data)
            return out
        })
    return { url: location.href, ogTitle: meta("og:title"), ogImage: meta("og:image"), links, images }
}

export type CaptureResult = { ok: true; draft: string; capturedUrl: string } | { ok: false; error: string }

// "Build from current tab": inspect the most-recently-active website tab and draft a profile.
export async function captureAndDraft(): Promise<CaptureResult> {
    try {
        const tabs = await browser.tabs.query({})
        const siteTabs = tabs
            .filter(t => t.url && /^https?:/.test(t.url) && t.id !== undefined)
            .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
        const tab = siteTabs[0]
        if (!tab?.id) return { ok: false, error: "Open the series page in a browser tab first, then try again." }
        const results = await browser.scripting.executeScript({ target: { tabId: tab.id }, func: captureInspector })
        const signals = results[0]?.result as CaptureSignals | undefined
        if (!signals) return { ok: false, error: "Could not read that tab (grant access to the site, then retry)." }
        return { ok: true, draft: JSON.stringify(draftProfileFromSignals(signals), null, 2), capturedUrl: signals.url }
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
}

// List imported profiles (id + display name) for the Sources management UI.
export async function listImportedProfiles(): Promise<Array<{ id: string; name: string }>> {
    const out: Array<{ id: string; name: string }> = []
    for (const raw of await listArchProfiles()) {
        const r = raw as { id?: unknown; name?: unknown }
        if (typeof r?.id === "string") out.push({ id: r.id, name: typeof r.name === "string" ? r.name : r.id })
    }
    return out
}

// Delete an imported profile and unregister its source.
export async function deleteImportedProfile(id: string): Promise<void> {
    sourceRegistry.unregister(id)
    await deleteArchProfile(id)
}

export type ImportResult =
    | { ok: true; id: string; name: string; verified: boolean; originCorrected: boolean; summary: string }
    | { ok: false; error: string }

// A bounded request context for the health-check probe, scoped to the profile's own origins +
// image hosts (so a redirect to a sibling mirror is allowed but nothing else is).
function buildProbeContext(profile: SiteProfile): SourceContext {
    const fetchImpl: FetchFunction = async (url, init) => {
        const response = await fetch(url, init as RequestInit)
        return { ok: response.ok, status: response.status, text: () => response.text() }
    }
    return {
        request: createBoundedRequestClient({
            fetch: fetchImpl,
            allowedOrigins: [...profile.origins, ...(profile.imageOrigins ?? [])],
            maxRequests: 30,
            maxResponseBytes: 8 * 1024 * 1024,
            timeoutMs: 15_000
        }),
        now: () => Date.now(),
        logger: { debug: () => undefined, warn: () => undefined }
    }
}

// Parse + validate + health-check (auto-correcting a rotated mirror) + register + persist a
// pasted profile. Returns a plain result the UI reads directly (outside the typed envelope).
export async function importProfileJson(text: string): Promise<ImportResult> {
    let data: unknown
    try {
        data = JSON.parse(text)
    } catch (error) {
        return { ok: false, error: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
    }
    const parsed = parseProfile(data)
    if (!parsed.ok) return { ok: false, error: parsed.error }

    // Probe the live site: verify the pipeline and auto-correct the origin if the mirror moved.
    let effective = parsed.profile
    let verified = false
    let originCorrected = false
    let summary = "registered without a live check"
    try {
        const report = await probeSource(parsed.profile, buildProbeContext(parsed.profile))
        effective = report.profile
        verified = report.ok
        originCorrected = report.originCorrected
        const parts = report.stages.map(s => `${s.stage}:${s.ok ? "ok" : "FAIL"}(${s.detail})`)
        summary = `${originCorrected ? `origin -> ${report.effectiveOrigin}; ` : ""}${parts.join(", ")}`
    } catch (error) {
        summary = `live check could not run: ${error instanceof Error ? error.message : String(error)}`
    }

    sourceRegistry.upsert(createAdapterFromProfile(effective))
    await putArchProfile(effective.id, effective)
    return { ok: true, id: effective.id, name: effective.name, verified, originCorrected, summary }
}
