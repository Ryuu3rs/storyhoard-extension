// Tab IDs opened internally by fetchChapterHtmlViaTab. Excluded from the main
// tabs.onUpdated listener so our own background tabs don't re-trigger captureChapter
// and race against the in-flight tab fetch.
const internalTabIds = new Set<number>()

// URLs currently loading in an internal fetch tab. Registered synchronously BEFORE
// tabs.create resolves, closing the window where the tab's first onUpdated url event
// fires before we learn its tabId and would be mistaken for user navigation.
const internalUrls = new Set<string>()

export function isInternalTab(tabId: number): boolean {
    return internalTabIds.has(tabId)
}

export function isInternalUrl(url: string | undefined): boolean {
    return url !== undefined && internalUrls.has(url)
}

// A Cloudflare (or similar) managed challenge reports "complete" for the interim
// "Just a moment..." page itself, then auto-solves and reloads the real page a
// few seconds later - a second "complete" event we'd otherwise miss since we
// only waited for the first one. Detect the challenge markers so we know to
// keep waiting instead of extracting the challenge page's HTML by mistake.
function looksLikeChallengePage(html: string): boolean {
    return (
        /id=["']challenge-(running|error-text|form)["']/i.test(html) ||
        /cf-turnstile/i.test(html) ||
        /Just a moment\.\.\./i.test(html) ||
        /cdn-cgi\/challenge-platform/i.test(html)
    )
}

// A src worth replacing from a data-* lazy attr: truly empty, an inline data: URI, or a
// URL whose FILENAME is itself a known placeholder ("loading.gif", "1x1.png", "spacer.png").
// Kept as an exported twin of the copy inlined into extractHtml's injected function below
// (browser.scripting serializes that function, so it cannot close over this) - the two MUST
// stay in sync. Testing the whole-URL tokens flagged real page images on any CDN whose path
// happened to contain "loading"/"blank"/"spacer"/"1x1".
export function isLazyPlaceholderSrc(src: string | null): boolean {
    if (!src || !src.trim()) return true
    if (/^data:/i.test(src)) return true
    const path = src.split(/[?#]/)[0] ?? src
    const file = (path.split("/").pop() ?? "").replace(/\.[a-z0-9]+$/i, "")
    return /^(1x1|blank|spacer|placeholder|loading)$/i.test(file) || /^\d{1,3}x\d{1,3}$/i.test(file)
}

// The origins a tab opened for `url` may legitimately end up on: its own, or the same site's
// "www." twin (apex <-> www redirects are routine). Anything else means the page redirected the tab
// somewhere the request never named.
function originsForRequest(url: string): string[] {
    const parsed = new URL(url)
    const twinHost = parsed.hostname.startsWith("www.") ? parsed.hostname.slice(4) : `www.${parsed.hostname}`
    return [parsed.origin, `${parsed.protocol}//${twinHost}${parsed.port ? `:${parsed.port}` : ""}`]
}

// Fail closed unless the tab is still on an origin the request named. The tab runs in the user's real
// session, and a hostile page can redirect it to another origin the extension holds access to (the
// extension's own site, a bundled source); reading that page would leak data the request never
// asked for. An unreadable tab URL (a redirect to an origin without host access) is a mismatch too.
async function assertTabOnRequestedOrigin(tabId: number, allowedOrigins: string[]): Promise<void> {
    const tab = await browser.tabs.get(tabId)
    let origin: string | undefined
    try {
        origin = tab.url ? new URL(tab.url).origin : undefined
    } catch {
        origin = undefined
    }
    if (origin === undefined || !allowedOrigins.includes(origin)) {
        throw new Error("The tab was redirected away from the requested site")
    }
}

async function extractHtml(tabId: number, allowedOrigins: string[]): Promise<string> {
    await assertTabOnRequestedOrigin(tabId, allowedOrigins)
    const results = await browser.scripting.executeScript({
        target: { tabId },
        args: [allowedOrigins],
        func: async (allowed: string[]) => {
            // The tab can navigate between the check above and this injection; read nothing from
            // a page that is no longer on the requested site.
            if (!allowed.includes(location.origin)) return ""
            // Some readers (e.g. MangaHub) server-render only a small preload window of
            // page <img> elements and inject the rest via JavaScript once a follow-up API
            // call returns - so an outerHTML snapshot taken at "load" captures only those
            // first few pages. Watch for <img> insertions and snapshot once they have
            // quiesced, so every injected page is present. A MutationObserver (not a fixed
            // sleep or count-poll) handles a slow/late API without either exiting early on
            // the preload window or always paying a worst-case wait. Deliberately no
            // scrolling: some strip readers append the NEXT chapter's images on
            // scroll-to-bottom, which would pollute this chapter's page list. Best-effort.
            try {
                await new Promise<void>(resolve => {
                    // Resolve this long after the last <img> is inserted (injection settled);
                    // this same floor also bounds the "nothing ever injects" case, and the
                    // hard cap bounds a page that keeps mutating forever.
                    const QUIET_MS = 1000
                    const NO_INJECT_FLOOR_MS = 3000
                    const HARD_CAP_MS = 8000
                    let settled = false
                    let quietTimer: ReturnType<typeof setTimeout> | undefined
                    const finish = () => {
                        if (settled) return
                        settled = true
                        observer.disconnect()
                        if (quietTimer) clearTimeout(quietTimer)
                        clearTimeout(hardTimer)
                        resolve()
                    }
                    const bump = (delay: number) => {
                        if (quietTimer) clearTimeout(quietTimer)
                        quietTimer = setTimeout(finish, delay)
                    }
                    const observer = new MutationObserver(mutations => {
                        for (const mutation of mutations) {
                            for (const node of mutation.addedNodes) {
                                if (
                                    node.nodeName === "IMG" ||
                                    (node instanceof Element && node.querySelector("img") !== null)
                                ) {
                                    bump(QUIET_MS)
                                    return
                                }
                            }
                        }
                    })
                    observer.observe(document.documentElement, { childList: true, subtree: true })
                    bump(NO_INJECT_FLOOR_MS)
                    const hardTimer = setTimeout(finish, HARD_CAP_MS)
                })
            } catch {
                // Settle is best-effort; fall through and snapshot whatever is present.
            }
            // Lazy-loading readers keep the real image URL on a data-* attribute until
            // each <img> scrolls into view, so an un-scrolled outerHTML snapshot only has
            // real src on the initial preload window. Fill any empty/placeholder src from
            // those data-* attrs so the snapshot carries every page. Best-effort only.
            try {
                // Only a truly empty/inline src, or a src whose FILENAME is itself a known
                // placeholder ("loading.gif", "1x1.png", "spacer.png"...), counts as a
                // placeholder to replace. Testing the tokens against the whole URL matched
                // real page images on any CDN whose path/title happened to contain "loading",
                // "blank", "spacer" or "1x1" (e.g. .../loading-scans/1.jpg) and clobbered
                // them with the wrong lazy attr.
                const isPlaceholder = (s: string | null): boolean => {
                    if (!s || !s.trim()) return true
                    if (/^data:/i.test(s)) return true
                    const path = s.split(/[?#]/)[0] ?? s
                    const file = (path.split("/").pop() ?? "").replace(/\.[a-z0-9]+$/i, "")
                    return /^(1x1|blank|spacer|placeholder|loading)$/i.test(file) || /^\d{1,3}x\d{1,3}$/i.test(file)
                }
                for (const img of Array.from(document.querySelectorAll("img"))) {
                    const src = img.getAttribute("src")
                    if (!isPlaceholder(src)) continue
                    const lazy =
                        img.getAttribute("data-src") ??
                        img.getAttribute("data-original") ??
                        img.getAttribute("data-lazy-src")
                    if (lazy) img.setAttribute("src", lazy)
                }
            } catch {
                // Snapshot whatever is present rather than failing the whole fetch.
            }
            return document.documentElement.outerHTML
        }
    })
    const html = results[0]?.result
    return typeof html === "string" ? html : ""
}

function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let settled = false
        const cleanup = () => {
            clearTimeout(timeoutId)
            browser.tabs.onUpdated.removeListener(listener)
        }
        const listener = (changedId: number, info: { status?: string }) => {
            if (changedId === tabId && info.status === "complete" && !settled) {
                settled = true
                cleanup()
                resolve()
            }
        }
        const timeoutId = setTimeout(() => {
            if (settled) return
            settled = true
            cleanup()
            reject(new Error("Tab load timed out"))
        }, timeoutMs)
        browser.tabs.onUpdated.addListener(listener)
        // A fast or cached page can reach "complete" before the listener attached, so
        // the event never arrives - poll once so we don't wait out the full timeout for
        // a load that already finished.
        void browser.tabs
            .get(tabId)
            .then(tab => {
                if (tab.status === "complete" && !settled) {
                    settled = true
                    cleanup()
                    resolve()
                }
            })
            .catch(() => {})
    })
}

// Open a background tab, wait for it to fully load, then extract the page HTML.
// Used as a fallback when direct fetch is blocked by bot-detection (5xx, 403).
// The tab uses the user's real browser session (cookies, TLS fingerprint).
export async function fetchChapterHtmlViaTab(url: string): Promise<string> {
    // Mark the URL internal before creating the tab: onUpdated can fire the tab's first
    // url event before tabs.create resolves and we learn its tabId, and without this
    // that event would be captured as if the user had navigated there.
    internalUrls.add(url)
    let tabId: number | undefined
    try {
        const tab = await browser.tabs.create({ url, active: false })
        tabId = tab.id
        if (!tabId) throw new Error("Tab creation failed")
        internalTabIds.add(tabId)
        const allowedOrigins = originsForRequest(url)
        await waitForTabComplete(tabId, 25_000)
        let html = await extractHtml(tabId, allowedOrigins)
        // The challenge auto-solves and reloads within a few seconds for a real
        // browser session - poll a bit longer rather than giving up immediately.
        for (let attempt = 0; attempt < 5 && looksLikeChallengePage(html); attempt++) {
            await new Promise<void>(resolve => setTimeout(resolve, 2_000))
            html = await extractHtml(tabId, allowedOrigins)
        }
        return html
    } finally {
        // Clear the internal markers only AFTER the tab is actually gone - mirroring the
        // register-before-create ordering at the top. If we cleared first, a challenge that
        // auto-solves and reloads the tab in the window before tabs.remove settles would no
        // longer be excluded, and onUpdated would treat it as real user navigation -> a
        // spurious re-capture from a background scraping tab mid-teardown.
        if (tabId !== undefined) {
            await browser.tabs.remove(tabId).catch(() => {})
            internalTabIds.delete(tabId)
        }
        internalUrls.delete(url)
    }
}
