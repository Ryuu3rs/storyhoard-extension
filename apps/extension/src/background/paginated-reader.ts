// MAIN-world "continuous scroll" for paginated DM5-engine readers (fanfox, mangahere and other
// DM5/dmzj-style sites). Those readers show ONE page image at a time, fetching each page's tokened
// image URL on demand via the site's own `requestimagedata()` -> chapterfun.ashx. The CSS "stack
// the images" trick the panel uses for long-strip sites has nothing to stack here, so this instead
// DRIVES THE SITE'S OWN READER: it walks the site's page counter, lets the site fetch each page the
// same way a reader clicking "next" would, captures the image URL the SITE resolved into the user's
// own tab, and stacks those into one vertical scroll column. The extension never calls the site's
// image endpoint itself and never circumvents anything - it only automates the pager in the page
// the user already opened (a client-side reading-UX enhancement).
//
// Runs in the MAIN world (injected via executeScript, so it is not blocked by the page CSP and can
// reach the site's window.requestimagedata / imagecount). On/off is the shared
// `data-amr-continuous` attribute on <html>, flipped by the isolated-world panel's Continuous
// scroll toggle. Inert on any page that isn't a DM5 reader, so it is safe to inject everywhere.
//
// Serialized and injected, so it must be self-contained: no imports, only its parameter + globals.
export function dm5ContinuousScrollMain(): void {
    const w = window as unknown as {
        __amrDm5CS?: boolean
        requestimagedata?: (refreshAd: boolean) => void
        imagecount?: number
        imagepage?: number
    }
    if (w.__amrDm5CS) return
    w.__amrDm5CS = true

    const STRIP_ID = "__amr-cs-strip__"
    const isOn = () => document.documentElement.getAttribute("data-amr-continuous") === "1"
    const isDm5 = () =>
        typeof w.requestimagedata === "function" &&
        typeof w.imagecount === "number" &&
        w.imagecount > 0 &&
        !!document.querySelector<HTMLImageElement>(".reader-main-img")

    let running = false
    let flattened = false

    const resolvedSrc = (img: HTMLImageElement, loadingGif: string, prev: string): Promise<string | null> =>
        new Promise(resolve => {
            let ticks = 0
            const iv = setInterval(() => {
                const s = img.getAttribute("src") || ""
                const real =
                    s &&
                    !s.includes(loadingGif) &&
                    /\.(jpe?g|png|webp|gif)(\?|$)/i.test(s) &&
                    !/\/(loading|blank|spacer)\./i.test(s)
                // A new page's src differs from the previous one; the first page may already be the
                // shown src, so accept an unchanged-but-real src only on the very first capture.
                if (real && (s !== prev || prev === "")) {
                    clearInterval(iv)
                    resolve(s.startsWith("//") ? location.protocol + s : s)
                } else if (++ticks > 80) {
                    // ~8s: give up on this page rather than stall the whole walk (a credits/ad page
                    // or a transient failure); the slot stays empty and the user can still scroll.
                    clearInterval(iv)
                    resolve(null)
                }
            }, 100)
        })

    async function flatten() {
        if (running || flattened || !isDm5()) return
        const img = document.querySelector<HTMLImageElement>(".reader-main-img")
        const main = img?.parentElement
        const total = w.imagecount ?? 0
        if (!img || !main || total <= 0) return
        running = true
        try {
            const loadingGif = img.getAttribute("data-loading-img") || "loading"
            const strip = document.createElement("div")
            strip.id = STRIP_ID
            strip.style.cssText = "display:flex;flex-direction:column;align-items:center;width:100%"
            const startPage = w.imagepage ?? 1
            let prev = ""
            for (let p = 1; p <= total; p++) {
                if (!isOn()) break // toggled off mid-walk
                w.imagepage = p
                try {
                    w.requestimagedata?.(false)
                } catch {
                    /* site fn threw; the wait below just times out for this page */
                }
                const src = await resolvedSrc(img, loadingGif, prev)
                const el = document.createElement("img")
                el.loading = "lazy"
                el.style.cssText = "max-width:100%;height:auto;display:block;margin:0 auto"
                if (src) {
                    el.src = src
                    prev = src.replace(location.protocol, "")
                }
                strip.appendChild(el)
            }
            if (isOn()) {
                img.style.display = "none"
                main.appendChild(strip)
                flattened = true
            } else {
                strip.remove()
            }
            w.imagepage = startPage
        } finally {
            running = false
        }
    }

    function restore() {
        document.getElementById(STRIP_ID)?.remove()
        const img = document.querySelector<HTMLImageElement>(".reader-main-img")
        if (img) img.style.display = ""
        flattened = false
    }

    function sync() {
        if (isOn()) void flatten()
        else restore()
    }

    new MutationObserver(sync).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-amr-continuous"]
    })
    sync()
}
