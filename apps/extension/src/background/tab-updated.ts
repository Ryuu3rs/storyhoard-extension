import { looksLikeChapterUrl, looksLikeReaderPage } from "@amr/source-engine"
import { captureTabSignals, findUpgradeableSeed } from "../arch-sources"
import { knownSourceFor } from "../handlers/add-source"
import { isAddableUrl } from "../source-scope"
import { findSource } from "../sources"
import { captureChapter, clearAddAvailableBadge, setAddAvailableBadge } from "./capture"
import { injectPanelForTab } from "./panel-injection"
import { isInternalTab, isInternalUrl } from "./tab-fetch"
import { userSourcesReady } from "./user-sources-ready"

// A single-page reader changes its address without a page load: tabs.onUpdated reports the new url
// but never status "complete". The page is given a moment to render the new chapter before it is
// inspected.
const SPA_SETTLE_MS = 1200

// The last address a tab was offered "add" for, so the url event and the later "complete" event for
// the same navigation inspect the page once.
const offeredUrl = new Map<number, string>()

async function hasHostAccess(origin: string): Promise<boolean> {
    try {
        return await browser.permissions.contains({ origins: [`${origin}/*`] })
    } catch {
        return false
    }
}

// Offer the toolbar "+" hint on a reader page the extension does not recognise (or only recognises as
// a tracking-only stand-in). The address must look like a chapter, and when host access is already
// held the page itself must agree it is a reader (page-sized images or a reader container), so a wiki
// or podcast page whose address merely ends in "chapter-3" or "episode-12" is not flagged. Without
// access nothing may be read, so only the (deliberately strict) address check applies. No network
// request is made either way.
async function offerAddIfReader(tabId: number, rawUrl: string): Promise<void> {
    if (offeredUrl.get(tabId) === rawUrl) return
    let url: URL
    try {
        url = new URL(rawUrl)
    } catch {
        return
    }
    const known = knownSourceFor(url)
    if (known && !(await findUpgradeableSeed(url))) return
    if (!isAddableUrl(url) || !looksLikeChapterUrl(rawUrl)) return
    if (await hasHostAccess(url.origin)) {
        const signals = await captureTabSignals(tabId)
        if (!signals) return
        let seen: URL
        try {
            seen = new URL(signals.url)
        } catch {
            return
        }
        if (seen.origin !== url.origin || seen.pathname !== url.pathname) return
        if (!looksLikeReaderPage(signals)) return
    }
    offeredUrl.set(tabId, rawUrl)
    await setAddAvailableBadge(tabId)
}

async function offerAfterSettle(tabId: number, rawUrl: string): Promise<void> {
    if (!looksLikeChapterUrl(rawUrl)) return
    await new Promise<void>(resolve => setTimeout(resolve, SPA_SETTLE_MS))
    let current: { url?: string | undefined; status?: string | undefined } | undefined
    try {
        current = await browser.tabs.get(tabId)
    } catch {
        return
    }
    // Moved on again, or a full page load is still in flight (its own "complete" event handles it).
    if (!current || current.url !== rawUrl || current.status === "loading") return
    await offerAddIfReader(tabId, rawUrl)
}

export async function handleTabUpdated(
    tabId: number,
    changeInfo: { url?: string | undefined; status?: string | undefined },
    tab: { url?: string | undefined }
): Promise<void> {
    // Leaving a page drops its "Add available" badge. Awaited so a hint set for the new page below
    // can never be wiped by this clear landing late.
    if (changeInfo.url) {
        offeredUrl.delete(tabId)
        await clearAddAvailableBadge(tabId).catch(() => {})
    }
    const internal = isInternalTab(tabId)

    // Added sources are re-registered from storage each time the worker starts, and a worker woken
    // by this very navigation gets here first. Every source decision below waits for that.
    await userSourcesReady()

    if (changeInfo.url && !internal && !isInternalUrl(changeInfo.url)) {
        void captureChapter(changeInfo.url).catch(error => {
            console.warn("[AMR] Automatic chapter capture failed", error)
        })
    }

    if (changeInfo.status === "complete" && tab.url && !internal && !isInternalUrl(tab.url)) {
        let parsedUrl: URL
        try {
            parsedUrl = new URL(tab.url)
        } catch {
            return
        }
        const source = findSource(parsedUrl)
        if (source?.match(parsedUrl) === "chapter") {
            await injectPanelForTab(tabId, tab.url)
        } else {
            await offerAddIfReader(tabId, tab.url)
        }
        return
    }

    if (changeInfo.url && !changeInfo.status && !internal && !isInternalUrl(changeInfo.url)) {
        await offerAfterSettle(tabId, changeInfo.url)
    }
}

export function forgetTab(tabId: number): void {
    offeredUrl.delete(tabId)
}
