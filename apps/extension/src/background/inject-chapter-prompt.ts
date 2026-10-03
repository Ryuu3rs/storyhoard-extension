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
      .wrap{position:fixed;right:16px;bottom:16px;z-index:2147483647}
      .handle{height:40px;display:inline-flex;align-items:center;gap:8px;background:${T.surface};
        border:1px solid ${T.border};border-radius:999px;padding:0 14px 0 6px;cursor:pointer;
        box-shadow:0 12px 40px rgba(0,0,0,.45);color:${T.text};font-size:12px;font-weight:600}
      .handle .ring{width:28px;height:28px;border-radius:999px;background:${T.panel};display:grid;place-items:center;
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

    const wrap = el("div", "wrap")

    // minimized handle
    const handle = el("div", "handle")
    const ring = el("span", "ring")
    ring.appendChild(el("span", "mono", "S"))
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
    brand.append(
        (() => {
            const m = el("span", "mono", "S")
            return m
        })(),
        document.createTextNode("StoryHoard")
    )
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
    handle.addEventListener("click", () => show(true))
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
