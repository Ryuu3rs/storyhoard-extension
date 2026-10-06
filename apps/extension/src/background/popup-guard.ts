// MAIN-world pop-up / pop-under / new-tab guard, injected via
// scripting.executeScript({ world: "MAIN" }) so it is NOT subject to the page CSP (an inline
// <script> appended from the content script is - a scraper with script-src 'self' would silently
// disable it while the UI still shows "on"). It is the in-page half of the blocker; the network
// half (destination denylist) lives in rules/popup-block.json via declarativeNetRequest, and is
// what actually stops top-frame `location` redirects and iframe opens that no in-page hook can.
//
// On/off is the shared `data-amr-block-popups` attribute on <html>, flipped by the isolated-world
// panel. When on this neuters window.open and cancels cross-origin new-tab navigations
// (anchor/form/area/base) in the capture phase, while never touching clicks inside our own panel
// (identified by the host element id; shadow-DOM events retarget to it).
//
// This function is serialized and injected, so it must be fully self-contained: no imports, no
// closover of module scope - only its parameter and page globals.
export function popupGuardMain(hostId: string): void {
    const w = window as unknown as { __amrPopupGuard?: boolean }
    if (w.__amrPopupGuard) return
    w.__amrPopupGuard = true

    const on = () => document.documentElement.getAttribute("data-amr-block-popups") === "1"

    // window.open: when blocking, return null (NOT a stub that looks "closed", which the common
    // `var x=open(u); if(!x||x.closed) location=u;` fallback keys off to redirect the top frame).
    try {
        const nativeOpen = window.open
        window.open = function (this: unknown, ...args: unknown[]) {
            if (on()) return null
            try {
                return (nativeOpen as (...a: unknown[]) => Window | null).apply(window, args)
            } catch {
                return null
            }
        } as typeof window.open
    } catch {
        /* open is non-configurable on this page; the DNR layer still covers the destination */
    }

    // Is `href` a cross-site http(s) target? Same registrable-ish host is allowed (a page's own
    // links), everything else to a new tab is treated as a pop-under.
    const crossSite = (href: string): boolean => {
        try {
            const u = new URL(href, location.href)
            if (u.protocol !== "http:" && u.protocol !== "https:") return false
            const a = u.hostname
            const b = location.hostname
            return !(a === b || a.endsWith("." + b) || b.endsWith("." + a))
        } catch {
            return false
        }
    }

    const baseTarget = (): string => {
        const base = document.querySelector("base[target]")
        return (base?.getAttribute("target") || "").toLowerCase()
    }

    // Cancel a click that would open a new tab to a cross-site URL, or follow a javascript:/data:
    // anchor. Covers <a>, <area> (image maps), and the effective target from <base target>.
    document.addEventListener(
        "click",
        (e: Event) => {
            if (!on()) return
            let n = e.target as Element | null
            while (n && n.nodeType === 1) {
                if ((n as HTMLElement).id === hostId) return // our own panel
                const tag = n.tagName
                if (tag === "A" || tag === "AREA") {
                    const href = n.getAttribute("href") || ""
                    const ownTarget = (n.getAttribute("target") || "").toLowerCase()
                    const target = ownTarget || baseTarget()
                    const newTab = target === "_blank" || target === "_new"
                    const scheme = /^\s*(javascript|data):/i.test(href)
                    if (scheme || (newTab && href && crossSite(href))) {
                        e.preventDefault()
                        e.stopImmediatePropagation()
                        return
                    }
                }
                n = n.parentElement
            }
        },
        true
    )

    // Forms: a target=_blank (or a submit button's formtarget) cross-site submit is the same
    // pop-under trick without an <a>.
    document.addEventListener(
        "submit",
        (e: Event) => {
            if (!on()) return
            const form = e.target as HTMLFormElement | null
            if (!form || form.tagName !== "FORM") return
            const submitter = (e as SubmitEvent).submitter as HTMLElement | null
            const target = (
                submitter?.getAttribute("formtarget") ||
                form.getAttribute("target") ||
                baseTarget()
            ).toLowerCase()
            const action = submitter?.getAttribute("formaction") || form.getAttribute("action") || ""
            if ((target === "_blank" || target === "_new") && crossSite(action)) {
                e.preventDefault()
                e.stopImmediatePropagation()
            }
        },
        true
    )
}
