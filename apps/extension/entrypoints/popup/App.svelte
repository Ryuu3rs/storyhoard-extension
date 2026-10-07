<script lang="ts">
    import { onMount } from "svelte"
    import { sendRuntimeMessage } from "../../src/runtime"
    import { sourceOrigins } from "../../src/permissions"
    import { getCachedCovers, type LibraryManga } from "../../src/database"
    import { hasNewerChapters, neverRead, readChapterLabel } from "../../src/reading-status"

    type PageState = {
        supported: boolean
        pageType?: "chapter" | "manga" | "none"
        url?: string
        sourceName?: string
    }

    type DetectResult =
        | { status: "none" }
        | { status: "known"; name: string }
        | {
              status: "found"
              name: string
              domain: string
              origin: string
              matchOk: boolean
              permissionOrigins: string[]
          }
    type AddResult = { ok: true; id: string; name: string; domain: string } | { ok: false; message: string }

    let page = $state<PageState | undefined>()
    let detected = $state<DetectResult>({ status: "none" })
    let confirmingAdd = $state(false)
    let activeTab: { id?: number | undefined; url?: string | undefined } = {}
    let message = $state("")
    let busy = $state(false)
    let library = $state<LibraryManga[]>([])
    let libraryLoaded = $state(false)
    let opening = $state<string | null>(null)
    // Covers hotlinked from source CDNs are blocked on an extension page, so use the same
    // cached blobs the app renders from (read straight out of IndexedDB).
    let coverSrcs = $state<Record<string, string>>({})

    onMount(() => {
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
            detected = await sendRuntimeMessage<DetectResult>({
                type: "source:detect",
                url: tab.url,
                ...(tab.id !== undefined ? { tabId: tab.id } : {})
            })
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
        const origins = detected.permissionOrigins
        let requestedNow = false
        try {
            if (!(await browser.permissions.contains({ origins }))) {
                if (!(await browser.permissions.request({ origins }))) {
                    message = "Permission is needed to read this site."
                    return
                }
                requestedNow = true
            }
            const result = await sendRuntimeMessage<AddResult>({
                type: "source:add-from-tab",
                url: activeTab.url,
                ...(activeTab.id !== undefined ? { tabId: activeTab.id } : {})
            })
            if (!result.ok) {
                if (requestedNow) await browser.permissions.remove({ origins }).catch(() => false)
                message = result.message
                return
            }
            message = `${result.name} added.`
            detected = { status: "known", name: result.name }
            confirmingAdd = false
            // Track the chapter on screen now that its site is recognised.
            await sendRuntimeMessage({ type: "page:capture", url: activeTab.url }).catch(() => undefined)
        } catch (cause) {
            message = cause instanceof Error ? cause.message : "The site could not be added."
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
    // synthetic anilist.co adds are dropped - they aren't things you open to read next.
    const overview = $derived.by(() => {
        const rows = library.filter(m => !(m.sourceId === "anilist.co" && !neverRead(m)))
        return [...rows].sort(
            (a, b) =>
                Number(hasNewerChapters(b)) - Number(hasNewerChapters(a)) ||
                (b.latestChapterAt ?? b.updatedAt ?? 0) - (a.latestChapterAt ?? a.updatedAt ?? 0)
        )
    })
    const unreadCount = $derived(overview.filter(hasNewerChapters).length)

    function ago(ts?: number): string {
        if (!ts) return ""
        const s = Math.floor((Date.now() - ts) / 1000)
        if (s < 60) return "just now"
        const m = Math.floor(s / 60)
        if (m < 60) return `${m}m ago`
        const h = Math.floor(m / 60)
        if (h < 24) return `${h}h ago`
        const d = Math.floor(h / 24)
        if (d < 30) return `${d}d ago`
        const mo = Math.floor(d / 30)
        if (mo < 12) return `${mo}mo ago`
        return `${Math.floor(mo / 12)}y ago`
    }

    // Count of unread chapters when both numbers are known, else null (show a plain "New" badge).
    function newCount(m: LibraryManga): number | null {
        if (typeof m.latestChapterNumber === "number" && typeof m.lastReadChapterNumber === "number") {
            const n = Math.round(m.latestChapterNumber - m.lastReadChapterNumber)
            return n > 0 ? n : null
        }
        return null
    }

    function chapterLine(m: LibraryManga): string {
        const read = readChapterLabel(m)
        const latest = m.latestChapterNumber
        if (typeof latest === "number") return `${read} of ${latest}`
        return read
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
        void browser.tabs.create({ url: target })
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

    {#if page?.supported && page.pageType === "chapter"}
        <section class="card">
            <span class="source">{page.sourceName ?? "Supported source"} · chapter</span>
            <button type="button" class="primary" onclick={grantAndRead} disabled={busy}>
                {busy ? "Resolving chapter…" : "Read this chapter in StoryHoard"}
            </button>
        </section>
    {/if}
    {#if detected.status === "found" && detected.matchOk}
        <section class="card">
            {#if confirmingAdd}
                <span class="source">Add this page's site</span>
                <p class="site-name">{detected.name}</p>
                <p class="muted site-domain">{detected.domain}</p>
                <div class="actions">
                    <button type="button" class="primary" onclick={addSite} disabled={busy}>
                        {busy ? "Adding…" : "Add site"}
                    </button>
                    <button type="button" onclick={() => (confirmingAdd = false)} disabled={busy}>Cancel</button>
                </div>
            {:else}
                <span class="source">New site</span>
                <button type="button" class="primary" onclick={() => (confirmingAdd = true)}>Add this site</button>
            {/if}
        </section>
    {/if}
    {#if message}<p class="notice">{message}</p>{/if}

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
                        {#if coverSrcs[m.id]}
                            <img class="cover" src={coverSrcs[m.id]} alt="" loading="lazy" />
                        {:else}
                            <span class="cover placeholder">{m.title.slice(0, 1)}</span>
                        {/if}
                        <span class="meta">
                            <span class="title">{m.title}</span>
                            <span class="sub"
                                >{chapterLine(m)}{#if ago(m.latestChapterAt ?? m.updatedAt)}
                                    · {ago(m.latestChapterAt ?? m.updatedAt)}{/if}</span>
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
