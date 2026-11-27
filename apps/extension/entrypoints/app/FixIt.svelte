<script lang="ts">
    import { browser } from "wxt/browser"
    import { sendRuntimeMessage } from "../../src/runtime"
    import { groupUpdateProblems, hasFixItWork, type FixTitle, type UpdateStatusLike } from "../../src/fix-it-groups"

    // What the last update check could not do, sorted by the action that fixes it. Each group has one
    // button that acts on the whole group, and every title opens its own details in place.
    type Status = UpdateStatusLike & {
        checkedAt: number
        updated: number
        skippedSources?: Record<string, number>
        trackingOnly?: Record<string, number>
        emptyLists?: Record<string, number>
        shortLists?: Record<string, number>
    }
    type Props = {
        status: Status
        sourceName: (sourceId: string) => string
        siteSessions: Array<{ origin: string; enabled: boolean }>
        onSetSiteSession: (origin: string, enabled: boolean) => void
        onOpenTitle: (mangaId: string) => void
        onCopyLog: () => void
        copyLabel: string
        // The title's name in the library now; the status keeps the name it had when the check ran.
        titleOf: (mangaId: string) => string | undefined
        onStopChecking: (mangaId: string) => void
        onRemove: (mangaId: string) => void
    }
    let {
        status,
        sourceName,
        siteSessions,
        onSetSiteSession,
        onOpenTitle,
        onCopyLog,
        copyLabel,
        titleOf,
        onStopChecking,
        onRemove
    }: Props = $props()

    type SiteInfo = { sourceId: string; canTurnOn: boolean; origins: string[] }
    const LIST_PREVIEW = 5
    const FIND_BATCH = 25

    const allGroups = $derived(groupUpdateProblems(status))
    let siteInfo = $state<Map<string, SiteInfo>>(new Map())
    let allNames = $state<Array<{ mangaId: string; title: string }>>([])

    // A row the user closed stays hidden while the same problem is reported for that title. A different
    // problem, or the same one after it went away, has no key here and shows again.
    const HIDDEN_KEY = "fixitHidden"
    let hidden = $state<Record<string, true>>({})
    let showHidden = $state(false)
    let collapsed = $state(false)
    let menuFor = $state<string | null>(null)
    const rowKey = (title: FixTitle) => `${title.mangaId}|${title.detail}`
    const nameKey = (mangaId: string) => `${mangaId}|name`
    const visitKey = (origin: string) => `visit|${origin}`
    const shownRow = (key: string) => showHidden || !hidden[key]

    $effect(() => {
        void browser.storage.local
            .get(HIDDEN_KEY)
            .then(stored => {
                hidden = (stored[HIDDEN_KEY] as Record<string, true> | undefined) ?? {}
            })
            .catch(() => undefined)
    })

    const currentKeys = $derived(
        new Set([
            ...allGroups.sites.flatMap(site => site.titles.map(rowKey)),
            ...allGroups.visit.map(row => visitKey(row.origin)),
            ...[...allGroups.lost, ...allGroups.retry, ...allGroups.other].map(rowKey),
            ...allNames.map(name => nameKey(name.mangaId))
        ])
    )
    const hiddenCount = $derived(Object.keys(hidden).filter(key => currentKeys.has(key)).length)

    function saveHidden(next: Record<string, true>) {
        // Keys for problems that are gone are dropped, so a problem that comes back later shows again.
        const kept = Object.fromEntries(
            Object.keys(next)
                .filter(key => currentKeys.has(key))
                .map(key => [key, true] as const)
        ) as Record<string, true>
        hidden = kept
        void browser.storage.local.set({ [HIDDEN_KEY]: kept }).catch(() => undefined)
    }
    function hide(keys: string[]) {
        menuFor = null
        saveHidden({ ...hidden, ...Object.fromEntries(keys.map(key => [key, true as const])) })
    }
    function unhide(key: string) {
        const { [key]: _gone, ...rest } = hidden
        saveHidden(rest)
    }
    function unhideAll() {
        showHidden = false
        saveHidden({})
    }

    const groups = $derived({
        sites: allGroups.sites
            .map(site => ({ ...site, titles: site.titles.filter(title => shownRow(rowKey(title))) }))
            .filter(site => site.titles.length > 0),
        visit: allGroups.visit.filter(row => shownRow(visitKey(row.origin))),
        lost: allGroups.lost.filter(title => shownRow(rowKey(title))),
        retry: allGroups.retry.filter(title => shownRow(rowKey(title))),
        other: allGroups.other.filter(title => shownRow(rowKey(title)))
    })
    const names = $derived(allNames.filter(name => shownRow(nameKey(name.mangaId))))

    function displayName(title: { mangaId: string; title: string }): string {
        return (titleOf(title.mangaId) ?? title.title ?? "").trim()
    }
    let busy = $state<Record<string, string>>({})
    let outcomes = $state<Record<string, "relinked" | "pick">>({})
    let notes = $state<Record<string, string>>({})
    let expanded = $state<Record<string, boolean>>({})
    let findProgress = $state<{ done: number; total: number } | null>(null)
    let stopFinding = false

    $effect(() => {
        const sourceIds = allGroups.sites.map(site => site.sourceId)
        void sendRuntimeMessage<{ sites: SiteInfo[]; names: Array<{ mangaId: string; title: string }> }>({
            type: "fixit:overview",
            sourceIds
        })
            .then(result => {
                siteInfo = new Map(result.sites.map(site => [site.sourceId, site]))
                allNames = result.names
            })
            .catch(() => undefined)
    })

    const turnOnIds = $derived(groups.sites.filter(site => siteInfo.get(site.sourceId)?.canTurnOn).map(s => s.sourceId))
    const goneSiteTitles = $derived(
        groups.sites.filter(site => !siteInfo.get(site.sourceId)?.canTurnOn).flatMap(site => site.titles)
    )
    const sitesTitleCount = $derived(groups.sites.reduce((sum, site) => sum + site.titles.length, 0))
    const notices = $derived([
        ...Object.entries(status.skippedSources ?? {}).map(
            ([id, n]) => `${sourceName(id)}: ${n} title${n === 1 ? "" : "s"} skipped, the site blocks automated checks.`
        ),
        ...Object.entries(status.trackingOnly ?? {}).map(
            ([id, n]) => `${sourceName(id)}: ${n} title${n === 1 ? "" : "s"} update when you open the site.`
        ),
        ...Object.entries(status.emptyLists ?? {}).map(
            ([id, n]) =>
                `${sourceName(id)}: ${n} title${n === 1 ? "" : "s"} showed no chapters. Add the site again from a chapter page.`
        ),
        ...Object.entries(status.shortLists ?? {}).map(
            ([id, n]) => `${sourceName(id)}: the chapter list stops short for ${n} title${n === 1 ? "" : "s"}.`
        )
    ])
    const nothingToFix = $derived(!hasFixItWork(groups) && names.length === 0)
    const problemCount = $derived(
        sitesTitleCount +
            groups.visit.reduce((n, row) => n + row.count, 0) +
            groups.lost.length +
            groups.retry.length +
            groups.other.length +
            names.length
    )

    function plural(n: number, word: string): string {
        return `${n} ${word}${n === 1 ? "" : "s"}`
    }
    function setBusy(key: string, text: string) {
        busy = { ...busy, [key]: text }
    }
    // One message for every site, because the background runs one check at a time and refuses a second.
    // An empty list re-checks everything.
    async function recheck(sourceIds: string[], keys: string[]) {
        for (const key of keys) {
            setBusy(key, "Re-checking…")
            notes = { ...notes, [key]: "" }
        }
        const ack = await sendRuntimeMessage<{ started: boolean; alreadyRunning?: boolean }>(
            sourceIds.length > 0 ? { type: "updates:check", sourceIds } : { type: "updates:check" }
        ).catch(() => undefined)
        if (!ack?.alreadyRunning) return
        for (const key of keys) {
            setBusy(key, "")
            notes = { ...notes, [key]: "Another update check is running. Try again when it finishes." }
        }
    }

    // One browser prompt for every site asked for; the request is the first await so the click still
    // counts as the user's gesture in Firefox.
    async function turnOn(sourceIds: string[]) {
        const origins = [...new Set(sourceIds.flatMap(id => siteInfo.get(id)?.origins ?? []))]
        if (origins.length === 0) return
        const granted = await browser.permissions.request({ origins }).catch(() => false)
        if (!granted) {
            notes = { ...notes, sites: "Access wasn't given, so nothing changed." }
            return
        }
        notes = { ...notes, sites: "" }
        const enabled: string[] = []
        for (const sourceId of sourceIds) {
            setBusy(sourceId, "Turning on…")
            const result = await sendRuntimeMessage<{ enabled: boolean }>({
                type: "fixit:enable-site",
                sourceId
            }).catch(() => ({ enabled: false }))
            if (result.enabled) enabled.push(sourceId)
            else setBusy(sourceId, "Couldn't turn it on")
        }
        if (enabled.length > 0) await recheck(enabled, enabled)
    }

    async function findAgain(titles: FixTitle[], key: string) {
        const pending = titles.filter(title => !outcomes[title.mangaId])
        if (pending.length === 0) return
        stopFinding = false
        findProgress = { done: 0, total: pending.length }
        setBusy(key, "Finding…")
        let relinked = 0
        let pick = 0
        for (let i = 0; i < pending.length && !stopFinding; i += FIND_BATCH) {
            const batch = pending.slice(i, i + FIND_BATCH)
            const result = await sendRuntimeMessage<{ results: Array<{ mangaId: string; outcome: string }> }>({
                type: "fixit:find",
                mangaIds: batch.map(title => title.mangaId)
            }).catch(() => ({ results: batch.map(title => ({ mangaId: title.mangaId, outcome: "pick" })) }))
            const next = { ...outcomes }
            for (const row of result.results) {
                if (row.outcome === "relinked") {
                    next[row.mangaId] = "relinked"
                    relinked += 1
                } else if (row.outcome === "pick") {
                    next[row.mangaId] = "pick"
                    pick += 1
                }
            }
            outcomes = next
            findProgress = { done: Math.min(i + batch.length, pending.length), total: pending.length }
        }
        findProgress = null
        setBusy(key, "")
        notes = {
            ...notes,
            [key]:
                (relinked > 0 ? `${plural(relinked, "title")} relinked automatically.` : "No sure matches found.") +
                (pick > 0 ? ` Pick a site for ${pick === 1 ? "it" : `the other ${pick}`} below.` : "")
        }
    }

    function openAndRecheck(row: { origin: string; sourceId: string; openUrl: string }) {
        // Waits for the site's page to settle (a browser check reloads it once), then re-checks that
        // site's titles by itself. Closing the tab re-checks straight away.
        void browser.tabs.create({ url: row.openUrl }).then(tab => {
            if (tab.id === undefined) return
            const tabId = tab.id
            setBusy(row.origin, "Waiting for the site…")
            let settle: ReturnType<typeof setTimeout> | undefined
            const finish = () => {
                clearTimeout(settle)
                clearTimeout(giveUp)
                browser.tabs.onUpdated.removeListener(onUpdated)
                browser.tabs.onRemoved.removeListener(onRemoved)
                void recheck([row.sourceId], [row.origin])
            }
            const onUpdated = (id: number, info: { status?: string }) => {
                if (id !== tabId || info.status !== "complete") return
                clearTimeout(settle)
                settle = setTimeout(finish, 6000)
            }
            const onRemoved = (id: number) => {
                if (id === tabId) finish()
            }
            const giveUp = setTimeout(finish, 180_000)
            browser.tabs.onUpdated.addListener(onUpdated)
            browser.tabs.onRemoved.addListener(onRemoved)
        })
    }

    async function retryNow() {
        const sourceIds = [...new Set(groups.retry.map(title => title.sourceId))]
        await recheck(sourceIds.includes("") ? [] : sourceIds, ["retry"])
    }

    async function fixNames() {
        setBusy("names", "Fixing names…")
        let remaining = names.length
        let after: string | undefined
        for (let round = 0; round < 10; round++) {
            const result = await sendRuntimeMessage<{ tried: number; remaining: number; next?: string }>({
                type: "fixit:names",
                ...(after !== undefined ? { after } : {})
            }).catch(() => undefined)
            if (!result) break
            remaining = result.remaining
            if (result.tried === 0 || result.next === undefined) break
            after = result.next
        }
        setBusy("names", "")
        notes = {
            ...notes,
            names:
                remaining === 0
                    ? "All names fixed."
                    : `${plural(remaining, "title")} still ${remaining === 1 ? "has" : "have"} no name the site would give.`
        }
        const refreshed = await sendRuntimeMessage<{ names: Array<{ mangaId: string; title: string }> }>({
            type: "fixit:overview",
            sourceIds: []
        }).catch(() => undefined)
        if (refreshed) allNames = refreshed.names
    }

    function scrollTo(id: string) {
        document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })
    }
