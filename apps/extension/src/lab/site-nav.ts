// Local testing build only: a previous / next hint for one lab site whose chapter pages carry no
// usable controls of their own. Serialized and injected into the page's isolated world before the
// panel, which reads the hint (seedNavFromHint in inject-chapter-prompt.ts). Self-contained: no
// imports or outer variables.
export function labSiteNavHint(pageUrl: string): void {
    try {
        if (!/(^|\.)comix\.to$/i.test(location.hostname)) return
        const m = new URL(pageUrl).pathname.match(/^\/title\/([a-z0-9][a-z0-9-]+)\/\d+-chapter-(\d+(?:\.\d+)?)\/?$/i)
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
        const prev = cur > 1 ? base + (Number.isInteger(cur) ? cur - 1 : Math.floor(cur)) : undefined
        const next =
            Number.isFinite(latest) && cur < latest
                ? base + (Number.isInteger(cur) ? cur + 1 : Math.ceil(cur))
                : undefined
        ;(globalThis as { __amrNavHint__?: unknown }).__amrNavHint__ = { url: pageUrl, prev, next }
    } catch {}
}
