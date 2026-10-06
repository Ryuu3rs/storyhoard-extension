// Self-contained - serialized and injected into the page via scripting.executeScript.
// Must not reference any external variables or imports.
//
// ARCHITECTURE TRACK A (on-site pivot prototype): the floating reader-enhancement panel.
// Rests as a minimized handle, expands on click. Two variants keyed off an official-site
// allowlist: OFFICIAL/partner sites get overlay + tracking only (no DOM/CSS restyle, no
// blocker); USER-ADDED sites get the reader controls (theme/fit/scroll) + a pop-up blocker
// toggle (the blocker itself is a later phase - the toggle is present but inert here).
// Preserves the existing mechanics: luminance dark, scroll progress, Webtoons/Comix nav
// seeding, chapter:siblings, chapter:track.
import type { OfficialSite } from "../official-sources"

export type ChapterPromptSupport = { sourceName: string; sourceUrl: string | null; amrUrl: string; amrLabel: string }

export function injectChapterPrompt(
    chapterUrl: string,
    officialSites: OfficialSite[],
    _support?: ChapterPromptSupport
): void {
    const HOST_ID = "__amr-chapter-prompt__"
    if (document.getElementById(HOST_ID)) return
    const STORYHOARD_LOGO =
        "data:image/png;base64,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"

    const ext: any = (globalThis as any).browser ?? (globalThis as any).chrome

    // Official/partner allowlist is resolved in the background (baked default merged with the
    // weeb.ltd feed) and passed in as officialSites, so there is one source of truth. On these
    // sites the panel is overlay-only: no restyle, no blocker, lighter chrome. Officialness keys
    // off the REAL host, never a source profile's self-declared domain (R3). Match host + parent.
    // Strip a trailing dot (absolute FQDN like "webtoons.com.") and www, matching the canonical
    // officialSiteForHost - otherwise an official site reached via an absolute FQDN would be
    // misclassified as user-added and wrongly get the restyle + blocker (violating R3).
    const host = location.hostname
        .replace(/\.$/, "")
        .replace(/^www\./, "")
        .toLowerCase()
    const officialMatch = (officialSites ?? []).find(s => {
        const d = s.domain
            .replace(/\.$/, "")
            .replace(/^www\./, "")
            .toLowerCase()
        return host === d || host.endsWith("." + d)
    })
    const isOfficial = officialMatch !== undefined
    const userAdded = !isOfficial

    function parseLuminance(css: string): number {
        const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
        if (!m) return -1
        return (0.2126 * parseInt(m[1]!) + 0.7152 * parseInt(m[2]!) + 0.0722 * parseInt(m[3]!)) / 255
    }
    const bgCss =
        getComputedStyle(document.documentElement).backgroundColor || getComputedStyle(document.body).backgroundColor
    const pageIsLight = parseLuminance(bgCss) > 0.5

    // ---- page restyle layers (USER-ADDED sites only; never on official partners) ----
    const styleEls: Record<string, HTMLStyleElement | undefined> = {}
    function setLayer(key: string, css: string | null) {
        if (!userAdded) return
        if (css === null) {
            styleEls[key]?.remove()
            styleEls[key] = undefined
            return
        }
        let el = styleEls[key]
        if (!el) {
            el = document.createElement("style")
            el.id = "__amr-layer-" + key
            document.head.appendChild(el)
            styleEls[key] = el
        }
        el.textContent = css
    }
    const DARK_CSS =
        "html,body{background-color:#111!important;color:#e2e8f0!important}" +
        ".chapter-container,.reading-content,.page-break,.wp-manga-chapter-img," +
        "div[class*='chapter'],div[class*='page']{background:#111!important}"
    const FIT_CSS =
        ".reading-content img,.wp-manga-chapter-img,div[class*='chapter'] img,div[class*='page'] img," +
        "._images,img[class*='page']{max-width:900px!important;width:100%!important;height:auto!important;margin:0 auto!important;display:block!important}"
    const SCROLL_CSS = ".reading-content,div[class*='chapter']{display:block!important}"
    // Webtoon "no gap": kill the whitespace between stacked page images (inline-image gaps come
    // from font-size/line-height on the container) so pages read as one continuous strip.
    const NO_GAP_CSS =
        ".reading-content,div[class*='chapter'],div[class*='page'],._images{font-size:0!important;line-height:0!important}" +
        ".reading-content img,.wp-manga-chapter-img,div[class*='chapter'] img,div[class*='page'] img,._images img,img[class*='page']{display:block!important;margin:0 auto!important;padding:0!important;border:0!important;vertical-align:top!important}"

    let theme: "auto" | "light" | "dark" = userAdded && pageIsLight ? "dark" : "auto"
    function applyTheme() {
        setLayer("dark", theme === "dark" ? DARK_CSS : null)
    }
    applyTheme()

    // ---- pop-up / pop-under / redirect blocker (USER-ADDED sites only) ----
    // Two cooperating layers, both outside this isolated-world panel:
    //   - popupGuardMain (injected by the background into the MAIN world, so it is NOT subject to
    //     the page CSP) neuters window.open and cancels cross-site new-tab anchor/form/area clicks.
    //   - a declarativeNetRequest denylist (rules/popup-block.json) blocks the known ad/18+
    //     destinations at the network layer, which is the only thing that can stop a top-frame
    //     `location` redirect or an iframe-originated open that no in-page hook can reach.
    // This function is just the on/off switch: it flips the shared documentElement attribute the
    // MAIN-world guard reads. Protection is ON by default on user-added sites (the ad-heavy scraper
    // hosts the block exists for - being sent to an 18+ pop-under on the first click is exactly
    // what must not happen before the user has even found the toggle); the toggle turns it off.
    function setPopupBlock(on: boolean) {
        if (!userAdded) return
        document.documentElement.setAttribute("data-amr-block-popups", on ? "1" : "")
    }
    setPopupBlock(true)

    // ---- synced per-title reading prefs (load on open, save on change; they ride the manga row, so
    // a change on one device shows on the next). Only meaningful on user-added sites (official sites
    // are overlay-only), but saving the pref is harmless either way.
    let panelMangaId: string | null = null
    let setFitTog: ((v: boolean) => void) | null = null
    let setNoGapTog: ((v: boolean) => void) | null = null
    let setWidth: ((pct: number) => void) | null = null
    let autoMarkRead = false
    let autoMarked = false
    // Auto-mark must not fire on the initial pre-layout frame: before the page's images lay out,
    // scrollHeight - clientHeight is 0, so pct computes as 100 and a chapter the user never viewed
    // would be marked read the instant the panel mounts. Arm it only once the user actually scrolls
    // or after a settle delay (so a genuinely short, no-scroll chapter still auto-marks post-layout).
    let autoMarkArmed = false
    function savePref(prefs: Record<string, unknown>) {
        if (!panelMangaId) return
        ext.runtime.sendMessage({ type: "library:reading-prefs", mangaId: panelMangaId, ...prefs }).catch(() => {})
    }
    // Page width as a percent of the viewport (30-100), applied over the site's page images.
    function widthCss(pct: number): string {
        return (
            ".reading-content img,.wp-manga-chapter-img,div[class*='chapter'] img,div[class*='page'] img," +
            "._images img,img[class*='page']{max-width:" +
            pct +
            "vw!important;width:100%!important;height:auto!important;margin:0 auto!important;display:block!important}"
        )
    }

    // ---- panel + handle shell ----
    const hostEl = document.createElement("div")
    hostEl.id = HOST_ID
    document.body.appendChild(hostEl)
    const shadow = hostEl.attachShadow({ mode: "open" })

    // Panel chrome theme is fixed at construction: a light page on an official site gets a
    // light panel; user-added panels stay dark (the segmented control themes the PAGE, not the
    // panel chrome, in this prototype).
    const panelIsLight = isOfficial && pageIsLight
    const T = panelIsLight
        ? { panel: "#ffffff", surface: "#eef1f6", border: "#d6dbe4", text: "#1a2230", muted: "#5b6878" }
        : { panel: "#11161d", surface: "#182338", border: "#1b2538", text: "#f0f4fa", muted: "#6b7a8d" }

    const style = document.createElement("style")
    style.textContent = `
      :host{all:initial}
      *{box-sizing:border-box;font-family:Inter,system-ui,-apple-system,sans-serif}
      .wrap{position:fixed;right:16px;bottom:16px;z-index:2147483647;touch-action:none}
      .handle{height:48px;display:inline-flex;align-items:center;gap:8px;background:${T.surface};
        border:1px solid ${T.border};border-radius:999px;padding:0 16px 0 6px;cursor:grab;user-select:none;
        box-shadow:0 12px 40px rgba(0,0,0,.45);color:${T.text};font-size:13px;font-weight:600}
      .handle.dragging{cursor:grabbing}
      .handle .ring{width:38px;height:38px;border-radius:999px;background:${T.panel};display:grid;place-items:center;
        border:2px solid ${userAdded ? "#8b5cf6" : T.border}}
      .mono{width:16px;height:16px;border-radius:5px;background:linear-gradient(135deg,#8b5cf6,#5b8def);
        display:grid;place-items:center;color:#fff;font-size:10px;font-weight:700}
      .panel{width:264px;max-height:70vh;overflow:auto;background:${T.panel};border:1px solid ${T.border};
        border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.5);color:${T.text};
        animation:si .18s cubic-bezier(.22,.6,.36,1) both}
      @keyframes si{from{transform:translateY(12px);opacity:0}to{transform:none;opacity:1}}
      @media (prefers-reduced-motion:reduce){.panel{animation:none}}
      .rail{height:2px;background:${T.surface}}
      .rail>span{display:block;height:100%;background:#8b5cf6;width:0%}
      .pad{padding:14px}
      .hd{display:flex;align-items:center;gap:8px;margin-bottom:12px}
      .brand{display:flex;align-items:center;gap:7px;font-weight:700;font-size:13px}
      .badge{font-size:11px;display:inline-flex;align-items:center;gap:4px;background:${T.surface};
        padding:2px 8px;border-radius:999px;color:${T.muted}}
      .badge .d{width:6px;height:6px;border-radius:999px;background:${T.muted}}
      .badge.enh{color:#c4b5fd}.badge.enh .d{background:#8b5cf6}
      .sp{margin-left:auto;display:flex;align-items:center;gap:6px;color:${T.muted}}
      .mini{width:22px;height:22px;border-radius:6px;display:grid;place-items:center;border:1px solid ${T.border};
        color:${T.muted};cursor:pointer;background:none;font-size:14px}
      .mini:hover{color:${T.text}}
      .title{font-size:15px;font-weight:700;line-height:1.25}
      .chapwrap{margin-top:6px}
      .chapsel{width:100%;background:${T.surface};color:${T.text};border:1px solid ${T.border};border-radius:8px;
        padding:6px 8px;font:inherit;font-size:12px;cursor:pointer;appearance:auto}
      .acts1{margin-top:10px;display:flex;gap:6px;align-items:stretch}
      .btn{border:0;border-radius:8px;font:inherit;font-weight:600;font-size:13px;padding:8px 10px;cursor:pointer;color:${T.text}}
      .btn.ico{background:${T.surface};border:1px solid ${T.border};width:38px;display:grid;place-items:center;flex:none;padding:0}
      .btn.ico:disabled{opacity:.3;cursor:default}
      .pri{background:#8b5cf6;color:#fff;flex:1}
      .sec{background:${T.surface};border:1px solid ${T.border};color:${T.text}}
      .pri:hover{background:#7c3aed}
      .btn.full{width:100%;background:${T.surface};border:1px solid ${T.border};margin-top:4px}
      .sethead{display:flex;align-items:center;gap:8px;margin-bottom:4px}
      .setttl{font-weight:700;font-size:14px}
      .slider{width:100%;accent-color:#8b5cf6;margin:2px 0 4px}
      .lbl{font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:${T.muted};margin:14px 0 6px}
      .seg{display:flex;background:${T.surface};border:1px solid ${T.border};border-radius:8px;padding:2px}
      .seg button{flex:1;border:0;background:none;color:${T.muted};font:inherit;font-size:12px;font-weight:600;
        padding:6px;border-radius:6px;cursor:pointer}
      .seg button.on{background:${T.panel};color:${T.text}}
      .tog{display:flex;align-items:center;justify-content:space-between;padding:7px 0;font-size:12px;font-weight:600}
      .tog .s2{color:${T.muted};font-weight:400;font-size:11px}
      .sw{width:34px;height:20px;border-radius:999px;background:${T.surface};position:relative;flex:none;cursor:pointer;border:0}
      .sw.on{background:#8b5cf6}
      .sw::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:#fff;transition:left .15s}
      .sw.on::after{left:16px}
      .div{height:1px;background:${T.border};margin:12px 0}
      .attr{font-size:11px;color:${T.muted};display:flex;align-items:center;justify-content:space-between}
      .explain{font-size:11px;color:${T.muted};margin-top:6px}
    `

    function el(tag: string, cls?: string, text?: string): HTMLElement {
        const e = document.createElement(tag)
        if (cls) e.className = cls
        if (text !== undefined) e.textContent = text
        return e
    }
    function logoImg(size: number): HTMLImageElement {
        const img = document.createElement("img")
        img.src = STORYHOARD_LOGO
        img.width = size
        img.height = size
        img.alt = ""
        img.style.display = "block"
        return img
    }

    const wrap = el("div", "wrap")

    // minimized handle
    const handle = el("div", "handle")
    const ring = el("span", "ring")
    ring.appendChild(logoImg(26))
    const handleLabel = el("span", undefined, "")
    handle.append(ring, handleLabel)

    // expanded panel
    const panel = el("div", "panel")
    panel.hidden = true
    const rail = el("div", "rail")
    const railFill = el("span")
    rail.appendChild(railFill)
    const pad = el("div", "pad")

    const hd = el("div", "hd")
    const brand = el("div", "brand")
    brand.append(logoImg(22), document.createTextNode("StoryHoard"))
    const badge = el("div", userAdded ? "badge enh" : "badge")
    badge.append(el("span", "d"), document.createTextNode(userAdded ? "Enhanced" : "Official"))
    const sp = el("div", "sp")
    const minBtn = el("button", "mini", "-")
    minBtn.setAttribute("aria-label", "Minimize")
    sp.append(minBtn)
    hd.append(brand, badge, sp)

    const CHEV_L =
        '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>'
    const CHEV_R =
        '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>'

    let chapLabel = ""

    const nowTitle = el("div", "title", "Detecting chapter...")

    // chapter dropdown
    const chapSel = document.createElement("select")
    chapSel.className = "chapsel"
    const curOpt = document.createElement("option")
    curOpt.textContent = "This chapter"
    curOpt.value = chapterUrl
    chapSel.appendChild(curOpt)
    const chapWrap = el("div", "chapwrap")
    chapWrap.appendChild(chapSel)

    // compact one-row actions: prev | mark read | next
    const bprev = document.createElement("button")
    bprev.className = "btn ico"
    bprev.innerHTML = CHEV_L
    bprev.disabled = true
    bprev.setAttribute("aria-label", "Previous chapter")
    const bnext = document.createElement("button")
    bnext.className = "btn ico"
    bnext.innerHTML = CHEV_R
    bnext.disabled = true
    bnext.setAttribute("aria-label", "Next chapter")
    const btrack = el("button", "btn pri", "Mark read") as HTMLButtonElement
    const acts = el("div", "acts1")
    acts.append(bprev, btrack, bnext)

    // "A more complete version is available" hint. Hidden until work:best-for-url says the ranker
    // has a clearly-better version (silent-unless-clearly-better). Copy is fixed and neutral; only
    // a verified official site is ever named (D2 / R7). Inline-styled so the injected panel stays
    // self-contained.
    const hint = el("div")
    hint.hidden = true
    hint.style.cssText =
        "margin-top:8px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.35;" +
        "background:rgba(139,92,246,.12);border:1px solid rgba(139,92,246,.5);display:flex;flex-direction:column;gap:6px"
    const hintText = el("div")
    const hintBtn = el("button", "btn pri", "Open best") as HTMLButtonElement
    hintBtn.style.alignSelf = "flex-start"
    hint.append(hintText, hintBtn)

    const mkTog = (
        label: string,
        sub: string | null,
        on: boolean,
        onToggle: (v: boolean) => void,
        register?: (api: { set: (v: boolean) => void }) => void
    ) => {
        const row = el("div", "tog")
        const left = el("span")
        left.append(document.createTextNode(label))
        if (sub) {
            left.append(document.createTextNode(" "))
            left.append(el("span", "s2", sub))
        }
        const sw = el("button", on ? "sw on" : "sw")
        sw.setAttribute("role", "switch")
        let state = on
        sw.addEventListener("click", () => {
            state = !state
            sw.className = state ? "sw on" : "sw"
            onToggle(state)
        })
        // Lets loaded prefs flip the switch WITHOUT firing onToggle (which would re-save).
        if (register) register({ set: (v: boolean) => ((state = v), (sw.className = v ? "sw on" : "sw")) })
        row.append(left, sw)
        return row
    }

    // Fullscreen + mark-read-and-next, shown on both official and user-added sites.
    const acts2 = el("div")
    acts2.style.cssText = "display:flex;gap:6px;margin-top:6px"
    const bfull = el("button", "btn sec", "Fullscreen") as HTMLButtonElement
    bfull.style.flex = "1"
    bfull.addEventListener("click", () => {
        track("fullscreen")
        try {
            if (document.fullscreenElement) void document.exitFullscreen()
            else void document.documentElement.requestFullscreen()
        } catch {}
    })
    const bmarknext = el("button", "btn sec", "Mark & next") as HTMLButtonElement
    bmarknext.style.flex = "1"
    bmarknext.addEventListener("click", () => {
        track("mark-next")
        ext.runtime.sendMessage({ type: "chapter:track", url: chapterUrl }).catch(() => {})
        if (nextUrl) window.location.href = nextUrl
        else {
            bmarknext.textContent = "Marked ✓"
            bmarknext.disabled = true
        }
    })
    acts2.append(bfull, bmarknext)

    // ---- MAIN view ----
    const mainView = el("div")
    mainView.append(nowTitle, chapWrap, acts, acts2, hint)
    if (userAdded) {
        mainView.append(el("div", "lbl", "Reading view"))
        const seg = el("div", "seg")
        const segBtns: Record<string, HTMLElement> = {}
        for (const t of ["auto", "light", "dark"] as const) {
            const b = el("button", t === theme ? "on" : undefined, t[0]!.toUpperCase() + t.slice(1))
            b.addEventListener("click", () => {
                theme = t
                for (const k of Object.keys(segBtns)) segBtns[k]!.className = k === t ? "on" : ""
                applyTheme()
            })
            segBtns[t] = b
            seg.appendChild(b)
        }
        mainView.appendChild(seg)
        mainView.appendChild(
            mkTog(
                "Fit width",
                null,
                false,
                v => {
                    setLayer("fit", v ? FIT_CSS : null)
                    savePref({ pageFit: v ? "width" : null })
                },
                api => (setFitTog = api.set)
            )
        )
        mainView.appendChild(
            mkTog(
                "No gap",
                null,
                false,
                v => {
                    setLayer("nogap", v ? NO_GAP_CSS : null)
                    savePref({ noGapContinuous: v ? true : null })
                },
                api => (setNoGapTog = api.set)
            )
        )
        mainView.appendChild(mkTog("Continuous scroll", null, false, v => setLayer("scroll", v ? SCROLL_CSS : null)))
        mainView.appendChild(mkTog("Block pop-ups", null, true, v => setPopupBlock(v)))
    }

    // ---- SETTINGS view (opened by the cog) ----
    const setView = el("div")
    setView.hidden = true
    const backBtn = el("button", "mini", "‹")
    backBtn.setAttribute("aria-label", "Back")
    const setHead = el("div", "sethead")
    setHead.append(backBtn, el("span", "setttl", "Settings"))
    setView.append(setHead)
    if (userAdded) {
        setView.append(el("div", "lbl", "Page width"))
        const slider = document.createElement("input")
        slider.type = "range"
        slider.min = "30"
        slider.max = "100"
        slider.value = "100"
        slider.className = "slider"
        // Apply without saving (used by loadPrefs); saving happens on user input below.
        setWidth = (pct: number) => {
            slider.value = String(pct)
            setLayer("width", pct >= 100 ? null : widthCss(pct))
        }
        slider.addEventListener("input", () => {
            const pct = parseInt(slider.value, 10) || 100
            setLayer("width", pct >= 100 ? null : widthCss(pct))
            savePref({ pageWidthPct: pct >= 100 ? null : pct })
        })
        setView.append(slider)
    }
    setView.append(mkTog("Auto mark-read at end", null, false, v => (autoMarkRead = v)))
    const openApp = el("button", "btn sec full", "Open full settings")
    openApp.addEventListener("click", () => {
        try {
            window.open(ext.runtime.getURL("app.html"), "_blank", "noopener")
        } catch {}
    })
    setView.append(openApp)

    pad.append(hd, mainView, setView)
    pad.append(el("div", "div"))
    const attr = el("div", "attr")
    attr.append(document.createTextNode("tracked by StoryHoard"))
    const gear = el("button", "mini", "⚙")
    gear.style.border = "0"
    gear.setAttribute("aria-label", "Settings")
    attr.append(gear)
    pad.append(attr)
    if (isOfficial) pad.append(el("div", "explain", "Reader controls off on official sites."))

    // cog <-> back toggles the settings view
    function toggleSettings(open: boolean) {
        setView.hidden = !open
        mainView.hidden = open
    }
    let settingsOpen = false
    gear.addEventListener("click", () => {
        settingsOpen = !settingsOpen
        toggleSettings(settingsOpen)
    })
    backBtn.addEventListener("click", () => {
        settingsOpen = false
        toggleSettings(false)
    })

    // Apply the resolved chapter title to whichever option is currently the selected one. Used by
    // both the chapter:siblings response and the dropdown rebuild, so whichever wins the race, the
    // label lands on a live node (the old code wrote to a detached placeholder when the list
    // rebuild ran after siblings resolved).
    function applyCurrentChapterLabel() {
        if (!chapLabel) return
        const sel = chapSel.selectedOptions[0] ?? curOpt
        if (sel && sel.isConnected) sel.textContent = chapLabel
    }

    // populate the chapter dropdown from the tracked chapter list
    ext.runtime
        .sendMessage({ type: "work:chapter-list", url: chapterUrl })
        .then((resp: any) => {
            const list = resp?.ok ? (resp.data as Array<{ url: string; title: string; sortKey: number }>) : null
            if (!Array.isArray(list) || list.length === 0) return
            chapSel.innerHTML = ""
            for (const c of list) {
                const o = document.createElement("option")
                o.value = c.url
                // Unnumbered chapters carry a non-finite sortKey (Infinity, which serializes to
                // null over the message boundary) - never render "Chapter null"/"Chapter Infinity".
                const hasNumber = typeof c.sortKey === "number" && Number.isFinite(c.sortKey)
                o.textContent = c.title && c.title !== "N/A" ? c.title : hasNumber ? "Chapter " + c.sortKey : "Extra"
                if (c.url === chapterUrl) o.selected = true
                chapSel.appendChild(o)
            }
            applyCurrentChapterLabel()
        })
        .catch(() => {})
    chapSel.addEventListener("change", () => {
        const target = chapSel.value
        if (target && target !== chapterUrl) {
            window.removeEventListener("scroll", onScroll)
            window.location.href = target
        }
    })

    panel.append(rail, pad)
    wrap.append(handle, panel)
    shadow.append(style, wrap)

    // expand / minimize
    function show(expanded: boolean) {
        panel.hidden = !expanded
        handle.hidden = expanded
    }

    // Docking: the wrap snaps to a viewport corner. Default bottom-right, but if that corner is
    // already occupied by a fixed site element (e.g. an on-site pop-up/chat widget), nudge to
    // the first clear corner so we never sit under the site's own UI. User can drag to re-dock.
    type Corner = "br" | "bl" | "tr" | "tl"
    const CORNER_KEY = "__amr_panel_corner__"
    function placeCorner(c: Corner) {
        wrap.style.left = wrap.style.right = wrap.style.top = wrap.style.bottom = "auto"
        if (c === "br") {
            wrap.style.right = "16px"
            wrap.style.bottom = "16px"
        } else if (c === "bl") {
            wrap.style.left = "16px"
            wrap.style.bottom = "16px"
        } else if (c === "tr") {
            wrap.style.right = "16px"
            wrap.style.top = "16px"
        } else {
            wrap.style.left = "16px"
            wrap.style.top = "16px"
        }
    }
    function cornerPoint(c: Corner): [number, number] {
        const w = window.innerWidth,
            h = window.innerHeight
        if (c === "br") return [w - 40, h - 40]
        if (c === "bl") return [40, h - 40]
        if (c === "tr") return [w - 40, 40]
        return [40, 40]
    }
    function cornerBlocked(c: Corner): boolean {
        const [x, y] = cornerPoint(c)
        const elAt = document.elementFromPoint(x, y)
        if (!elAt || elAt === document.body || elAt === document.documentElement) return false
        // Walk up: blocked if an ancestor is fixed/sticky (a site widget sitting in that corner).
        let node: Element | null = elAt
        for (let i = 0; node && i < 6; i++) {
            const pos = getComputedStyle(node).position
            if (pos === "fixed" || pos === "sticky") return true
            node = node.parentElement
        }
        return false
    }
    let corner: Corner = "br"
    try {
        const saved = localStorage.getItem(CORNER_KEY)
        if (saved === "br" || saved === "bl" || saved === "tr" || saved === "tl") corner = saved
    } catch {}
    // If the chosen corner is blocked by a site element, pick the first clear one.
    if (cornerBlocked(corner)) {
        corner = (["tr", "bl", "tl", "br"] as Corner[]).find(c => !cornerBlocked(c)) ?? corner
    }
    placeCorner(corner)

    // Drag the handle to re-dock; a short press without movement counts as a click (expand).
    let dragging = false
    let startX = 0,
        startY = 0,
        moved = false
    handle.addEventListener("pointerdown", e => {
        dragging = true
        moved = false
        startX = e.clientX
        startY = e.clientY
        handle.setPointerCapture(e.pointerId)
        handle.classList.add("dragging")
    })
    handle.addEventListener("pointermove", e => {
        if (!dragging) return
        if (Math.abs(e.clientX - startX) > 6 || Math.abs(e.clientY - startY) > 6) moved = true
        if (!moved) return
        wrap.style.right = wrap.style.bottom = "auto"
        wrap.style.left = e.clientX - 24 + "px"
        wrap.style.top = e.clientY - 24 + "px"
    })
    handle.addEventListener("pointerup", e => {
        if (!dragging) return
        dragging = false
        handle.classList.remove("dragging")
        try {
            handle.releasePointerCapture(e.pointerId)
        } catch {}
        if (!moved) {
            show(true)
            return
        }
        // Snap to nearest corner by pointer position.
        const right = e.clientX > window.innerWidth / 2
        const bottom = e.clientY > window.innerHeight / 2
        corner = (bottom ? (right ? "br" : "bl") : right ? "tr" : "tl") as Corner
        placeCorner(corner)
        try {
            localStorage.setItem(CORNER_KEY, corner)
        } catch {}
    })
    minBtn.addEventListener("click", () => show(false))

    // scroll progress -> rail + handle label
    function updateProgress() {
        const r = document.documentElement
        const scrollable = r.scrollHeight - r.clientHeight
        // A chapter that fits the viewport (nothing to scroll) is fully visible = at the end, so
        // treat it as 100% (otherwise auto-mark-read could never fire on short chapters).
        const pct = scrollable > 0 ? Math.round((window.scrollY / scrollable) * 100) : 100
        railFill.style.width = pct + "%"
        // Auto mark-read once, when the reader reaches the end - but only after arming (see above),
        // so the pre-layout mount frame can't mark an unviewed chapter read.
        if (autoMarkRead && autoMarkArmed && !autoMarked && pct >= 98) {
            autoMarked = true
            track("auto-mark")
            ext.runtime.sendMessage({ type: "chapter:track", url: chapterUrl }).catch(() => {})
        }
        const base = chapLabel !== "" ? chapLabel : "Tracking"
        handleLabel.textContent = base
    }
    let rafPending = false
    function onScroll() {
        autoMarkArmed = true // a real scroll means the page has laid out and the user is engaged
        if (rafPending) return
        rafPending = true
        requestAnimationFrame(() => {
            updateProgress()
            rafPending = false
        })
    }
    window.addEventListener("scroll", onScroll, { passive: true })
    // A short chapter that needs no scroll still arms after a settle delay (enough for images to
    // lay out), so "auto mark-read at end" works there too without firing on the pre-layout frame.
    setTimeout(() => {
        autoMarkArmed = true
        updateProgress()
    }, 2500)

    function track(action: string) {
        ext.runtime
            .sendMessage({ type: "analytics:record", event: "panel_action", detail: JSON.stringify({ action }) })
            .catch(() => {})
    }

    let prevUrl: string | null = null
    let nextUrl: string | null = null

    ;(function seedNavFromDom() {
        try {
            const cu = new URL(chapterUrl)
            const epNo = Number(cu.searchParams.get("episode_no"))
            const titleNo = cu.searchParams.get("title_no")
            if (!epNo || !titleNo || isNaN(epNo)) return
            const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="episode_no="]'))
            for (const a of anchors) {
                try {
                    const au = new URL(a.href || a.getAttribute("href") || "", location.origin)
                    if (au.searchParams.get("title_no") !== titleNo) continue
                    const aEpNo = Number(au.searchParams.get("episode_no"))
                    if (aEpNo === epNo - 1 && !prevUrl) {
                        prevUrl = au.toString()
                        bprev.disabled = false
                    }
                    if (aEpNo === epNo + 1 && !nextUrl) {
                        nextUrl = au.toString()
                        bnext.disabled = false
                    }
                } catch {}
            }
        } catch {}
    })()
    ;(function seedComixNavFromDom() {
        try {
            if (!/(^|\.)comix\.to$/i.test(location.hostname)) return
            const m = new URL(chapterUrl).pathname.match(
                /^\/title\/([a-z0-9][a-z0-9-]+)\/\d+-chapter-(\d+(?:\.\d+)?)\/?$/i
            )
            if (!m) return
            const slug = m[1]
            const cur = parseFloat(m[2]!)
            if (!isFinite(cur)) return
            let latest = Infinity
            const dataEl = document.getElementById("initial-data")
            if (dataEl && dataEl.textContent) {
                const data = JSON.parse(dataEl.textContent)
                const queries = data && data.queries
                if (queries && typeof queries === "object") {
                    for (const k of Object.keys(queries)) {
                        let key: unknown
                        try {
                            key = JSON.parse(k)
                        } catch {
                            continue
                        }
                        if (Array.isArray(key) && key.indexOf("detail") !== -1) {
                            const lc = (queries as Record<string, { latestChapter?: unknown }>)[k]?.latestChapter
                            if (typeof lc === "number") {
                                latest = lc
                                break
                            }
                        }
                    }
                }
            }
            const base = `${location.origin}/title/${slug}/0-chapter-`
            if (cur > 1 && !prevUrl) {
                prevUrl = base + (Number.isInteger(cur) ? cur - 1 : Math.floor(cur))
                bprev.disabled = false
            }
            if (Number.isFinite(latest) && cur < latest && !nextUrl) {
                nextUrl = base + (Number.isInteger(cur) ? cur + 1 : Math.ceil(cur))
                bnext.disabled = false
            }
        } catch {}
    })()

    ext.runtime
        .sendMessage({ type: "chapter:siblings", url: chapterUrl })
        .then((resp: any) => {
            if (!resp?.ok || !resp.data) return
            const d = resp.data as {
                prevUrl: string | null
                nextUrl: string | null
                mangaTitle: string | null
                chapterTitle: string | null
                mangaId: string | null
            }
            if (d.prevUrl !== null) prevUrl = d.prevUrl
            if (d.nextUrl !== null) nextUrl = d.nextUrl
            if (d.mangaTitle) nowTitle.textContent = d.mangaTitle
            if (d.chapterTitle) {
                chapLabel = d.chapterTitle
                applyCurrentChapterLabel()
            }
            bprev.disabled = !prevUrl
            bnext.disabled = !nextUrl
            updateProgress()
            if (d.mangaId) {
                panelMangaId = d.mangaId
                loadPrefs(d.mangaId)
            }
        })
        .catch(() => {})

    // Load this title's saved reading prefs and apply them (user-added sites only - the setters +
    // restyle layers are no-ops on official sites). Flips the toggles without re-saving.
    function loadPrefs(mangaId: string) {
        if (!userAdded) return
        ext.runtime
            .sendMessage({ type: "library:get", mangaId })
            .then((resp: any) => {
                const m = resp?.ok ? resp.data : null
                if (!m) return
                if (m.pageFit === "width") {
                    setLayer("fit", FIT_CSS)
                    setFitTog?.(true)
                }
                if (m.noGapContinuous === true) {
                    setLayer("nogap", NO_GAP_CSS)
                    setNoGapTog?.(true)
                }
                if (typeof m.pageWidthPct === "number" && m.pageWidthPct >= 30 && m.pageWidthPct < 100) {
                    setWidth?.(m.pageWidthPct)
                }
            })
            .catch(() => {})
    }

    // Ask the ranker whether a clearly-better version exists for this title. Shows the quiet hint
    // only when it does; the button opens the best source's own page in this tab (user action).
    ext.runtime
        .sendMessage({ type: "work:best-for-url", url: chapterUrl })
        .then((resp: any) => {
            if (!resp?.ok || !resp.data?.hasBetter) return
            const d = resp.data as { bestUrl?: string; bestIsOfficial?: boolean; officialName?: string }
            if (!d.bestUrl) return
            hintText.textContent = d.officialName
                ? "A more complete version is on " + d.officialName
                : "A more complete version is available"
            hintBtn.addEventListener("click", () => {
                track("open-better")
                // Only navigate to an http(s) destination (defense in depth with the handler guard).
                if (!/^https?:\/\//i.test(d.bestUrl!)) return
                try {
                    location.assign(d.bestUrl!)
                } catch {}
            })
            hint.hidden = false
        })
        .catch(() => {})

    btrack.addEventListener("click", () => {
        track("mark-read")
        ext.runtime.sendMessage({ type: "chapter:track", url: chapterUrl }).catch(() => {})
        btrack.textContent = "Marked ✓"
        ;(btrack as HTMLButtonElement).disabled = true
    })
    bprev.addEventListener("click", () => {
        if (!prevUrl) return
        track("prev")
        bprev.textContent = "← Going..."
        bprev.disabled = true
        bnext.disabled = true
        window.removeEventListener("scroll", onScroll)
        window.location.href = prevUrl
    })
    bnext.addEventListener("click", () => {
        if (!nextUrl) return
        track("next")
        bnext.textContent = "Going... →"
        bprev.disabled = true
        bnext.disabled = true
        window.removeEventListener("scroll", onScroll)
        window.location.href = nextUrl
    })

    // Keyboard navigation: Left/[ = prev chapter, Right/] = next, F = fullscreen. Ignored while the
    // user is typing in a field, and when a modifier is held (so site/browser shortcuts still work).
    // USER-ADDED sites only: official sites are overlay-only, and the panel must not preventDefault
    // the arrow keys / hijack F over the site's own native reader.
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return
        const t = e.target as HTMLElement | null
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
        if ((e.key === "ArrowLeft" || e.key === "[") && prevUrl) {
            e.preventDefault()
            track("key-prev")
            window.removeEventListener("scroll", onScroll)
            window.location.href = prevUrl
        } else if ((e.key === "ArrowRight" || e.key === "]") && nextUrl) {
            e.preventDefault()
            track("key-next")
            window.removeEventListener("scroll", onScroll)
            window.location.href = nextUrl
        } else if (e.key === "f" || e.key === "F") {
            try {
                if (document.fullscreenElement) void document.exitFullscreen()
                else void document.documentElement.requestFullscreen()
            } catch {}
        }
    }
    if (userAdded) document.addEventListener("keydown", onKeyDown)

    // SPA chapter changes (history pushState, no full reload) don't re-fire the background's
    // inject (it's gated on tabs.onUpdated status:"complete"), so without this the panel keeps the
    // PREVIOUS chapter's url, prev/next and progress - and "Mark read" would track the wrong
    // chapter. The content script runs in the isolated world and can't hook the page's own
    // pushState, so poll location.href; on a real url change, tear this panel down and re-inject a
    // fresh one for the new url. Only same-document changes reach here (a full navigation unloads
    // the page), so this never double-injects over a normal load.
    const withoutHash = (u: string) => u.split("#")[0]
    const spaPoll = window.setInterval(() => {
        if (withoutHash(location.href) === withoutHash(chapterUrl)) return
        window.clearInterval(spaPoll)
        window.removeEventListener("scroll", onScroll)
        document.removeEventListener("keydown", onKeyDown)
        hostEl.remove()
        injectChapterPrompt(location.href, officialSites, _support)
    }, 1200)

    updateProgress()
}