</script>

{#snippet titleRows(titles: FixTitle[], key: string)}
    {@const shown = expanded[key] ? titles : titles.slice(0, LIST_PREVIEW)}
    {#each shown as title (title.mangaId)}
        {@const name = displayName(title)}
        {@const hideKey = key === "names" ? nameKey(title.mangaId) : rowKey(title)}
        {@const menuKey = `${key}:${title.mangaId}`}
        <div class="fixit-row" class:fixit-row-hidden={!!hidden[hideKey]}>
            <button type="button" class="fixit-title" onclick={() => onOpenTitle(title.mangaId)}>
                {name || "Untitled"}
            </button>
            {#if !name}<span class="fixit-tag">no name yet</span>{/if}
            {#if outcomes[title.mangaId] === "relinked"}
                <span class="fixit-ok">Relinked ✓</span>
            {:else if outcomes[title.mangaId] === "pick"}
                <button type="button" class="btn-sm btn-outline" onclick={() => onOpenTitle(title.mangaId)}>
                    Pick a site
                </button>
            {:else}
                <span class="muted">{title.sourceId ? `${sourceName(title.sourceId)} · ` : ""}{title.detail}</span>
            {/if}
            <span class="fixit-row-actions">
                <button
                    type="button"
                    class="fixit-icon"
                    aria-label="More options for {name || 'this title'}"
                    aria-expanded={menuFor === menuKey}
                    onclick={() => (menuFor = menuFor === menuKey ? null : menuKey)}>⋯</button>
                {#if hidden[hideKey]}
                    <button
                        type="button"
                        class="fixit-icon"
                        aria-label="Show this problem again"
                        onclick={() => unhide(hideKey)}>↺</button>
                {:else}
                    <button
                        type="button"
                        class="fixit-icon"
                        aria-label="Hide this problem"
                        onclick={() => hide([hideKey])}>×</button>
                {/if}
                {#if menuFor === menuKey}
                    <span class="fixit-menu" role="menu">
                        <button type="button" role="menuitem" onclick={() => hide([hideKey])}>Hide this problem</button>
                        <button
                            type="button"
                            role="menuitem"
                            onclick={() => {
                                menuFor = null
                                onOpenTitle(title.mangaId)
                            }}>Use another source</button>
                        <button
                            type="button"
                            role="menuitem"
                            onclick={() => {
                                hide([hideKey])
                                onStopChecking(title.mangaId)
                            }}>Stop checking this title</button>
                        <button
                            type="button"
                            role="menuitem"
                            class="fixit-danger"
                            onclick={() => {
                                menuFor = null
                                onRemove(title.mangaId)
                            }}>Remove from library</button>
                    </span>
                {/if}
            </span>
        </div>
    {/each}
    {#if titles.length > LIST_PREVIEW}
        <button
            type="button"
            class="link-btn fixit-more"
            onclick={() => (expanded = { ...expanded, [key]: !expanded[key] })}>
            {expanded[key] ? "Show fewer" : `Show all ${titles.length}`}
        </button>
    {/if}
{/snippet}

<div class="fixit" data-fixit>
    <div class="fixit-head">
        <div>
            <h2 class="activity-section-head fixit-heading">
                {nothingToFix ? "Last check" : `${plural(problemCount, "title")} couldn't update`}
            </h2>
        </div>
        <div class="fixit-head-actions">
            {#if !nothingToFix}
                <button
                    type="button"
                    class="btn-sm btn-outline"
                    aria-expanded={!collapsed}
                    onclick={() => (collapsed = !collapsed)}>{collapsed ? "Show" : "Hide list"}</button>
            {/if}
            <button
                type="button"
                class="btn-sm btn-outline"
                title="Copies a support-safe summary: your titles, but no source site names"
                onclick={onCopyLog}>{copyLabel}</button>
        </div>
    </div>

    {#if !collapsed}
        {#if nothingToFix}
            <p class="muted">Nothing needs fixing. Every title checked fine.</p>
        {:else}
            <div class="fixit-chips">
                {#if groups.sites.length > 0}<button
                        type="button"
                        class="fixit-chip"
                        onclick={() => scrollTo("fixit-sites")}><b>{sitesTitleCount}</b> not connected</button
                    >{/if}
                {#if groups.visit.length > 0}<button
                        type="button"
                        class="fixit-chip"
                        onclick={() => scrollTo("fixit-visit")}
                        ><b>{groups.visit.reduce((n, v) => n + v.count, 0)}</b> open the site once</button
                    >{/if}
                {#if groups.lost.length > 0}<button
                        type="button"
                        class="fixit-chip"
                        onclick={() => scrollTo("fixit-lost")}><b>{groups.lost.length}</b> lost their page</button
                    >{/if}
                {#if groups.retry.length > 0}<button
                        type="button"
                        class="fixit-chip"
                        onclick={() => scrollTo("fixit-retry")}><b>{groups.retry.length}</b> will retry</button
                    >{/if}
                {#if names.length > 0}<button type="button" class="fixit-chip" onclick={() => scrollTo("fixit-names")}
                        ><b>{names.length}</b> missing {names.length === 1 ? "name" : "names"}</button
                    >{/if}
            </div>
        {/if}

        {#if groups.sites.length > 0}
            <section class="fixit-card" id="fixit-sites">
                <div class="fixit-card-head">
                    <h4>
                        Reconnect your sites <span class="muted"
                            >· {plural(sitesTitleCount, "title")} on {plural(groups.sites.length, "site")}</span>
                    </h4>
                    {#if turnOnIds.length > 1}
                        <button type="button" class="btn-sm" onclick={() => void turnOn(turnOnIds)}>
                            {turnOnIds.length === 2 ? "Turn on both sites" : `Turn on all ${turnOnIds.length} sites`}
                        </button>
                    {/if}
                </div>
                <p class="muted fixit-help">
                    One browser prompt. Every title on a site reconnects as soon as you allow it. A site the app can't
                    reach any more is searched for on your other sites instead.
                </p>
                {#each groups.sites as site (site.sourceId)}
                    {@const info = siteInfo.get(site.sourceId)}
                    <div class="fixit-site">
                        <span class="fixit-site-name">{sourceName(site.sourceId)}</span>
                        <span class="muted">{plural(site.titles.length, "title")}</span>
                        {#if busy[site.sourceId]}
                            <span class="muted">{busy[site.sourceId]}</span>
                        {:else if info?.canTurnOn}
                            <button
                                type="button"
                                class="btn-sm btn-outline"
                                onclick={() => void turnOn([site.sourceId])}>
                                Turn on
                            </button>
                        {:else}
                            <button
                                type="button"
                                class="btn-sm btn-outline"
                                onclick={() => void findAgain(site.titles, site.sourceId)}>
                                Find on my other sites
                            </button>
                        {/if}
                        <button
                            type="button"
                            class="fixit-icon"
                            aria-label="Hide this site's titles here"
                            onclick={() => hide(site.titles.map(rowKey))}>×</button>
                    </div>
                    {#if notes[site.sourceId]}<p class="muted fixit-note">{notes[site.sourceId]}</p>{/if}
                {/each}
                {#if notes["sites"]}<p class="muted fixit-note">{notes["sites"]}</p>{/if}
                {#if goneSiteTitles.length > 0}
                    <details class="fixit-details">
                        <summary>Titles on sites that can't be turned back on ({goneSiteTitles.length})</summary>
                        {@render titleRows(goneSiteTitles, "gone")}
                    </details>
                {/if}
            </section>
        {/if}

        {#if groups.visit.length > 0}
            <section class="fixit-card site-gate" id="fixit-visit" data-site-gate>
                <div class="fixit-card-head">
                    <h4>
                        Open the site first <span class="muted"
                            >· {plural(
                                groups.visit.reduce((n, v) => n + v.count, 0),
                                "title"
                            )} on {plural(groups.visit.length, "site")}</span>
                    </h4>
                </div>
                <p class="muted fixit-help">
                    The site wants a quick browser check. This opens it in a tab, then re-checks its titles by itself
                    once the page has loaded.
                </p>
                {#each groups.visit as row (row.origin)}
                    {@const session = siteSessions.find(site => site.origin === row.origin)}
                    <div class="fixit-site site-gate-row">
                        <span class="fixit-site-name"
                            >{sourceName(row.sourceId)}
                            <span class="muted">· {row.sampleTitle}{row.count > 1 ? `, +${row.count - 1}` : ""}</span
                            ></span>
                        {#if session}
                            <label
                                class="fixit-session site-gate-session"
                                title="Sends your cookies for this site with its update checks and nowhere else. Off by default.">
                                <input
                                    type="checkbox"
                                    checked={session.enabled}
                                    onchange={event => onSetSiteSession(row.origin, event.currentTarget.checked)} />
                                Use my browser session
                            </label>
                        {/if}
                        {#if busy[row.origin]}
                            <span class="muted">{busy[row.origin]}</span>
                        {:else}
                            <button
                                type="button"
                                class="btn-sm btn-outline"
                                data-site-gate-open
                                onclick={() => openAndRecheck(row)}>
                                Open and re-check
                            </button>
                        {/if}
                        <button
                            type="button"
                            class="fixit-icon"
                            aria-label="Hide this site here"
                            onclick={() => hide([visitKey(row.origin)])}>×</button>
                    </div>
                    {#if notes[row.origin]}<p class="muted fixit-note">{notes[row.origin]}</p>{/if}
                {/each}
            </section>
        {/if}

        {#if groups.lost.length > 0}
            <section class="fixit-card" id="fixit-lost">
                <div class="fixit-card-head">
                    <h4>Lost their page <span class="muted">· {plural(groups.lost.length, "title")}</span></h4>
                    {#if findProgress && busy["lost"]}
                        <button type="button" class="btn-sm btn-outline" onclick={() => (stopFinding = true)}>
                            Stop ({findProgress.done} of {findProgress.total})
                        </button>
                    {:else}
                        <button type="button" class="btn-sm" onclick={() => void findAgain(groups.lost, "lost")}>
                            Find them again
                        </button>
                    {/if}
                </div>
                <p class="muted fixit-help">
                    The site moved the page or the link is missing. This searches your sites and relinks the sure
                    matches; you pick the rest.
                </p>
                {#if notes["lost"]}<p class="fixit-note fixit-ok">{notes["lost"]}</p>{/if}
                {@render titleRows(groups.lost, "lost")}
            </section>
        {/if}

        {#if groups.retry.length > 0}
            <section class="fixit-card" id="fixit-retry">
                <div class="fixit-card-head">
                    <h4>Will retry on their own <span class="muted">· {plural(groups.retry.length, "title")}</span></h4>
                    <button
                        type="button"
                        class="btn-sm btn-outline"
                        disabled={!!busy["retry"]}
                        onclick={() => void retryNow()}>
                        {busy["retry"] || "Retry now"}
                    </button>
                </div>
                <p class="muted fixit-help">
                    The site was busy or offline for a moment. The next scheduled check tries again.
                </p>
                {#if notes["retry"]}<p class="muted fixit-note">{notes["retry"]}</p>{/if}
                {@render titleRows(groups.retry, "retry")}
            </section>
        {/if}

        {#if names.length > 0}
            <section class="fixit-card" id="fixit-names">
                <div class="fixit-card-head">
                    <h4>
                        Missing names <span class="muted"
                            >· {plural(names.length, "title")}
                            {names.length === 1 ? "shows" : "show"} a code instead of a name</span>
                    </h4>
                    <button
                        type="button"
                        class="btn-sm btn-outline"
                        disabled={!!busy["names"]}
                        onclick={() => void fixNames()}>
                        {busy["names"] || "Fix names"}
                    </button>
                </div>
                {#if notes["names"]}<p class="muted fixit-note">{notes["names"]}</p>{/if}
                {@render titleRows(
                    names.map(n => ({ ...n, sourceId: "", detail: "No name yet" })),
                    "names"
                )}
            </section>
        {/if}

        {#if groups.other.length > 0}
            <section class="fixit-card">
                <div class="fixit-card-head">
                    <h4>Other problems <span class="muted">· {plural(groups.other.length, "title")}</span></h4>
                </div>
                {@render titleRows(groups.other, "other")}
            </section>
        {/if}

        {#if notices.length > 0}
            <details class="fixit-details">
                <summary>Good to know ({notices.length})</summary>
                {#each notices as notice}<p class="muted fixit-note">{notice}</p>{/each}
            </details>
        {/if}

        {#if hiddenCount > 0}
            <p class="muted fixit-hidden-line">
                {plural(hiddenCount, "problem")} hidden ·
                <button type="button" class="link-btn" onclick={() => (showHidden = !showHidden)}
                    >{showHidden ? "Leave them hidden" : "Show hidden"}</button>
                {#if showHidden}· <button type="button" class="link-btn" onclick={unhideAll}>Unhide all</button>{/if}
            </p>
        {/if}
    {/if}
</div>
