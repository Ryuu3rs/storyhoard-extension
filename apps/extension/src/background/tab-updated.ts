import { looksLikeChapterUrl, looksLikeReaderPage } from "@amr/source-engine"
import { captureTabSignals, findUpgradeableSeed } from "../arch-sources"
import { addSourceFromTab, deriveSeedListOnVisit, knownSourceFor } from "../handlers/add-source"
import { getSettings } from "../settings"
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

// Which page an address is: origin, path and query. The #fragment only counts for "#/..." routing, so a
// reader that rewrites the fragment as the user scrolls is still one page, while ?ch=5 and ?ch=6 are two.
function pageKey(url: URL): string {
    return url.origin + url.pathname + url.search + (url.hash.startsWith("#/") ? url.hash : "")
}

// The last page a tab was offered "add" for, so the url event and the later "complete" event for the
// same navigation inspect the page once.
const offeredUrl = new Map<number, string>()

// The check running for each tab right now. The url event and the settle timer can both reach
// offerAddIfReader for the same navigation while the first is still awaiting host access or tab signals,
// so the "already offered" check has not been reached yet; this coalesces them to one run, which is what
// stops a detected page being injected (and auto-followed) twice. A new page, or a reload of the same
// one, replaces the run, and the old run stops at its next step.
type OfferRun = { page: string }
const offering = new Map<number, OfferRun>()

// Many readers draw their pages with their own script a moment after the browser reports the load
// finished, so a page that host access lets us read is looked at again after these delays.
const RECHECK_DELAYS_MS = [1500, 4000]

async function hasHostAccess(origin: string): Promise<boolean> {
    try {
        return await browser.permissions.contains({ origins: [`${origin}/*`] })
    } catch {
        return false
    }
}

// With host access held the page itself decides, not its address, so a reader whose chapter address
// carries no number (an opaque id, a page counter) is still found. A page that is not a reader yet is
// looked at again while its own script may still be drawing it; the checks stop as soon as the tab is
// on another page. Everything read stays in this worker.
async function pageIsReader(tabId: number, url: URL, run: OfferRun): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
        const signals = await captureTabSignals(tabId)
        if (!signals || offering.get(tabId) !== run) return false
        let seen: URL
        try {
            seen = new URL(signals.url)
        } catch {
            return false
        }
        if (pageKey(seen) !== run.page) return false
        if (looksLikeReaderPage(signals)) return true
        const delay = RECHECK_DELAYS_MS[attempt]
        if (delay === undefined) return false
        await new Promise<void>(resolve => setTimeout(resolve, delay))
        if (offering.get(tabId) !== run) return false
    }
}

// Offer the toolbar "+" hint on a reader page the extension does not recognise (or only recognises as
// a tracking-only stand-in). Without host access nothing may be read, so only the (deliberately
// strict) address check applies and a wiki or podcast page whose address merely ends in "chapter-3"
// or "episode-12" is not flagged. With access, the page itself must show it is a reader (page-sized
// images or a reader container). No network request is made either way.
//
// When access is held, the page is confirmed a reader and nothing recognises the site at all, the
// observe-only panel is put on it too: the grant the user gave (for this site, or "Detect on all
// sites") is what makes that possible, and the panel only watches the user's own tab. A page with no
// access gets the hint and nothing more.
async function offerAddIfReader(tabId: number, rawUrl: string): Promise<void> {
    let url: URL
    try {
        url = new URL(rawUrl)
    } catch {
        return
    }
    const page = pageKey(url)
    if (offeredUrl.get(tabId) === page || offering.get(tabId)?.page === page) return
    const run: OfferRun = { page }
    offering.set(tabId, run)
    try {
        const known = knownSourceFor(url)
        if (known && !(await findUpgradeableSeed(url))) return
        if (!isAddableUrl(url)) return
        const hasAccess = await hasHostAccess(url.origin)
        const chapterAddress = looksLikeChapterUrl(rawUrl)
        if (!hasAccess && !chapterAddress) return
        if (hasAccess && !(await pageIsReader(tabId, url, run))) return
        if (offering.get(tabId) !== run) return
        offeredUrl.set(tabId, page)
        // The hint is cosmetic: a failed badge must not cost the page its panel.
        await setAddAvailableBadge(tabId).catch(() => undefined)
        if (hasAccess && !known) {
            const injected = await injectPanelForTab(tabId, rawUrl, "detected").catch(() => false)
            // Following adds the site with no click, so it needs the address to say "chapter" as well as
            // the page: any page with a few large images passes the content check alone.
            if (injected && chapterAddress) await followIfOptedIn(tabId, rawUrl)
        }
    } finally {
        if (offering.get(tabId) === run) offering.delete(tabId)
    }
}

// The opt-in "follow recognised sites automatically" setting (off unless the user turned it on). It runs
// the same add pipeline the Track button does, on a site whose access the user already granted; without
// the setting a detected page is only ever offered the button.
async function followIfOptedIn(tabId: number, rawUrl: string): Promise<void> {
    const settings = await getSettings().catch(() => undefined)
    if (settings?.autoFollowDetected !== true) return
    await addSourceFromTab({ url: rawUrl, tabId }).catch(() => undefined)
}

async function offerAfterSettle(tabId: number, rawUrl: string): Promise<void> {
    if (!looksLikeChapterUrl(rawUrl)) {
        let origin: string
        try {
            origin = new URL(rawUrl).origin
        } catch {
            return
        }
        if (!(await hasHostAccess(origin))) return
    }
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
    // A reload keeps the address, so a loading event also forgets the offer; otherwise the same url
    // would be treated as already offered and the hint would never come back after the page reloads.
    // A check still running for the page being reloaded ends too, so the reloaded page gets checks of its own.
    if (changeInfo.status === "loading") {
        offeredUrl.delete(tabId)
        offering.delete(tabId)
    }
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
            void deriveSeedListOnVisit(tabId, tab.url).catch(error => {
                console.warn("[AMR] Working out a site's chapter list failed", error)
            })
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
    offering.delete(tabId)
}
