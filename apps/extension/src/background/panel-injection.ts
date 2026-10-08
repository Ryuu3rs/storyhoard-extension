import { isProfileSource, renderedSelectorsOf } from "../arch-sources"
import { findSource } from "../sources"
import { AMR_KOFI_URL, AMR_SUPPORT_LABEL } from "../support"
import { getCachedOfficialSites } from "../official-sources"
import { injectChapterPrompt, type ChapterPromptSupport } from "./inject-chapter-prompt"
import { popupGuardMain } from "./popup-guard"
import { dm5ContinuousScrollMain } from "./paginated-reader"

// Put the on-site panel (and its main-world helpers) on a chapter page of a recognised source.
// Resolves false when the URL is not a chapter page of any registered source. Used when a navigation
// finishes loading, and right after a site is added so the panel appears without a reload.
export async function injectPanelForTab(tabId: number, url: string): Promise<boolean> {
    let parsedUrl: URL
    try {
        parsedUrl = new URL(url)
    } catch {
        return false
    }
    const source = findSource(parsedUrl)
    if (source?.match(parsedUrl) !== "chapter") return false

    const support: ChapterPromptSupport = {
        sourceName: source.manifest.name,
        sourceUrl: source.manifest.supportUrl ?? null,
        amrUrl: AMR_KOFI_URL,
        amrLabel: AMR_SUPPORT_LABEL
    }
    const officialSites = await getCachedOfficialSites()
    await browser.scripting
        .executeScript({
            target: { tabId },
            func: injectChapterPrompt,
            args: [
                url,
                officialSites,
                support,
                isProfileSource(source.manifest.id) ? (renderedSelectorsOf(source.manifest.id) ?? {}) : null
            ]
        })
        .catch(() => {})
    // Pop-up/pop-under guard in the MAIN world (NOT CSP-gated, unlike an inline
    // <script> the content script would append). Inert until the isolated panel
    // flips data-amr-block-popups=1 (user-added sites, default on). "__amr-chapter-
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
