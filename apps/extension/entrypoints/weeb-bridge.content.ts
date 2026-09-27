// Bridge between the weeb.ltd site and the installed extension. Runs ONLY on
// weeb.ltd (and an optional dev origin). Implements the handshake the site half
// (H15, already deployed) expects - keep the attribute + event names and detail
// shapes stable; changing them needs an H-row so WEEB updates in lockstep.
//
//   Announce presence: set document.documentElement.dataset.storyhoard = <version>
//     and data-storyhoard-linked ("1" when an account is linked), and dispatch a
//     window CustomEvent("storyhoard:ready", { detail: { version, linked } }). The
//     dataset attributes are the reliable cross-world channel (they survive the
//     content-script / page isolation that can strip a CustomEvent's detail); the
//     event just wakes a site listener that mounted after we first announced.
//   Re-announce on window "storyhoard:ping" - covers the site mounting after us.
//   Open a title: listen for window CustomEvent("storyhoard:open",
//     { detail: { anilistId, title } }) and relay a validated site:open to the
//     background, which adds the title, resolves a source, and opens it.
//
// Security: no externally_connectable is declared, so this content script is the only
// path a web page can reach the extension, and it only runs on weeb.ltd. A cross-origin
// iframe embedded on the page has its own window and cannot dispatch events into ours,
// so a same-window CustomEvent can only come from weeb.ltd's own page code.

export default defineContentScript({
    matches: [
        "https://weeb.ltd/*",
        ...(import.meta.env.VITE_WEEB_SITE_ORIGIN ? [import.meta.env.VITE_WEEB_SITE_ORIGIN as string] : [])
    ],
    runAt: "document_start",
    async main() {
        const root = document.documentElement
        const version = browser.runtime.getManifest().version
        let linked = false

        function announce() {
            root.dataset.storyhoard = version
            root.dataset.storyhoardLinked = linked ? "1" : "0"
            try {
                window.dispatchEvent(new CustomEvent("storyhoard:ready", { detail: { version, linked } }))
            } catch {
                // detail may not cross the isolated world on some browsers; the dataset
                // attributes above already carry version + linked, so this is best-effort.
            }
        }

        // Announce immediately (linked defaults to false until the status check returns).
        announce()
        try {
            const res = (await browser.runtime.sendMessage({ type: "account:status" })) as
                | { ok: true; data: { token?: string; invalid?: boolean } }
                | { ok: false }
                | undefined
            linked = !!res && res.ok && typeof res.data.token === "string" && !res.data.invalid
        } catch {
            linked = false
        }
        announce()

        // The site may mount its detector after our first announce; a ping re-announces.
        window.addEventListener("storyhoard:ping", () => announce())

        window.addEventListener("storyhoard:open", event => {
            const detail = (event as CustomEvent).detail as { anilistId?: unknown; title?: unknown } | undefined
            const anilistId = Number(detail?.anilistId)
            if (!Number.isInteger(anilistId) || anilistId <= 0) return
            const title = typeof detail?.title === "string" ? detail.title.slice(0, 500) : ""
            void browser.runtime.sendMessage({ type: "site:open", anilistId, title })
        })
    }
})
