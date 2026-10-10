// Self-contained - serialized and injected into the page via scripting.executeScript.
// Must not reference any external variables or imports.
//
// ARCHITECTURE TRACK A (on-site pivot prototype): the floating reader-enhancement panel.
// Rests as a minimized handle, expands on click. Three explicit modes, chosen by the background:
// OFFICIAL/partner sites get the overlay + tracking and the reader toggles (off until the user
// flips one; saved view prefs are NOT auto-restored there, so a layout a toggle breaks never
// sticks); FOLLOWED sites additionally get their saved view prefs restored, the pop-up blocker on
// by default, and the keyboard shortcuts; DETECTED sites (a reader page the user has not followed)
// are observed only: label, on-page chapter list, prev/next and progress, with none of the above.
// Preserves the existing mechanics: luminance dark, scroll progress, Webtoons/Comix nav
// seeding, chapter:siblings, chapter:track.
import type { OfficialSite } from "../official-sources"
import type { PanelMode, PanelState, PanelStateInput, PanelText } from "./panel-state"

export type ChapterPromptSupport = { sourceName: string; sourceUrl: string | null; amrUrl: string; amrLabel: string }

// What the background hands the panel about a profile-backed source's rendered chapter list: the CSS
// selectors it declares for it ({} when it declares none). Null/undefined for every other site, which
// switches the list read off entirely.
export type RenderedListSelectors = { container?: string | undefined; item?: string | undefined }

