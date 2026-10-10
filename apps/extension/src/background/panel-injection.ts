import { isProfileSource, renderedSelectorsOf } from "../arch-sources"
import { detectedPageFor } from "../detected-site"
import { findSource } from "../sources"
import { AMR_KOFI_URL, AMR_SUPPORT_LABEL } from "../support"
import { getCachedOfficialSites, isOfficialHost } from "../official-sources"
import { injectChapterPrompt, type ChapterPromptSupport } from "./inject-chapter-prompt"
import type { PanelMode } from "./panel-state"
import { popupGuardMain } from "./popup-guard"
import { dm5ContinuousScrollMain } from "./paginated-reader"

// Put the on-site panel (and its main-world helpers) on a chapter page of a recognised source.
// Resolves false when the URL is not a chapter page of any registered source. Used when a navigation
// finishes loading, and right after a site is added so the panel appears without a reload.
//
// `panelMode: "detected"` puts the observe-only panel on a reader page that has no registered source: the
// caller has confirmed the page is a reader and that host access is already held. It never injects the
// main-world helpers (the pop-up guard and the continuous-scroll flattener belong to followed sites),
// and resolves false for a registered source or an official partner, which have their own modes.
export async function injectPanelForTab(tabId: number, url: string, panelMode?: "detected"): Promise<boolean> {
    let parsedUrl: URL
    try {
        parsedUrl = new URL(url)
    } catch {
        return false
    }
    if (panelMode === "detected") return injectDetectedPanel(tabId, url, parsedUrl)
    const source = findSource(parsedUrl)
    if (source?.match(parsedUrl) !== "chapter") return false

    const support: ChapterPromptSupport = {
        sourceName: source.manifest.name,
        sourceUrl: source.manifest.supportUrl ?? null,
        amrUrl: AMR_KOFI_URL,
        amrLabel: AMR_SUPPORT_LABEL
    }
    const officialSites = await getCachedOfficialSites()
    // Officialness keys off the REAL host, never a source profile's self-declared domain (R3).
    // isOfficialHost strips a trailing dot (absolute FQDN) and www, so an official site reached via
    // an absolute FQDN is not misclassified and wrongly given the restyle + blocker.
    const mode: PanelMode = isOfficialHost(parsedUrl.hostname, officialSites) ? "official" : "followed"
    await browser.scripting
        .executeScript({
            target: { tabId },
            func: injectChapterPrompt,
            args: [
                url,
                officialSites,
                support,
                isProfileSource(source.manifest.id) ? (renderedSelectorsOf(source.manifest.id) ?? {}) : null,
                mode
            ]
        })
        .catch(() => {})
    // Pop-up/pop-under guard in the MAIN world (NOT CSP-gated, unlike an inline
    // <script> the content script would append). Inert until the isolated panel
    // flips data-amr-block-popups=1 (followed sites, default on). "__amr-chapter-
    // prompt__" must match HOST_ID in inject-chapter-prompt.ts (the panel host id
    // the guard whitelists so it never cancels our own clicks).
    await browser.scripting
        .executeScript({
            target: { tabId },
            world: "MAIN",
            func: popupGuardMain,
            args: ["__amr-chapter-prompt__"]
        })
        .catch(() => {})
    // Continuous-scroll for paginated DM5-engine readers (also MAIN world, for the
    // same CSP reason + to reach the site's own requestimagedata). Inert until the
    // panel flips data-amr-continuous=1, and a no-op on any non-DM5 page.
    await browser.scripting
        .executeScript({
            target: { tabId },
            world: "MAIN",
            func: dm5ContinuousScrollMain
        })
        .catch(() => {})
    return true
}

async function injectDetectedPanel(tabId: number, url: string, parsedUrl: URL): Promise<boolean> {
    if (findSource(parsedUrl) || detectedPageFor(url) === undefined) return false
    const officialSites = await getCachedOfficialSites()
    if (isOfficialHost(parsedUrl.hostname, officialSites)) return false
    const support: ChapterPromptSupport = {
        sourceName: parsedUrl.hostname,
        sourceUrl: null,
        amrUrl: AMR_KOFI_URL,
        amrLabel: AMR_SUPPORT_LABEL
    }
    // `{}` turns the on-page chapter list read on without declaring any selectors: there is no profile to
    // supply them, so the panel reads the usual chapter-list containers only.
    await browser.scripting
        .executeScript({
            target: { tabId },
            func: injectChapterPrompt,
            args: [url, officialSites, support, {}, "detected"]
        })
        .catch(() => {})
    return true
}
