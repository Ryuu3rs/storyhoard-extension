<script lang="ts">
    import { onMount } from "svelte"
    import { sendRuntimeMessage } from "../../src/runtime"
    import { UPDATE_MODE_LABEL, type UpdateMode } from "../../src/update-mode"
    import { sourceOrigins } from "../../src/permissions"
    import { getCachedCovers, type LibraryManga } from "../../src/database"
    import { hasNewerChapters, neverRead } from "../../src/reading-status"
    import { rowSubtitle } from "../../src/popup-row"
    import { libraryCoverMode, proxiedCoverUrl } from "../../src/cover-crossorigin"
    import { isCatalogAdd } from "../../src/find-source"
    import UsageNotice from "../app/UsageNotice.svelte"

    type PageState = {
        supported: boolean
        pageType?: "chapter" | "manga" | "none"
        url?: string
        sourceName?: string
    }

    type DetectResult =
        | { status: "none" }
        | { status: "off"; name: string; permissionOrigins: string[] }
        | { status: "known"; name: string; updateMode?: UpdateMode }
        | {
              status: "found"
              name: string
              domain: string
              origin: string
              matchOk: boolean
              upgrade: boolean
              permissionOrigins: string[]
          }
    type AddResult =
        | {
              ok: true
              id: string
              name: string
              domain: string
              updateMode: UpdateMode
              upgraded?: boolean
              carriedOver?: boolean
          }
        | { ok: false; message: string }
    type TurnOnResult =
        | { ok: true; id: string; name: string; updateMode: UpdateMode; carriedOver?: boolean }
        | { ok: false; message: string }

    let page = $state<PageState | undefined>()
    let detected = $state<DetectResult>({ status: "none" })
    let confirmingAdd = $state(false)
    // Whether host access for the detected site was already held when the popup opened. Read up front
    // so the click handler can call permissions.request as its very first await: Firefox only honours
    // the request while the click's user gesture is still live.
    let accessHeldBefore = false
    let activeTab: { id?: number | undefined; url?: string | undefined } = {}
    let message = $state("")
    // A site just added that the app can look through for the rest of the library.
    let findOnSourceId = $state<string | null>(null)
    let busy = $state(false)
    let library = $state<LibraryManga[]>([])
    let libraryLoaded = $state(false)
    let opening = $state<string | null>(null)
    // The cached cover blobs the app renders from (read straight out of IndexedDB), falling back to the
    // title's cover address the way the app's library does.
    let coverSrcs = $state<Record<string, string>>({})
    let failedCovers = $state<Set<string>>(new Set())
    let permittedOrigins = $state<readonly string[]>(browser.runtime.getManifest().host_permissions ?? [])
    const now = Date.now()
    const coverSrc = (m: LibraryManga) => proxiedCoverUrl(coverSrcs[m.id] ?? m.coverUrl)

    onMount(() => {
        void browser.permissions
            .getAll()
            .then(all => (permittedOrigins = all.origins ?? permittedOrigins))
            .catch(() => undefined)
        // Page detection and the library overview load in parallel; neither blocks the other.
        void sendRuntimeMessage<PageState>({ type: "page:current" })
            .then(p => (page = p))
            .catch(() => (page = { supported: false }))
        void detectCurrentPage()
        void sendRuntimeMessage<LibraryManga[]>({ type: "library:list" })
            .then(list => {
                library = list
                void loadCovers(list)
            })
            .catch(() => (library = []))
            .finally(() => (libraryLoaded = true))
    })

    // Is the page in front of the user a reader the extension does not recognise yet?
    async function detectCurrentPage(): Promise<void> {
        try {
            const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
            if (!tab?.url) return
            activeTab = { id: tab.id, url: tab.url }
            const result = await sendRuntimeMessage<DetectResult>({
                type: "source:detect",
                url: tab.url,
                ...(tab.id !== undefined ? { tabId: tab.id } : {})
            })
            detected = result
            // The plain array from the reply, not the reactive copy: Chromium's permissions API refuses a proxy.
            if (result.status === "found" || result.status === "off") {
                accessHeldBefore = await browser.permissions
                    .contains({ origins: result.permissionOrigins })
                    .catch(() => false)
            }
        } catch {
            detected = { status: "none" }
        }
    }

    // Host access is requested HERE, straight from the user's click: a request made later from the
    // background worker is not guaranteed to still carry the click's user gesture.
    async function addSite(): Promise<void> {
        if (detected.status !== "found" || !activeTab.url) return
        busy = true
        message = ""
        findOnSourceId = null
        const origins = $state.snapshot(detected.permissionOrigins)
        const requestedNow = !accessHeldBefore
        try {
            // First await of the click: resolves true without a prompt when access is already held.
            if (!(await browser.permissions.request({ origins }))) {
                message = "Permission is needed to read this site."
                return
            }
            const result = await sendRuntimeMessage<AddResult>({
                type: "source:add-from-tab",
                url: activeTab.url,
                ...(activeTab.id !== undefined ? { tabId: activeTab.id } : {}),
                grantedByCaller: requestedNow
            })
            if (!result.ok) {
                if (requestedNow) await browser.permissions.remove({ origins }).catch(() => false)
                message = result.message
                return
            }
            const modeLabel = UPDATE_MODE_LABEL[result.updateMode]
            message = result.upgraded ? `Site upgraded. ${modeLabel}.` : `Site added. ${modeLabel}.`
            confirmingAdd = false
            await detectCurrentPage()
            // Track the chapter on screen now that its site is recognised, unless the add carried this site's
            // detected titles over (the visit is then already recorded, and a capture would record it twice).
            if (!result.carriedOver) {
                await sendRuntimeMessage({ type: "page:capture", url: activeTab.url }).catch(() => undefined)
            }
            const find = await sendRuntimeMessage<{ availability: string }>({
                type: "source:find-availability",
                sourceId: result.id
            }).catch(() => undefined)
            if (find?.availability === "ok" && hasOtherTitles(result.id)) findOnSourceId = result.id
        } catch (cause) {
            message = cause instanceof Error ? cause.message : "The site could not be added."
        } finally {
            busy = false
        }
    }

    // A site already in the library that is turned off: the same click-first grant as adding one, then the
    // background turns the stored site back on under its own id and puts the panel on the page.
    async function turnOnSite(): Promise<void> {
        if (detected.status !== "off" || !activeTab.url) return
        busy = true
        message = ""
        findOnSourceId = null
        const origins = $state.snapshot(detected.permissionOrigins)
        const requestedNow = !accessHeldBefore
        try {
            if (!(await browser.permissions.request({ origins }))) {
                message = "Permission is needed to read this site."
                return
            }
            const result = await sendRuntimeMessage<TurnOnResult>({
                type: "source:turn-on",
                url: activeTab.url,
                ...(activeTab.id !== undefined ? { tabId: activeTab.id } : {})
            })
            if (!result.ok) {
                if (requestedNow) await browser.permissions.remove({ origins }).catch(() => false)
                message = result.message
                return
            }
            message = `Site turned on. ${UPDATE_MODE_LABEL[result.updateMode]}.`
            await detectCurrentPage()
            if (!result.carriedOver) {
                await sendRuntimeMessage({ type: "page:capture", url: activeTab.url }).catch(() => undefined)
            }
            const find = await sendRuntimeMessage<{ availability: string }>({
                type: "source:find-availability",
                sourceId: result.id
            }).catch(() => undefined)
            if (find?.availability === "ok" && hasOtherTitles(result.id)) findOnSourceId = result.id
        } catch (cause) {
            message = cause instanceof Error ? cause.message : "The site could not be turned on."
        } finally {
            busy = false
        }
    }

    async function loadCovers(list: LibraryManga[]): Promise<void> {
        try {
            const covers = await getCachedCovers(list.map(m => m.id))
            const next: Record<string, string> = {}
            for (const [id, record] of covers) next[id] = URL.createObjectURL(record.blob)
            coverSrcs = next
        } catch {
            // No covers is fine - rows fall back to a title initial.
        }
    }

    // Unread-first overview: titles with new chapters float to the top (the review's core ask),
    // then everything else by most-recently-updated. Seed/demo rows and the "already read"
    // synthetic catalog adds are dropped - they aren't things you open to read next.
    const overview = $derived.by(() => {
        const rows = library.filter(m => !(isCatalogAdd(m) && !neverRead(m)))
        return [...rows].sort(
            (a, b) =>
                Number(hasNewerChapters(b)) - Number(hasNewerChapters(a)) ||
                (b.latestChapterAt ?? b.updatedAt ?? 0) - (a.latestChapterAt ?? a.updatedAt ?? 0)
        )
    })
    const unreadCount = $derived(overview.filter(hasNewerChapters).length)

    // Count of unread chapters when both numbers are known, else null (show a plain "New" badge).
    function newCount(m: LibraryManga): number | null {
        if (typeof m.latestChapterNumber === "number" && typeof m.lastReadChapterNumber === "number") {
            const n = Math.round(m.latestChapterNumber - m.lastReadChapterNumber)
            return n > 0 ? n : null
        }
        return null
    }

    // Titles in the library on some other site (or none yet). The page's own title, still filed under the
    // observe-only site until the add moved it, does not count.
    function hasOtherTitles(sourceId: string): boolean {
        return library.some(m => m.sourceId !== sourceId && !m.sourceId.startsWith("detected:"))
    }

    function findMyTitles(sourceId: string) {
        const url = `${browser.runtime.getURL("/app.html")}?findOn=${encodeURIComponent(sourceId)}`
        void browser.tabs.create({ url })
    }

    function openApp() {
        void browser.tabs.create({ url: browser.runtime.getURL("/app.html") })
    }

    // Open a title at its resume position in the reader (same logic as the full app): resolve the
    // last-read chapter, fall back to the source URL. Manual/anilist entries have no readable
    // source, so they open the full library instead of a dead reader tab.
    async function openTitle(m: LibraryManga) {
        if (opening) return
        if (m.manualTracking && m.sourceId.includes(".")) {
            openApp()
            return
        }
        opening = m.id
        let target = m.sourceUrl
        try {
            const resumed = await sendRuntimeMessage<{ url?: string }>({ type: "chapter:resume", mangaId: m.id })
            if (resumed?.url) target = resumed.url
        } catch {
            // fall back to sourceUrl
        } finally {
            opening = null
        }
        // On-site reading: open the chapter on the source itself, not the retired in-app reader.
        if (/^https?:\/\//i.test(target)) void browser.tabs.create({ url: target })
        else openApp()
    }

    async function grantAndRead() {
        if (!page?.url) return
        busy = true
        message = ""
        const granted = await browser.permissions.request({ origins: sourceOrigins() })
        if (!granted) {
            message = "Site access is required to resolve this chapter."
            busy = false
            return
        }
        try {
            const result = await sendRuntimeMessage<{ added?: boolean }>({ type: "page:capture", url: page.url })
            // Already on the chapter's own page; just confirm the add (the retired reader no longer opens).
            message = result.added ? "Added to your library." : ""
        } catch (cause) {
            message = cause instanceof Error ? cause.message : "The chapter could not be opened."
        } finally {
            busy = false
        }
    }
</script>

<main>
    <header>
        <img src="/icons/icon_48.png" alt="" />
        <div class="brand">
            <h1>StoryHoard</h1>
            <p>{unreadCount > 0 ? `${unreadCount} with new chapters` : "Your library"}</p>
        </div>
        <button class="icon" type="button" onclick={openApp} title="Open the full library">Library</button>
    </header>

    <UsageNotice />

    {#if page?.supported && page.pageType === "chapter"}
        <section class="card">
            <span class="source">{page.sourceName ?? "Supported source"} · chapter</span>
            <button type="button" class="primary" onclick={grantAndRead} disabled={busy}>
                {busy ? "Resolving chapter…" : "Read this chapter in StoryHoard"}
            </button>
        </section>
    {/if}
    {#if detected.status === "known" && detected.updateMode && !message}
        <section class="card">
            <span class="source">{detected.name}</span>
            <p class="muted">{UPDATE_MODE_LABEL[detected.updateMode]}</p>
        </section>
    {/if}
    {#if detected.status === "off"}
        <section class="card">
            <span class="source">{detected.name} · turned off</span>
            <p class="muted">
                This site is in your library but turned off, so its chapters aren't tracked and the tracker doesn't show
                on its pages. Turn it on to carry on where you left off.
            </p>
            <button type="button" class="primary" onclick={turnOnSite} disabled={busy}>
                {busy ? "Turning on…" : "Turn this site on"}
            </button>
        </section>
    {/if}
    {#if detected.status === "found" && !detected.matchOk}
        <section class="card">
            <span class="source">Can't add this site automatically</span>
            <p class="muted">
                This page looks like a reader, but its chapter links don't follow a pattern StoryHoard can use, so the
                site can't be added automatically. Try again from a chapter page of a series with several chapters.
            </p>
        </section>
    {/if}
    {#if detected.status === "found" && detected.matchOk}
        <section class="card">
            {#if confirmingAdd}
                <span class="source">{detected.upgrade ? "Upgrade this site" : "Add this page's site"}</span>
                <p class="muted site-domain">{detected.domain}</p>
                <div class="actions">
                    <button type="button" class="primary" onclick={addSite} disabled={busy}>
                        {busy ? "Adding…" : detected.upgrade ? "Upgrade site" : "Add site"}
                    </button>
                    <button type="button" onclick={() => (confirmingAdd = false)} disabled={busy}>Cancel</button>
                </div>
            {:else}
                <span class="source">{detected.upgrade ? "Tracking only" : "New site"}</span>
                {#if detected.upgrade}
                    <p class="muted">
                        This site is tracked, but its new chapters aren't detected automatically. Upgrade it from this
                        chapter page to turn update checks on.
                    </p>
                {/if}
                <button type="button" class="primary" onclick={() => (confirmingAdd = true)}>
                    {detected.upgrade ? "Upgrade this site" : "Add this site"}
                </button>
            {/if}
        </section>
    {/if}
    {#if message}<p class="notice">{message}</p>{/if}
    {#if findOnSourceId}
        <div class="find-offer">
            <p>This site may have more of your titles.</p>
            <button type="button" class="primary" onclick={() => findOnSourceId && findMyTitles(findOnSourceId)}>
                Find my other titles here
            </button>
        </div>
    {/if}

    {#if !libraryLoaded}
        <p class="muted pad">Loading your library…</p>
    {:else if overview.length === 0}
        <div class="empty">
            <p>Your library is empty.</p>
            <p class="muted">Open a chapter on a supported source, or browse Discover in the library.</p>
            <button type="button" class="primary" onclick={openApp}>Open library</button>
        </div>
    {:else}
        <ul class="titles">
            {#each overview as m (m.id)}
                {@const unread = hasNewerChapters(m)}
                {@const count = newCount(m)}
                <li>
                    <button
                        type="button"
                        class="row"
                        class:opening={opening === m.id}
                        onclick={() => void openTitle(m)}>
                        {#if coverSrc(m) && !failedCovers.has(m.id)}
                            <img
                                class="cover"
                                crossorigin={libraryCoverMode(coverSrc(m), permittedOrigins)}
                                src={coverSrc(m)}
                                alt=""
                                loading="lazy"
                                onerror={() => (failedCovers = new Set(failedCovers).add(m.id))} />
                        {:else}
                            <span class="cover placeholder">{m.title.slice(0, 1)}</span>
                        {/if}
                        <span class="meta">
                            <span class="title">{m.title}</span>
                            <span class="sub">{rowSubtitle(m, now)}</span>
                        </span>
                        {#if unread}
                            <span class="badge">{count ?? "new"}{count ? " new" : ""}</span>
                        {/if}
                    </button>
                </li>
            {/each}
        </ul>
    {/if}
</main>
