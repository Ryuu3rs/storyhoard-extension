// Bridge between the weeb.ltd site and the installed extension. Runs ONLY on
// weeb.ltd (and an optional dev origin). Two jobs:
//   1. Announce presence - set data-storyhoard-ext (version) + data-storyhoard-linked
//      on <html> so the site can swap "Read with StoryHoard" (install) for
//      "Open in StoryHoard" (deep-link) when the extension is present.
//   2. Relay an "open this title" request the site page posts via window.postMessage
//      to the background, which adds the title, auto-resolves a source, and opens it.
//
// Security: this is the only path a web page can reach the extension (no
// externally_connectable is declared, so arbitrary sites cannot message us). We still
// gate every relayed message on same-origin (ev.origin === location.origin) and a
// strict shape, so only weeb.ltd's own page code - not a cross-origin iframe embedded
// on it - can trigger an open, and only with a validated numeric AniList id.

export default defineContentScript({
    matches: [
        "https://weeb.ltd/*",
        ...(import.meta.env.VITE_WEEB_SITE_ORIGIN ? [import.meta.env.VITE_WEEB_SITE_ORIGIN as string] : [])
    ],
    runAt: "document_start",
    async main() {
        const root = document.documentElement
        // Presence first, synchronously - the site can read it as soon as its scripts run.
        root.setAttribute("data-storyhoard-ext", browser.runtime.getManifest().version)
        try {
            const res = (await browser.runtime.sendMessage({ type: "account:status" })) as
                | { ok: true; data: { token?: string; invalid?: boolean } }
                | { ok: false }
                | undefined
            const linked = !!res && res.ok && typeof res.data.token === "string" && !res.data.invalid
            root.setAttribute("data-storyhoard-linked", linked ? "1" : "0")
        } catch {
            root.setAttribute("data-storyhoard-linked", "0")
        }

        window.addEventListener("message", ev => {
            // Same-window, same-origin only: ignore cross-origin iframes and other windows.
            if (ev.source !== window || ev.origin !== location.origin) return
            const d = ev.data as {
                source?: unknown
                type?: unknown
                anilistId?: unknown
                title?: unknown
                coverUrl?: unknown
                genres?: unknown
            } | null
            if (!d || typeof d !== "object" || d.source !== "storyhoard-site" || d.type !== "open") return

            const anilistId = Number(d.anilistId)
            if (!Number.isInteger(anilistId) || anilistId <= 0) return
            const title = typeof d.title === "string" ? d.title.slice(0, 500) : ""
            const coverUrl =
                typeof d.coverUrl === "string" && /^https:\/\//.test(d.coverUrl) ? d.coverUrl.slice(0, 2000) : undefined
            const genres = Array.isArray(d.genres)
                ? d.genres.filter((g): g is string => typeof g === "string").slice(0, 30)
                : undefined

            void browser.runtime.sendMessage({
                type: "site:open",
                anilistId,
                title,
                ...(coverUrl ? { coverUrl } : {}),
                ...(genres && genres.length > 0 ? { genres } : {})
            })
        })
    }
})