export function injectChapterPrompt(
    chapterUrl: string,
    officialSites: OfficialSite[],
    _support?: ChapterPromptSupport,
    renderedSelectors?: RenderedListSelectors | null,
    mode: PanelMode = "followed"
): void {
    const HOST_ID = "__amr-chapter-prompt__"
    if (document.getElementById(HOST_ID)) return
    const STORYHOARD_LOGO =
        "data:image/png;base64,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"

    const ext: any = (globalThis as any).browser ?? (globalThis as any).chrome

    // The mode is resolved in the background (it knows the registered source and the official/partner
    // allowlist, baked default merged with the weeb.ltd feed) and passed in, so there is one source
    // of truth. Officialness keys off the REAL host, never a source profile's self-declared domain
    // (R3). On official sites the panel is overlay-only: no restyle, no blocker, lighter chrome.
    const isOfficial = mode === "official"
    const isFollowed = mode === "followed"
    const isDetected = mode === "detected"

    function parseLuminance(css: string): number {
        const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
        if (!m) return -1
        return (0.2126 * parseInt(m[1]!) + 0.7152 * parseInt(m[2]!) + 0.0722 * parseInt(m[3]!)) / 255
    }
    const bgCss =
        getComputedStyle(document.documentElement).backgroundColor || getComputedStyle(document.body).backgroundColor
    const pageIsLight = parseLuminance(bgCss) > 0.5

    // ---- page restyle layers ----
    // Shown on every recognized site (same neutral toolset everywhere, not singled out by site):
    // the reader controls and restyle layers apply wherever the panel injects.
    const styleEls: Record<string, HTMLStyleElement | undefined> = {}
    // The restyle layers act ONLY on the page-image container, never on every element whose class
    // happens to contain "chapter" or "page" (that hit navigation, headers and whole-layout wrappers
    // on sites whose markup reuses those words, and font-size:0 blanked their text). The containers
    // are found from the page itself: the parent of a run of page-sized images, marked with a data
    // attribute the CSS keys on. Re-marked whenever a layer is applied, since lazy readers add
    // images after load.
    const READER_ATTR = "data-amr-reader"
    function markReaderContainers() {
        const counts = new Map<Element, number>()
        for (const img of Array.from(document.querySelectorAll("img")).slice(0, 600)) {
            if (img.closest("#" + HOST_ID)) continue
            const w = Math.max(img.naturalWidth, img.clientWidth)
            const h = Math.max(img.naturalHeight, img.clientHeight)
            const lazy =
                img.hasAttribute("data-src") || img.hasAttribute("data-url") || img.hasAttribute("data-lazy-src")
            if (w < 300 || (h < 300 && !lazy)) continue
            const parent = img.parentElement
            if (parent) counts.set(parent, (counts.get(parent) ?? 0) + 1)
        }
        for (const old of Array.from(document.querySelectorAll("[" + READER_ATTR + "]"))) {
            if (!counts.has(old)) old.removeAttribute(READER_ATTR)
        }
        for (const [parent, n] of counts) if (n >= 1) parent.setAttribute(READER_ATTR, "1")
    }
    function setLayer(key: string, css: string | null) {
        if (css === null) {
            styleEls[key]?.remove()
            styleEls[key] = undefined
            return
        }
        markReaderContainers()
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
        "[data-amr-reader]{background:#111!important}"
    const FIT_CSS =
        ".reading-content img,.wp-manga-chapter-img,._images img,[data-amr-reader] img" +
        "{max-width:900px!important;width:100%!important;height:auto!important;margin:0 auto!important;display:block!important}"
    const SCROLL_CSS = ".reading-content,[data-amr-reader]{display:block!important}"
    // Webtoon "no gap": kill the whitespace between stacked page images (inline-image gaps come
    // from font-size/line-height on the container) so pages read as one continuous strip.
    const NO_GAP_CSS =
        ".reading-content,._images,[data-amr-reader]{font-size:0!important;line-height:0!important}" +
        ".reading-content img,.wp-manga-chapter-img,._images img,[data-amr-reader] img{display:block!important;margin:0 auto!important;padding:0!important;border:0!important;vertical-align:top!important}"

    let theme: "auto" | "light" | "dark" = isFollowed && pageIsLight ? "dark" : "auto"
    function applyTheme() {
        setLayer("dark", theme === "dark" ? DARK_CSS : null)
    }
    applyTheme()

    // ---- pop-up / pop-under / redirect blocker (FOLLOWED sites only) ----
    // Two cooperating layers, both outside this isolated-world panel:
    //   - popupGuardMain (injected by the background into the MAIN world, so it is NOT subject to
    //     the page CSP) neuters window.open and cancels cross-site new-tab anchor/form/area clicks.
    //   - a declarativeNetRequest denylist (rules/popup-block.json) blocks the known ad/18+
    //     destinations at the network layer, which is the only thing that can stop a top-frame
    //     `location` redirect or an iframe-originated open that no in-page hook can reach.
    // This function is just the on/off switch: it flips the shared documentElement attribute the
    // MAIN-world guard reads. Protection is ON by default on followed sites (the ad-heavy scraper
    // hosts the block exists for - being sent to an 18+ pop-under on the first click is exactly
    // what must not happen before the user has even found the toggle); the toggle turns it off.
    function setPopupBlock(on: boolean) {
        document.documentElement.setAttribute("data-amr-block-popups", on ? "1" : "")
    }
    // The toggle shows on official and followed sites, but defaults ON only on followed (ad-heavy)
    // sites; on official partners it defaults OFF so a legitimate window.open (share/login) isn't
    // blocked before the user asks for it. A detected site is observed only: the blocker stays off
    // and has no toggle until the site is followed.
    setPopupBlock(isFollowed)

    // ---- synced per-title reading prefs (save on change; they ride the manga row, so a change on one
    // device shows on the next). Saved prefs are only AUTO-RESTORED on followed sites: an official
    // site's own markup is not one these layers were fitted to, and restoring a layout that breaks it
    // would make the break persistent. The toggles themselves stay available everywhere.
    let panelMangaId: string | null = null
    // Detected mode only: whether the background has answered the tracking-only record request, and
    // whether it declined to keep one (auto-add is off), which is a different thing from a failed read.
    let detectedRecorded = false
    let detectedDeclined = false
    let setFitTog: ((v: boolean) => void) | null = null
    let setNoGapTog: ((v: boolean) => void) | null = null
    let setScrollTog: ((v: boolean) => void) | null = null
    let setWidth: ((pct: number) => void) | null = null
    let setThemeSeg: ((t: "auto" | "light" | "dark") => void) | null = null
    let autoMarkRead = false
    let autoMarked = false
    // Auto-mark must not fire on the initial pre-layout frame: before the page's images lay out,
    // scrollHeight - clientHeight is 0, so pct computes as 100 and a chapter the user never viewed
    // would be marked read the instant the panel mounts. Arm it only once the user actually scrolls
    // or after a settle delay (so a genuinely short, no-scroll chapter still auto-marks post-layout).
    let autoMarkArmed = false
    // panelMangaId is only known once chapter:siblings resolves (an async SW round-trip that can
    // cold-start the worker). A pref the user changes before then would be lost by a bare
    // `if (!panelMangaId) return`, so buffer it and flush once the id arrives. `touchedPrefs`
    // records which keys the user set so loadPrefs does not overwrite an in-flight change with the
    // older stored value.
    let pendingPrefs: Record<string, unknown> = {}
    let hasPendingPrefs = false
    const touchedPrefs = new Set<string>()
    function savePref(prefs: Record<string, unknown>) {
        for (const k of Object.keys(prefs)) touchedPrefs.add(k)
        if (!panelMangaId) {
            Object.assign(pendingPrefs, prefs)
            hasPendingPrefs = true
            return
        }
        ext.runtime.sendMessage({ type: "library:reading-prefs", mangaId: panelMangaId, ...prefs }).catch(() => {})
    }
    function flushPendingPrefs() {
        if (!panelMangaId || !hasPendingPrefs) return
        const prefs = pendingPrefs
        pendingPrefs = {}
        hasPendingPrefs = false
        ext.runtime.sendMessage({ type: "library:reading-prefs", mangaId: panelMangaId, ...prefs }).catch(() => {})
    }
    // Page width as a percent of the viewport (30-100), applied over the site's page images.
    function widthCss(pct: number): string {
        return (
            ".reading-content img,.wp-manga-chapter-img,._images img,[data-amr-reader] img{max-width:" +
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
    // light panel; followed and detected panels stay dark (the segmented control themes the PAGE, not the
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
        border:2px solid ${isFollowed ? "#8b5cf6" : T.border}}
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
    const badge = el("div", isFollowed ? "badge enh" : "badge")
    const badgeText = document.createTextNode(isFollowed ? "Enhanced" : isDetected ? "Detected" : "Official")
    badge.append(el("span", "d"), badgeText)
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

    // Shown only when every bounded rescan ran and the chapter list still could not be read.
    const retryBtn = el("button", "btn sec full", "Try again") as HTMLButtonElement
    retryBtn.hidden = true

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

    // "More chapters elsewhere" hint. Hidden until work:best-for-url says the ranker has a
    // clearly-better version (silent-unless-clearly-better). Copy is fixed and neutral; only a
    // verified official site is ever named (D2 / R7). Inline-styled so the injected panel stays
    // self-contained.
    const hint = el("div")
    // Default hidden via display:none (NOT the `hidden` attribute - the inline display below would
    // override it, which is why "Go there" used to show on every site regardless of hasBetter).
    // Revealed by setting display:flex only when work:best-for-url reports a clearly-better version.
    hint.style.cssText =
        "margin-top:8px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.35;" +
        "background:rgba(139,92,246,.12);border:1px solid rgba(139,92,246,.5);display:none;flex-direction:column;gap:6px"
    const hintText = el("div")
    const hintBtn = el("button", "btn pri", "Go there") as HTMLButtonElement
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

    // Fullscreen + mark-read-and-next, shown on every mode.
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
        trackChapter()
        if (nextUrl) window.location.href = nextUrl
        else {
            bmarknext.textContent = "Marked ✓"
            bmarknext.disabled = true
        }
    })
    acts2.append(bfull, bmarknext)

    // ---- MAIN view ----
    const mainView = el("div")
    mainView.append(nowTitle, chapWrap, retryBtn, acts, acts2, hint)
    // Reader controls render on official and followed sites (uniform neutral toolset). A detected site is
    // observed only, so the restyle controls wait until the site is followed.
    if (!isDetected) {
        mainView.append(el("div", "lbl", "Reading view"))
        const seg = el("div", "seg")
        const segBtns: Record<string, HTMLElement> = {}
        // Apply a theme choice to the buttons + page. `save` is false when loadPrefs restores it
        // (so restoring doesn't echo a write back).
        const applyThemeChoice = (t: "auto" | "light" | "dark", save: boolean) => {
            theme = t
            for (const k of Object.keys(segBtns)) segBtns[k]!.className = k === t ? "on" : ""
            applyTheme()
            if (save) savePref({ readerTheme: t })
        }
        for (const t of ["auto", "light", "dark"] as const) {
            const b = el("button", t === theme ? "on" : undefined, t[0]!.toUpperCase() + t.slice(1))
            b.addEventListener("click", () => applyThemeChoice(t, true))
            segBtns[t] = b
            seg.appendChild(b)
        }
        setThemeSeg = t => applyThemeChoice(t, false)
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
        mainView.appendChild(
            mkTog(
                "Continuous scroll",
                null,
                false,
                v => {
                    // Two layers: SCROLL_CSS stacks images on long-strip readers; the attribute
                    // drives the MAIN-world DM5 flattener on paginated readers (fanfox etc.).
                    setLayer("scroll", v ? SCROLL_CSS : null)
                    document.documentElement.setAttribute("data-amr-continuous", v ? "1" : "")
                    savePref({ continuousScroll: v ? true : null })
                },
                api => (setScrollTog = api.set)
            )
        )
        mainView.appendChild(mkTog("Block pop-ups", null, isFollowed, v => setPopupBlock(v)))
    }

    // ---- SETTINGS view (opened by the cog) ----
    const setView = el("div")
    setView.hidden = true
    const backBtn = el("button", "mini", "‹")
    backBtn.setAttribute("aria-label", "Back")
    const setHead = el("div", "sethead")
    setHead.append(backBtn, el("span", "setttl", "Settings"))
    setView.append(setHead)
    if (!isDetected) {
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
    const footerText = document.createTextNode("detecting chapter...")
    attr.append(footerText)
    const gear = el("button", "mini", "⚙")
    gear.style.border = "0"
    gear.setAttribute("aria-label", "Settings")
    attr.append(gear)
    pad.append(attr)

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

    // populate the chapter dropdown from the tracked chapter list. Re-run after the panel records a list
    // it read from the page, so a source with no fetchable list fills its dropdown on the same visit.
    function loadChapterDropdown() {
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
                    o.textContent =
                        c.title && c.title !== "N/A" ? c.title : hasNumber ? "Chapter " + c.sortKey : "Extra"
                    if (c.url === chapterUrl) o.selected = true
                    chapSel.appendChild(o)
                }
                applyCurrentChapterLabel()
                renderPanelState()
            })
            .catch(() => {})
    }
    loadChapterDropdown()
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

    // Honest panel state. Both helpers below are inline copies of the ones in panel-state.ts (this
    // function is serialised into the page and cannot import); panel-state.test.ts keeps them in sync.
    function selectPanelState(input: PanelStateInput): PanelState {
        const resolved = input.mangaResolved || input.listCount > 1
        if (input.mode === "official") {
            return resolved || input.backoffExhausted || input.labelResolved ? "tracking-page" : "detecting"
        }
        if (resolved) return input.mode === "detected" ? "needs-follow" : "followed"
        if (input.backoffExhausted) return "couldnt-read-list"
        return input.hasNeighbour || input.labelResolved ? "tracking-page" : "detecting"
    }
    function panelStateText(state: PanelState, label: string): PanelText {
        if (state === "detecting")
            return { handle: label || "Detecting...", footer: "detecting chapter...", retry: false }
        if (state === "tracking-page")
            return { handle: label || "This page", footer: "tracking this page", retry: false }
        if (state === "needs-follow") {
            return { handle: label || "Detected", footer: "not followed yet", retry: false }
        }
        if (state === "couldnt-read-list") {
            return { handle: "Couldn't read list", footer: "couldn't read the chapter list", retry: true }
        }
        return { handle: label || "Tracking", footer: "tracked by StoryHoard", retry: false }
    }
    let rescansDone = 0
    function currentPanelState(): PanelState {
        return selectPanelState({
            mode,
            labelResolved: chapLabel !== "",
            listCount: chapSel.options.length,
            mangaResolved: !!panelMangaId || detectedDeclined,
            hasNeighbour: !!prevUrl || !!nextUrl,
            backoffExhausted: rescansDone >= RESCAN_DELAYS.length
        })
    }
    function renderPanelState() {
        const state = currentPanelState()
        const text = panelStateText(state, chapLabel)
        handleLabel.textContent = text.handle
        footerText.textContent = text.footer
        retryBtn.hidden = !text.retry
        if (state === "couldnt-read-list" && nowTitle.textContent === "Detecting chapter...") {
            nowTitle.textContent = "Couldn't read the chapter list"
        }
    }

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
            trackChapter()
        }
        renderPanelState()
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

    // The chapter label the page itself shows: the selected entry of a chapter dropdown, else the link to
    // this chapter in a chapter list, else the document title. The background reads the chapter number
    // from it for a site whose URL carries only an internal chapter id.
    function currentChapterLabel(): string {
        const SELECTED = [
            "select[class*='chapter' i] option:checked",
            "select[id*='chapter' i] option:checked",
            "select[name*='chapter' i] option:checked",
            "[class*='chapter' i] [aria-current]",
            "[id*='chapter' i] [aria-current]",
            "[class*='chapter' i] .active",
            "[class*='chapter' i] .current",
            "[id*='chapter' i] .active",
            "[id*='chapter' i] .current"
        ].join(", ")
        let text = ""
        try {
            text = (document.querySelector(SELECTED)?.textContent ?? "").trim()
            if (!text) {
                for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).slice(0, 3000)) {
                    if (a.closest("#" + HOST_ID) || a.href.split("#")[0] !== chapterUrl.split("#")[0]) continue
                    text = (a.textContent ?? "").trim()
                    if (text) break
                }
            }
        } catch {}
        if (!text) text = document.title
        return text.replace(/s+/g, " ").trim().slice(0, 200)
    }
    function trackChapter() {
        const label = currentChapterLabel()
        // A detected page has no registered source for chapter:track to resolve; the background keeps its
        // own tracking-only record instead.
        const message = isDetected
            ? { type: "work:track-detected", url: chapterUrl, explicit: true }
            : { type: "chapter:track", url: chapterUrl }
        ext.runtime.sendMessage({ ...message, ...(label ? { label } : {}) }).catch(() => {})
    }

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

    // Generic prev/next seed for any site that is not an official partner: before a chapter list is recorded there is no
    // database neighbour, but the page itself usually carries its own previous / next chapter controls
    // (rel="prev"/"next", or a link labelled that way). Read those, accepting only a link to another
    // page on this origin with the same path shape as this chapter (so a "next page" of a series
    // listing, a login link, or an ad never becomes the next chapter). Idempotent: fills only a side
    // that is still empty, and is re-run once the page has finished rendering.
    function seedGenericNavFromDom() {
        if (isOfficial || (prevUrl && nextUrl)) return
        try {
            const here = new URL(chapterUrl)
            const hereSegments = here.pathname.split("/").filter(Boolean)
            const PREV = /\bprev(?:ious)?\b|←|上一?章|前の?話/i
            const NEXT = /\bnext\b|→|下一?章|次の?話/i
            const usable = (a: HTMLAnchorElement): string | null => {
                if (a.closest("#" + HOST_ID)) return null
                if (a.getAttribute("aria-disabled") === "true" || /\bdisabled\b/i.test(a.className)) return null
                try {
                    const u = new URL(a.getAttribute("href") ?? "", location.href)
                    if (u.origin !== here.origin || u.pathname === here.pathname) return null
                    const segments = u.pathname.split("/").filter(Boolean)
                    if (segments.length !== hereSegments.length || segments[0] !== hereSegments[0]) return null
                    return u.toString()
                } catch {
                    return null
                }
            }
            for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).slice(0, 1000)) {
                const label = [
                    (a.textContent ?? "").trim().slice(0, 40),
                    a.getAttribute("aria-label") ?? "",
                    a.getAttribute("title") ?? "",
                    a.getAttribute("rel") ?? ""
                ].join(" ")
                const wantsPrev = !prevUrl && PREV.test(label)
                const wantsNext = !nextUrl && NEXT.test(label)
                if (!wantsPrev && !wantsNext) continue
                const target = usable(a)
                if (!target) continue
                if (wantsPrev) {
                    prevUrl = target
                    bprev.disabled = false
                } else if (wantsNext) {
                    nextUrl = target
                    bnext.disabled = false
                }
                if (prevUrl && nextUrl) break
            }
        } catch {}
    }
    seedGenericNavFromDom()

    // The chapter list the site renders in the user's own page (a dropdown or list its script built),
    // read from the DOM only - the panel never requests anything. Scoped to the profile's declared
    // selectors when it has them, else to the usual chapter-list containers; an anchor or option
    // outside those (a "latest updates" widget, a footer) is never read.
    const LIST_ITEM_CAP = 2000
    function readRenderedChapterList(): Array<{ url: string; text: string }> {
        const KNOWN_CONTAINERS = [
            "select[class*='chapter' i]",
            "select[id*='chapter' i]",
            "select[name*='chapter' i]",
            "[class*='chapter-list' i]",
            "[class*='chapterlist' i]",
            "[class*='chapters' i]",
            "[class*='episode-list' i]",
            "[id*='chapter-list' i]",
            "[id*='chapterlist' i]",
            "[id*='chapters' i]",
            "ul.chapters",
            "#chapters"
        ].join(", ")
        const query = (root: ParentNode, selector: string): Element[] => {
            try {
                return Array.from(root.querySelectorAll(selector))
            } catch {
                return []
            }
        }
        const items: Array<{ url: string; text: string }> = []
        const seen = new Set<string>()
        const add = (raw: string | null, text: string | null) => {
            if (!raw || items.length >= LIST_ITEM_CAP) return
            let absolute: string
            try {
                absolute = new URL(raw, location.href).toString()
            } catch {
                return
            }
            if (seen.has(absolute)) return
            seen.add(absolute)
            items.push({ url: absolute, text: (text ?? "").replace(/\s+/g, " ").trim().slice(0, 200) })
        }
        const containers = renderedSelectors?.container
            ? query(document, renderedSelectors.container)
            : query(document, KNOWN_CONTAINERS)
        for (const container of containers.slice(0, 10)) {
            if (container.closest("#" + HOST_ID)) continue
            const entries = renderedSelectors?.item
                ? query(container, renderedSelectors.item)
                : query(container, "a[href], option[value]")
            for (const entry of entries.slice(0, LIST_ITEM_CAP)) {
                if (entry instanceof HTMLOptionElement) add(entry.value, entry.textContent)
                else if (entry instanceof HTMLAnchorElement) add(entry.getAttribute("href"), entry.textContent)
                else add(entry.querySelector("a[href]")?.getAttribute("href") ?? null, entry.textContent)
            }
        }
        return items
    }

    // Send the list read from the page to the background (only when it changed since the last send),
    // which keeps just this site's own chapters, fills the dropdown and notices new chapters. Sent on
    // followed and detected sites; the background ignores any other source and validates every link.
    let renderedListSignature = ""
    function reportRenderedList() {
        if (isOfficial || !renderedSelectors) return
        if (isDetected && !detectedRecorded) return
        const items = readRenderedChapterList()
        if (items.length === 0) return
        const signature = items.length + "|" + items[0]!.url + "|" + items[items.length - 1]!.url
        if (signature === renderedListSignature) return
        ext.runtime
            .sendMessage({
                type: "work:record-chapter-list",
                url: chapterUrl,
                ...(panelMangaId ? { mangaId: panelMangaId } : {}),
                items
            })
            .then((resp: any) => {
                if (!resp?.ok || !resp.data || (!resp.data.recorded && !resp.data.advanced)) return
                // Remember this list as sent ONLY after the worker confirms it recorded/advanced. A
                // send that lands on a cold worker (sources not yet registered) records nothing;
                // leaving the signature unset lets the next backoff scan re-send instead of caching
                // the failure and skipping forever - the first-load "stuck on This chapter" bug.
                renderedListSignature = signature
                loadChapterDropdown()
                loadSiblings()
            })
            .catch(() => {})
    }
    // A cold service worker (still registering sources) or a script-built list not yet in the DOM
    // both make the first scan come back empty. Retry on a bounded geometric backoff, re-running the
    // whole resolve each tick (generic nav + on-page list report + dropdown + siblings), and stop as
    // soon as the panel actually resolves - the dropdown filled past the lone "This chapter" entry,
    // or siblings returned a mangaId. Replaces the old two fixed 1.5s/6s timeouts, which could not
    // recover when the first list report landed on a cold worker (see reportRenderedList).
    const RESCAN_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000]
    let rescanIndex = 0
    function panelResolved(): boolean {
        return chapSel.options.length > 1 || !!panelMangaId
    }
    // A detected page keeps scanning until its own chapter list has been read: the title being tracked
    // (which this panel arranges itself) is not the point of the visit, the list is.
    function scanSettled(): boolean {
        return isDetected ? chapSel.options.length > 1 : panelResolved()
    }
    // A detected page has no registered source, so no title exists for its list to attach to until the
    // background has kept its tracking-only record of the visit. Success-gated like the list report:
    // asked again on each rescan until the background answers, and again once the page shows a readable
    // chapter label when the address alone carries no chapter number.
    function ensureDetectedRecord() {
        if (!isDetected || detectedRecorded) return
        const label = currentChapterLabel()
        ext.runtime
            .sendMessage({ type: "work:track-detected", url: chapterUrl, ...(label ? { label } : {}) })
            .then((resp: any) => {
                if (!resp?.ok || !resp.data?.supported || resp.data.retry) return
                detectedRecorded = true
                if (!resp.data.tracked) {
                    detectedDeclined = true
                    renderPanelState()
                    return
                }
                loadSiblings()
                reportRenderedList()
            })
            .catch(() => {})
    }
    function scheduleRescan() {
        if (rescanIndex >= RESCAN_DELAYS.length) return
        setTimeout(scanRenderedPage, RESCAN_DELAYS[rescanIndex++]!)
    }
    function scanRenderedPage() {
        rescansDone += 1
        seedGenericNavFromDom()
        bprev.disabled = !prevUrl
        bnext.disabled = !nextUrl
        ensureDetectedRecord()
        reportRenderedList()
        if (!scanSettled()) {
            loadChapterDropdown()
            loadSiblings()
        }
        if (!scanSettled()) scheduleRescan()
        renderPanelState()
    }
    // Manual retry after the bounded backoff gave up: start the whole resolve over.
    function retryScan() {
        rescanIndex = 0
        rescansDone = 0
        renderedListSignature = ""
        renderPanelState()
        scheduleRescan()
    }
    retryBtn.addEventListener("click", () => {
        track("retry-list")
        retryScan()
    })
    ensureDetectedRecord()
    scheduleRescan()

    function loadSiblings() {
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
                    const firstResolve = panelMangaId !== d.mangaId
                    panelMangaId = d.mangaId
                    if (firstResolve) {
                        loadPrefs(d.mangaId)
                        flushPendingPrefs()
                    }
                }
            })
            .catch(() => {})
    }
    loadSiblings()

    // Load this title's saved reading prefs and apply them on a followed site, flipping the toggles
    // without re-saving. Official sites skip this (see the note above the prefs state).
    function loadPrefs(mangaId: string) {
        if (!isFollowed) return
        ext.runtime
            .sendMessage({ type: "library:get", mangaId })
            .then((resp: any) => {
                const m = resp?.ok ? resp.data : null
                if (!m) return
                // Skip any key the user already changed since the panel opened (buffered in
                // pendingPrefs) - their in-flight choice wins over the older stored value.
                if (!touchedPrefs.has("pageFit") && m.pageFit === "width") {
                    setLayer("fit", FIT_CSS)
                    setFitTog?.(true)
                }
                if (!touchedPrefs.has("noGapContinuous") && m.noGapContinuous === true) {
                    setLayer("nogap", NO_GAP_CSS)
                    setNoGapTog?.(true)
                }
                if (!touchedPrefs.has("continuousScroll") && m.continuousScroll === true) {
                    setLayer("scroll", SCROLL_CSS)
                    document.documentElement.setAttribute("data-amr-continuous", "1")
                    setScrollTog?.(true)
                }
                if (
                    !touchedPrefs.has("readerTheme") &&
                    (m.readerTheme === "auto" || m.readerTheme === "light" || m.readerTheme === "dark")
                ) {
                    setThemeSeg?.(m.readerTheme)
                }
                if (
                    !touchedPrefs.has("pageWidthPct") &&
                    typeof m.pageWidthPct === "number" &&
                    m.pageWidthPct >= 30 &&
                    m.pageWidthPct < 100
                ) {
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
                ? "More chapters on " + d.officialName
                : "More chapters on another site"
            hintBtn.addEventListener("click", () => {
                track("open-better")
                // Only navigate to an http(s) destination (defense in depth with the handler guard).
                if (!/^https?:\/\//i.test(d.bestUrl!)) return
                try {
                    location.assign(d.bestUrl!)
                } catch {}
            })
            hint.style.display = "flex"
        })
        .catch(() => {})

    btrack.addEventListener("click", () => {
        track("mark-read")
        trackChapter()
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
    // FOLLOWED sites only: official sites are overlay-only, detected sites are observe-only, and the panel must not preventDefault
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
    if (isFollowed) document.addEventListener("keydown", onKeyDown)

    // SPA chapter changes (history pushState, no full reload) don't re-fire the background's
    // inject (it's gated on tabs.onUpdated status:"complete"), so without this the panel keeps the
    // PREVIOUS chapter's url, prev/next and progress - and "Mark read" would track the wrong
    // chapter. The content script runs in the isolated world and can't hook the page's own
    // pushState, so poll location.href; on a real url change, tear this panel down and re-inject a
    // fresh one for the new url. Only same-document changes reach here (a full navigation unloads
    // the page), so this never double-injects over a normal load.
    const withoutHash = (u: string) => u.split("#")[0]
    const spaPoll = window.setInterval(() => {
        // Lazy readers add (and size) their page images after load, so keep the marked containers
        // current while any restyle layer is on.
        if (Object.values(styleEls).some(Boolean)) markReaderContainers()
        if (withoutHash(location.href) === withoutHash(chapterUrl)) return
        window.clearInterval(spaPoll)
        window.removeEventListener("scroll", onScroll)
        document.removeEventListener("keydown", onKeyDown)
        hostEl.remove()
        injectChapterPrompt(location.href, officialSites, _support, renderedSelectors, mode)
    }, 1200)

    updateProgress()
}
