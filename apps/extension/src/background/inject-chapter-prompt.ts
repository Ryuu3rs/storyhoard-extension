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
export type ChapterPromptSupport = { sourceName: string; sourceUrl: string | null; amrUrl: string; amrLabel: string }

export function injectChapterPrompt(chapterUrl: string, _support?: ChapterPromptSupport): void {
    const HOST_ID = "__amr-chapter-prompt__"
    if (document.getElementById(HOST_ID)) return
    const STORYHOARD_LOGO =
        "data:image/png;base64,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"

    const ext: any = (globalThis as any).browser ?? (globalThis as any).chrome

    // Official/partner allowlist (fallback copy; later served by weeb.ltd). On these sites the
    // panel is overlay-only: no restyle, no blocker, lighter chrome. Match host + parent domain.
    const OFFICIAL = ["webtoons.com", "mangadex.org", "mangaplus.shueisha.co.jp", "tapas.io", "comikey.com", "inkr.com"]
    const host = location.hostname.replace(/^www\./, "")
    const isOfficial = OFFICIAL.some(d => host === d || host.endsWith("." + d))
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

    let theme: "auto" | "light" | "dark" = userAdded && pageIsLight ? "dark" : "auto"
    function applyTheme() {
        setLayer("dark", theme === "dark" ? DARK_CSS : null)
    }
    applyTheme()

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
      .chap{font-size:12px;color:${T.muted};margin-top:2px}
      .acts{margin-top:12px;display:flex;flex-direction:column;gap:6px}
      .brow{display:flex;gap:6px}
      .btn{border:0;border-radius:8px;font:inherit;font-weight:600;font-size:13px;padding:9px 10px;cursor:pointer;color:${T.text}}
      .sec{flex:1;background:${T.surface};border:1px solid ${T.border}}
      .sec:disabled{opacity:.3;cursor:default}
      .pri{background:#8b5cf6;color:#fff;width:100%}
      .pri:hover{background:#7c3aed}
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
    badge.append(el("span", "d"), document.createTextNode(userAdded ? "Enhanced" : "Partner"))
    const sp = el("div", "sp")
    const minBtn = el("button", "mini", "-")
    minBtn.setAttribute("aria-label", "Minimize")
    sp.append(minBtn)
    hd.append(brand, badge, sp)

    const nowTitle = el("div", "title", "Detecting chapter...")
    const nowChap = el("div", "chap", "")

    const acts = el("div", "acts")
    const brow = el("div", "brow")
    const bprev = el("button", "btn sec", "‹ Prev") as HTMLButtonElement
    bprev.disabled = true
    const bnext = el("button", "btn sec", "Next ›") as HTMLButtonElement
    bnext.disabled = true
    brow.append(bprev, bnext)
    const btrack = el("button", "btn pri", "Mark read")
    acts.append(brow, btrack)

    pad.append(hd, nowTitle, nowChap, acts)

    // reader controls - user-added only
    if (userAdded) {
        pad.append(el("div", "lbl", "Reading view"))
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
        pad.appendChild(seg)

        const mkTog = (label: string, sub: string | null, on: boolean, onToggle: (v: boolean) => void) => {
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
            row.append(left, sw)
            return row
        }
        pad.appendChild(mkTog("Fit width", null, false, v => setLayer("fit", v ? FIT_CSS : null)))
        pad.appendChild(mkTog("Continuous scroll", null, false, v => setLayer("scroll", v ? SCROLL_CSS : null)))
        // Blocker toggle is present per the design; the actual malvertising blocker is a later
        // phase, so this toggle is inert in the prototype.
        pad.appendChild(mkTog("Block pop-ups", "soon", true, () => {}))
    }

    pad.append(el("div", "div"))
    const attr = el("div", "attr")
    attr.append(document.createTextNode("tracked by StoryHoard"))
    const gear = el("button", "mini", "⚙")
    gear.style.border = "0"
    gear.setAttribute("aria-label", "Open StoryHoard")
    attr.append(gear)
    pad.append(attr)
    if (isOfficial) pad.append(el("div", "explain", "Reader controls off on partner sites."))

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
    gear.addEventListener("click", () => {
        try {
            window.open(ext.runtime.getURL("app.html"), "_blank", "noopener")
        } catch {}
    })

    // scroll progress -> rail + handle label
    function updateProgress() {
        const r = document.documentElement
        const scrollable = r.scrollHeight - r.clientHeight
        const pct = scrollable > 0 ? Math.round((window.scrollY / scrollable) * 100) : 0
        railFill.style.width = pct + "%"
        const base = nowChap.textContent && nowChap.textContent !== "" ? nowChap.textContent : "Tracking"
        handleLabel.textContent = base
    }
    let rafPending = false
    function onScroll() {
        if (rafPending) return
        rafPending = true
        requestAnimationFrame(() => {
            updateProgress()
            rafPending = false
        })
    }
    window.addEventListener("scroll", onScroll, { passive: true })

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
            }
            if (d.prevUrl !== null) prevUrl = d.prevUrl
            if (d.nextUrl !== null) nextUrl = d.nextUrl
            if (d.mangaTitle) nowTitle.textContent = d.mangaTitle
            if (d.chapterTitle) nowChap.textContent = d.chapterTitle
            bprev.disabled = !prevUrl
            bnext.disabled = !nextUrl
            updateProgress()
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

    updateProgress()
}
