<script lang="ts">
    import type { ImportConflict, ImportResolution, LibraryManga, PageBookmark } from "../../src/database"
    import { AMR_KOFI_URL } from "../../src/support"
    import {
        neverRead,
        hasNewerChapters,
        statusOf,
        readChapterLabel,
        effectiveReadingStatus,
        isOngoing
    } from "../../src/reading-status"
    import type { AppSettings } from "../../src/settings"
    import { SITE_BASE, type AccountProfile } from "../../src/account"
    import { IMPORT_FORMATS } from "../../src/import"
    import { onDestroy, onMount, tick } from "svelte"
    import { sendRuntimeMessage } from "../../src/runtime"
    import { runSettled } from "../../src/bulk"
    import { sourceOrigins, syncOrigins } from "../../src/permissions"
    import { migrateLegacyImport } from "../../src/legacy-import"
    import { encryptBackup, decryptBackup } from "../../src/backup-crypto"
    import { getCachedCovers } from "../../src/database"
    import { groupSearchResultsIntoWorks } from "../../src/search-grouping"
    import type { Suggestion } from "../../src/suggestions"
    import { repairMangahubChapterNumbers } from "../../src/handlers/updates-sources"
    import { formatUpdateFailureLog } from "../../src/updates-failure-log"
    import { communityConfigured, CONSENT_VERSION } from "../../src/community"
    import { analyticsConfigured } from "../../src/analytics-usage"
    import {
        PRIVACY_POLICY,
        DATA_COLLECTED,
        CONSENT_SUMMARY,
        DECLINE_EXPLAINER,
        POLICY_URL
    } from "../../src/privacy-policy"
    import { pruneSelectionToVisible } from "../../src/library-selection"
    import { subscribeLive } from "../../src/live"
    import ActivityHeatmap from "./ActivityHeatmap.svelte"
    import ImportReconcile from "./ImportReconcile.svelte"
    import FindSource from "./FindSource.svelte"
    import { entryNeedsSource } from "../../src/find-source"

    type SyncStatus = {
        hasToken: boolean
        gistId?: string
        autoSync: boolean
        lastPushedAt?: number
        lastPulledAt?: number
    }

    type AniListStatus = {
        hasToken: boolean
        autoSync: boolean
        syncMembership: boolean
        statusPush?: boolean
        statusPull?: boolean
        lastSyncAt?: number
        viewerName?: string
    }

    const sections = ["Discover", "Library", "Activity", "Stats", "Sources", "Data", "Settings"] as const
    let activeSection = $state<(typeof sections)[number]>("Discover")
    // Bookmarks + Updates + History are folded into one "Activity" tab with these sub-tabs.
    let activityTab = $state<"Updates" | "History" | "Bookmarks">("Updates")
    // The configured start page (Discover / Library) is applied once on first load, never on
    // later refreshes - so it can't yank the user off a tab they navigated to.
    let startPageApplied = false

    // weeb.ltd companion site. The Community nav entry + footer link only show when the user
    // hasn't turned them off AND the site actually answered a reachability probe - so if the
    // site is ever down or retired (the project changes, no one maintains it), the links simply
    // disappear rather than dangling.
    // Prefer VITE_WEEB_SITE_ORIGIN (the SAME var wxt.config adds to host_permissions), stripped of a
    // trailing "/*" match-pattern suffix, so the probe/link target is always a granted origin. A dev
    // pointing at a staging origin sets that one var and both the manifest grant and this agree.
    const WEEB_SITE_URL =
        (import.meta.env.VITE_WEEB_SITE_ORIGIN as string | undefined)?.replace(/\/\*$/, "") ||
        (import.meta.env.VITE_WEEB_SITE_URL as string | undefined) ||
        "https://weeb.ltd"
    let siteReachable = $state(false)
    function openWeebSite() {
        void browser.tabs.create({ url: WEEB_SITE_URL })
    }
    function openWeebSignUp() {
        void browser.tabs.create({ url: `${WEEB_SITE_URL}/join` })
    }

    // Settings page: rail + filter + scroll-spy. Sections are literal markup below; this
    // index only drives the rail and the "find a setting" filter.
    const SETTINGS_SECTIONS = [
        {
            id: "library",
            label: "Library & updates",
            labels: [
                "Auto-add manga",
                "Track reading on the source site",
                "Update schedule",
                "Auto-pause after N days",
                "New-chapter notifications",
                "Daily automatic backup",
                "Extension updates"
            ]
        },
        {
            id: "reader",
            label: "Reader",
            labels: [
                "Default view",
                "Reading direction",
                "Page fit",
                "Page width",
                "Show page number",
                "Double-page gap",
                "Remove gaps between pages (continuous mode)",
                "Preload pages",
                "Open chapters in",
                "Chapter language"
            ]
        },
        {
            id: "appearance",
            label: "Appearance & habits",
            labels: ["Theme", "Start page", "Community link", "Daily reading goal", "Blur NSFW covers"]
        },
        { id: "account", label: "weeb.ltd account", labels: ["weeb.ltd account", "Link this device"] },
        {
            id: "community",
            label: "Privacy & community",
            labels: ["Community features", "What we collect", "Community username", "Delete my community data"]
        },
        { id: "danger", label: "Danger zone", labels: ["Clear reading history", "Clear entire library"] }
    ] as const
    type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"]
    let settingsQuery = $state("")
    let settingsActive = $state<SettingsSectionId>("library")
    function settingMatches(label: string): boolean {
        const q = settingsQuery.trim().toLowerCase()
        return !q || label.toLowerCase().includes(q)
    }
    function sectionVisible(id: string): boolean {
        const s = SETTINGS_SECTIONS.find(x => x.id === id)
        return !s || s.labels.some(settingMatches)
    }
    function jumpToSettings(id: SettingsSectionId): void {
        settingsActive = id
        document.getElementById("settings-" + id)?.scrollIntoView({ behavior: "smooth", block: "start" })
    }
    function settingsScrollSpy(node: HTMLElement): { destroy(): void } {
        const io = new IntersectionObserver(
            entries => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue
                    const id = (entry.target as HTMLElement).dataset.settingsSection
                    if (id) settingsActive = id as SettingsSectionId
                }
            },
            { rootMargin: "-15% 0px -70% 0px" }
        )
        for (const el of node.querySelectorAll("[data-settings-section]")) io.observe(el)
        return { destroy: () => io.disconnect() }
    }
    let library = $state<LibraryManga[]>([])
    let settings = $state<AppSettings | undefined>()
    const showCommunityLink = $derived((settings?.showCommunity ?? true) && siteReachable)
    // Local optimistic mirrors of specific settings controls - driven synchronously by
    // user interaction rather than by the settings:update round trip, so the displayed
    // value never appears to "go blank" or reset on any timing hiccup while it saves.
    let updateIntervalSelection = $state<0 | 6 | 12 | 24>(12)
    let updateIntervalSaved = $state(false)
    let updateIntervalSavedTimer: ReturnType<typeof setTimeout> | undefined
    let noGapSelection = $state(false)
    let noGapSelectionSaved = $state(false)
    let noGapSelectionSavedTimer: ReturnType<typeof setTimeout> | undefined
    // Local mirror of the auto-pause window (days of no reading before a title reads as
    // paused). 0 disables it. Drives both the settings input and the effective-status
    // filtering, so keep it in sync with settings on every load/refresh.
    let autoPauseDays = $state(0)
    let loading = $state(true)
    let query = $state("")
    let librarySort = $state<
        "updates-first" | "recent-read" | "recent-added" | "recently-updated" | "title" | "latest-chapter"
    >("updates-first")
    // Persist the chosen sort so the library reopens the same way. Saved on change only
    // (never via an effect) so the default can't clobber the stored value on startup.
    function persistLibrarySort() {
        void browser.storage.local.set({ librarySort })
    }
    let categoryFilter = $state("")
    // Reveals the rename/delete tag manager inline in the Library (replaces the old
    // dedicated Tags tab, which was mostly a redundant filtered-library view).
    let manageTags = $state(false)
    let genreFilter = $state("")
    let sourceFilter = $state("")
    let ratingFilter = $state(0)
    let updatedSinceFilter = $state(0)
    let showFiltersPanel = $state(false)
    let selectMode = $state(false)
    let selectedIds = $state<Set<string>>(new Set())
    let bulkCategory = $state("")
    let bulkMessage = $state("")
    let bulkWorking = $state(false)
    let bookmarks = $state<PageBookmark[]>([])
    let bookmarksLoaded = $state(false)

    function toggleSelect(id: string) {
        const next = new Set(selectedIds)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        selectedIds = next
        disarmBulkRemove()
    }

    function clearSelection() {
        selectedIds = new Set()
        selectMode = false
        bulkMessage = ""
        disarmBulkRemove()
    }

    // Select (or, if they're all already selected, deselect) every title on the current
    // page - the rows actually rendered (pagedLibrary), not the whole filtered set. Bulk
    // actions must never reach a title the user can't see, so a selection can only ever
    // contain rendered rows; use "Load more" to bring more into range, then select again.
    function toggleSelectAllVisible() {
        const allSelected = pagedLibrary.length > 0 && pagedLibrary.every(m => selectedIds.has(m.id))
        const next = new Set(selectedIds)
        for (const m of pagedLibrary) {
            if (allSelected) next.delete(m.id)
            else next.add(m.id)
        }
        selectedIds = next
        disarmBulkRemove()
    }

    // Remove is irreversible and acts on a whole selection, so it takes two clicks: the
    // first arms it (showing exactly how many titles are about to go), the second runs
    // it. Arming lapses on a timer, on Cancel, and whenever the selection or the visible
    // set changes underneath it - so a count the user read can never be the count that
    // actually gets deleted.
    let bulkRemoveArmed = $state(false)
    let bulkRemoveArmTimer: ReturnType<typeof setTimeout> | undefined
    // The exact id set the confirm was armed against. The second click only deletes if
    // the current on-screen selection still equals this - so ANY change between arm and
    // confirm (a filter change, a partial-failure re-selection from another bulk action,
    // a background refresh) forces a fresh arm instead of deleting a set the user never
    // confirmed. This content check is the authoritative guard; the explicit disarm calls
    // elsewhere are just for immediate visual feedback.
    let bulkRemoveArmedKey = ""
    const BULK_REMOVE_ARM_MS = 5000

    function selectionKey(ids: string[]): string {
        return [...ids].sort().join("\n")
    }

    function disarmBulkRemove() {
        bulkRemoveArmed = false
        bulkRemoveArmedKey = ""
        if (bulkRemoveArmTimer) clearTimeout(bulkRemoveArmTimer)
        bulkRemoveArmTimer = undefined
    }

    function requestBulkRemove() {
        if (bulkWorking) return
        const current = selectedVisibleIds()
        if (!bulkRemoveArmed || selectionKey(current) !== bulkRemoveArmedKey) {
            // First click, or the selection changed under an existing arm: (re-)arm.
            if (current.length === 0) {
                disarmBulkRemove()
                return
            }
            bulkRemoveArmed = true
            bulkRemoveArmedKey = selectionKey(current)
            if (bulkRemoveArmTimer) clearTimeout(bulkRemoveArmTimer)
            bulkRemoveArmTimer = setTimeout(disarmBulkRemove, BULK_REMOVE_ARM_MS)
            return
        }
        disarmBulkRemove()
        void bulkRemove()
    }

    // Bulk actions act only on titles the user can currently see. The view-change effect
    // further down already prunes the selection, so this is the hard guard at the moment
    // of action - Remove is destructive and has no confirmation step, so it must never be
    // able to reach an id that isn't on screen.
    function selectedVisibleIds(): string[] {
        return [
            ...pruneSelectionToVisible(
                selectedIds,
                pagedLibrary.map(m => m.id)
            )
        ]
    }

    // Each id is removed independently - a mid-loop failure (SW restart, transient
    // error, one bad id) must not leave the local library out of sync with what was
    // actually deleted. Only the ids that actually succeeded are dropped from
    // `library` and cleared from the selection; failed ids stay selected so the
    // user can see what didn't go through and retry just those.
    async function bulkRemove() {
        const ids = selectedVisibleIds()
        bulkMessage = ""
        bulkWorking = true
        let succeeded: string[] = []
        let failed: string[] = []
        try {
            ;({ succeeded, failed } = await runSettled(ids, async id => {
                await sendRuntimeMessage({ type: "library:remove", mangaId: id })
            }))
        } finally {
            bulkWorking = false
        }
        const removedIds = new Set(succeeded)
        library = library.filter(m => !removedIds.has(m.id))
        if (failed.length > 0) {
            selectedIds = new Set([...selectedIds].filter(id => !removedIds.has(id)))
            bulkMessage = `Removed ${removedIds.size} of ${ids.length}. ${failed.length} failed - still selected, try again.`
        } else {
            clearSelection()
        }
    }

    async function bulkAddCategory() {
        const tags = bulkCategory
            .split(",")
            .map(s => s.trim())
            .filter(Boolean)
        if (tags.length === 0 || bulkWorking) return
        const ids = selectedVisibleIds()
        bulkMessage = ""
        // Hold bulkWorking like bulkRemove/bulkManual so a concurrent Remove can't run
        // against the same selection while this loop is mid-flight, and use runSettled so
        // one failing id neither throws out of the loop (aborting the rest) nor claims the
        // tag was applied when the write never landed - only succeeded ids are patched
        // locally and cleared from the selection.
        bulkWorking = true
        const pending = new Map(
            ids.map(id => [id, [...new Set([...(library.find(x => x.id === id)?.categories ?? []), ...tags])]])
        )
        let succeeded: string[] = []
        let failed: string[] = []
        try {
            ;({ succeeded, failed } = await runSettled(ids, async id => {
                await sendRuntimeMessage({ type: "library:categories", mangaId: id, categories: pending.get(id)! })
            }))
        } finally {
            bulkWorking = false
        }
        const done = new Set(succeeded)
        library = library.map(x => (done.has(x.id) ? applyCategories(x, x.id, pending.get(x.id)!) : x))
        if (failed.length > 0) {
            selectedIds = new Set([...selectedIds].filter(id => !done.has(id)))
            bulkMessage = `Tagged ${done.size} of ${ids.length}. ${failed.length} failed - still selected, try again.`
        } else {
            bulkCategory = ""
            clearSelection()
        }
    }

    // Same per-id success/failure tracking as bulkRemove: only the ids that
    // actually succeeded get their local manualTracking flag flipped and cleared
    // from the selection, so a mid-loop failure can't make the dashboard claim a
    // manga is manual (or not) when the write never landed.
    async function bulkManual(on: boolean) {
        const ids = selectedVisibleIds()
        bulkMessage = ""
        bulkWorking = true
        let succeeded: string[] = []
        let failed: string[] = []
        try {
            ;({ succeeded, failed } = await runSettled(ids, async id => {
                await sendRuntimeMessage({ type: "library:manual", mangaId: id, manual: on })
            }))
        } finally {
            bulkWorking = false
        }
        const updatedIds = new Set(succeeded)
        library = library.map(m => (updatedIds.has(m.id) ? { ...m, manualTracking: on } : m))
        if (failed.length > 0) {
            selectedIds = new Set([...selectedIds].filter(id => !updatedIds.has(id)))
            bulkMessage = `Updated ${updatedIds.size} of ${ids.length}. ${failed.length} failed - still selected, try again.`
        } else {
            clearSelection()
        }
    }

    // Bulk "Caught up": set every selected title's last-read to its own latest chapter, so
    // a batch of titles clears their New-ch badge at once. Same per-id success/failure
    // tracking as bulkManual - only ids whose write landed get their local numbers moved.
    // Titles with no known latest chapter can't be caught up and are skipped, not failed.
    async function bulkCaughtUp() {
        const ids = selectedVisibleIds()
        const byId = new Map(library.map(m => [m.id, m]))
        const actionable = ids.filter(id => byId.get(id)?.latestChapterNumber !== undefined)
        bulkMessage = ""
        bulkWorking = true
        let succeeded: string[] = []
        let failed: string[] = []
        try {
            ;({ succeeded, failed } = await runSettled(actionable, async id => {
                const m = byId.get(id)!
                await sendRuntimeMessage({
                    type: "library:numbers",
                    mangaId: id,
                    lastReadChapterNumber: m.latestChapterNumber,
                    ...(m.latestChapterId ? { lastReadChapterId: m.latestChapterId } : {})
                })
            }))
        } finally {
            bulkWorking = false
        }
        const done = new Set(succeeded)
        library = library.map(m => {
            if (!done.has(m.id) || m.latestChapterNumber === undefined) return m
            return {
                ...m,
                lastReadChapterNumber: m.latestChapterNumber,
                ...(m.latestChapterId ? { lastReadChapterId: m.latestChapterId } : {})
            }
        })
        if (failed.length > 0) {
            selectedIds = new Set([...selectedIds].filter(id => !done.has(id)))
            bulkMessage = `Marked ${done.size} caught up. ${failed.length} failed - still selected, try again.`
        } else {
            clearSelection()
        }
    }

    // Bulk-set a reading status (or On Hold, or clear both) across the selection - the multi-
    // select equivalent of the detail modal's status buttons.
    async function bulkStatus(kind: "on-hold" | "planning" | "dropped" | "clear") {
        const ids = selectedVisibleIds()
        bulkMessage = ""
        bulkWorking = true
        let succeeded: string[] = []
        let failed: string[] = []
        try {
            ;({ succeeded, failed } = await runSettled(ids, async id => {
                if (kind === "on-hold") {
                    await sendRuntimeMessage({ type: "library:hold", mangaId: id, onHold: true })
                } else if (kind === "clear") {
                    await sendRuntimeMessage({ type: "library:status", mangaId: id, status: null })
                    await sendRuntimeMessage({ type: "library:hold", mangaId: id, onHold: false })
                } else {
                    await sendRuntimeMessage({ type: "library:status", mangaId: id, status: kind })
                }
            }))
        } finally {
            bulkWorking = false
        }
        const done = new Set(succeeded)
        library = library.map(m => {
            if (!done.has(m.id)) return m
            if (kind === "on-hold") return { ...m, onHold: true }
            if (kind === "clear") {
                const { readingStatus: _drop, ...rest } = m
                return { ...rest, onHold: false }
            }
            return { ...m, readingStatus: kind }
        })
        if (failed.length > 0) {
            selectedIds = new Set([...selectedIds].filter(id => !done.has(id)))
            bulkMessage = `Updated ${done.size}. ${failed.length} failed - still selected, try again.`
        } else {
            clearSelection()
        }
    }

    let showDuplicates = $state(false)
    // A group's stable key = its lexicographically-smallest member id (independent of which
    // copy is chosen to keep). Tracks which group's "keep which copy?" menu is open, and
    // which groups have a merge in flight so the button disables + shows progress.
    function groupKeyOf(group: LibraryManga[]): string {
        return [...group].map(m => m.id).sort()[0] ?? ""
    }
    let dupMenuFor = $state<string | null>(null)
    let mergingGroups = $state<Set<string>>(new Set())

    // Group duplicates by title AND by source + rotation-stable slug, unioned. The slug key
    // catches the Asura class where a rotated per-series hash forks a second entry whose title
    // may also have drifted (a stale "... Chapter N" or a hash-in-slug) - the title key alone
    // misses those. Cross-source same-title entries still group as before.
    const duplicateGroups = $derived.by(() => {
        const items = library.filter(m => !isSeedData(m))
        const parent = new Map<string, string>()
        const find = (x: string): string => {
            const p = parent.get(x)
            if (p === undefined || p === x) return x
            const root = find(p)
            parent.set(x, root)
            return root
        }
        const union = (a: string, b: string) => parent.set(find(a), find(b))
        for (const m of items) parent.set(m.id, m.id)
        // Strip a legacy numeric prefix and a trailing hex hash so a rotated slug collapses to
        // its stable base. Mirrors asurascans baseSlug EXACTLY (6+ digit prefix; an 8-char hex
        // suffix only when it is a real hash - a mix of a letter and a digit) so the tool never
        // groups slugs the rotation matcher itself would treat as distinct. Scoped to asurascans:
        // it is the only source that rotates a per-series hash, and applying the strip to every
        // source collapsed unrelated titles whose ids merely end in 8 hex/digits.
        const baseSlug = (s: string) =>
            s
                .replace(/^\d{6,}-/, "")
                .replace(/-([0-9a-f]{8})$/i, (whole, hash: string) =>
                    /[a-f]/i.test(hash) && /[0-9]/.test(hash) ? "" : whole
                )
        const repByKey = new Map<string, string>()
        for (const m of items) {
            const keys = [`t:${(m.normalizedTitle || m.title).trim().toLowerCase()}`]
            if (m.sourceMangaId && m.sourceId === "asurascans") {
                keys.push(`s:${m.sourceId}:${baseSlug(m.sourceMangaId)}`)
            }
            for (const key of keys) {
                const rep = repByKey.get(key)
                if (rep) union(m.id, rep)
                else repByKey.set(key, m.id)
            }
        }
        const groups = new Map<string, LibraryManga[]>()
        for (const m of items) {
            const root = find(m.id)
            const arr = groups.get(root) ?? []
            arr.push(m)
            groups.set(root, arr)
        }
        return [...groups.values()].filter(group => group.length > 1)
    })

    // Deterministic primary pick, shared by mergeDuplicates and the merge-suggestion UI
    // so the badge shown before confirming always matches who actually wins the merge.
    // Deterministic hue (0-359) from a title, so each placeholder cover gets its own colour.
    function coverHue(title: string): number {
        let h = 0
        for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0
        return h % 360
    }

    function primaryOfGroup(group: LibraryManga[]): LibraryManga | undefined {
        return [...group].sort(
            (a, b) => (b.lastReadChapterNumber ?? 0) - (a.lastReadChapterNumber ?? 0) || b.updatedAt - a.updatedAt
        )[0]
    }

    // A title added from Discover as "already read" is a synthetic anilist.co entry with read
    // progress and no live source. The user logged it as read, so it does NOT need a source and
    // must not appear in the "needs a source" reconcile panel - if they want to re-read it they
    // can add a source from the library. Planning/unread synthetic entries still get offered a
    // source (neverRead is true for those).
    function isReadOnlyDiscoverAdd(m: LibraryManga): boolean {
        return m.sourceId === "anilist.co" && !neverRead(m)
    }

    // Merging duplicates is a single backend transaction (library:merge - see
    // mergeMangaRecords in src/database.ts) that re-points progress/historyEvents/
    // downloads/pageBookmarks onto the chosen primary and folds every field-merge
    // rule (numbers, categories, rating, notes, nsfw, etc.) into one atomic write,
    // instead of the multi-message replay this used to do.
    async function mergeDuplicates(group: LibraryManga[], keepId?: string) {
        dupMenuFor = null
        // keepId lets the user override the suggested primary via the dropdown.
        const primary = keepId ? group.find(m => m.id === keepId) : primaryOfGroup(group)
        if (!primary) return
        // loserIds is a fresh plain string[] (map over the $derived group), not a $state proxy,
        // so it structured-clones across the message boundary cleanly.
        const loserIds = group.filter(m => m.id !== primary.id).map(m => m.id)
        if (loserIds.length === 0) return
        const key = groupKeyOf(group)
        if (mergingGroups.has(key)) return
        mergingGroups = new Set(mergingGroups).add(key)
        try {
            await sendRuntimeMessage({ type: "library:merge", primaryId: primary.id, loserIds })
            // Optimistically drop the merged-away copies so the row disappears immediately,
            // instead of waiting on the full refresh() round-trip (the old code left the row
            // sitting there for a beat and made Merge feel like it did nothing).
            const gone = new Set(loserIds)
            library = library.filter(m => !gone.has(m.id))
            clearSelection()
        } catch (error) {
            showSugToast(`Merge failed: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
            mergingGroups = new Set([...mergingGroups].filter(k => k !== key))
        }
        // Reconcile merged numbers/progress/covers in the background - never block the click.
        void refresh()
    }
    let failedCovers = $state<Set<string>>(new Set())
    let coverSrcs = $state<Record<string, string>>({})
    // cachedAt of the covers-table row each entry in coverSrcs was created from -
    // lets loadCachedCovers detect that a blob was re-cached (capture.ts rewrites
    // the cover on every successful capture) and revoke+recreate just that one
    // object URL instead of keeping a stale image forever. Plain object, not
    // $state: only read/written inside loadCachedCovers, never rendered.
    let coverCachedAt: Record<string, number> = {}
    let refreshingCovers = $state(false)
    // Set at the start of each backfillCovers() run once the first batch response
    // establishes a total, cleared at the start of the NEXT run (component-level
    // $state, not module-scope, so it can't leak across separate invocations).
    let coverProgress = $state<{ done: number; total: number } | undefined>()

    let syncStatus = $state<SyncStatus | undefined>()
    let syncToken = $state("")
    let syncGistId = $state("")
    let syncMessage = $state("")
    let syncing = $state(false)
    let restoreBannerDismissed = $state(false)

    let anilistStatus = $state<AniListStatus | undefined>()
    let anilistToken = $state("")
    let anilistMessage = $state("")
    let anilistSyncing = $state(false)
    let anilistImporting = $state(false)
    // AniList setup helper: the user pastes their Client ID and we build the
    // implicit-grant authorize link for them, so they don't have to hand-assemble the URL.
    const ANILIST_PIN_REDIRECT = "https://anilist.co/api/v2/oauth/pin"
    let anilistClientId = $state("")
    let anilistRedirectCopied = $state(false)
    let anilistAuthorizeCopied = $state(false)
    const anilistAuthorizeUrl = $derived(
        anilistClientId.trim()
            ? `https://anilist.co/api/v2/oauth/authorize?client_id=${encodeURIComponent(anilistClientId.trim())}&response_type=token`
            : ""
    )
    async function copyText(value: string, mark: (copied: boolean) => void) {
        try {
            await navigator.clipboard.writeText(value)
            mark(true)
            setTimeout(() => mark(false), 1500)
        } catch {
            // Clipboard can be denied; the value is visible for manual copy anyway.
        }
    }
    const copyAniListRedirect = () => copyText(ANILIST_PIN_REDIRECT, v => (anilistRedirectCopied = v))
    const copyAniListAuthorize = () => copyText(anilistAuthorizeUrl, v => (anilistAuthorizeCopied = v))

    function coverFailed(id: string) {
        const next = new Set(failedCovers)
        next.add(id)
        failedCovers = next
    }
    let addUrl = $state("")
    let addMessage = $state("")
    let adding = $state(false)
    let stats = $state<{
        mangaCount: number
        completedChapters: number
        readingDays: number
        currentStreak: number
        longestStreak: number
        chaptersThisWeek: number
        chaptersToday: number
        ratedCount?: number
        categoriesCount?: number
        downloadedChapters?: number
        sourcesUsed?: number
        completedSeries?: number
        estimatedMinutes?: number
        minutesThisWeek?: number
        achievements: Array<{
            id: string
            title: string
            description: string
            unlocked: boolean
            progress: number
            target: number
            category?: string
        }>
    }>()
    let dataMessage = $state("")
    let importConflicts = $state<ImportConflict[]>([])
    let importEnvelope = $state<unknown>(null)
    let importMigrationMeta = $state<{
        migrated: boolean
        converted: number
        skipped: number
        needsAttention: string[]
    } | null>(null)
    let importResolutions = $state<Record<string, ImportResolution>>({})
    let importWorking = $state(false)
    let importError = $state("")
    // Encrypted-backup passphrases (optional AES-GCM envelope via backup-crypto). Export
    // encrypts only when a passphrase is set; import holds the ciphertext until the user
    // supplies the passphrase to decrypt.
    let exportPassphrase = $state("")
    let importPassphrase = $state("")
    let pendingEncryptedText = $state<string | null>(null)

    // --- Repair auto-tracked entries (library:cleanup:scan / library:cleanup:apply) ---
    type CleanupMatchedBy = "adapter" | "pathname" | "scrape"
    type CleanupCandidateRecord = {
        mangaId: string
        title: string
        sourceUrl: string
        matchedChapterNumbers: number[]
        matchedBy: CleanupMatchedBy
    }
    type CleanupGroup = {
        canonicalId: string
        canonicalTitle: string
        canonicalCoverUrl?: string
        sourceId: string
        sourceMangaId: string
        mangaUrl: string
        representativeChapterUrl: string
        inLibrary: boolean
        selfHeal: boolean
        records: CleanupCandidateRecord[]
        overflowCount?: number
    }
    type CleanupUnresolved = { mangaId: string; title: string; sourceId: string; sourceUrl: string; reason: string }
    type CleanupScanResult = { groups: CleanupGroup[]; unresolved: CleanupUnresolved[]; candidateCount: number }
    type CleanupApplyResponse = {
        merged: number
        groups: number
        enriched: number
        skippedStale: number
        skippedUnverified: number
        failed: Array<{ canonicalId: string; reason: string }>
        backupId: number
    }

    let cleanupScanning = $state(false)
    let cleanupResult = $state<CleanupScanResult | null>(null)
    let cleanupSelected = $state<Record<string, boolean>>({})
    let cleanupExpanded = $state<Record<string, boolean>>({})
    let cleanupApplying = $state(false)
    let cleanupMessage = $state("")
    let cleanupBackupId = $state<number | null>(null)

    const cleanupSelectedGroups = $derived(
        cleanupResult ? cleanupResult.groups.filter(g => cleanupSelected[g.canonicalId] !== false) : []
    )
    const cleanupSelectedEntryCount = $derived(cleanupSelectedGroups.reduce((sum, g) => sum + g.records.length, 0))

    async function runCleanupScan() {
        cleanupScanning = true
        cleanupMessage = ""
        cleanupBackupId = null
        try {
            cleanupResult = await sendRuntimeMessage<CleanupScanResult>({ type: "library:cleanup:scan" })
            cleanupSelected = Object.fromEntries(cleanupResult.groups.map(g => [g.canonicalId, true]))
            cleanupExpanded = {}
        } catch (cause) {
            cleanupMessage = cause instanceof Error ? cause.message : "Scan failed."
        } finally {
            cleanupScanning = false
        }
    }

    function cancelCleanup() {
        cleanupResult = null
        cleanupSelected = {}
        cleanupExpanded = {}
    }

    async function applyCleanup() {
        if (!cleanupResult || cleanupSelectedGroups.length === 0) return
        cleanupApplying = true
        try {
            const payload = cleanupSelectedGroups.map(g => ({
                canonicalId: g.canonicalId,
                sourceId: g.sourceId,
                sourceMangaId: g.sourceMangaId,
                mangaUrl: g.mangaUrl,
                representativeChapterUrl: g.representativeChapterUrl,
                losers: g.records
                    .filter(r => r.mangaId !== g.canonicalId)
                    .map(r => ({ mangaId: r.mangaId, matchedBy: r.matchedBy }))
            }))
            const result = await sendRuntimeMessage<CleanupApplyResponse>({
                type: "library:cleanup:apply",
                groups: payload
            })
            cleanupBackupId = result.backupId
            cleanupMessage =
                `Merged ${result.merged} entries into ${result.groups} titles. ${result.enriched} enriched in place.` +
                ` ${result.skippedStale} skipped (stale). ${result.skippedUnverified} skipped (unverified).`
            cleanupResult = null
            cleanupSelected = {}
            cleanupExpanded = {}
            await load()
            await loadBackups()
        } catch (cause) {
            cleanupMessage = cause instanceof Error ? cause.message : "Cleanup apply failed."
        } finally {
            cleanupApplying = false
        }
    }

    // --- Backups list + restore (Data section) ---
    type BackupSummary = { id: number; createdAt: number; reason: string }
    let backupsList = $state<BackupSummary[]>([])
    let backupsLoaded = $state(false)
    let backupRestoreConfirm = $state<number | null>(null)
    let backupRestoring = $state(false)
    let backupMessage = $state("")

    async function loadBackups() {
        try {
            backupsList = await sendRuntimeMessage<BackupSummary[]>({ type: "data:backup:list" })
        } catch {
            // best-effort
        }
    }

    $effect(() => {
        if (activeSection === "Data" && !backupsLoaded) {
            backupsLoaded = true
            void loadBackups()
        }
    })

    async function restoreBackupById(id: number): Promise<boolean> {
        backupRestoring = true
        try {
            await sendRuntimeMessage({ type: "data:backup:restore", id })
            backupMessage = "Backup restored."
            backupRestoreConfirm = null
            await load()
            await loadBackups()
            // The restored library may no longer match a cleanup preview computed
            // against the pre-restore snapshot - drop it so a stale preview can
            // never survive past a restore. Also clear the cleanup backup id and
            // message so a stale "Merged N entries... Undo" banner from an earlier
            // cleanup can never point at the wrong backup after a manual restore.
            cancelCleanup()
            cleanupBackupId = null
            cleanupMessage = ""
            return true
        } catch (cause) {
            backupMessage = cause instanceof Error ? cause.message : "Restore failed."
            return false
        } finally {
            backupRestoring = false
        }
    }

    async function undoCleanup() {
        if (cleanupBackupId === null) return
        const id = cleanupBackupId
        cleanupBackupId = null
        const restored = await restoreBackupById(id)
        cleanupMessage = restored
            ? "Cleanup undone - backup restored."
            : "Undo failed - the backup could not be restored. See the Backups panel for details."
    }

    const showRestoreBanner = $derived(
        !loading && !restoreBannerDismissed && library.length === 0 && Boolean(syncStatus?.hasToken) && !importWorking
    )

    let clearConfirm = $state<"" | "history" | "all">("")
    let clearWorking = $state(false)
    let downloadsCount = $state(0)
    let reconcileIds = $state<string[]>([])
    let libScanIds = $state<string[]>([])
    const currentVersion = browser.runtime.getManifest().version
    // Build marker (git commit of this build) so a local dev build is identifiable next to the
    // release-please-owned version, which only bumps on an actual release.
    const buildId = __BUILD_ID__
    // Owner broadcast messages (fetched on mount, dismissible; dismissed ids persisted).
    type AppAnnouncement = { id: string; title: string; body: string; level: string }
    let announcements = $state<AppAnnouncement[]>([])
    let dismissedAnnouncements = $state<Set<string>>(new Set())
    const visibleAnnouncements = $derived(announcements.filter(a => !dismissedAnnouncements.has(a.id)))
    async function dismissAnnouncement(id: string) {
        dismissedAnnouncements = new Set(dismissedAnnouncements).add(id)
        try {
            await browser.storage.local.set({ dismissedAnnouncements: [...dismissedAnnouncements] })
        } catch {
            /* best-effort */
        }
    }
    async function loadAnnouncements() {
        try {
            const stored = await browser.storage.local.get("dismissedAnnouncements")
            const ids = stored["dismissedAnnouncements"]
            if (Array.isArray(ids)) dismissedAnnouncements = new Set(ids as string[])
            announcements = await sendRuntimeMessage<AppAnnouncement[]>({ type: "community:announcements" })
        } catch {
            announcements = []
        }
    }
    let extensionUpdate = $state<{
        available: boolean
        latestVersion: string
        releaseUrl: string
        downloadUrl?: string
        downloadName?: string
    } | null>(null)
    let updateDownloadHint = $state<string | null>(null)
    const isFirefoxBuild = import.meta.env.BROWSER === "firefox"

    async function downloadUpdate() {
        try {
            const res = await sendRuntimeMessage<{ started: boolean; filename: string }>({
                type: "extension-update:download"
            })
            updateDownloadHint = res.started
                ? isFirefoxBuild
                    ? `Downloaded ${res.filename}. Open about:addons → gear → Install Add-on From File to load it (or update from AMO).`
                    : `Downloaded ${res.filename}. Open chrome://extensions, enable Developer mode, and drag the unzipped folder in.`
                : "No matching download found for this release - use View release."
        } catch {
            updateDownloadHint = "Download failed - use View release instead."
        }
    }
    let updateBannerDismissed = $state(false)
    let checkingExtUpdate = $state(false)
    let updateStatus = $state<{
        checked: number
        updated: number
        failed: number
        checkedAt: number
        errors?: Array<{ mangaId: string; title: string; message: string }>
        failuresBySource?: Record<string, number>
        skippedSources?: Record<string, number>
        needsRelink?: Record<string, number>
    } | null>(null)
    let updateProgress = $state<{
        running: boolean
        done: number
        total: number
        currentTitle?: string
        sourceId?: string
        startedAt: number
    } | null>(null)
    // Must match STALE_PROGRESS_TIMEOUT_MS in src/handlers/updates-sources.ts - a
    // running=true progress record older than this is treated as a crashed check
    // rather than a real one still in flight.
    const UPDATE_PROGRESS_STALE_MS = 15 * 60 * 1000

    let updateLogCopyState = $state<"idle" | "ok" | "fail">("idle")
    let updateLogCopyTimer: ReturnType<typeof setTimeout> | undefined
    // Two clipboard writes started moments apart settle in no guaranteed order, so
    // without this guard an earlier click could land last and silently overwrite the
    // clipboard with a stale log (and flip the status text) after a later one.
    let updateLogCopying = false
    let componentAlive = true
    async function copyUpdateFailureLog() {
        if (updateLogCopying) return
        const hasErrors = (updateStatus?.errors?.length ?? 0) > 0
        const hasSkips = Object.keys(updateStatus?.skippedSources ?? {}).length > 0
        const hasRelink = Object.keys(updateStatus?.needsRelink ?? {}).length > 0
        if (!updateStatus || (!hasErrors && !hasSkips && !hasRelink)) return
        const text = formatUpdateFailureLog(updateStatus.errors ?? [], {
            version: browser.runtime.getManifest().version,
            checkedAt: updateStatus.checkedAt,
            checked: updateStatus.checked,
            updated: updateStatus.updated,
            failed: updateStatus.failed,
            ...(updateStatus.failuresBySource ? { failuresBySource: updateStatus.failuresBySource } : {}),
            ...(updateStatus.skippedSources ? { skippedSources: updateStatus.skippedSources } : {}),
            ...(updateStatus.needsRelink ? { needsRelink: updateStatus.needsRelink } : {})
        })
        updateLogCopying = true
        let outcome: "ok" | "fail"
        try {
            await navigator.clipboard.writeText(text)
            outcome = "ok"
        } catch {
            // Surface the failure rather than silently no-op: a user who sees nothing
            // happen might paste stale clipboard contents into a bug report as "the log".
            outcome = "fail"
        } finally {
            updateLogCopying = false
        }
        // Torn down mid-copy: don't write state or arm a timer onDestroy can't clear.
        if (!componentAlive) return
        updateLogCopyState = outcome
        if (updateLogCopyTimer) clearTimeout(updateLogCopyTimer)
        updateLogCopyTimer = setTimeout(() => {
            updateLogCopyState = "idle"
        }, 1500)
    }
    let sourcesList = $state<
        Array<{
            id: string
            name: string
            domains: string[]
            capabilities: string[]
            canSearch: boolean
            homepage?: string
        }>
    >([])
    // Sources excluded from aggregate search (Home search + mirror finder). Mirrors
    // settings.searchDisabledSourceIds and is updated optimistically on toggle.
    let searchDisabledSourceIds = $state<string[]>([])
    let checkingUpdates = $state(false)
    let detailManga = $state<LibraryManga | null>(null)
    let detailCommunityStats = $state<{ avgRating: number | null; ratingCount: number; readerCount: number } | null>(
        null
    )
    let relinkUrl = $state("")
    let relinkMessage = $state("")
    let mirrorResults = $state<SearchResult[]>([])
    let mirrorChecking = $state(false)
    let mirrorCheckedFor = $state("")
    // The mirror switch this manga's Switch button set is in flight for, keyed by
    // sourceId - a tab-fallback switch can take up to ~35s, so this both labels the
    // in-flight button and (via disabled={mirrorSwitching !== null} below) blocks a
    // second concurrent switch on the same manga while one is still running.
    let mirrorSwitching = $state<string | null>(null)
    // openInReader awaits chapter:resume before opening the tab; without a guard a
    // fast double-click resolves twice and opens two reader tabs.
    let openingReader = false

    // Re-point detailManga at the freshly-fetched record so an open detail
    // overlay reflects the latest library data (e.g. another tab's edit, a
    // backup restore, or a cleanup merge) - if the manga was deleted in the
    // process, leave the existing (now-dangling) reference alone rather than
    // clearing it out from under the user. Shared by both load() and refresh().
    function reconcileDetailManga() {
        const openDetailId = detailManga?.id
        if (openDetailId) {
            const updated = library.find(m => m.id === openDetailId)
            if (updated) detailManga = updated
        }
    }

    function closeDetail() {
        detailManga = null
        relinkUrl = ""
        relinkMessage = ""
        openSourceError = ""
        mirrorResults = []
        mirrorCheckedFor = ""
    }

    function normTitle(s: string): string {
        return s
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim()
    }

    // sendRuntimeMessage() rejects with whatever message the background dispatcher
    // forwarded verbatim (see src/background/handler-types.ts's failure()) - for
    // network-layer failures (a source timing out, 403ing, etc.) that's raw debug
    // text like "Request failed with status 403 [https://kagane.to/series/…]",
    // never meant for a user to read as-is. Curated SourceError messages have no
    // such bracketed/status-coded suffix and pass through unchanged; only the raw,
    // technical-looking ones get swapped for a friendly fallback. The raw message
    // is still logged for our own debugging.
    const RAW_ERROR_PATTERN = /\[https?:\/\/|\brequest (failed|timed out)\b|\bstatus \d{3}\b/i
    function describeError(cause: unknown, fallback: string): string {
        console.warn("[AMR] mirror action failed:", cause)
        const raw = cause instanceof Error ? cause.message : ""
        if (!raw || RAW_ERROR_PATTERN.test(raw)) return fallback
        return raw
    }

    // Same-source search endpoints can return duplicate/near-duplicate entries for
    // one underlying series - different sourceMangaIds under slightly different
    // title variants or translations (a catalog-data issue on the source's end).
    // Collapse those per-source so the mirror list doesn't show the same series
    // twice; entries from DIFFERENT sources are never merged even when titles
    // match closely, since that's a legitimate multi-mirror scenario. When a pair
    // differs on chapter count, keep whichever result has a real number.
    function dedupeMirrors(results: SearchResult[]): SearchResult[] {
        const kept: SearchResult[] = []
        for (const result of results) {
            const norm = normTitle(result.title)
            const dupIdx = kept.findIndex(k => {
                if (k.sourceId !== result.sourceId) return false
                const kNorm = normTitle(k.title)
                return kNorm === norm || kNorm.includes(norm) || norm.includes(kNorm)
            })
            if (dupIdx === -1) {
                kept.push(result)
                continue
            }
            const existing = kept[dupIdx]!
            const existingHasChapter = !!existing.latestChapter
            const candidateHasChapter = !!result.latestChapter
            if (!existingHasChapter && candidateHasChapter) {
                kept[dupIdx] = result
            } else if (existingHasChapter && candidateHasChapter) {
                const existingNum = parseFloat(existing.latestChapter ?? "0") || 0
                const candidateNum = parseFloat(result.latestChapter ?? "0") || 0
                if (candidateNum > existingNum) kept[dupIdx] = result
            }
        }
        return kept
    }

    async function switchMirror(manga: LibraryManga, result: SearchResult) {
        mirrorCheckedFor = manga.id
        mirrorSwitching = result.sourceId
        try {
            await sendRuntimeMessage({
                type: "library:switch",
                mangaId: manga.id,
                sourceId: result.sourceId,
                sourceMangaId: result.sourceMangaId,
                mangaUrl: result.url,
                allowTabFallback: true
            })
            await load()
            detailManga = library.find(m => m.id === manga.id) ?? null
            relinkMessage = `Switched to ${result.sourceId}. Progress preserved by chapter number.`
        } catch (cause) {
            relinkMessage = describeError(cause, "Switch failed - this source may be temporarily unavailable.")
        } finally {
            mirrorSwitching = null
        }
    }

    // Search every supported source for this title and show which mirrors carry
    // it, sorted by the latest hosted chapter so the freshest mirror is on top.
    async function checkMirrors(manga: LibraryManga) {
        mirrorChecking = true
        mirrorResults = []
        mirrorCheckedFor = manga.id
        try {
            const all = await sendRuntimeMessage<SearchResult[]>({ type: "manga:search", query: manga.title })
            const want = normTitle(manga.title)
            mirrorResults = dedupeMirrors(
                all.filter(r => {
                    const t = normTitle(r.title)
                    return t === want || t.includes(want) || want.includes(t)
                })
            ).sort((a, b) => (parseFloat(b.latestChapter ?? "0") || 0) - (parseFloat(a.latestChapter ?? "0") || 0))
        } catch {
            mirrorResults = []
        } finally {
            mirrorChecking = false
        }
    }

    async function relink(manga: LibraryManga) {
        const url = relinkUrl.trim()
        if (!url) return
        relinkMessage = "Re-linking…"
        try {
            const result = await sendRuntimeMessage({ type: "library:relink", mangaId: manga.id, url })
            relinkUrl = ""
            await load()
            // After load(), find the updated record by the new mangaId
            const newMangaId = (result as { sourceId: string; mangaId: string })?.mangaId ?? manga.id
            detailManga = library.find(m => m.id === newMangaId) ?? null
            relinkMessage = "Re-linked. Progress preserved by chapter number."
        } catch (cause) {
            relinkMessage = describeError(cause, "Re-link failed - the source may be unavailable.")
        }
    }
    // The manual "Find source" flow (FindSource.svelte) adopted a live source onto a
    // tracking-only / dead-source entry via library:switch. switchMangaSource preserved
    // all data in place (progress/rating/categories/notes/workId, read chapter remapped
    // by number), so we just refresh and re-point the open detail modal at the same id.
    // The row keeps its id across a switch, unlike relink which can mint a new one.
    async function onSourceAdopted(mangaId: string) {
        await load()
        detailManga = library.find(m => m.id === mangaId) ?? null
        reconcileIds = reconcileIds.filter(rid => rid !== mangaId)
    }

    let hasPermission = $state(false)
    let onboardingDismissed = $state(true)
    let browseQuery = $state("")

    async function dismissOnboarding() {
        onboardingDismissed = true
        await browser.storage.local.set({ onboardingDismissed: true })
    }

    async function onboardGrant() {
        await grantPermission()
        if (hasPermission) void backfillCovers()
    }
    type SearchResult = {
        sourceId: string
        sourceMangaId: string
        title: string
        url: string
        coverUrl?: string
        latestChapter?: string
    }
    let searchResults = $state<SearchResult[]>([])
    let searchLoading = $state(false)
    // True once a search has been run this session and not yet cleared. Keeps the results
    // popover open even when a search settles with zero matches, so the "No results" message
    // shows instead of the popover silently unmounting (searchResults stays empty then).
    let hasSearched = $state(false)
    let searchTotal = $state(0)
    let searchSettled = $state(0)
    let expandedSourceGroups = $state<Set<string>>(new Set())
    // The first source to return results this search; auto-expanded until the user toggles a group.
    let autoExpandSourceId = $state<string | null>(null)
    // Search-result view: ON collapses the same work across mirrors into one card
    // carrying a source chip per mirror; OFF restores today's per-source grouping.
    let groupDuplicates = $state(true)
    function toggleSourceGroup(sourceId: string) {
        const next = new Set(expandedSourceGroups)
        if (next.has(sourceId)) next.delete(sourceId)
        else next.add(sourceId)
        expandedSourceGroups = next
    }
    let selectedManga = $state<{ title: string } | null>(null)
    let mangaChapters = $state<Array<{ id: string; title: string; chapter?: string; url: string }>>([])
    let chaptersLoading = $state(false)
    // True while the chapter list or global search results are showing on Home - the
    // continue-reading/recently-added shelves aren't relevant then and would otherwise
    // render directly underneath with no separation, reading as a layout glitch.
    const searchActive = $derived(
        Boolean(selectedManga) ||
            (browseQuery.trim().length > 0 && (searchLoading || searchResults.length > 0 || hasSearched))
    )
    // If the title being browsed in the chapters panel is already in the library,
    // match it by normalized title so the last-read chapter can be highlighted.
    const selectedMangaLibraryEntry = $derived.by(() => {
        if (!selectedManga) return undefined
        const want = normTitle(selectedManga.title)
        return library.find(m => normTitle(m.title) === want)
    })
    type HistoryEntry = {
        mangaId: string
        title: string
        type: "started" | "completed"
        occurredAt: number
        chapterNumber?: number | null
        chapterTitle?: string | null
        chapterUrl?: string | null
    }
    let history = $state<HistoryEntry[]>([])
    let historyLoaded = $state(false)
    let expandedHistory = $state<Set<string>>(new Set())

    function toggleHistoryGroup(mangaId: string) {
        const next = new Set(expandedHistory)
        if (next.has(mangaId)) next.delete(mangaId)
        else next.add(mangaId)
        expandedHistory = next
    }

    // Group history events by manga, newest activity first; each group keeps its
    // events sorted newest-first for the expandable chapter list.
    const historyGroups = $derived.by(() => {
        const byManga = new Map<string, { mangaId: string; title: string; events: HistoryEntry[]; latest: number }>()
        for (const event of history) {
            const group = byManga.get(event.mangaId) ?? {
                mangaId: event.mangaId,
                title: event.title,
                events: [],
                latest: 0
            }
            group.events.push(event)
            group.latest = Math.max(group.latest, event.occurredAt)
            byManga.set(event.mangaId, group)
        }
        const groups = [...byManga.values()]
        for (const g of groups) g.events.sort((a, b) => b.occurredAt - a.occurredAt)
        return groups.sort((a, b) => b.latest - a.latest)
    })

    async function loadHistory() {
        try {
            history = await sendRuntimeMessage<HistoryEntry[]>({ type: "history:list" })
        } catch {
            history = []
        } finally {
            historyLoaded = true
        }
    }

    // Auto-refresh history every time the tab is opened.
    $effect(() => {
        if (activeSection === "Activity" && activityTab === "History") void loadHistory()
    })

    async function loadBookmarks() {
        try {
            bookmarks = await sendRuntimeMessage<PageBookmark[]>({ type: "bookmark:list" })
        } catch {
            bookmarks = []
        } finally {
            bookmarksLoaded = true
        }
    }

    $effect(() => {
        if (activeSection === "Activity" && activityTab === "Bookmarks") void loadBookmarks()
    })

    async function deleteBookmark(id: string) {
        await sendRuntimeMessage({ type: "bookmark:remove", id })
        bookmarks = bookmarks.filter(b => b.id !== id)
    }

    function bookmarkReaderUrl(b: PageBookmark): string {
        const base = browser.runtime.getURL("/reader.html")
        return `${base}?url=${encodeURIComponent(b.chapterUrl)}&page=${b.pageIndex}`
    }

    $effect(() => {
        document.documentElement.dataset["theme"] = settings?.theme ?? "dark"
    })

    function isSeedData(manga: LibraryManga): boolean {
        return manga.id.startsWith("seed-")
    }

    const DAY_MS = 86_400_000

    function isRecentlyAdded(manga: LibraryManga): boolean {
        return manga.addedAt > Date.now() - DAY_MS
    }

    // Updates-list / "Updated"-chip membership: newer chapters, OR a never-opened title
    // that has any chapter to read. Kept distinct from hasNewerChapters so the badge and
    // the Updates list can disagree on the never-read case exactly as they did before.
    function hasUpdates(manga: LibraryManga): boolean {
        return (
            hasNewerChapters(manga) ||
            (neverRead(manga) && (manga.latestChapterId !== undefined || manga.latestChapterNumber !== undefined))
        )
    }

    // When a dashboard tab that's already open regains focus (e.g. the reader's
    // "back to dashboard" refocuses it rather than opening a fresh one), pick up any
    // progress changes from the reading session with a cheap indexed re-query -
    // without re-triggering the cover backfill cascade.
    function onVisibilityChange() {
        if (document.visibilityState === "visible") void refresh()
    }

    let unsubscribeLive: (() => void) | undefined

    onMount(async () => {
        document.addEventListener("visibilitychange", onVisibilityChange)
        unsubscribeLive = subscribeLive(["library", "chapters", "progress", "all"], () => void refresh())
        // Probe the companion site once. A no-cors HEAD resolves (opaquely) when the site
        // answers and rejects when it's unreachable, gating the Community links either way.
        void fetch(WEEB_SITE_URL, { method: "HEAD", mode: "no-cors" })
            .then(() => (siteReachable = true))
            .catch(() => {})
        void loadAnnouncements()
        await load()
        hasPermission = await sendRuntimeMessage<boolean>({ type: "source:permission:check" })
        if (hasPermission) {
            void maybeBackfillCovers()
            // Invisible, one-time maintenance: fixes already-poisoned MangaHub badges
            // (see repairMangahubChapterNumbers) within a normal app session - no UI,
            // no progress bar. The function itself guards against re-running via a
            // persisted storage flag, so this call is safe on every mount.
            void repairMangahubChapterNumbers()
        }
        try {
            const stored = await browser.storage.local.get("onboardingDismissed")
            onboardingDismissed = Boolean(stored["onboardingDismissed"])
        } catch {
            onboardingDismissed = false
        }
        try {
            const v = (await browser.storage.local.get("librarySort"))["librarySort"]
            if (
                v === "updates-first" ||
                v === "recent-read" ||
                v === "recent-added" ||
                v === "recently-updated" ||
                v === "title" ||
                v === "latest-chapter"
            ) {
                librarySort = v
            }
        } catch {
            // keep the default sort
        }
        await loadSyncStatus()
        await loadAniListStatus()
        await loadAccountStatus()
        try {
            sourcesList = await sendRuntimeMessage<typeof sourcesList>({ type: "sources:list" })
        } catch {
            // optional
        }
        try {
            const downloads = await sendRuntimeMessage<Array<{ chapterId: string }>>({ type: "downloads:list" })
            downloadsCount = downloads.length
        } catch {
            // optional
        }
        try {
            const stored = (await browser.storage.local.get("updateProgress"))["updateProgress"] as
                | typeof updateProgress
                | undefined
            if (stored) {
                updateProgress = stored
                // A running=true left over from a check that never finished (e.g. the
                // service worker died mid-loop) would otherwise disable "Check all"
                // forever if automatic interval checks are off - mirrors the same
                // STALE_PROGRESS_TIMEOUT_MS threshold the updates:check handler uses to
                // self-heal server-side (src/handlers/updates-sources.ts).
                const isStale = stored.running && Date.now() - stored.startedAt > UPDATE_PROGRESS_STALE_MS
                checkingUpdates = stored.running && !isStale
            }
        } catch {
            // optional
        }
        // An update check (this popup's own, or the background alarm's) writes its
        // live progress to storage as it goes - reflect it here instead of awaiting
        // the `updates:check` message, which is now fire-and-forget (see checkForUpdates).
        browser.storage.onChanged.addListener((changes, area) => {
            if (area !== "local") return
            if (changes["updateProgress"]) {
                const next = (changes["updateProgress"].newValue as typeof updateProgress) ?? null
                const wasRunning = (changes["updateProgress"].oldValue as typeof updateProgress | undefined)?.running
                updateProgress = next
                if (wasRunning && !next?.running) {
                    checkingUpdates = false
                    // The check just finished - the library data it touched (latest
                    // chapter ids/numbers) needs a refresh to show up in the UI.
                    void refresh()
                }
            }
            if (changes["updateStatus"]) {
                updateStatus = (changes["updateStatus"].newValue as typeof updateStatus) ?? null
            }
        })
    })

    onDestroy(() => {
        document.removeEventListener("visibilitychange", onVisibilityChange)
        unsubscribeLive?.()
        componentAlive = false
        if (updateLogCopyTimer) clearTimeout(updateLogCopyTimer)
        if (bulkRemoveArmTimer) clearTimeout(bulkRemoveArmTimer)
        // Full revoke-everything sweep so nothing leaks when the tab closes -
        // loadCachedCovers only revokes URLs for ids that drop out of the library
        // between refreshes, not the ones still current when the component unmounts.
        for (const url of Object.values(coverSrcs)) URL.revokeObjectURL(url)
    })

    // Diffs by mangaId instead of rebuilding coverSrcs from scratch: an id that
    // already has an object URL keeps it (no revoke+recreate), a genuinely new id
    // gets a fresh object URL, and an id no longer present (manga removed) gets
    // its URL revoked and dropped. Rebuilding from scratch on every call (the
    // prior behavior) meant a live-triggered refresh() revoked every cover's
    // object URL right as it reassigned coverSrcs, blanking the whole grid for a
    // frame even though nothing about the covers actually changed.
    // Also compares cachedAt per id: capture.ts re-caches a manga's cover blob on
    // every successful chapter capture (not just when uncached), so an unchanged
    // mangaId can still point at stale image bytes. When cachedAt has moved, the
    // existing object URL is revoked and recreated from the fresh blob; ids whose
    // cachedAt is unchanged keep their existing URL untouched, same as before.
    async function loadCachedCovers() {
        const records = await getCachedCovers(library.map(m => m.id))
        const next: Record<string, string> = {}
        const nextCachedAt: Record<string, number> = {}
        // Revoke only after coverSrcs points at the replacement URLs, so no
        // in-between render can hold a revoked URL as an img src.
        const toRevoke: string[] = []
        for (const [mangaId, record] of records) {
            const existing = coverSrcs[mangaId]
            if (existing !== undefined && coverCachedAt[mangaId] === record.cachedAt) {
                next[mangaId] = existing
            } else {
                if (existing !== undefined) toRevoke.push(existing)
                next[mangaId] = URL.createObjectURL(record.blob)
            }
            nextCachedAt[mangaId] = record.cachedAt
        }
        for (const [mangaId, url] of Object.entries(coverSrcs)) {
            if (!(mangaId in next)) toRevoke.push(url)
        }
        coverSrcs = next
        coverCachedAt = nextCachedAt
        for (const url of toRevoke) URL.revokeObjectURL(url)
        // A cached blob now exists for these ids - clear any stale "failed to load"
        // flag so a previously-broken remote cover doesn't stay permanently blanked
        // once a cached blob has been backfilled (or, now, re-cached with a working
        // image after previously failing).
        if (failedCovers.size > 0) {
            const cleared = new Set(failedCovers)
            let changed = false
            for (const mangaId of Object.keys(next)) {
                if (cleared.delete(mangaId)) changed = true
            }
            if (changed) failedCovers = cleared
        }
    }

    async function loadSyncStatus() {
        try {
            syncStatus = await sendRuntimeMessage<SyncStatus>({ type: "sync:status" })
            syncGistId = syncStatus.gistId ?? ""
        } catch {
            // sync optional
        }
    }

    async function saveSyncToken() {
        const token = syncToken.trim()
        if (!token) return
        const granted = await browser.permissions.request({ origins: syncOrigins() })
        if (!granted) {
            syncMessage = "GitHub access was not granted."
            return
        }
        syncStatus = await sendRuntimeMessage<SyncStatus>({ type: "sync:config", config: { token } })
        syncToken = ""
        syncMessage = "Token saved."
    }

    async function saveGistId() {
        syncStatus = await sendRuntimeMessage<SyncStatus>({
            type: "sync:config",
            config: { gistId: syncGistId.trim() }
        })
    }

    async function toggleAutoSync(on: boolean) {
        try {
            syncStatus = await sendRuntimeMessage<SyncStatus>({ type: "sync:config", config: { autoSync: on } })
        } catch {
            if (syncStatus) syncStatus = { ...syncStatus }
        }
    }

    // weeb.ltd account link: a device token pasted from the site's Account page. Sync runs
    // on link, on demand, and every 30 minutes via the account alarm.
    let accountProfile = $state<AccountProfile | undefined>()
    let accountToken = $state("")
    let accountBusy = $state(false)
    let accountMessage = $state("")
    const accountLinked = $derived(Boolean(accountProfile?.token))
    // The Settings sign-in nudge is shown until the user links an account or dismisses it.
    // Dismissal persists so it never nags on every visit; the sidebar Sign-in button stays.
    let accountNudgeDismissed = $state(false)
    const showAccountNudge = $derived(!accountLinked && !accountNudgeDismissed)
    // A one-off "make an account to auto-back-up" hint shown right after a manual import - the
    // highest-intent moment to convert. Not persisted; clears when they act or leave Data.
    let showImportBackupHint = $state(false)

    function dismissAccountNudge() {
        accountNudgeDismissed = true
        void browser.storage.local.set({ accountNudgeDismissed: true })
    }
    // Jump to the account section in Settings (token paste + link-device + site link live there).
    async function openAccount() {
        activeSection = "Settings"
        await tick()
        jumpToSettings("account")
    }
    // Start sign-up: open the weeb.ltd sign-up page (where they create an account and get their
    // link code) in a focused new tab, and ready the paste field in the extension underneath so
    // it's waiting for them the moment they come back with the code.
    function startSignIn() {
        openWeebSignUp()
        void openAccount()
    }

    async function loadAccountStatus() {
        try {
            accountProfile = await sendRuntimeMessage<AccountProfile>({ type: "account:status" })
        } catch {
            // account link optional
        }
        try {
            const stored = await browser.storage.local.get("accountNudgeDismissed")
            accountNudgeDismissed = stored["accountNudgeDismissed"] === true
        } catch {
            // default to showing the nudge
        }
    }

    async function linkAccount() {
        const token = accountToken.trim()
        if (!token) return
        accountBusy = true
        accountMessage = ""
        try {
            accountProfile = await sendRuntimeMessage<AccountProfile>({ type: "account:link", token })
            accountToken = ""
            accountMessage = `Linked as ${accountProfile.name ?? "your account"}. First sync done.`
        } catch (cause) {
            accountMessage = cause instanceof Error ? cause.message : "Link failed."
        } finally {
            accountBusy = false
        }
    }

    async function unlinkAccount() {
        if (!confirm("Unlink this device from your weeb.ltd account? Your local library stays as it is.")) return
        accountProfile = await sendRuntimeMessage<AccountProfile>({ type: "account:unlink" })
        accountMessage = "Unlinked."
    }

    async function syncAccountNow() {
        accountBusy = true
        accountMessage = ""
        try {
            accountProfile = await sendRuntimeMessage<AccountProfile>({ type: "account:sync" })
            accountMessage = accountProfile.invalid
                ? "This link token was revoked on the site. Create a new one to re-link."
                : `Synced ${accountProfile.itemCount ?? 0} titles.`
            await load()
        } catch (cause) {
            accountMessage = cause instanceof Error ? cause.message : "Sync failed."
        } finally {
            accountBusy = false
        }
    }

    async function pushSync() {
        syncing = true
        syncMessage = ""
        try {
            const res = await sendRuntimeMessage<{ gistId: string }>({ type: "sync:push" })
            syncMessage = `Pushed to gist ${res.gistId}.`
            await loadSyncStatus()
        } catch (cause) {
            syncMessage = cause instanceof Error ? cause.message : "Push failed."
        } finally {
            syncing = false
        }
    }

    async function pullSync() {
        syncing = true
        syncMessage = ""
        try {
            const res = await sendRuntimeMessage<{ manga: number; chapters: number }>({ type: "sync:pull" })
            syncMessage = `Pulled ${res.manga} manga and ${res.chapters} chapters.`
            failedCovers = new Set()
            await load()
            await loadSyncStatus()
        } catch (cause) {
            syncMessage = cause instanceof Error ? cause.message : "Pull failed."
        } finally {
            syncing = false
        }
    }

    async function loadAniListStatus() {
        try {
            anilistStatus = await sendRuntimeMessage<AniListStatus>({ type: "anilist:status" })
        } catch {
            // AniList sync optional
        }
    }

    async function saveAniListToken() {
        const token = anilistToken.trim()
        if (!token) return
        anilistMessage = ""
        try {
            // graphql.anilist.co is a required host permission, so no runtime grant needed.
            anilistStatus = await sendRuntimeMessage<AniListStatus>({ type: "anilist:config", config: { token } })
            anilistToken = ""
            anilistMessage = anilistStatus.viewerName ? `Connected as ${anilistStatus.viewerName}.` : "Token saved."
        } catch (cause) {
            anilistMessage = cause instanceof Error ? cause.message : "That token was not accepted."
        }
    }

    async function disconnectAniList() {
        anilistStatus = await sendRuntimeMessage<AniListStatus>({ type: "anilist:config", config: { token: "" } })
        anilistMessage = "Disconnected."
    }

    // On a failed config write, reassign anilistStatus (unchanged values) so Svelte
    // re-asserts the checkbox to its true state instead of leaving it visually flipped
    // from the user's click.
    async function toggleAniListAutoSync(on: boolean) {
        try {
            anilistStatus = await sendRuntimeMessage<AniListStatus>({
                type: "anilist:config",
                config: { autoSync: on }
            })
        } catch (cause) {
            anilistMessage = cause instanceof Error ? cause.message : "Could not update auto-sync."
            if (anilistStatus) anilistStatus = { ...anilistStatus }
        }
    }

    async function toggleAniListMembership(on: boolean) {
        try {
            anilistStatus = await sendRuntimeMessage<AniListStatus>({
                type: "anilist:config",
                config: { syncMembership: on }
            })
        } catch (cause) {
            anilistMessage = cause instanceof Error ? cause.message : "Could not update membership sync."
            if (anilistStatus) anilistStatus = { ...anilistStatus }
        }
    }

    async function toggleAniListStatusSync(dir: "statusPush" | "statusPull", on: boolean) {
        try {
            anilistStatus = await sendRuntimeMessage<AniListStatus>({
                type: "anilist:config",
                config: { [dir]: on }
            })
        } catch (cause) {
            anilistMessage = cause instanceof Error ? cause.message : "Could not update status sync."
            if (anilistStatus) anilistStatus = { ...anilistStatus }
        }
    }

    async function syncAniListNow() {
        anilistSyncing = true
        anilistMessage = ""
        try {
            await sendRuntimeMessage<{ started: boolean }>({ type: "anilist:sync" })
            anilistMessage = "Sync started - chapter progress is pushed in the background."
        } catch (cause) {
            anilistMessage = cause instanceof Error ? cause.message : "Sync failed."
        } finally {
            anilistSyncing = false
        }
    }

    async function importAniListNow() {
        anilistImporting = true
        anilistMessage = ""
        try {
            const result = await sendRuntimeMessage<{ imported: number; skipped: number; total: number }>({
                type: "anilist:import"
            })
            anilistMessage = `Imported ${result.imported}, skipped ${result.skipped}.`
            await refresh()
        } catch (cause) {
            anilistMessage = cause instanceof Error ? cause.message : "Import failed."
        } finally {
            anilistImporting = false
        }
    }

    // Background cover-freshness sweep shouldn't re-run its full network cascade
    // on every single dashboard open - the MV3 service worker is essentially always
    // killed and restarted between reading sessions, so an in-memory dedup set alone
    // doesn't prevent that. Gate the automatic onMount trigger behind this TTL; the
    // manual "Refresh covers" button and post-import call still bypass it below.
    const COVER_BACKFILL_TTL_MS = 8 * 60 * 60 * 1000

    async function maybeBackfillCovers() {
        try {
            const stored = await browser.storage.local.get("lastCoverBackfillAt")
            const last = stored["lastCoverBackfillAt"] as number | undefined
            if (last && Date.now() - last < COVER_BACKFILL_TTL_MS) return
        } catch {
            // storage read failed - fall through and attempt the backfill anyway
        }
        void backfillCovers()
    }

    // Manually kick the metadata enrichment pass (genres/cover/status) over the whole library.
    async function backfillMetadata() {
        toolsOpen = false
        try {
            await sendRuntimeMessage({ type: "library:metadata:backfill" })
            showSugToast("Filling in genres, covers & status in the background…")
        } catch {
            showSugToast("Couldn't start the metadata refresh")
        }
    }

    async function backfillCovers() {
        if (refreshingCovers) return
        refreshingCovers = true
        // Reset at the start of THIS run - must not carry a stale done/total from a
        // previous invocation into a fresh one.
        coverProgress = undefined
        void browser.storage.local.set({ lastCoverBackfillAt: Date.now() }).catch(() => {})
        try {
            let anyUpdated = false
            // `total` reflects the handler's remaining target-set size at the start of
            // that batch, which can shrink between batches as attempted ids drop out of
            // the target set (see library:covers:backfill) - track the largest total
            // seen so the progress bar doesn't appear to shrink mid-run.
            let maxTotal = 0
            for (;;) {
                const res = await sendRuntimeMessage<{ updated: number; remaining: number; total: number }>({
                    type: "library:covers:backfill"
                })
                if (res.updated > 0) anyUpdated = true
                if (typeof res.total === "number") {
                    maxTotal = Math.max(maxTotal, res.total)
                    coverProgress = { done: Math.max(0, maxTotal - res.remaining), total: maxTotal }
                }
                if (res.remaining === 0) break
                // Brief pause between batches so the service worker doesn't timeout
                await new Promise<void>(r => setTimeout(r, 300))
            }
            // Refresh once at the end instead of after every batch - a backfill can span
            // many batches, and reloading the whole library (stats/settings/updates +
            // every cached cover) after each one was the actual bottleneck, not the
            // backfill itself.
            if (anyUpdated) {
                failedCovers = new Set()
                void load()
            }
        } catch {
            // covers are best-effort
        } finally {
            refreshingCovers = false
        }
    }

    // A "Search all"/"Find better sources" reconcile sweep can auto-link dozens of
    // titles in quick succession - each onLinked() call firing a synchronous load()
    // (a full library-list + every cached cover re-read from IndexedDB) would flood
    // the dashboard with ~1 full reload per link, competing with the sweep's own
    // network traffic. Trailing-debounce collapses a burst of onLinked() calls into
    // one load() 1s after the last one. The live-update-bus refresh() subscription
    // (subscribeLive, see onMount) already covers incremental freshness in the
    // meantime, so this doesn't lose reactivity between the last link and the
    // debounced load().
    let scheduledLoadTimer: ReturnType<typeof setTimeout> | undefined
    function scheduleLoad() {
        if (scheduledLoadTimer !== undefined) clearTimeout(scheduledLoadTimer)
        scheduledLoadTimer = setTimeout(() => {
            scheduledLoadTimer = undefined
            void load()
        }, 1000)
    }

    async function load() {
        loading = true
        try {
            ;[library, settings] = await Promise.all([
                sendRuntimeMessage<LibraryManga[]>({ type: "library:list" }),
                sendRuntimeMessage<AppSettings>({ type: "settings:get" })
            ])
            updateIntervalSelection = settings.updateIntervalHours
            noGapSelection = settings.noGapContinuous
            autoPauseDays = settings.autoPauseDays ?? 0
            searchDisabledSourceIds = settings.searchDisabledSourceIds ?? []
            if (!startPageApplied) {
                startPageApplied = true
                activeSection = settings.startPage === "library" ? "Library" : "Discover"
            }
            // stats:get scans the whole progress/history tables and isn't needed to paint
            // the library - fetch it in the background instead of blocking the grid on it.
            void sendRuntimeMessage<typeof stats>({ type: "stats:get" }).then(result => {
                stats = result
            })
            void sendRuntimeMessage<typeof updateStatus>({ type: "updates:get" }).then(result => {
                updateStatus = result
            })
            const stored = (await browser.storage.local.get("extensionUpdate"))["extensionUpdate"] as
                | typeof extensionUpdate
                | undefined
            if (stored?.available) extensionUpdate = stored
            // Fire a non-blocking check on every popup open (24h throttle in background).
            // Ensures the banner appears promptly after a release even without a browser restart.
            void sendRuntimeMessage<typeof extensionUpdate>({ type: "extension-update:check" }).then(result => {
                if (result) extensionUpdate = result
            })
            // Persist broken-link panel across page opens. Entries with manualTracking
            // and a hostname-style sourceId (contains ".") were imported from an unknown
            // source. Adapter IDs like "madara"/"mangadex" never contain dots, so this
            // correctly skips titles the user deliberately marked manual.
            const libraryNeedsAttention = library
                .filter(m => m.manualTracking && m.sourceId.includes(".") && !isReadOnlyDiscoverAdd(m))
                .map(m => m.id)
            if (libraryNeedsAttention.length > 0) {
                reconcileIds = [...new Set([...reconcileIds, ...libraryNeedsAttention])]
            }
        } finally {
            loading = false
        }
        reconcileDetailManga()
        void loadCachedCovers()
    }

    // Same data-fetching as load(), but for a tab that's already showing the
    // library - never flips `loading` (which would blank the whole page behind a
    // spinner), and is generation-guarded against out-of-order responses: a fast
    // refocus-triggered refresh() racing a live-event-triggered one could
    // otherwise let the slower response's stale library data land last and
    // clobber the newer one.
    let refreshGeneration = 0

    async function refresh() {
        refreshGeneration += 1
        const generation = refreshGeneration
        const [nextLibrary, nextSettings] = await Promise.all([
            sendRuntimeMessage<LibraryManga[]>({ type: "library:list" }),
            sendRuntimeMessage<AppSettings>({ type: "settings:get" })
        ])
        // A newer refresh() call started while this one was in flight - let it win.
        if (generation !== refreshGeneration) return

        library = nextLibrary
        settings = nextSettings
        updateIntervalSelection = settings.updateIntervalHours
        noGapSelection = settings.noGapContinuous
        autoPauseDays = settings.autoPauseDays ?? 0
        searchDisabledSourceIds = settings.searchDisabledSourceIds ?? []
        void sendRuntimeMessage<typeof stats>({ type: "stats:get" }).then(result => {
            stats = result
        })
        void sendRuntimeMessage<typeof updateStatus>({ type: "updates:get" }).then(result => {
            updateStatus = result
        })
        const stored = (await browser.storage.local.get("extensionUpdate"))["extensionUpdate"] as
            | typeof extensionUpdate
            | undefined
        if (stored?.available) extensionUpdate = stored
        void sendRuntimeMessage<typeof extensionUpdate>({ type: "extension-update:check" }).then(result => {
            if (result) extensionUpdate = result
        })
        const libraryNeedsAttention = library
            .filter(m => m.manualTracking && m.sourceId.includes(".") && !isReadOnlyDiscoverAdd(m))
            .map(m => m.id)
        if (libraryNeedsAttention.length > 0) {
            reconcileIds = [...new Set([...reconcileIds, ...libraryNeedsAttention])]
        }
        reconcileDetailManga()
        void loadCachedCovers()
    }

    function isValidUrl(value: string | undefined | null): value is string {
        if (!value) return false
        try {
            // Require an http(s) scheme: new URL() also accepts javascript:/data:/blob:,
            // and these values flow to browser.tabs.create as source-controlled input.
            const protocol = new URL(value).protocol
            return protocol === "http:" || protocol === "https:"
        } catch {
            return false
        }
    }

    // Single funnel for opening a source-controlled URL in a tab. Every mangaUrl/sourceUrl/
    // chapter URL comes from an adapter parsing a third-party page, so it must pass the
    // http(s) scheme gate before reaching browser.tabs.create - a compromised/hostile adapter
    // returning a javascript:/data:/file: URL is otherwise handed straight to the browser.
    // Returns false when the URL was rejected so callers can surface an error.
    function openExternal(url: string | undefined | null, active = true): boolean {
        if (!isValidUrl(url)) return false
        void browser.tabs.create({ url, active })
        return true
    }

    // Best-effort link for a manga: the series/detail page is more durable than
    // a last-captured chapter URL, which can 404 once a site reslugs chapters.
    // Falls back to the adapter's homepage/domain if neither stored URL is usable.
    function resolveSourceLink(manga: LibraryManga): string | undefined {
        if (isValidUrl(manga.mangaUrl)) return manga.mangaUrl
        if (isValidUrl(manga.sourceUrl)) return manga.sourceUrl
        const meta = sourceMeta.get(manga.sourceId)
        const homepage = meta?.homepage ?? (meta?.domains[0] ? `https://${meta.domains[0]}` : undefined)
        return isValidUrl(homepage) ? homepage : undefined
    }

    let openSourceError = $state("")

    function openInBrowser(manga: LibraryManga, active = true, opts: { fallback?: boolean } = {}) {
        openSourceError = ""
        if (!opts.fallback) {
            if (!openExternal(manga.sourceUrl, active)) {
                openSourceError = "Couldn't open - no working link found for this source."
            }
            return
        }
        const url = resolveSourceLink(manga)
        if (!openExternal(url, active)) {
            openSourceError = "Couldn't open - no working link found for this source."
        }
    }

    function openSeriesPage(manga: LibraryManga, e?: MouseEvent) {
        // auxclick fires for right-click too - don't hijack the context menu.
        if (e?.button === 2) return
        if (selectMode) {
            toggleSelect(manga.id)
            return
        }
        openExternal(manga.mangaUrl ?? manga.sourceUrl, e?.button !== 1)
    }

    async function openInReader(manga: LibraryManga) {
        if (openingReader) return
        openingReader = true
        // Resume at the last-read chapter (or the first if unread) instead of always
        // opening sourceUrl, which is the latest chapter. Fall back to sourceUrl if the
        // resolver can't find a chapter.
        let target = manga.sourceUrl
        try {
            const resumed = await sendRuntimeMessage<{ url?: string }>({ type: "chapter:resume", mangaId: manga.id })
            if (resumed?.url) target = resumed.url
        } catch {
            // ignore - fall back to sourceUrl
        } finally {
            openingReader = false
        }
        void browser.tabs.create({
            url: browser.runtime.getURL(`/reader.html?url=${encodeURIComponent(target)}`)
        })
    }

    // Primary click honors the openChapterIn setting. Ctrl/middle-click always
    // opens the source page directly in a background tab (G11).
    function read(manga: LibraryManga, event?: MouseEvent) {
        // auxclick fires for right-click too - don't hijack the context menu.
        if (event?.button === 2) return
        if (selectMode) {
            toggleSelect(manga.id)
            return
        }
        if (event && (event.ctrlKey || event.metaKey || event.button === 1)) {
            openInBrowser(manga, false)
            return
        }
        if (settings?.openChapterIn === "browser") openInBrowser(manga)
        else void openInReader(manga)
    }

    async function remove(mangaId: string) {
        await sendRuntimeMessage({ type: "library:remove", mangaId })
        library = library.filter(m => m.id !== mangaId)
    }

    function applyCategories<T extends { id: string; categories?: string[] }>(item: T, id: string, next?: string[]): T {
        if (item.id !== id) return item
        const copy = { ...item }
        if (next && next.length > 0) copy.categories = next
        else delete copy.categories
        return copy
    }

    async function commitCategories(manga: LibraryManga, categories: string[]) {
        const deduped = [...new Set(categories.map(c => c.trim()).filter(Boolean))]
        await sendRuntimeMessage({ type: "library:categories", mangaId: manga.id, categories: deduped })
        const next = deduped.length > 0 ? deduped : undefined
        library = library.map(m => applyCategories(m, manga.id, next))
        if (detailManga && detailManga.id === manga.id) detailManga = applyCategories(detailManga, manga.id, next)
    }

    // Tags == categories. Add/remove individual tags and bulk-add comma lists.
    function tagsOf(manga: LibraryManga): string[] {
        return manga.categories ?? []
    }
    async function addTags(manga: LibraryManga, incoming: string[]) {
        await commitCategories(manga, [...tagsOf(manga), ...incoming])
    }
    async function removeTag(manga: LibraryManga, tag: string) {
        await commitCategories(
            manga,
            tagsOf(manga).filter(t => t !== tag)
        )
    }

    let tagDraft = $state("")
    async function addTagDraft(manga: LibraryManga) {
        const parts = tagDraft
            .split(",")
            .map(s => s.trim())
            .filter(Boolean)
        if (parts.length === 0) return
        await addTags(manga, parts)
        tagDraft = ""
    }

    // Suggested tags pulled from the source's genre list (best-effort).
    let genreSuggestions = $state<string[]>([])
    let genresLoading = $state(false)
    let genresForId = $state<string | null>(null)
    async function loadGenres(manga: LibraryManga) {
        genresForId = manga.id
        genresLoading = true
        genreSuggestions = []
        try {
            const result = await sendRuntimeMessage<string[]>({ type: "manga:genres", mangaId: manga.id })
            // Guard against a stale response landing after the user already switched
            // to a different title - don't overwrite what's now on screen.
            if (detailManga?.id === manga.id) genreSuggestions = result
        } catch {
            if (detailManga?.id === manga.id) genreSuggestions = []
        } finally {
            if (detailManga?.id === manga.id) genresLoading = false
        }
    }
    $effect(() => {
        const id = detailManga?.id
        if (id && genresForId !== id) {
            genresForId = id
            if (detailManga) void loadGenres(detailManga)
        }
    })

    // Same previous-id-guard pattern as the genres effect above: without it, a
    // live-triggered refresh() reassigning detailManga to a new object reference
    // for the SAME id would re-run this effect (Svelte 5 effects re-run on
    // reference changes even when the id is unchanged), clearing and re-fetching
    // community stats on every refresh and causing a visible flicker.
    let communityStatsForId = $state<string | null>(null)
    $effect(() => {
        const id = detailManga?.id
        const title = detailManga?.title
        if (!id || communityStatsForId === id) return
        communityStatsForId = id
        detailCommunityStats = null
        if (title) {
            void sendRuntimeMessage<{ avgRating: number | null; ratingCount: number; readerCount: number }>({
                type: "community:manga-stats",
                mangaTitle: title
            })
                .then(s => {
                    // Guard against a stale response landing after the user switched titles.
                    if (detailManga?.id === id) detailCommunityStats = s
                })
                .catch(() => {})
        }
    })

    // Genres shown read-only in the detail modal: the stored (auto-enriched) genres unioned
    // with any freshly fetched from the source. Genres are enrichment data, distinct from the
    // user's own tags - no longer offered as "tags to add".
    function detailGenres(dm: LibraryManga): string[] {
        return [...new Set([...(dm.genres ?? []), ...genreSuggestions])]
    }

    // Effective status of the title open in the detail modal, for the Status button row.
    const detailEff = $derived(
        detailManga ? effectiveReadingStatus(detailManga, { autoPauseDays, now: Date.now() }) : "reading"
    )

    async function rate(manga: LibraryManga, value: number) {
        const next = manga.rating === value ? 0 : value
        await sendRuntimeMessage({ type: "library:rate", mangaId: manga.id, rating: next })
        const nextRating = next === 0 ? undefined : next
        library = library.map(m => (m.id === manga.id ? { ...m, rating: nextRating } : m))
        if (detailManga && detailManga.id === manga.id) detailManga = { ...detailManga, rating: nextRating }
        if (next > 0) {
            void sendRuntimeMessage({ type: "community:rate", mangaTitle: manga.title, rating: next }).catch(() => {})
        }
    }

    // Each of these one-way-bound (checked/value={state}) controls updates state only
    // after the write resolves. On a failed write, revertControls() reassigns the backing
    // state to a fresh reference so Svelte snaps the control back to its true value instead
    // of leaving it showing the user's change for a setting that was never applied.
    function revertControls() {
        if (detailManga) detailManga = { ...detailManga }
        library = [...library]
    }

    async function setNsfw(manga: LibraryManga, nsfw: boolean) {
        try {
            await sendRuntimeMessage({ type: "library:nsfw", mangaId: manga.id, nsfw })
            library = library.map(m => (m.id === manga.id ? { ...m, nsfw } : m))
            if (detailManga && detailManga.id === manga.id) detailManga = { ...detailManga, nsfw }
        } catch {
            revertControls()
        }
    }

    async function setManual(manga: LibraryManga, manual: boolean) {
        try {
            await sendRuntimeMessage({ type: "library:manual", mangaId: manga.id, manual })
            library = library.map(m => (m.id === manga.id ? { ...m, manualTracking: manual } : m))
            if (detailManga && detailManga.id === manga.id) detailManga = { ...detailManga, manualTracking: manual }
        } catch {
            revertControls()
        }
    }

    // The detail-modal Status buttons, kept mutually exclusive: On Hold sets the onHold flag and
    // clears any stored override; the others clear onHold and set (or clear, for Reading) the
    // readingStatus. Reading = the default derived state.
    async function detailSetStatus(manga: LibraryManga, kind: "reading" | "on-hold" | "dropped" | "planning") {
        try {
            if (kind === "on-hold") {
                await sendRuntimeMessage({ type: "library:status", mangaId: manga.id, status: null })
                await sendRuntimeMessage({ type: "library:hold", mangaId: manga.id, onHold: true })
            } else {
                await sendRuntimeMessage({ type: "library:hold", mangaId: manga.id, onHold: false })
                await sendRuntimeMessage({
                    type: "library:status",
                    mangaId: manga.id,
                    status: kind === "reading" ? null : kind
                })
            }
            await load()
        } catch {
            revertControls()
        }
    }

    async function setNumber(manga: LibraryManga, field: "lastReadChapterNumber" | "latestChapterNumber", raw: string) {
        const trimmed = raw.trim()
        const value = trimmed === "" ? null : Math.max(0, Number(trimmed))
        if (value !== null && !Number.isFinite(value)) return
        try {
            await sendRuntimeMessage({ type: "library:numbers", mangaId: manga.id, [field]: value })
            const applyNumber = (m: LibraryManga): LibraryManga => {
                const next = { ...m }
                if (value === null) delete next[field]
                else next[field] = value
                return next
            }
            library = library.map(m => (m.id === manga.id ? applyNumber(m) : m))
            if (detailManga && detailManga.id === manga.id) detailManga = applyNumber(detailManga)
        } catch {
            revertControls()
        }
    }

    async function setReadingDirection(manga: LibraryManga, raw: string) {
        const value = raw === "" ? null : (raw as "ltr" | "rtl" | "vertical")
        try {
            await sendRuntimeMessage({ type: "library:reading-prefs", mangaId: manga.id, readingDirection: value })
            const apply = (m: LibraryManga): LibraryManga => {
                const next = { ...m }
                if (value === null) delete next.readingDirection
                else next.readingDirection = value
                return next
            }
            library = library.map(m => (m.id === manga.id ? apply(m) : m))
            if (detailManga && detailManga.id === manga.id) detailManga = apply(detailManga)
        } catch {
            revertControls()
        }
    }

    async function setReadingPageFit(manga: LibraryManga, raw: string) {
        const value = raw === "" ? null : (raw as "width" | "height" | "contain" | "original" | "actual")
        try {
            await sendRuntimeMessage({ type: "library:reading-prefs", mangaId: manga.id, pageFit: value })
            const apply = (m: LibraryManga): LibraryManga => {
                const next = { ...m }
                if (value === null) delete next.pageFit
                else next.pageFit = value
                return next
            }
            library = library.map(m => (m.id === manga.id ? apply(m) : m))
            if (detailManga && detailManga.id === manga.id) detailManga = apply(detailManga)
        } catch {
            revertControls()
        }
    }

    async function setReadingPageWidth(manga: LibraryManga, raw: string) {
        const n = raw === "" ? null : Number(raw)
        const value = n === null || !Number.isFinite(n) ? null : Math.max(30, Math.min(100, Math.round(n)))
        try {
            await sendRuntimeMessage({ type: "library:reading-prefs", mangaId: manga.id, pageWidthPct: value })
            const apply = (m: LibraryManga): LibraryManga => {
                const next = { ...m }
                if (value === null) delete next.pageWidthPct
                else next.pageWidthPct = value
                return next
            }
            library = library.map(m => (m.id === manga.id ? apply(m) : m))
            if (detailManga && detailManga.id === manga.id) detailManga = apply(detailManga)
        } catch {
            revertControls()
        }
    }

    async function changeAutoAdd(enabled: boolean) {
        try {
            settings = await sendRuntimeMessage<AppSettings>({
                type: "settings:update",
                settings: { autoAdd: enabled }
            })
        } catch {
            if (settings) settings = { ...settings }
        }
    }

    async function updateSetting(patch: Partial<AppSettings>) {
        try {
            settings = await sendRuntimeMessage<AppSettings>({ type: "settings:update", settings: patch })
        } catch {
            if (settings) settings = { ...settings }
        }
    }

    async function addByUrl() {
        adding = true
        addMessage = ""
        try {
            const parsed = new URL(addUrl)
            const granted = await browser.permissions.request({ origins: sourceOrigins() })
            if (!granted) {
                addMessage = "Site access was not granted."
                return
            }
            const result = await sendRuntimeMessage<{ supported: boolean; added?: boolean }>({
                type: "page:capture",
                url: parsed.toString()
            })
            if (!result.supported) {
                addMessage = "This URL is not a supported chapter."
                return
            }
            addMessage = result.added ? "Added to your library." : "Automatic adding is disabled."
            addUrl = ""
            await load()
        } catch (cause) {
            addMessage = cause instanceof Error ? cause.message : "The URL could not be added."
        } finally {
            adding = false
        }
    }

    async function exportData() {
        dataMessage = ""
        try {
            const envelope = await sendRuntimeMessage<unknown>({ type: "data:export" })
            const pass = exportPassphrase.trim()
            const stamp = new Date().toISOString().slice(0, 10)
            let text: string
            let filename: string
            if (pass) {
                text = await encryptBackup(JSON.stringify(envelope), pass)
                filename = `amr-backup-${stamp}.amrenc.json`
            } else {
                text = JSON.stringify(envelope, null, 2)
                filename = `amr-backup-${stamp}.json`
            }
            const blob = new Blob([text], { type: "application/json" })
            const url = URL.createObjectURL(blob)
            const a = document.createElement("a")
            a.href = url
            a.download = filename
            a.click()
            URL.revokeObjectURL(url)
            exportPassphrase = ""
            dataMessage = pass ? "Encrypted backup exported." : "Backup exported."
        } catch (cause) {
            dataMessage = cause instanceof Error ? cause.message : "Backup export failed."
        }
    }

    async function exportLog() {
        dataMessage = ""
        try {
            const { text } = await sendRuntimeMessage<{ text: string }>({ type: "log:export" })
            const blob = new Blob([text], { type: "text/plain" })
            const url = URL.createObjectURL(blob)
            const a = document.createElement("a")
            a.href = url
            a.download = `amr-diagnostic-log-${new Date().toISOString().slice(0, 10)}.txt`
            a.click()
            URL.revokeObjectURL(url)
            dataMessage = "Diagnostic log exported."
        } catch (cause) {
            dataMessage = cause instanceof Error ? cause.message : "Log export failed."
        }
    }

    // An AMR encrypted backup is the self-describing backup-crypto envelope, distinct from a
    // plaintext export (which carries `format: "all-mangas-reader"` + `data`).
    function isEncryptedEnvelope(v: unknown): boolean {
        return (
            typeof v === "object" &&
            v !== null &&
            (v as { kdf?: unknown }).kdf === "PBKDF2" &&
            typeof (v as { ct?: unknown }).ct === "string"
        )
    }

    async function importData(file: File) {
        importConflicts = []
        importEnvelope = null
        importMigrationMeta = null
        importResolutions = {}
        dataMessage = ""
        importError = ""
        pendingEncryptedText = null
        importWorking = true
        try {
            const text = await file.text()
            let raw: unknown
            try {
                raw = JSON.parse(text)
            } catch {
                throw new Error("The backup could not be read.")
            }
            if (isEncryptedEnvelope(raw)) {
                // Hold the ciphertext and wait for the passphrase; don't touch the DB yet.
                pendingEncryptedText = text
                importWorking = false
                return
            }
            await processImport(raw)
        } catch (cause) {
            dataMessage = cause instanceof Error ? cause.message : "The backup could not be imported."
        } finally {
            importWorking = false
        }
    }

    async function decryptAndImport() {
        if (!pendingEncryptedText) return
        importError = ""
        importWorking = true
        try {
            const json = await decryptBackup(pendingEncryptedText, importPassphrase)
            let raw: unknown
            try {
                raw = JSON.parse(json)
            } catch {
                throw new Error("Decrypted data is not a valid backup.")
            }
            pendingEncryptedText = null
            importPassphrase = ""
            await processImport(raw)
        } catch (cause) {
            importError = cause instanceof Error ? cause.message : "Could not decrypt this backup."
        } finally {
            importWorking = false
        }
    }

    async function processImport(raw: unknown) {
        const { envelope, migrated, converted, skipped, needsAttention } = migrateLegacyImport(raw)
        const conflicts = await sendRuntimeMessage<ImportConflict[]>({
            type: "data:import:preview",
            envelope
        })
        importEnvelope = envelope
        importMigrationMeta = { migrated, converted, skipped, needsAttention }
        if (conflicts.length > 0) {
            importConflicts = conflicts
            importResolutions = Object.fromEntries(conflicts.map(c => [c.mangaId, "overwrite" as ImportResolution]))
        } else {
            await applyImport(envelope, {}, { migrated, converted, skipped, needsAttention })
        }
    }

    async function applyImport(
        envelope: unknown,
        resolutions: Record<string, ImportResolution>,
        meta: { migrated: boolean; converted: number; skipped: number; needsAttention: string[] }
    ) {
        const result = await sendRuntimeMessage<{ manga: number; chapters: number }>({
            type: "data:import",
            // envelope/resolutions can be $state proxies (importEnvelope/importResolutions) when
            // called from confirmImport() - extension messaging structurally clones the payload,
            // which throws on a Proxy ("Proxy object could not be cloned"). Snapshot to plain data.
            envelope: $state.snapshot(envelope),
            resolutions: $state.snapshot(resolutions)
        })
        importConflicts = []
        importEnvelope = null
        importMigrationMeta = null
        importResolutions = {}
        await load()
        if (meta.migrated) {
            reconcileIds = meta.needsAttention
            dataMessage =
                `Imported ${meta.converted} manga from old AMR backup.` +
                (meta.skipped > 0 ? ` ${meta.skipped} entries skipped (no title or URL).` : "") +
                (meta.needsAttention.length > 0
                    ? ` ${meta.needsAttention.length} titles need a live source - see below.`
                    : "")
            if (meta.needsAttention.length > 0) activeSection = "Data"
        } else {
            dataMessage = `Imported ${result.manga} manga and ${result.chapters} chapters.`
        }
        // Highest-intent moment to convert: they just showed they care about their list. Nudge a
        // free account for automatic cloud backup - only if they aren't already linked.
        if (!accountLinked) showImportBackupHint = true
        void backfillCovers()
    }

    async function confirmImport() {
        if (!importEnvelope || !importMigrationMeta) return
        importWorking = true
        importError = ""
        try {
            await applyImport(importEnvelope, importResolutions, importMigrationMeta)
        } catch (cause) {
            importError = cause instanceof Error ? cause.message : "Import failed."
        } finally {
            importWorking = false
        }
    }

    // --- Import from another reader (Mihon/Tachiyomi/...) ---
    type ReaderImportPreview = { total: number; withAniList: number; trackingOnly: number; withProgress: number }
    let readerImportFormat = $state<string>(IMPORT_FORMATS[0]?.id ?? "")
    let readerImportPreview = $state<ReaderImportPreview | null>(null)
    let readerImportB64 = $state<string | null>(null)
    let readerImportWorking = $state(false)
    let readerImportMessage = $state("")
    const readerImportAccept = $derived(IMPORT_FORMATS.find(f => f.id === readerImportFormat)?.accept ?? "")

    async function fileToBase64(file: File): Promise<string> {
        const bytes = new Uint8Array(await file.arrayBuffer())
        let binary = ""
        const CHUNK = 0x8000
        for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
        }
        return btoa(binary)
    }

    async function previewReaderImport(file: File) {
        readerImportPreview = null
        readerImportB64 = null
        readerImportMessage = ""
        readerImportWorking = true
        try {
            const dataB64 = await fileToBase64(file)
            const preview = await sendRuntimeMessage<ReaderImportPreview>({
                type: "import:reader",
                format: readerImportFormat,
                dataB64,
                preview: true
            })
            if (preview.total === 0) {
                readerImportMessage = "No titles found in that file. Is it the right backup and format?"
                return
            }
            readerImportB64 = dataB64
            readerImportPreview = preview
        } catch (cause) {
            readerImportMessage = cause instanceof Error ? cause.message : "That file could not be read."
        } finally {
            readerImportWorking = false
        }
    }

    async function confirmReaderImport() {
        if (!readerImportB64) return
        readerImportWorking = true
        try {
            const result = await sendRuntimeMessage<{ imported: number; skipped: number; total: number }>({
                type: "import:reader",
                format: readerImportFormat,
                dataB64: readerImportB64,
                preview: false
            })
            readerImportPreview = null
            readerImportB64 = null
            await load()
            const importedMsg = `Imported ${result.imported} titles${result.skipped > 0 ? ` (${result.skipped} already in your library)` : ""}.`
            readerImportMessage = importedMsg
            // High-intent moment (they just brought a whole library across) - nudge a free account
            // for automatic cloud backup, same as a normal import.
            if (!accountLinked) showImportBackupHint = true
            void backfillCovers()
            // Auto-resolve sources in the background: adopt a live reader source for the
            // tracking-only rows the import left behind, but only on a high-confidence
            // exact match (the handler enforces this). Best-effort - failures are silent,
            // the titles are already tracked either way. Refresh + note how many linked.
            void (async () => {
                try {
                    const auto = await sendRuntimeMessage<{ scanned: number; resolved: number }>({
                        type: "import:resolve"
                    })
                    if (auto.resolved > 0) {
                        await load()
                        readerImportMessage = `${importedMsg} Auto-linked ${auto.resolved} to a live source.`
                    }
                } catch {
                    // leave the plain imported message; the titles are still tracked
                }
            })()
        } catch (cause) {
            readerImportMessage = cause instanceof Error ? cause.message : "Import failed."
        } finally {
            readerImportWorking = false
        }
    }

    function cancelReaderImport() {
        readerImportPreview = null
        readerImportB64 = null
        readerImportMessage = ""
    }

    function cancelImport() {
        importConflicts = []
        importEnvelope = null
        importMigrationMeta = null
        importResolutions = {}
        importError = ""
    }

    function setAllResolutions(resolution: ImportResolution) {
        importResolutions = Object.fromEntries(importConflicts.map(c => [c.mangaId, resolution]))
    }

    async function checkForUpdates(sourceId?: string) {
        checkingUpdates = true
        try {
            // Fire-and-forget: a full library check can run for minutes, longer than an
            // MV3 message channel survives. The background handler starts the check and
            // acks immediately; progress/completion are picked up via the
            // browser.storage.onChanged listener registered in onMount.
            const ack = await sendRuntimeMessage<{ started: boolean; alreadyRunning?: boolean }>({
                type: "updates:check",
                ...(sourceId ? { sourceId } : {})
            })
            if (!ack.started) {
                // A check is already running (this popup's own alarm-triggered check, or
                // one started elsewhere) - leave checkingUpdates on, the storage listener
                // will clear it when that check completes.
                return
            }
        } catch (cause) {
            console.error("[AMR] Update check failed", cause)
            checkingUpdates = false
        }
    }

    const updateProgressPct = $derived(
        updateProgress && updateProgress.total > 0 ? Math.round((updateProgress.done / updateProgress.total) * 100) : 0
    )

    const librarySources = $derived([...new Set(library.filter(m => !isSeedData(m)).map(m => m.sourceId))].sort())

    const sourceTitleCounts = $derived.by(() => {
        const counts = new Map<string, number>()
        for (const m of library) {
            if (isSeedData(m)) continue
            counts.set(m.sourceId, (counts.get(m.sourceId) ?? 0) + 1)
        }
        return counts
    })

    async function checkForExtensionUpdate() {
        checkingExtUpdate = true
        try {
            const result = await sendRuntimeMessage<typeof extensionUpdate>({
                type: "extension-update:check",
                force: true
            })
            extensionUpdate = result
            updateBannerDismissed = false
        } catch (cause) {
            console.error("[AMR] Extension update check failed", cause)
        } finally {
            checkingExtUpdate = false
        }
    }

    async function changeUpdateInterval(value: string) {
        const next = Number(value) as 0 | 6 | 12 | 24
        // Update the local selection synchronously, before the await, so the <select>
        // never appears to reset/go blank while the round trip is in flight.
        updateIntervalSelection = next
        settings = await sendRuntimeMessage<AppSettings>({
            type: "settings:update",
            settings: { updateIntervalHours: next }
        })
        updateIntervalSaved = true
        if (updateIntervalSavedTimer) clearTimeout(updateIntervalSavedTimer)
        updateIntervalSavedTimer = setTimeout(() => {
            updateIntervalSaved = false
        }, 1500)
    }

    async function changeNoGapContinuous(enabled: boolean) {
        noGapSelection = enabled
        settings = await sendRuntimeMessage<AppSettings>({
            type: "settings:update",
            settings: { noGapContinuous: enabled }
        })
        noGapSelectionSaved = true
        if (noGapSelectionSavedTimer) clearTimeout(noGapSelectionSavedTimer)
        noGapSelectionSavedTimer = setTimeout(() => {
            noGapSelectionSaved = false
        }, 1500)
    }

    async function changeAutoPauseDays(raw: string) {
        const next = Math.max(0, Math.floor(Number(raw) || 0))
        autoPauseDays = next
        await updateSetting({ autoPauseDays: next })
    }

    async function seedData() {
        try {
            await sendRuntimeMessage({ type: "data:seed" })
            await load()
            dataMessage = "Sample data loaded."
        } catch (cause) {
            dataMessage = cause instanceof Error ? cause.message : "Failed to load samples."
        }
    }

    async function grantPermission() {
        hasPermission = await browser.permissions.request({ origins: sourceOrigins() })
    }

    // Only one search-stream port should ever be in flight - a new search (typed or
    // submitted) disconnects whatever the previous one started so rapid typing doesn't
    // pile up concurrent streaming searches.
    let searchPort: ReturnType<typeof browser.runtime.connect> | null = null
    let searchDebounceHandle: ReturnType<typeof setTimeout> | null = null
    const SEARCH_DEBOUNCE_MS = 450
    const SEARCH_MIN_LENGTH = 3

    function doSearch() {
        if (!browseQuery.trim()) return
        if (searchDebounceHandle) {
            clearTimeout(searchDebounceHandle)
            searchDebounceHandle = null
        }
        if (searchPort) {
            searchPort.disconnect()
            searchPort = null
        }
        searchLoading = true
        searchResults = []
        hasSearched = true
        searchAddMessage = ""
        autoExpandSourceId = null
        searchTotal = 0
        searchSettled = 0
        expandedSourceGroups = new Set()
        selectedManga = null

        const port = browser.runtime.connect({ name: "search-stream" })
        searchPort = port
        const query = browseQuery.trim()

        port.onMessage.addListener(
            (msg: { type: string; total?: number; results?: SearchResult[]; sourceId?: string }) => {
                if (msg.type === "start") {
                    searchTotal = msg.total ?? 0
                } else if (msg.type === "partial" && msg.results) {
                    searchResults = [...searchResults, ...msg.results]
                    // Pin the first source that returns results as the auto-expanded group, so
                    // the ungrouped view doesn't re-pick "first" (and collapse what the user is
                    // reading) every time searchBySource re-sorts by count on a later partial.
                    if (autoExpandSourceId === null && msg.results[0]) autoExpandSourceId = msg.results[0].sourceId
                } else if (msg.type === "settled") {
                    // One source finished (matched, empty, timed out, or errored). Count
                    // settlements, not partials, so "X/Y sources" reflects true progress.
                    searchSettled++
                } else if (msg.type === "done") {
                    searchLoading = false
                    port.disconnect()
                    if (searchPort === port) searchPort = null
                    // Suggestion search found nothing under this title - try the next variant
                    // (english/romaji/synonym) so a romaji-only Korean/Chinese title still resolves.
                    if (searchResults.length === 0 && suggestionSearchQueue.length > 0) {
                        const next = suggestionSearchQueue.shift()
                        if (next) {
                            browseQuery = next
                            doSearch()
                        }
                    }
                }
            }
        )

        port.onDisconnect.addListener(() => {
            searchLoading = false
            if (searchPort === port) searchPort = null
        })

        port.postMessage({ type: "manga:search", query })
    }

    // Close the search popover and return to the normal Discover page: stop any in-flight
    // search, drop the query and every result, so nothing lingers underneath the suggestions.
    function clearSearch() {
        if (searchDebounceHandle) {
            clearTimeout(searchDebounceHandle)
            searchDebounceHandle = null
        }
        if (searchPort) {
            searchPort.disconnect()
            searchPort = null
        }
        browseQuery = ""
        searchResults = []
        searchLoading = false
        hasSearched = false
        suggestionSearchQueue = []
        searchTotal = 0
        searchSettled = 0
        selectedManga = null
        mangaChapters = []
        searchAddMessage = ""
        autoExpandSourceId = null
        expandedSourceGroups = new Set()
    }

    // Jump from the Library filter to a full source search for the same term: switch to
    // Discover, seed the query, and run it so the results popover opens. Lets the Library
    // filter double as "find something new" when a title isn't in the list yet.
    function searchSourcesFor(term: string) {
        const q = term.trim()
        if (!q) return
        activeSection = "Discover"
        browseQuery = q
        doSearch()
    }

    // Debounced type-to-search: fires ~450ms after the user stops typing, once the
    // query is at least 3 characters. Enter/submit (doSearch called directly) always
    // fires immediately regardless of this timer or the minimum length. Emptying the
    // field closes the popover straight away rather than leaving stale results behind.
    function scheduleAutoSearch() {
        if (searchDebounceHandle) clearTimeout(searchDebounceHandle)
        // The user is typing their own query - drop any suggestion fallback chain so we don't
        // hijack their search by retrying a suggestion's alternate titles.
        suggestionSearchQueue = []
        if (browseQuery.trim().length === 0) {
            clearSearch()
            return
        }
        searchDebounceHandle = setTimeout(() => {
            searchDebounceHandle = null
            if (browseQuery.trim().length >= SEARCH_MIN_LENGTH) doSearch()
        }, SEARCH_DEBOUNCE_MS)
    }

    // Generation guard (mirrors refreshGeneration): two chapter-list loads can be in flight
    // at once (the user opens result Y while X's slow load is pending). Without this, X's late
    // response would land into mangaChapters while selectedManga still shows Y - the header and
    // the chapter list would disagree, and "Read" would open the wrong series' chapter.
    let openResultSeq = 0
    // MangaDex can list chapters; other sources open the manga page directly.
    async function openResult(result: SearchResult) {
        if (result.sourceId !== "mangadex") {
            openExternal(result.url)
            return
        }
        const seq = ++openResultSeq
        selectedManga = { title: result.title }
        chaptersLoading = true
        mangaChapters = []
        try {
            const chapters = await sendRuntimeMessage<typeof mangaChapters>({
                type: "manga:chapters",
                mangaId: result.sourceMangaId
            })
            if (seq !== openResultSeq) return // a newer openResult superseded this one
            mangaChapters = chapters
        } catch {
            if (seq === openResultSeq) mangaChapters = []
        } finally {
            if (seq === openResultSeq) chaptersLoading = false
        }
    }

    async function readChapter(chapterUrl: string) {
        void browser.tabs.create({
            url: browser.runtime.getURL(`/reader.html?url=${encodeURIComponent(chapterUrl)}`)
        })
    }

    let addingResultKey = $state<string | null>(null)
    let searchAddMessage = $state("")
    // The "Added to your library." (and error) notice clears itself after 10s so it doesn't
    // sit on screen indefinitely. Re-arms on each new message; cleared if the message is reset.
    $effect(() => {
        if (!searchAddMessage) return
        const t = setTimeout(() => (searchAddMessage = ""), 10000)
        return () => clearTimeout(t)
    })

    function resultKey(result: SearchResult): string {
        return `${result.sourceId}:${result.sourceMangaId}`
    }

    function resultInLibrary(result: SearchResult): boolean {
        const id = `${result.sourceId}:manga:${result.sourceMangaId}`
        return library.some(m => m.id === id)
    }

    // Primary click on a search result adds the series in an unread state instead of
    // leaving the app. library:add takes the result's own series-level fields and works
    // for EVERY source (unlike the old page:capture path, which needed a capturable
    // chapter URL a search result never carries, so non-MangaDex sources fell back to
    // "open on site"). Dedupe is handled up front by the stable library id and again in
    // the handler, which reports added:false for a title already present.
    async function addResult(result: SearchResult) {
        if (resultInLibrary(result)) {
            searchAddMessage = `${result.title} is already in your library.`
            return
        }
        addingResultKey = resultKey(result)
        searchAddMessage = ""
        try {
            const granted = await browser.permissions.request({ origins: sourceOrigins() })
            if (!granted) {
                searchAddMessage = "Site access was not granted."
                return
            }
            const added = await sendRuntimeMessage<{ added: boolean; mangaId: string }>({
                type: "library:add",
                sourceId: result.sourceId,
                sourceMangaId: result.sourceMangaId,
                mangaUrl: result.url,
                title: result.title,
                ...(result.coverUrl ? { coverUrl: result.coverUrl } : {})
            })
            if (added.added) {
                searchAddMessage = "Added to your library."
                await load()
            } else {
                searchAddMessage = `${result.title} is already in your library.`
            }
        } catch (cause) {
            searchAddMessage = cause instanceof Error ? cause.message : "This title could not be added."
        } finally {
            addingResultKey = null
        }
    }

    // Ctrl/Cmd-click keeps the old behavior (open on the source site / MangaDex chapter
    // list) so that route isn't lost now that a plain click adds to the library.
    function activateResult(event: MouseEvent, result: SearchResult) {
        if (event.ctrlKey || event.metaKey) {
            void openResult(result)
            return
        }
        void addResult(result)
    }

    // Middle-click opens on the source site without adding.
    function auxActivateResult(event: MouseEvent, result: SearchResult) {
        if (event.button === 1) {
            event.preventDefault()
            void openResult(result)
        }
    }

    const allCategories = $derived(
        [...new Set(library.flatMap(m => m.categories ?? []))].sort((a, b) => a.localeCompare(b))
    )

    // Genres come from the source (backfilled per-title), unlike tags which are user-created.
    const allGenres = $derived([...new Set(library.flatMap(m => m.genres ?? []))].sort((a, b) => a.localeCompare(b)))

    // Tag organisation: counts per tag, plus rename/delete across the whole library.
    const tagCounts = $derived.by(() => {
        const counts = new Map<string, number>()
        for (const m of library) for (const tag of m.categories ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1)
        return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    })
    let tagBusy = $state(false)
    async function renameTag(oldTag: string, rawNew: string) {
        const newTag = rawNew.trim()
        if (!newTag || newTag === oldTag) return
        tagBusy = true
        try {
            for (const m of library.filter(x => (x.categories ?? []).includes(oldTag))) {
                await commitCategories(
                    m,
                    (m.categories ?? []).map(t => (t === oldTag ? newTag : t))
                )
            }
            // A tag currently used as the active filter no longer matches anything once
            // renamed away - follow the rename so the view doesn't silently go empty.
            if (categoryFilter === oldTag) categoryFilter = newTag
        } finally {
            tagBusy = false
        }
    }
    async function deleteTag(tag: string) {
        tagBusy = true
        try {
            for (const m of library.filter(x => (x.categories ?? []).includes(tag))) await removeTag(m, tag)
            // Same reasoning as renameTag - a deleted tag can't stay the active filter,
            // or the library view is stuck on "no titles match" with no way to clear it
            // (the category dropdown itself disappears once no tags remain).
            if (categoryFilter === tag) categoryFilter = ""
        } finally {
            tagBusy = false
        }
    }
    function filterByTag(tag: string) {
        categoryFilter = tag
        activeSection = "Library"
    }

    // The status-chip predicate for a given filter value, independent of the active chip and of
    // the search/tag/advanced filters - so it can drive both the current filter and the per-chip
    // counts shown next to each status.
    function matchesStatus(m: LibraryManga, f: string): boolean {
        if (f === "all") return true
        if (f === "manual") return Boolean(m.manualTracking)
        const effective = effectiveReadingStatus(m, { autoPauseDays, now: Date.now() })
        if (f === "updates") {
            return hasUpdates(m) && effective !== "on-hold" && effective !== "dropped" && effective !== "completed"
        }
        if (f === "ongoing") return isOngoing(effective)
        // "unread" | "reading" | "completed" | "on-hold" | "dropped" map 1:1 to the effective status.
        return effective === f
    }

    function matchesFilter(m: LibraryManga): boolean {
        if (sourceFilter && m.sourceId !== sourceFilter) return false
        if (ratingFilter > 0 && (m.rating ?? 0) < ratingFilter) return false
        if (updatedSinceFilter > 0 && m.updatedAt < Date.now() - updatedSinceFilter * 86_400_000) return false
        return matchesStatus(m, libraryFilter)
    }

    const advancedFilterCount = $derived(
        (sourceFilter ? 1 : 0) + (ratingFilter > 0 ? 1 : 0) + (updatedSinceFilter > 0 ? 1 : 0)
    )

    function clearAdvancedFilters() {
        sourceFilter = ""
        ratingFilter = 0
        updatedSinceFilter = 0
        categoryFilter = ""
        genreFilter = ""
    }

    const visibleLibrary = $derived.by(() => {
        const q = query.trim().toLowerCase()
        const filtered = library.filter(
            m =>
                m.normalizedTitle.includes(q) &&
                (!categoryFilter || (m.categories ?? []).includes(categoryFilter)) &&
                (!genreFilter || (m.genres ?? []).includes(genreFilter)) &&
                matchesFilter(m)
        )
        const sorted = [...filtered]
        switch (librarySort) {
            case "updates-first":
                // Titles with a new/unread chapter first, then by freshest update - the default,
                // so what needs reading floats to the top.
                sorted.sort(
                    (a, b) =>
                        Number(hasNewerChapters(b)) - Number(hasNewerChapters(a)) ||
                        (b.latestChapterAt ?? b.updatedAt) - (a.latestChapterAt ?? a.updatedAt)
                )
                break
            case "recent-read":
                sorted.sort((a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0) || b.updatedAt - a.updatedAt)
                break
            case "recent-added":
                sorted.sort((a, b) => b.addedAt - a.addedAt)
                break
            case "title":
                sorted.sort((a, b) => a.title.localeCompare(b.title))
                break
            case "latest-chapter":
                sorted.sort((a, b) => (b.latestChapterNumber ?? 0) - (a.latestChapterNumber ?? 0))
                break
            case "recently-updated":
                // Freshest new chapter first; fall back to updatedAt for titles not yet
                // re-checked since this field was added.
                sorted.sort((a, b) => (b.latestChapterAt ?? b.updatedAt) - (a.latestChapterAt ?? a.updatedAt))
                break
        }
        return sorted
    })

    // "Find better sources" scope: an explicit Select-mode selection when there is one,
    // otherwise the currently visible (filtered) library minus manually-tracked titles.
    const relinkScopeIds = $derived(
        selectedIds.size > 0 ? [...selectedIds] : visibleLibrary.filter(m => !m.manualTracking).map(m => m.id)
    )

    // Library view: grid (covers) or list (rows), with a user-set page size so
    // large libraries don't render everything at once.
    let libraryView = $state<"grid" | "list">("grid")
    // Collapsible "Tools" menu in the library toolbar (Manage tags / covers / Find sources / etc).
    let toolsOpen = $state(false)
    const missingCoverCount = $derived(
        library.filter(m => !isSeedData(m) && ((!coverSrcs[m.id] && !m.coverUrl) || failedCovers.has(m.id))).length
    )
    let libraryFilter = $state<
        "all" | "ongoing" | "updates" | "unread" | "reading" | "completed" | "dropped" | "manual" | "on-hold"
    >("ongoing")
    const LIBRARY_FILTERS = [
        "all",
        "ongoing",
        "updates",
        "unread",
        "reading",
        "completed",
        "on-hold",
        "dropped",
        "manual"
    ] as const
    // Per-chip counts shown next to each status. Counted over the library narrowed by the
    // search + tag/genre + advanced filters (but NOT the active status chip), so each number is
    // "how many you'd see if you clicked this chip".
    const statusCountBase = $derived.by(() => {
        const q = query.trim().toLowerCase()
        const now = Date.now()
        return library.filter(
            m =>
                m.normalizedTitle.includes(q) &&
                (!categoryFilter || (m.categories ?? []).includes(categoryFilter)) &&
                (!genreFilter || (m.genres ?? []).includes(genreFilter)) &&
                (!sourceFilter || m.sourceId === sourceFilter) &&
                (ratingFilter === 0 || (m.rating ?? 0) >= ratingFilter) &&
                (updatedSinceFilter === 0 || m.updatedAt >= now - updatedSinceFilter * 86_400_000)
        )
    })
    const statusCounts = $derived.by(() => {
        const counts: Record<string, number> = {}
        for (const f of LIBRARY_FILTERS) counts[f] = 0
        for (const m of statusCountBase) {
            for (const f of LIBRARY_FILTERS) if (matchesStatus(m, f)) counts[f] = (counts[f] ?? 0) + 1
        }
        return counts
    })
    let libraryPageSize = $state(50)
    let libraryLimit = $state(50)
    const pagedLibrary = $derived(visibleLibrary.slice(0, libraryLimit))
    const allVisibleSelected = $derived(pagedLibrary.length > 0 && pagedLibrary.every(m => selectedIds.has(m.id)))
    $effect(() => {
        // Reset paging whenever the FILTERED VIEW changes. Deliberately depends only on
        // the filter/search/sort inputs - not selectedIds - so selecting a title doesn't
        // collapse a "Load more" back to the first page.
        void query
        void categoryFilter
        void genreFilter
        void librarySort
        void libraryFilter
        void sourceFilter
        void ratingFilter
        void updatedSinceFilter
        libraryLimit = libraryPageSize
    })

    $effect(() => {
        // Drop any selected id the current page no longer renders. Without this, selecting
        // under one filter and then changing it left off-screen ids armed, and Remove
        // deleted titles that were nowhere on screen. Disarm the remove confirm ONLY when
        // this actually changed the selection - the view-derived reads here recompute a
        // fresh array on any unrelated background refresh (a capture/update elsewhere), so
        // disarming unconditionally would silently cancel an active confirm mid-window.
        // pruneSelectionToVisible returns a subset, so a size match means an exact match.
        if (selectedIds.size > 0) {
            const pruned = pruneSelectionToVisible(
                selectedIds,
                pagedLibrary.map(m => m.id)
            )
            if (pruned.size !== selectedIds.size) {
                selectedIds = pruned
                disarmBulkRemove()
            }
        }
    })

    // Per-row chapter navigation (resolved on demand from the source).
    let rowBusy = $state<string | null>(null)
    let rowMessage = $state<{ id: string; text: string } | null>(null)

    async function openAdjacent(manga: LibraryManga, which: "next" | "prev") {
        rowBusy = manga.id
        rowMessage = null
        try {
            const adj = await sendRuntimeMessage<{
                current: number | null
                next: { url: string; title: string; number: number } | null
                prev: { url: string; title: string; number: number } | null
            }>({ type: "chapter:adjacent", mangaId: manga.id })
            const target = which === "next" ? adj.next : adj.prev
            if (!target) {
                rowMessage = {
                    id: manga.id,
                    text: which === "next" ? "No next chapter found." : "No previous chapter."
                }
                return
            }
            if (settings?.openChapterIn === "browser") openExternal(target.url)
            else
                void browser.tabs.create({
                    url: browser.runtime.getURL(`/reader.html?url=${encodeURIComponent(target.url)}`)
                })
        } catch {
            rowMessage = { id: manga.id, text: "Could not resolve chapters." }
        } finally {
            rowBusy = null
        }
    }

    async function markCaughtUp(manga: LibraryManga) {
        const latest = manga.latestChapterNumber
        if (latest === undefined) return
        await sendRuntimeMessage({
            type: "library:numbers",
            mangaId: manga.id,
            lastReadChapterNumber: latest,
            ...(manga.latestChapterId ? { lastReadChapterId: manga.latestChapterId } : {})
        })
        library = library.map(m =>
            m.id === manga.id
                ? {
                      ...m,
                      lastReadChapterNumber: latest,
                      ...(manga.latestChapterId ? { lastReadChapterId: manga.latestChapterId } : {})
                  }
                : m
        )
    }

    const unreadPool = $derived(
        library.filter(m => {
            const status = effectiveReadingStatus(m, { autoPauseDays, now: Date.now() })
            return status !== "completed" && status !== "on-hold" && status !== "dropped"
        })
    )
    function surpriseMe() {
        const pool = unreadPool.length > 0 ? unreadPool : library
        if (pool.length === 0) return
        const pick = pool[Math.floor(Math.random() * pool.length)]
        // Surprise Me is a navigation action, not a card click - it should always
        // open the pick, even if select mode happens to be active.
        if (selectMode) clearSelection()
        if (pick) read(pick)
    }

    // Command palette (Ctrl/Cmd-K): jump to a tab or a library title.
    type PaletteItem =
        | { kind: "tab"; label: string; section: (typeof sections)[number] }
        | { kind: "manga"; label: string; manga: LibraryManga }
    let paletteOpen = $state(false)
    let paletteQuery = $state("")
    const paletteResults = $derived.by<PaletteItem[]>(() => {
        const q = paletteQuery.trim().toLowerCase()
        const tabs: PaletteItem[] = sections
            .filter(s => !q || s.toLowerCase().includes(q))
            .map(s => ({ kind: "tab", label: s, section: s }))
        if (!q) return tabs
        const titles: PaletteItem[] = library
            .filter(m => m.title.toLowerCase().includes(q))
            .slice(0, 8)
            .map(m => ({ kind: "manga", label: m.title, manga: m }))
        return [...tabs, ...titles]
    })
    function runPalette(item: PaletteItem) {
        if (item.kind === "tab") activeSection = item.section
        else {
            // The palette is a navigation shortcut - jumping to a title should always
            // open it, even if select mode happens to be active in the library view.
            if (selectMode) clearSelection()
            read(item.manga)
        }
        paletteOpen = false
    }
    function onGlobalKey(e: KeyboardEvent) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
            e.preventDefault()
            paletteOpen = !paletteOpen
            paletteQuery = ""
        } else if (e.key === "Escape" && paletteOpen) {
            paletteOpen = false
        }
    }
    function autofocus(node: HTMLInputElement) {
        node.focus()
    }

    // Per-manga freeform notes (saved from the detail overlay). $state, not a
    // writable $derived: a writable derived resets on ANY detailManga
    // reassignment, including a same-id reassignment from a live-triggered
    // refresh(), which would clobber in-progress typing. Reset only via the
    // previous-id-guard effect below, mirroring the genresForId pattern.
    let noteDraft = $state("")
    let noteDraftForId = $state<string | null>(null)
    $effect(() => {
        const id = detailManga?.id ?? null
        if (id === noteDraftForId) return
        noteDraftForId = id
        noteDraft = detailManga?.notes ?? ""
    })
    function applyNote<T extends { id: string; notes?: string }>(item: T, id: string, note: string): T {
        if (item.id !== id) return item
        const copy = { ...item }
        if (note) copy.notes = note
        else delete copy.notes
        return copy
    }

    async function saveNote(manga: LibraryManga) {
        const note = noteDraft.trim()
        await sendRuntimeMessage({ type: "library:note", mangaId: manga.id, note })
        library = library.map(m => applyNote(m, manga.id, note))
        if (detailManga && detailManga.id === manga.id) detailManga = applyNote(detailManga, manga.id, note)
    }

    // Reading-activity heatmap (Stats tab).
    let activity = $state<Array<{ date: string; count: number }>>([])
    let activityLoaded = $state(false)
    $effect(() => {
        if (activeSection === "Stats" && !activityLoaded) {
            activityLoaded = true
            void sendRuntimeMessage<Array<{ date: string; count: number }>>({ type: "activity:get" })
                .then(d => (activity = d))
                .catch(() => (activity = []))
        }
    })

    type AnalyticsSummary = {
        days: number
        captureOk: number
        captureErrors: number
        readerOpened: number
        onSiteTrack: number
        directResolves: number
        tabResolves: number
        readerRate: number
        errorRate: number
        topSources: Array<{ sourceId: string; count: number }>
        topErrors: Array<{ sourceId: string; count: number }>
        errorTypes: Array<{ type: string; count: number }>
        panelActions: Array<{ action: string; count: number }>
        topGenres: Array<{ genre: string; count: number }>
        topAuthors: Array<{ author: string; count: number }>
        statusBreakdown: Array<{ status: string; count: number }>
    }
    let analyticsSummary = $state<AnalyticsSummary | null>(null)
    let analyticsLoaded = $state(false)
    $effect(() => {
        if (activeSection === "Stats" && !analyticsLoaded) {
            analyticsLoaded = true
            void sendRuntimeMessage<AnalyticsSummary>({ type: "analytics:summary" })
                .then(d => (analyticsSummary = d))
                .catch(() => {})
        }
    })

    type CommunityProfile = {
        enabled: boolean
        username: string
        userId: string
        lastSyncAt: number
        communityRank: number | null
        recommendations: Array<{ title: string; sourceId: string }>
        newAchievements: string[]
        communityStats: {
            leaderboard: Array<{ rank: number; username: string; chaptersWeek: number }>
            trendingManga: Array<{ title: string; sourceId: string; count: number }>
            topGenres: Array<{ genre: string; count: number }>
            totalUsers: number
        } | null
        consentVersion: number
        consentAt: number
        declined: boolean
    }
    let communityProfile = $state<CommunityProfile | null>(null)
    let communityLoaded = $state(false)
    let communityUsernameInput = $state("")
    let communityRegisterError = $state("")
    let showPolicy = $state(false)
    let deleteDataConfirm = $state(false)
    let deleteDataWorking = $state(false)
    // The first-run consent card shows once: community features are configured (a base URL is
    // baked in), the user has never agreed to the current policy version, AND they have not
    // already tapped Disable. Dismissed for the session once acted on.
    let consentCardDismissed = $state(false)
    let consentExpand = $state(false)
    const showConsentCard = $derived(
        communityConfigured &&
            !consentCardDismissed &&
            communityProfile !== null &&
            !communityProfile.declined &&
            communityProfile.consentVersion < CONSENT_VERSION
    )
    $effect(() => {
        if ((activeSection === "Stats" || activeSection === "Settings") && !communityLoaded) {
            communityLoaded = true
            void sendRuntimeMessage<CommunityProfile>({ type: "community:status" })
                .then(p => (communityProfile = p))
                .catch(() => {})
        }
    })
    async function toggleCommunity(enabled: boolean) {
        communityProfile = await sendRuntimeMessage<CommunityProfile>({ type: "community:toggle", enabled })
    }
    // Consent card: Accept turns community on (the handler stamps the consent version and
    // auto-registers an anonymous username the user can rename in Settings).
    async function acceptConsent() {
        consentCardDismissed = true
        await toggleCommunity(true)
    }
    // Decline records the explicit choice so the card never nags again; nothing is sent.
    async function declineConsent() {
        consentCardDismissed = true
        communityProfile = await sendRuntimeMessage<CommunityProfile>({ type: "community:decline" })
    }
    async function deleteCommunityData() {
        deleteDataWorking = true
        try {
            communityProfile = await sendRuntimeMessage<CommunityProfile>({ type: "community:delete-data" })
            deleteDataConfirm = false
        } finally {
            deleteDataWorking = false
        }
    }

    // Suggestions tab. Content-based (AniList co-recommendations + local genre/author
    // overlap) computed in the background handler; community "readers also read" picks
    // arrive folded into the same list with a `community` marker. Empty/unreachable
    // AniList degrades to an empty state, never an error.
    let suggestions = $state<Suggestion[]>([])
    // Cold-start editor picks: shown only when the library is empty and there are no
    // recommendations yet. Clicking one runs a full source search so it can be added.
    const EDITOR_PICKS = [
        "One Piece",
        "Chainsaw Man",
        "Jujutsu Kaisen",
        "Solo Leveling",
        "Berserk",
        "Vinland Saga",
        "Frieren",
        "One Punch Man",
        "Vagabond",
        "Oshi no Ko"
    ]
    // anilistId of the suggestion whose "More" menu is open (null = none).
    let sugMenuFor = $state<number | null>(null)
    // anilist ids the user quick-added this session; filtered out of every suggestions fetch
    // so a stale cache can't re-surface a title they've already logged.
    const quickAddedIds = new Set<number>()
    // Transient confirmation after a quick-add (mark-read / plan-to-read). An optional
    // action (label + handler) renders as a button in the toast, used for "Undo" after
    // hiding a suggestion.
    let sugToast = $state("")
    let sugToastAction = $state<{ label: string; run: () => void } | null>(null)
    let sugToastTimer: ReturnType<typeof setTimeout> | undefined
    function showSugToast(msg: string, action: { label: string; run: () => void } | null = null) {
        sugToast = msg
        sugToastAction = action
        clearTimeout(sugToastTimer)
        sugToastTimer = setTimeout(
            () => {
                sugToast = ""
                sugToastAction = null
            },
            action ? 6000 : 2800
        )
    }
    let suggestionsRequestedForVisit = $state(false)
    let suggestionsLoading = $state(false)
    let suggestionsFailed = $state(false)
    // "Continue the series": sequels of read titles the user doesn't own. Loaded once per
    // Discover visit alongside the main suggestions; filtered of anything just quick-added.
    let nextInSeries = $state<Suggestion[]>([])
    const visibleNextInSeries = $derived(nextInSeries.filter(s => !quickAddedIds.has(s.anilistId)))
    // "Trending in the community": most-read titles across all opted-in users (public
    // aggregate). Owned titles are filtered out so it stays a discovery rail.
    let trending = $state<{ title: string; sourceId: string; count: number }[]>([])
    const visibleTrending = $derived.by(() => {
        const owned = new Set(library.map(m => m.title.trim().toLocaleLowerCase("en")))
        return trending.filter(t => !owned.has(t.title.trim().toLocaleLowerCase("en"))).slice(0, 15)
    })
    const communitySuggestions = $derived(suggestions.filter(s => s.community))
    // Suggestions-tab filters. Genre keys are lowercased; a suggestion must carry ALL
    // selected genres (AND narrowing). Community-only keeps just the "readers also read"
    // picks. Sort re-orders the already score-ranked list.
    let sugQuery = $state("")
    let sugGenres = $state<string[]>([])
    let sugCommunityOnly = $state(false)
    let sugSort = $state<"score" | "frequency" | "title">("score")
    const sugFiltersActive = $derived(sugQuery.trim() !== "" || sugGenres.length > 0 || sugCommunityOnly)
    // Distinct genres present across the current suggestions, most-common first, keeping the
    // first-seen casing for display. Drives the filter chip row.
    const suggestionGenreOptions = $derived.by(() => {
        const counts = new Map<string, { name: string; count: number }>()
        for (const s of suggestions) {
            const seen = new Set<string>()
            for (const g of s.genres ?? []) {
                const key = g.toLocaleLowerCase("en")
                if (seen.has(key)) continue
                seen.add(key)
                const e = counts.get(key)
                if (e) e.count += 1
                else counts.set(key, { name: g, count: 1 })
            }
        }
        return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    })
    const filteredSuggestions = $derived.by(() => {
        const q = sugQuery.trim().toLocaleLowerCase("en")
        const need = sugGenres
        const out = suggestions.filter(s => {
            if (sugCommunityOnly && !s.community) return false
            if (q && !s.title.toLocaleLowerCase("en").includes(q)) return false
            if (need.length > 0) {
                const have = new Set((s.genres ?? []).map(g => g.toLocaleLowerCase("en")))
                for (const g of need) if (!have.has(g)) return false
            }
            return true
        })
        // `suggestions` arrives already score-sorted; only re-sort for the other modes.
        if (sugSort === "frequency")
            out.sort((a, b) => b.frequency - a.frequency || b.score - a.score || a.title.localeCompare(b.title))
        else if (sugSort === "title") out.sort((a, b) => a.title.localeCompare(b.title))
        return out
    })
    function toggleSugGenre(key: string) {
        sugGenres = sugGenres.includes(key) ? sugGenres.filter(g => g !== key) : [...sugGenres, key]
        suggestionsShown = SUGGESTIONS_PAGE
    }
    function clearSugFilters() {
        sugQuery = ""
        sugGenres = []
        sugCommunityOnly = false
        suggestionsShown = SUGGESTIONS_PAGE
    }
    // The cached handler hands back up to ~60 items at once; rendering every card (and
    // firing every cover fetch) up front makes the tab feel slow. Grow a visible slice
    // instead, one page at a time as the user scrolls to the end.
    const SUGGESTIONS_PAGE = 12
    let suggestionsShown = $state(SUGGESTIONS_PAGE)
    let suggestionsSentinel = $state<HTMLElement>()
    async function loadSuggestions(force: boolean) {
        suggestionsLoading = true
        suggestionsFailed = false
        suggestionsShown = SUGGESTIONS_PAGE
        try {
            const fetched = await sendRuntimeMessage<Suggestion[]>({
                type: "suggestions:get",
                ...(force ? { force: true } : {})
            })
            // Keep just-added titles out even if the (stale-while-revalidate) cache still
            // carries them - the user logged them as read/planning, so they must not reappear.
            suggestions = fetched.filter(s => !quickAddedIds.has(s.anilistId))
            suggestionsFailed = false
        } catch {
            // A failed refresh (AniList unreachable / rate-limited) must NOT blank the page -
            // keep whatever we already have. The empty-state error only shows on a genuine
            // cold start (no suggestions at all). A manual Refresh gets a toast so the user
            // knows it didn't take.
            suggestionsFailed = true
            if (force && suggestions.length > 0) showSugToast("Couldn't refresh right now - showing your last picks")
        } finally {
            suggestionsLoading = false
        }
    }
    async function loadNextInSeries() {
        try {
            nextInSeries = await sendRuntimeMessage<Suggestion[]>({ type: "suggestions:continue" })
        } catch {
            // A failed load just means no rail this visit - never blocks the rest of Discover.
        }
    }
    async function loadTrending() {
        try {
            trending = await sendRuntimeMessage<{ title: string; sourceId: string; count: number }[]>({
                type: "community:trending"
            })
        } catch {
            // Community offline / not configured - just no trending rail this visit.
        }
    }
    $effect(() => {
        // One load attempt per visit to the tab: the flag guards against re-firing while
        // we stay on the tab, and resets when we leave, so a failed first load retries on
        // the next visit (and a success revalidates cheaply via the cached handler).
        if (activeSection === "Discover") {
            if (!suggestionsRequestedForVisit) {
                suggestionsRequestedForVisit = true
                void loadSuggestions(false)
                void loadNextInSeries()
                void loadTrending()
            }
        } else {
            suggestionsRequestedForVisit = false
            // Leaving Discover clears any "More like X" focus so returning shows the full
            // page, not a stale focused view from a "Find similar" click.
            discoverFocus = null
        }
    })
    $effect(() => {
        // Reveal the next page when the end-of-list sentinel scrolls into view. The effect
        // re-runs whenever the sentinel is (re)mounted; once every item is shown the
        // sentinel is removed from the DOM and this cleanup tears the observer down.
        const el = suggestionsSentinel
        if (!el) return
        const observer = new IntersectionObserver(entries => {
            if (entries.some(e => e.isIntersecting) && suggestionsShown < restSuggestionsCount) {
                suggestionsShown = Math.min(suggestionsShown + SUGGESTIONS_PAGE, restSuggestionsCount)
            }
        })
        observer.observe(el)
        return () => observer.disconnect()
    })
    // Send the user to the global search prefilled with a suggestion's title so they can
    // add it from whichever mirror carries it.
    // Remaining fallback titles for the active suggestion search. A suggestion's AniList title
    // (often romaji for a Korean/Chinese series) frequently doesn't match how scanlation sites
    // index it, so we try english/romaji/synonyms in turn until a search returns results.
    let suggestionSearchQueue: string[] = []
    function findSuggestion(title: string, searchTitles?: string[]) {
        const list = (searchTitles && searchTitles.length > 0 ? searchTitles : [title])
            .map(t => t.trim())
            .filter(Boolean)
        const uniq = [...new Set(list)]
        activeSection = "Discover"
        suggestionSearchQueue = uniq.slice(1)
        browseQuery = uniq[0] ?? title
        doSearch()
    }
    // Quick-add a suggestion to the library as already-read/completed or plan-to-read, without
    // needing a source. Removes it from the on-screen list (now owned) and refreshes the
    // suggestions so the recommendation engine reweights against the updated taste profile.
    async function quickAddSuggestion(s: Suggestion, mode: "read" | "planning") {
        sugMenuFor = null
        try {
            const res = await sendRuntimeMessage<{ added: boolean }>({
                type: "library:quick-add",
                anilistId: s.anilistId,
                title: s.title,
                ...(s.coverUrl ? { coverUrl: s.coverUrl } : {}),
                // s.genres is a Svelte $state proxy array; spread to a plain array so
                // runtime.sendMessage can structured-clone it ("Proxy could not be cloned").
                ...(s.genres ? { genres: [...s.genres] } : {}),
                mode
            })
            const label = mode === "read" ? "already read" : "plan-to-read"
            showSugToast(res.added ? `Added “${s.title}” to ${label}` : `“${s.title}” is already in your library`)
            quickAddedIds.add(s.anilistId)
            suggestions = suggestions.filter(x => x.anilistId !== s.anilistId)
            void loadSuggestions(true)
        } catch (cause) {
            showSugToast(`Add failed: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
    }
    // "Not interested": hide a suggestion so the engine never surfaces it again. Remove it
    // from the on-screen list immediately and offer an Undo - a mis-click shouldn't cost the
    // pick permanently. Undo re-shows it on the next refresh.
    async function hideSuggestion(s: Suggestion) {
        sugMenuFor = null
        suggestions = suggestions.filter(x => x.anilistId !== s.anilistId)
        try {
            await sendRuntimeMessage<{ hidden: number }>({ type: "suggestions:hide", anilistId: s.anilistId })
            showSugToast(`Hidden “${s.title}”`, {
                label: "Undo",
                run: () => {
                    void sendRuntimeMessage({ type: "suggestions:unhide", anilistId: s.anilistId })
                        .then(() => loadSuggestions(false))
                        .catch(() => {})
                }
            })
        } catch (cause) {
            showSugToast(`Couldn't hide: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
    }
    // Flip the "mix it up" ordering and re-render from the (cheap, cached) handler so the
    // change is visible immediately without a fresh AniList fetch.
    async function toggleDiversify() {
        await updateSetting({ discoverDiversify: !(settings?.discoverDiversify ?? true) })
        void loadSuggestions(false)
    }
    function suggestionWhy(s: Suggestion): string {
        if (s.reasons.length > 0) return `Recommended because you read ${s.reasons.slice(0, 2).join(", ")}`
        if (s.genres && s.genres.length > 0) return `Matches genres you read: ${s.genres.slice(0, 2).join(", ")}`
        return "Recommended for you"
    }
    // Library-derived genre profile for the Stats tab and the Suggestions podium. Each
    // title contributes once per distinct genre (case-insensitive); the first-seen casing
    // is kept for display, and up to three owning titles are collected as examples.
    const genreBreakdown = $derived.by(() => {
        const counts = new Map<string, { name: string; count: number; titles: string[] }>()
        for (const m of library) {
            const seen = new Set<string>()
            for (const genre of m.genres ?? []) {
                const key = genre.toLocaleLowerCase("en")
                if (seen.has(key)) continue
                seen.add(key)
                const entry = counts.get(key)
                if (entry) {
                    entry.count += 1
                    if (entry.titles.length < 3) entry.titles.push(m.title)
                } else {
                    counts.set(key, { name: genre, count: 1, titles: [m.title] })
                }
            }
        }
        return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    })
    // The user's strongest genres, used to highlight matched-genre chips on the podium.
    const topGenreKeys = $derived(new Set(genreBreakdown.slice(0, 10).map(g => g.name.toLocaleLowerCase("en"))))
    function matchedGenres(s: Suggestion): string[] {
        if (!s.genres) return []
        return s.genres.filter(g => topGenreKeys.has(g.toLocaleLowerCase("en"))).slice(0, 3)
    }
    // Suggestions past the top-3 podium feed the paginated grid; keep its lazy-load slice
    // counting against this so the podium picks are never duplicated below. Based on the
    // filtered list so paging respects the active filters.
    const restSuggestionsCount = $derived(Math.max(0, filteredSuggestions.length - 3))

    // --- Discover rails (all derived from the already-fetched `suggestions`, no new network) ---
    // "Because you read X": group suggestions by the owned titles that led to them (a
    // Suggestion carries the owned titles in `reasons`). One rail per owned title with
    // enough picks, strongest first.
    const becauseYouReadRails = $derived.by(() => {
        const byTitle = new Map<string, Suggestion[]>()
        for (const s of suggestions) {
            for (const reason of s.reasons) {
                const arr = byTitle.get(reason) ?? []
                if (arr.length < 24) arr.push(s)
                byTitle.set(reason, arr)
            }
        }
        return [...byTitle.entries()]
            .filter(([, items]) => items.length >= 3)
            .sort((a, b) => b[1].length - a[1].length)
            .slice(0, 6)
            .map(([title, items]) => ({ title, items: items.slice(0, 15) }))
    })
    // "More <genre>": one rail per the user's strongest genres, filled from suggestions
    // carrying that genre. Skipped when a genre has too few picks to be worth a row.
    const byGenreRails = $derived.by(() => {
        const rails: { genre: string; items: Suggestion[] }[] = []
        for (const g of genreBreakdown) {
            const key = g.name.toLocaleLowerCase("en")
            const items = suggestions.filter(s => (s.genres ?? []).some(x => x.toLocaleLowerCase("en") === key))
            if (items.length >= 4) rails.push({ genre: g.name, items: items.slice(0, 15) })
            if (rails.length >= 5) break
        }
        return rails
    })
    // "Hidden gems": highly rated on AniList but not widely read. Filter to well-scored picks
    // that carry a popularity figure, then surface the LEAST popular of them - a great title
    // most people haven't found. Needs a few to be worth a rail of its own.
    const hiddenGems = $derived.by(() => {
        const scored = suggestions.filter(s => (s.averageScore ?? 0) >= 75 && typeof s.popularity === "number")
        if (scored.length < 4) return []
        return [...scored]
            .sort(
                (a, b) =>
                    (a.popularity as number) - (b.popularity as number) || (b.averageScore ?? 0) - (a.averageScore ?? 0)
            )
            .slice(0, 15)
    })
    // Focus mode: "Find similar" on a library title opens Discover scoped to that title's
    // picks (the suggestions whose `reasons` cite it). Null = the full Discover page.
    let discoverFocus = $state<string | null>(null)
    const focusedSuggestions = $derived(
        discoverFocus ? suggestions.filter(s => s.reasons.includes(discoverFocus as string)) : []
    )
    function discoverSimilarTo(title: string) {
        discoverFocus = title
        activeSection = "Discover"
        suggestionsShown = SUGGESTIONS_PAGE
        if (!suggestionsRequestedForVisit && suggestions.length === 0) void loadSuggestions(false)
    }
    function clearDiscoverFocus() {
        discoverFocus = null
    }
    async function executeClear(scope: "history" | "all") {
        clearWorking = true
        try {
            await sendRuntimeMessage({ type: scope === "all" ? "library:clear" : "library:clear-history" })
            if (scope === "all") {
                library = []
            }
            clearConfirm = ""
        } finally {
            clearWorking = false
        }
    }

    async function reloadCommunityProfile() {
        communityProfile = await sendRuntimeMessage<CommunityProfile>({ type: "community:status" }).catch(
            () => communityProfile
        )
    }

    let communitySyncing = $state(false)
    async function syncNow() {
        communitySyncing = true
        try {
            await sendRuntimeMessage({ type: "community:sync" })
            await reloadCommunityProfile()
        } catch {
        } finally {
            communitySyncing = false
        }
    }

    async function registerCommunity() {
        const name = communityUsernameInput.trim()
        if (!name) return
        communityRegisterError = ""
        try {
            communityProfile = await sendRuntimeMessage<CommunityProfile>({
                type: "community:register",
                username: name
            })
            communityUsernameInput = ""
            // Sync fires immediately on registration; re-fetch after a short delay to pick up stats
            setTimeout(() => void reloadCommunityProfile(), 4000)
        } catch (e) {
            communityRegisterError = e instanceof Error ? e.message : "Registration failed"
        }
    }

    const UPDATES_INITIAL = 50
    let updatesLimit = $state(UPDATES_INITIAL)
    const updatedManga = $derived(library.filter(m => !isSeedData(m) && hasUpdates(m)))
    const pagedUpdates = $derived(updatedManga.slice(0, updatesLimit))
    let expandedUpdates = $state(new Set<string>())
    let updatesNewChapters = $state<Record<string, Array<{ id: string; title: string; sortKey: number; url: string }>>>(
        {}
    )

    async function loadNewChapters(mangaId: string) {
        if (updatesNewChapters[mangaId]) return
        try {
            const chapters = await sendRuntimeMessage<
                Array<{ id: string; title: string; sortKey: number; url: string }>
            >({
                type: "updates:new-chapters",
                mangaId
            })
            updatesNewChapters[mangaId] = chapters
        } catch {
            updatesNewChapters[mangaId] = []
        }
    }

    function toggleUpdate(mangaId: string) {
        const next = new Set(expandedUpdates)
        if (next.has(mangaId)) {
            next.delete(mangaId)
            // Clear cached chapters so re-opening always fetches fresh data
            const { [mangaId]: _dropped, ...rest } = updatesNewChapters
            updatesNewChapters = rest
        } else {
            next.add(mangaId)
            void loadNewChapters(mangaId)
        }
        expandedUpdates = next
    }

    // Search results grouped by source, with display name + homepage from the registry.
    const sourceMeta = $derived(new Map(sourcesList.map(s => [s.id, s])))
    const searchBySource = $derived.by(() => {
        const groups = new Map<string, SearchResult[]>()
        for (const r of searchResults) {
            const arr = groups.get(r.sourceId) ?? []
            arr.push(r)
            groups.set(r.sourceId, arr)
        }
        return [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
    })
    // Cross-mirror "works" view: pure grouping by AniList id when present, else by a
    // normalized title key. No network - safe with every server off.
    const searchWorks = $derived(groupSearchResultsIntoWorks(searchResults))
    const achievementsByCategory = $derived.by(() => {
        const groups = new Map<string, NonNullable<typeof stats>["achievements"]>()
        for (const a of stats?.achievements ?? []) {
            const key = a.category ?? "General"
            const arr = groups.get(key) ?? []
            arr.push(a)
            groups.set(key, arr)
        }
        return [...groups.entries()]
    })

    function openSourceSite(src: { homepage?: string; domains: string[] }) {
        openExternal(src.homepage ?? (src.domains[0] ? `https://${src.domains[0]}` : undefined))
    }

    const searchDisabledSet = $derived(new Set(searchDisabledSourceIds))
    const searchCapableSources = $derived(sourcesList.filter(s => s.canSearch))
    const searchEnabledCount = $derived(searchCapableSources.filter(s => !searchDisabledSet.has(s.id)).length)

    async function toggleSourceSearch(src: { id: string }) {
        const next = searchDisabledSet.has(src.id)
            ? searchDisabledSourceIds.filter(id => id !== src.id)
            : [...searchDisabledSourceIds, src.id]
        searchDisabledSourceIds = next
        await updateSetting({ searchDisabledSourceIds: next })
    }

    async function enableAllSearch() {
        searchDisabledSourceIds = []
        await updateSetting({ searchDisabledSourceIds: [] })
    }

    async function disableAllSearch() {
        const next = searchCapableSources.map(s => s.id)
        searchDisabledSourceIds = next
        await updateSetting({ searchDisabledSourceIds: next })
    }

    // Display-only ordering for the Sources page - registration order in
    // packages/sources/src/index.ts stays untouched for anything that depends on it.
    const sourcesListAlpha = $derived([...sourcesList].sort((a, b) => a.name.localeCompare(b.name)))

    let pingState = $state<Map<string, "live" | "gated" | "dead">>(new Map())
    let pinging = $state(false)
    let pingedOnce = $state(false)

    async function pingSources() {
        if (pinging) return
        pinging = true
        try {
            const res = await sendRuntimeMessage<Array<{ id: string; status: "live" | "gated" | "dead" }>>({
                type: "sources:ping"
            })
            pingState = new Map(res.map(r => [r.id, r.status]))
            pingedOnce = true
        } catch {
            // reachability is best-effort
        } finally {
            pinging = false
        }
    }

    $effect(() => {
        if (activeSection === "Sources" && !pingedOnce && sourcesList.length > 0) void pingSources()
    })
</script>

<svelte:window onkeydown={onGlobalKey} />

<div class="shell">
    <aside>
        <div class="brand">
            <img src="/icons/icon_48.png" alt="" />
            <span>Story<strong>Hoard</strong></span>
        </div>
        <nav aria-label="Main navigation">
            {#each sections as section}
                <button
                    type="button"
                    class:active={activeSection === section}
                    aria-current={activeSection === section ? "page" : undefined}
                    onclick={() => (activeSection = section)}>
                    {section}
                </button>
                {#if section === "Activity" && showCommunityLink}
                    <button type="button" class="nav-external" onclick={openWeebSite} title="Open weeb.ltd">
                        Community <span class="nav-ext-arrow" aria-hidden="true">↗</span>
                    </button>
                {/if}
            {/each}
        </nav>
        <div class="sidebar-footer">
            <span class="sidebar-version">v{currentVersion}{buildId ? ` · ${buildId}` : ""}</span>
            <button
                type="button"
                class="signin-btn signin-footer"
                class:linked={accountLinked}
                onclick={() => (accountLinked ? void openAccount() : startSignIn())}>
                {#if accountLinked}{accountProfile?.name ?? "Account"}{:else}Sign in{/if}
            </button>
            <button
                type="button"
                class="discord-btn"
                onclick={() => void browser.tabs.create({ url: "https://discord.gg/mVx4W4AQKx" })}>
                <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true"
                    style="flex-shrink:0"
                    ><path
                        d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" /></svg>
                Join Discord
            </button>
            <button type="button" class="kofi-btn" onclick={() => void browser.tabs.create({ url: AMR_KOFI_URL })}>
                ☕ Support on Ko-fi
            </button>
            {#if showCommunityLink}
                <button type="button" class="weeb-btn" onclick={openWeebSite}>🌐 weeb.ltd</button>
            {/if}
        </div>
    </aside>

    <main class:full={activeSection === "Discover" || activeSection === "Settings"}>
        {#each visibleAnnouncements as a (a.id)}
            <div class="announce announce-{a.level}" role="status">
                <div class="announce-body">
                    <strong>{a.title}</strong>
                    <span>{a.body}</span>
                </div>
                <button
                    type="button"
                    class="announce-dismiss"
                    aria-label="Dismiss"
                    onclick={() => void dismissAnnouncement(a.id)}>✕</button>
            </div>
        {/each}
        {#if extensionUpdate?.available && !updateBannerDismissed}
            <div class="update-banner" role="alert">
                <span>StoryHoard <strong>v{extensionUpdate.latestVersion}</strong> is available.</span>
                {#if extensionUpdate.downloadUrl}
                    <button type="button" class="btn-sm" onclick={() => void downloadUpdate()}>
                        Download {isFirefoxBuild ? "Firefox" : "Chrome"} build
                    </button>
                {/if}
                <button
                    type="button"
                    class="btn-outline btn-sm"
                    onclick={() => void browser.tabs.create({ url: extensionUpdate!.releaseUrl })}>
                    View release ↗
                </button>
                <button type="button" class="btn-outline btn-sm" onclick={() => (updateBannerDismissed = true)}>
                    Dismiss
                </button>
                {#if updateDownloadHint}
                    <span class="update-hint">{updateDownloadHint}</span>
                {/if}
            </div>
        {/if}

        {#if showRestoreBanner}
            <div class="restore-banner" role="alert">
                <span>
                    <strong>Your library appears empty.</strong> You have a Gist backup configured - restore it now?
                    {#if syncMessage && !syncing}<br /><span class="muted">{syncMessage}</span>{/if}
                </span>
                <button type="button" class="btn-sm" disabled={syncing} onclick={() => void pullSync()}>
                    {syncing ? "Restoring…" : "Restore from Gist"}
                </button>
                <button type="button" class="btn-outline btn-sm" onclick={() => (restoreBannerDismissed = true)}>
                    Dismiss
                </button>
            </div>
        {/if}

        {#if activeSection === "Discover"}
            {#if !hasPermission && !onboardingDismissed}
                <div class="onboarding">
                    <h2>Welcome to StoryHoard</h2>
                    <p class="muted">
                        Track and read manga from many sources - everything stays local in your browser.
                    </p>
                    <ol class="onboarding-steps">
                        <li>Grant access to the manga sites you use.</li>
                        <li>Open a chapter and click “Read in StoryHoard”, or paste a chapter URL below.</li>
                        <li>Search across every source, or set up Gist sync under Data.</li>
                    </ol>
                    <div class="onboarding-actions">
                        <button type="button" onclick={() => void onboardGrant()}>Grant source access</button>
                        <button type="button" class="btn-outline" onclick={() => void dismissOnboarding()}>
                            Maybe later
                        </button>
                    </div>
                </div>
            {/if}

            <form
                class="search-bar global-search home-search"
                onsubmit={e => {
                    e.preventDefault()
                    doSearch()
                }}>
                <input
                    bind:value={browseQuery}
                    oninput={scheduleAutoSearch}
                    placeholder="Search every source for a title…"
                    aria-label="Search all sources" />
                <button type="submit" disabled={searchLoading || !browseQuery.trim()}>
                    {searchLoading ? "Searching…" : "Search"}
                </button>
            </form>
            {#if searchActive}
                <!-- Results live in a popover over the page, not inline, so a long result list
                     no longer shoves the Discover shelves down. Clicking the dim backdrop or the
                     close button (or emptying the field) returns to the normal Discover page. -->
                <div class="search-overlay">
                    <button type="button" class="search-backdrop" aria-label="Close search" onclick={clearSearch}
                    ></button>
                    <div class="search-popover" aria-label="Search results">
                        <button type="button" class="search-close" aria-label="Close search" onclick={clearSearch}
                            >×</button>
                        {#if selectedManga}
                            <div class="chapters-panel">
                                <button
                                    type="button"
                                    class="btn-back"
                                    onclick={() => {
                                        selectedManga = null
                                        mangaChapters = []
                                    }}>← Back to search</button>
                                <h2 class="chapters-title">{selectedManga.title}</h2>
                                {#if chaptersLoading}
                                    <p class="muted">Loading chapters...</p>
                                {:else if mangaChapters.length === 0}
                                    <p class="muted">No English chapters found.</p>
                                {:else}
                                    <p class="muted chapters-count">
                                        {mangaChapters.length} chapter{mangaChapters.length === 1 ? "" : "s"}
                                        {#if selectedMangaLibraryEntry?.lastReadChapterNumber !== undefined}
                                            · last read ch {selectedMangaLibraryEntry.lastReadChapterNumber}
                                        {/if}
                                    </p>
                                    <div class="chapter-list">
                                        {#each mangaChapters as ch}
                                            {@const isLastRead =
                                                !!selectedMangaLibraryEntry &&
                                                selectedMangaLibraryEntry.lastReadChapterId === ch.id}
                                            <div class="chapter-row" class:chapter-row-current={isLastRead}>
                                                <p class="chapter-title">
                                                    {ch.title}
                                                    {#if isLastRead}<span class="chapter-lastread-badge">Last read</span
                                                        >{/if}
                                                </p>
                                                <button type="button" onclick={() => void readChapter(ch.url)}
                                                    >Read</button>
                                            </div>
                                        {/each}
                                    </div>
                                {/if}
                            </div>
                        {:else}
                            {#if searchLoading && searchResults.length === 0}
                                <p class="muted">
                                    Searching…{searchTotal > 0 ? ` (${searchSettled}/${searchTotal} sources)` : ""}
                                </p>
                            {/if}
                            {#if searchResults.length > 0}
                                {#if searchLoading}
                                    <p class="muted search-progress">
                                        Searching… {searchSettled}/{searchTotal} sources - {searchResults.length} result{searchResults.length ===
                                        1
                                            ? ""
                                            : "s"} so far
                                    </p>
                                {/if}
                                <div style="display:flex;align-items:center;gap:8px;margin:4px 0 12px">
                                    <label class="toggle">
                                        <input
                                            type="checkbox"
                                            bind:checked={groupDuplicates}
                                            aria-label="Group duplicate results across sources" />
                                        <span class="track"></span>
                                    </label>
                                    <span class="muted">Group duplicates across sources</span>
                                </div>
                                {#if searchAddMessage}<p class="notice">{searchAddMessage}</p>{/if}
                                {#if groupDuplicates}
                                    <div class="search-results">
                                        {#each searchWorks as work (work.key)}
                                            <div class="search-result">
                                                <div class="result-cover">
                                                    {#if work.coverUrl}<img
                                                            src={work.coverUrl}
                                                            alt={work.title} />{:else}<span>{work.title[0]}</span>{/if}
                                                </div>
                                                <div class="result-info">
                                                    <p class="result-title">{work.title}</p>
                                                    <p class="muted">
                                                        {work.members.length} source{work.members.length === 1
                                                            ? ""
                                                            : "s"}
                                                    </p>
                                                    <p class="muted">
                                                        Click a source to add it - Ctrl-click to open on site
                                                    </p>
                                                    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px">
                                                        {#each work.members as member (member.sourceId + member.sourceMangaId)}
                                                            {@const inLibrary = resultInLibrary(member)}
                                                            <span
                                                                style="display:inline-flex;align-items:center;gap:2px">
                                                                <button
                                                                    type="button"
                                                                    class="btn-sm"
                                                                    disabled={inLibrary ||
                                                                        addingResultKey === resultKey(member)}
                                                                    title={inLibrary
                                                                        ? "Already in your library"
                                                                        : "Add to library (Ctrl-click or middle-click to open on site)"}
                                                                    onclick={e => activateResult(e, member)}
                                                                    onauxclick={e => auxActivateResult(e, member)}>
                                                                    {inLibrary ? "✓ " : ""}{sourceMeta.get(
                                                                        member.sourceId
                                                                    )?.name ?? member.sourceId}
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    class="btn-sm"
                                                                    title="Open on source site"
                                                                    aria-label="Open {sourceMeta.get(member.sourceId)
                                                                        ?.name ?? member.sourceId} on site"
                                                                    onclick={() => void openResult(member)}>↗</button>
                                                            </span>
                                                        {/each}
                                                    </div>
                                                </div>
                                            </div>
                                        {/each}
                                    </div>
                                {:else}
                                    {#each searchBySource as [sourceId, results]}
                                        {@const expanded =
                                            expandedSourceGroups.has(sourceId) ||
                                            (expandedSourceGroups.size === 0 && sourceId === autoExpandSourceId)}
                                        <div class="source-group">
                                            <button
                                                type="button"
                                                class="source-group-head"
                                                aria-expanded={expanded}
                                                onclick={() => toggleSourceGroup(sourceId)}>
                                                <span class="source-name"
                                                    >{sourceMeta.get(sourceId)?.name ?? sourceId}</span>
                                                <span class="muted"
                                                    >{results.length} result{results.length === 1 ? "" : "s"}</span>
                                                <span class="source-caret">{expanded ? "▾" : "▸"}</span>
                                            </button>
                                            {#if expanded}
                                                <div class="search-results">
                                                    {#each results as result}
                                                        {@const inLibrary = resultInLibrary(result)}
                                                        <div class="search-result">
                                                            <div class="result-cover">
                                                                {#if result.coverUrl}<img
                                                                        src={result.coverUrl}
                                                                        alt={result.title} />{:else}<span
                                                                        >{result.title[0]}</span
                                                                    >{/if}
                                                            </div>
                                                            <div class="result-info">
                                                                <p class="result-title">{result.title}</p>
                                                                <p class="muted">
                                                                    {#if result.latestChapter}latest ch {result.latestChapter}{:else}-{/if}
                                                                </p>
                                                            </div>
                                                            <div
                                                                style="display:flex;gap:6px;align-items:center;flex-shrink:0">
                                                                <button
                                                                    type="button"
                                                                    disabled={inLibrary ||
                                                                        addingResultKey === resultKey(result)}
                                                                    title={inLibrary
                                                                        ? "Already in your library"
                                                                        : "Add to library (Ctrl-click or middle-click to open on site)"}
                                                                    onclick={e => activateResult(e, result)}
                                                                    onauxclick={e => auxActivateResult(e, result)}>
                                                                    {#if inLibrary}✓ In library{:else if addingResultKey === resultKey(result)}Adding…{:else}Add{/if}
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    title={result.sourceId === "mangadex"
                                                                        ? "Browse chapters"
                                                                        : "Open on source site"}
                                                                    aria-label={result.sourceId === "mangadex"
                                                                        ? "Browse chapters"
                                                                        : "Open on source site"}
                                                                    onclick={() => void openResult(result)}>
                                                                    {result.sourceId === "mangadex" ? "Chapters" : "↗"}
                                                                </button>
                                                            </div>
                                                        </div>
                                                    {/each}
                                                </div>
                                            {/if}
                                        </div>
                                    {/each}
                                {/if}
                            {:else if browseQuery.trim() && !searchLoading}
                                <p class="muted">No results across any source.</p>
                            {/if}
                        {/if}
                    </div>
                </div>
            {/if}
            {#if !searchActive}
                {#snippet sugActions(s: Suggestion)}
                    <div class="sug-actions">
                        <button
                            type="button"
                            class="btn-sm sug-find-btn"
                            onclick={() => findSuggestion(s.title, s.searchTitles)}>Find</button>
                        <button
                            type="button"
                            class="btn-sm sug-more-btn"
                            aria-haspopup="menu"
                            aria-expanded={sugMenuFor === s.anilistId}
                            onclick={() => (sugMenuFor = sugMenuFor === s.anilistId ? null : s.anilistId)}
                            >More ▾</button>
                        {#if sugMenuFor === s.anilistId}
                            <div class="sug-menu" role="menu">
                                <button
                                    type="button"
                                    role="menuitem"
                                    onclick={() => {
                                        sugMenuFor = null
                                        findSuggestion(s.title, s.searchTitles)
                                    }}>Find on a source</button>
                                <button type="button" role="menuitem" onclick={() => void quickAddSuggestion(s, "read")}
                                    >Mark as already read</button>
                                <button
                                    type="button"
                                    role="menuitem"
                                    onclick={() => void quickAddSuggestion(s, "planning")}>Add to plan-to-read</button>
                                <button
                                    type="button"
                                    role="menuitem"
                                    class="sug-menu-danger"
                                    onclick={() => void hideSuggestion(s)}>Not interested</button>
                            </div>
                        {/if}
                    </div>
                {/snippet}
                {#snippet sugCard(s: Suggestion)}
                    <article class="disc-card">
                        <div class="poster-wrap">
                            <button
                                type="button"
                                class="poster"
                                onclick={() => findSuggestion(s.title, s.searchTitles)}>
                                {#if s.coverUrl}<img
                                        src={s.coverUrl}
                                        alt={s.title}
                                        loading="lazy"
                                        decoding="async" />{:else}<span
                                        class="cover-initial"
                                        style="--ph-hue:{coverHue(s.title)}">{s.title[0]}</span
                                    >{/if}
                                {#if s.community}
                                    <div class="poster-badges"><span class="updated-chip">Readers also read</span></div>
                                {/if}
                            </button>
                        </div>
                        <p class="poster-title">{s.title}</p>
                        <p class="poster-sub muted">{suggestionWhy(s)}</p>
                        {@render sugActions(s)}
                    </article>
                {/snippet}
                {#snippet rail(heading: string, items: Suggestion[])}
                    <section class="disc-rail">
                        <h2 class="disc-rail-head">{heading}</h2>
                        <div class="disc-rail-track">
                            {#each items as s (s.anilistId)}
                                {@render sugCard(s)}
                            {/each}
                        </div>
                    </section>
                {/snippet}
                <div class="page-head no-title">
                    <div class="disc-head-actions">
                        <button
                            type="button"
                            class="btn-sm sug-mix-btn"
                            class:on={settings?.discoverDiversify ?? true}
                            aria-pressed={settings?.discoverDiversify ?? true}
                            title="Reorder picks to break up runs of the same genre"
                            onclick={() => void toggleDiversify()}>Mix it up</button>
                        <button
                            type="button"
                            class="btn-sm"
                            disabled={suggestionsLoading}
                            onclick={() => void loadSuggestions(true)}>
                            {suggestionsLoading ? "Refreshing…" : "Refresh"}
                        </button>
                    </div>
                </div>
                {#if discoverFocus}
                    <div class="disc-focus-head">
                        <button type="button" class="link-btn" onclick={clearDiscoverFocus}>‹ Back to Discover</button>
                        <h2>More like {discoverFocus}</h2>
                    </div>
                    {#if focusedSuggestions.length === 0}
                        <p class="muted">
                            No similar picks for {discoverFocus} yet. Read a bit more of it, then hit Refresh.
                        </p>
                    {:else}
                        <div class="poster-grid">
                            {#each focusedSuggestions as s (s.anilistId)}
                                {@render sugCard(s)}
                            {/each}
                        </div>
                    {/if}
                {:else if suggestionsLoading && suggestions.length === 0}
                    <p class="muted">Finding titles you might like…</p>
                {:else if suggestions.length === 0}
                    {#if suggestionsFailed && library.length > 0}
                        <p class="muted">
                            Couldn't reach AniList for recommendations right now. Try Refresh again later.
                        </p>
                    {:else}
                        <div class="disc-empty">
                            {#if !accountLinked}
                                <div class="disc-signup">
                                    <p class="disc-signup-title">Never lose your library</p>
                                    <p class="muted">
                                        A free weeb.ltd account syncs your list across devices and keeps an automatic
                                        cloud backup, so a reinstall or new browser never loses your progress.
                                    </p>
                                    <button type="button" onclick={startSignIn}>Create a free account</button>
                                </div>
                            {/if}
                            <h2>Start your library</h2>
                            <p class="muted">
                                Recommendations grow from what you read. Add one of these editor picks to get going, or
                                bring a list you already have.
                            </p>
                            <div class="disc-picks">
                                {#each EDITOR_PICKS as pick}
                                    <button type="button" class="disc-pick" onclick={() => searchSourcesFor(pick)}>
                                        {pick}
                                    </button>
                                {/each}
                            </div>
                            <div class="disc-empty-actions">
                                <button type="button" class="btn-sm" onclick={() => (activeSection = "Data")}>
                                    Import a backup (JSON)
                                </button>
                                <button type="button" class="btn-sm" onclick={() => (activeSection = "Data")}>
                                    Connect an AniList list
                                </button>
                                <button type="button" class="btn-sm" onclick={() => (activeSection = "Sources")}>
                                    Browse sources
                                </button>
                            </div>
                            <p class="muted disc-empty-hint">
                                Or use the search box above to find any title across every source.
                            </p>
                        </div>
                    {/if}
                {:else}
                    {#if visibleNextInSeries.length > 0 && !sugFiltersActive}
                        {@render rail("Continue the series", visibleNextInSeries)}
                    {/if}
                    <h2 class="podium-heading">Top picks for you</h2>
                    <p class="muted" style="margin-top:-4px;text-align:center">
                        Based on the genres and authors you read.
                    </p>
                    <div class="sug-filters">
                        <input
                            class="sug-search"
                            type="search"
                            placeholder="Filter by title…"
                            bind:value={sugQuery}
                            oninput={() => (suggestionsShown = SUGGESTIONS_PAGE)} />
                        <label class="sug-control">
                            <span>Sort</span>
                            <select bind:value={sugSort} onchange={() => (suggestionsShown = SUGGESTIONS_PAGE)}>
                                <option value="score">Best match</option>
                                <option value="frequency">Most recommended</option>
                                <option value="title">Title A-Z</option>
                            </select>
                        </label>
                        <label class="sug-control sug-toggle">
                            <input
                                type="checkbox"
                                bind:checked={sugCommunityOnly}
                                onchange={() => (suggestionsShown = SUGGESTIONS_PAGE)} />
                            <span>Community picks</span>
                        </label>
                        {#if sugFiltersActive}
                            <button type="button" class="btn-sm" onclick={clearSugFilters}>
                                Clear ({filteredSuggestions.length})
                            </button>
                        {/if}
                    </div>
                    {#if suggestionGenreOptions.length > 0}
                        <div class="sug-genre-chips">
                            {#each suggestionGenreOptions as g (g.name)}
                                {@const key = g.name.toLocaleLowerCase("en")}
                                <button
                                    type="button"
                                    class="genre-chip genre-chip-btn"
                                    class:genre-chip-on={sugGenres.includes(key)}
                                    aria-pressed={sugGenres.includes(key)}
                                    onclick={() => toggleSugGenre(key)}>
                                    {g.name} <span class="genre-chip-count">{g.count}</span>
                                </button>
                            {/each}
                        </div>
                    {/if}
                    {#if filteredSuggestions.length === 0}
                        <p class="muted">
                            No suggestions match these filters.
                            <button type="button" class="link-btn" onclick={clearSugFilters}>Clear filters</button>
                        </p>
                    {:else}
                        <div class="podium">
                            {#each filteredSuggestions.slice(0, 3) as s, i (s.anilistId)}
                                {@const matched = matchedGenres(s)}
                                <article class="podium-item" class:podium-first={i === 0}>
                                    <div class="poster-wrap">
                                        <button
                                            type="button"
                                            class="poster"
                                            onclick={() => findSuggestion(s.title, s.searchTitles)}>
                                            {#if s.coverUrl}<img
                                                    src={s.coverUrl}
                                                    alt={s.title}
                                                    loading="lazy"
                                                    decoding="async" />{:else}<span
                                                    class="cover-initial"
                                                    style="--ph-hue:{coverHue(s.title)}">{s.title[0]}</span
                                                >{/if}
                                            <span class="podium-rank podium-rank-{i + 1}"
                                                >{i === 0 ? "1st" : i === 1 ? "2nd" : "3rd"}</span>
                                            {#if s.community}
                                                <div class="poster-badges">
                                                    <span class="updated-chip">Readers also read</span>
                                                </div>
                                            {/if}
                                        </button>
                                    </div>
                                    <p class="poster-title">{s.title}</p>
                                    {#if s.reasons.length > 0}
                                        <p class="poster-sub muted">
                                            Because you read {s.reasons.slice(0, 2).join(", ")}
                                        </p>
                                    {:else if matched.length === 0}
                                        <p class="poster-sub muted">Popular with readers like you</p>
                                    {/if}
                                    {#if matched.length > 0}
                                        <div class="podium-chips">
                                            {#each matched as g}<span class="genre-chip">{g}</span>{/each}
                                        </div>
                                    {/if}
                                    {@render sugActions(s)}
                                </article>
                            {/each}
                        </div>
                        {#if restSuggestionsCount > 0}
                            <div class="poster-grid">
                                {#each filteredSuggestions.slice(3, 3 + suggestionsShown) as s (s.anilistId)}
                                    {@render sugCard(s)}
                                {/each}
                            </div>
                            {#if suggestionsShown < restSuggestionsCount}
                                <div bind:this={suggestionsSentinel} class="suggestions-sentinel">
                                    <button
                                        type="button"
                                        class="btn-sm"
                                        onclick={() =>
                                            (suggestionsShown = Math.min(
                                                suggestionsShown + SUGGESTIONS_PAGE,
                                                restSuggestionsCount
                                            ))}>
                                        Load more ({restSuggestionsCount - suggestionsShown} remaining)
                                    </button>
                                </div>
                            {/if}
                        {/if}
                    {/if}
                    {#if !sugFiltersActive && communitySuggestions.length > 0}
                        <h2 style="margin-top:8px">Readers also read</h2>
                        <p class="muted">Popular with readers who share your library.</p>
                        <div class="poster-grid">
                            {#each communitySuggestions as s (s.anilistId)}
                                {@render sugCard(s)}
                            {/each}
                        </div>
                    {/if}
                    {#if !sugFiltersActive}
                        <!-- Supplementary discovery rails, below the main picks so the familiar
                         top-3 + genre-filter layout leads. Hidden while a filter is active. -->
                        {#if hiddenGems.length > 0}
                            {@render rail("Hidden gems", hiddenGems)}
                        {/if}
                        {#if visibleTrending.length > 0}
                            <section class="disc-rail">
                                <h2 class="disc-rail-head">Trending in the community</h2>
                                <div class="disc-rail-track">
                                    {#each visibleTrending as t (t.title)}
                                        <article class="disc-card trend-card">
                                            <p class="poster-title">{t.title}</p>
                                            <p class="poster-sub muted">
                                                {t.count}
                                                {t.count === 1 ? "reader" : "readers"}
                                            </p>
                                            <div class="sug-actions">
                                                <button
                                                    type="button"
                                                    class="btn-sm sug-find-btn"
                                                    onclick={() => findSuggestion(t.title)}>Find</button>
                                            </div>
                                        </article>
                                    {/each}
                                </div>
                            </section>
                        {/if}
                        {#each becauseYouReadRails as r (r.title)}
                            {@render rail(`Because you read ${r.title}`, r.items)}
                        {/each}
                        {#each byGenreRails as r (r.genre)}
                            {@render rail(`More ${r.genre}`, r.items)}
                        {/each}
                    {/if}
                {/if}
            {/if}
        {:else if activeSection === "Library"}
            <div class="library-toolbar">
                <div class="toolbar-row toolbar-primary">
                    <input
                        class="toolbar-search"
                        bind:value={query}
                        onkeydown={e => {
                            if (e.key === "Enter") {
                                e.preventDefault()
                                searchSourcesFor(query)
                            }
                        }}
                        aria-label="Search library"
                        placeholder="Search titles, or press Enter to search all sources..." />
                    <div class="toolbar-group toolbar-primary-end">
                        <div class="view-toggle">
                            <button
                                type="button"
                                class="btn-sm"
                                class:active={libraryView === "grid"}
                                onclick={() => (libraryView = "grid")}>Grid</button>
                            <button
                                type="button"
                                class="btn-sm"
                                class:active={libraryView === "list"}
                                onclick={() => (libraryView = "list")}>List</button>
                        </div>
                        <select aria-label="Sort library" bind:value={librarySort} onchange={persistLibrarySort}>
                            <option value="updates-first">Updates first</option>
                            <option value="recent-read">Recently read</option>
                            <option value="recently-updated">Recently updated</option>
                            <option value="recent-added">Recently added</option>
                            <option value="title">Title (A-Z)</option>
                            <option value="latest-chapter">Latest chapter</option>
                        </select>
                        <label class="page-size">
                            <span class="muted">Per page</span>
                            <select aria-label="Items per page" bind:value={libraryPageSize}>
                                {#each [10, 15, 20, 50, 100] as n}
                                    <option value={n}>{n}</option>
                                {/each}
                            </select>
                        </label>
                    </div>
                </div>
                <div class="toolbar-row toolbar-filter-row">
                    <div class="filter-chips">
                        {#each LIBRARY_FILTERS as f}
                            <button
                                type="button"
                                class="chip"
                                class:active={libraryFilter === f}
                                onclick={() => (libraryFilter = f)}>
                                {f === "all"
                                    ? "All"
                                    : f === "on-hold"
                                      ? "On Hold"
                                      : f === "unread"
                                        ? "Never opened"
                                        : f[0]?.toUpperCase() + f.slice(1)}
                                <span class="chip-count">{statusCounts[f] ?? 0}</span>
                            </button>
                        {/each}
                    </div>
                    <div class="toolbar-group toolbar-narrow">
                        {#if allCategories.length > 0}
                            <select aria-label="Filter by tag" bind:value={categoryFilter}>
                                <option value="">All tags</option>
                                {#each allCategories as cat}
                                    <option value={cat}>{cat}</option>
                                {/each}
                            </select>
                        {/if}
                        {#if allGenres.length > 0}
                            <select aria-label="Filter by genre" bind:value={genreFilter}>
                                <option value="">All genres</option>
                                {#each allGenres as genre}
                                    <option value={genre}>{genre}</option>
                                {/each}
                            </select>
                        {/if}
                        <button
                            type="button"
                            class="btn-sm filter-toggle"
                            class:active={showFiltersPanel || advancedFilterCount > 0}
                            onclick={() => (showFiltersPanel = !showFiltersPanel)}
                            aria-expanded={showFiltersPanel}>
                            Filters{advancedFilterCount > 0 ? ` (${advancedFilterCount})` : ""}
                        </button>
                    </div>
                </div>
                <div class="toolbar-row toolbar-action-row">
                    <div class="toolbar-group toolbar-actions">
                        <button
                            type="button"
                            class="btn-sm btn-outline"
                            onclick={() => (selectMode ? clearSelection() : (selectMode = true))}>
                            {selectMode ? "Cancel" : "Select"}
                        </button>
                        <div class="tools-menu">
                            <button
                                type="button"
                                class="btn-sm btn-outline"
                                aria-haspopup="menu"
                                aria-expanded={toolsOpen}
                                onclick={() => (toolsOpen = !toolsOpen)}>Tools ▾</button>
                            {#if toolsOpen}
                                <div class="tools-dropdown" role="menu">
                                    {#if allCategories.length > 0}
                                        <button
                                            type="button"
                                            role="menuitem"
                                            onclick={() => {
                                                manageTags = !manageTags
                                                toolsOpen = false
                                            }}>Manage tags</button>
                                    {/if}
                                    <button
                                        type="button"
                                        role="menuitem"
                                        disabled={refreshingCovers || !hasPermission}
                                        title={hasPermission ? "Fetch missing covers" : "Grant source access first"}
                                        onclick={() => {
                                            void backfillCovers()
                                            toolsOpen = false
                                        }}>
                                        {refreshingCovers
                                            ? coverProgress
                                                ? `Fetching… ${coverProgress.done}/${coverProgress.total}`
                                                : "Fetching…"
                                            : missingCoverCount > 0
                                              ? `Missing covers (${missingCoverCount})`
                                              : "Refresh covers"}
                                    </button>
                                    <button
                                        type="button"
                                        role="menuitem"
                                        title="Fetch genres, covers and publication status for titles missing them"
                                        onclick={() => void backfillMetadata()}>Fill genres &amp; metadata</button>
                                    <button
                                        type="button"
                                        role="menuitem"
                                        disabled={relinkScopeIds.length === 0}
                                        onclick={() => {
                                            libScanIds = relinkScopeIds
                                            activeSection = "Data"
                                            toolsOpen = false
                                        }}>
                                        Find better sources ({relinkScopeIds.length})
                                    </button>
                                    {#if duplicateGroups.length > 0}
                                        <button
                                            type="button"
                                            role="menuitem"
                                            onclick={() => {
                                                showDuplicates = !showDuplicates
                                                toolsOpen = false
                                            }}>Duplicates ({duplicateGroups.length})</button>
                                    {/if}
                                    <button
                                        type="button"
                                        role="menuitem"
                                        disabled={library.length === 0}
                                        onclick={() => {
                                            surpriseMe()
                                            toolsOpen = false
                                        }}>🎲 Surprise me</button>
                                </div>
                            {/if}
                        </div>
                    </div>
                </div>
            </div>
            {#if showFiltersPanel}
                <div class="filters-panel">
                    <div class="filters-row">
                        <label class="filters-field">
                            <span class="muted">Source</span>
                            <select aria-label="Filter by source" bind:value={sourceFilter}>
                                <option value="">All sources</option>
                                {#each librarySources as sid}
                                    <option value={sid}>{sid}</option>
                                {/each}
                            </select>
                        </label>
                        <label class="filters-field">
                            <span class="muted">Min rating</span>
                            <select aria-label="Minimum rating" bind:value={ratingFilter}>
                                <option value={0}>Any</option>
                                {#each [1, 2, 3, 4, 5] as r}
                                    <option value={r}>{"★".repeat(r)}</option>
                                {/each}
                            </select>
                        </label>
                        <label class="filters-field">
                            <span class="muted">Updated</span>
                            <select aria-label="Updated since" bind:value={updatedSinceFilter}>
                                <option value={0}>Any time</option>
                                <option value={7}>Last 7 days</option>
                                <option value={30}>Last 30 days</option>
                                <option value={90}>Last 90 days</option>
                            </select>
                        </label>
                        {#if advancedFilterCount > 0}
                            <button type="button" class="btn-sm filters-clear" onclick={clearAdvancedFilters}>
                                Clear filters
                            </button>
                        {/if}
                    </div>
                </div>
            {/if}
            <form
                class="url-form"
                onsubmit={e => {
                    e.preventDefault()
                    void addByUrl()
                }}>
                <input bind:value={addUrl} type="url" required placeholder="Add chapter by URL..." />
                <button type="submit" disabled={adding}>{adding ? "Adding..." : "Add"}</button>
            </form>
            {#if addMessage}<p class="notice">{addMessage}</p>{/if}
            {#if manageTags}
                <div class="tag-manage">
                    <p class="muted search-hint">
                        Rename or delete a tag to update every title at once. Add tags per title from the ⋯ details
                        panel.
                    </p>
                    {#if tagCounts.length === 0}
                        <p class="muted">No tags yet. Open a title's details to add some.</p>
                    {:else}
                        <div class="tag-table">
                            {#each tagCounts as [tag, count] (tag)}
                                <div class="tag-row">
                                    <button
                                        type="button"
                                        class="tag-name"
                                        onclick={() => filterByTag(tag)}
                                        title="Filter library">{tag}</button>
                                    <span class="tag-count muted">{count} title{count === 1 ? "" : "s"}</span>
                                    <input
                                        class="tag-rename"
                                        value={tag}
                                        disabled={tagBusy}
                                        aria-label={`Rename ${tag}`}
                                        onchange={e => void renameTag(tag, e.currentTarget.value)} />
                                    <button
                                        type="button"
                                        class="btn-sm confirm-remove-btn"
                                        disabled={tagBusy}
                                        onclick={() => void deleteTag(tag)}>Delete</button>
                                </div>
                            {/each}
                        </div>
                    {/if}
                </div>
            {/if}
            {#if showDuplicates && duplicateGroups.length > 0}
                <div class="dup-panel">
                    <p class="row-label">Possible duplicates</p>
                    {#each duplicateGroups as group}
                        {@const primary = primaryOfGroup(group)}
                        {@const distinctTitles = [...new Set(group.map(m => m.title.trim()))]}
                        {@const groupKey = groupKeyOf(group)}
                        <div class="dup-group">
                            <span class="dup-title">{distinctTitles.join("  ·  ")}</span>
                            {#if distinctTitles.length > 1}
                                <span
                                    class="list-badge badge-warn"
                                    title="This group holds more than one distinct title - check before merging, they may be different series">
                                    {distinctTitles.length} titles
                                </span>
                            {/if}
                            <span class="muted">{group.map(m => m.sourceId).join(", ")}</span>
                            {#if primary}
                                <span
                                    class="list-badge badge-keep"
                                    title="This copy is kept; the rest are merged into it">
                                    Keeps: {primary.sourceId}
                                </span>
                            {/if}
                            <div class="dup-actions">
                                <button
                                    type="button"
                                    class="btn-sm"
                                    disabled={mergingGroups.has(groupKey)}
                                    aria-haspopup="menu"
                                    aria-expanded={dupMenuFor === groupKey}
                                    onclick={() => (dupMenuFor = dupMenuFor === groupKey ? null : groupKey)}>
                                    {mergingGroups.has(groupKey) ? "Merging…" : `Merge ${group.length} ▾`}
                                </button>
                                {#if dupMenuFor === groupKey}
                                    <div class="dup-menu" role="menu">
                                        <p class="dup-menu-head">Keep which copy?</p>
                                        {#each group as m (m.id)}
                                            <button
                                                type="button"
                                                role="menuitem"
                                                onclick={() => void mergeDuplicates(group, m.id)}>
                                                <span class="dup-menu-src">{m.sourceId}</span>
                                                {#if distinctTitles.length > 1}<span class="dup-menu-t">{m.title}</span
                                                    >{/if}
                                                {#if m.id === primary?.id}<span class="muted">suggested</span>{/if}
                                            </button>
                                        {/each}
                                    </div>
                                {/if}
                            </div>
                        </div>
                    {/each}
                </div>
            {/if}
            {#if selectMode}
                <div class="bulk-bar">
                    <span>{selectedIds.size} selected</span>
                    <button
                        type="button"
                        class="btn-sm"
                        disabled={visibleLibrary.length === 0}
                        onclick={toggleSelectAllVisible}>
                        {allVisibleSelected ? "Deselect all" : "Select all"}
                    </button>
                    <input bind:value={bulkCategory} placeholder="Tags (comma-separated)…" aria-label="Bulk tags" />
                    <button
                        type="button"
                        class="btn-sm"
                        disabled={selectedIds.size === 0 || !bulkCategory.trim() || bulkWorking}
                        onclick={() => void bulkAddCategory()}>Add tags</button>
                    <button
                        type="button"
                        class="btn-sm"
                        disabled={selectedIds.size === 0 || bulkWorking}
                        onclick={() => void bulkManual(true)}>{bulkWorking ? "Working…" : "Mark manual"}</button>
                    <button
                        type="button"
                        class="btn-sm"
                        disabled={selectedIds.size === 0 || bulkWorking}
                        onclick={() => void bulkManual(false)}>{bulkWorking ? "Working…" : "Unmark manual"}</button>
                    <button
                        type="button"
                        class="btn-sm"
                        disabled={selectedIds.size === 0 || bulkWorking}
                        title="Set each selected title's progress to its latest chapter"
                        onclick={() => void bulkCaughtUp()}>{bulkWorking ? "Working…" : "Mark caught up"}</button>
                    <select
                        class="bulk-status-select"
                        aria-label="Set status for selected"
                        disabled={selectedIds.size === 0 || bulkWorking}
                        onchange={e => {
                            const v = e.currentTarget.value
                            e.currentTarget.value = ""
                            if (v) void bulkStatus(v as "on-hold" | "planning" | "dropped" | "clear")
                        }}>
                        <option value="">Set status…</option>
                        <option value="on-hold">On Hold</option>
                        <option value="planning">Plan to read</option>
                        <option value="dropped">Dropped</option>
                        <option value="clear">Clear status</option>
                    </select>
                    <button
                        type="button"
                        class="btn-sm confirm-remove-btn"
                        class:armed={bulkRemoveArmed}
                        disabled={selectedIds.size === 0 || bulkWorking}
                        onclick={requestBulkRemove}
                        >{bulkWorking
                            ? "Working…"
                            : bulkRemoveArmed
                              ? `Confirm remove ${selectedIds.size}`
                              : "Remove"}</button>
                    {#if bulkRemoveArmed && !bulkWorking}
                        <button type="button" class="btn-sm" onclick={disarmBulkRemove}>Cancel</button>
                    {/if}
                    {#if bulkMessage}<p class="notice" role="status" aria-live="polite">{bulkMessage}</p>{/if}
                </div>
            {/if}
            {#if visibleLibrary.length === 0}
                <p class="muted" style="margin-top:16px">
                    {query || libraryFilter !== "all" ? "No titles match." : "Your library is empty."}
                </p>
                {#if query.trim()}
                    <button type="button" class="btn-sm" style="margin-top:8px" onclick={() => searchSourcesFor(query)}>
                        Search all sources for “{query.trim()}”
                    </button>
                {/if}
            {:else if libraryView === "grid"}
                <div class="poster-grid">
                    {#each pagedLibrary as manga (manga.id)}
                        <article class:selected={selectMode && selectedIds.has(manga.id)}>
                            <div class="poster-wrap">
                                <button
                                    type="button"
                                    class="poster"
                                    class:sample={isSeedData(manga)}
                                    onclick={e => read(manga, e)}
                                    onauxclick={e => read(manga, e)}>
                                    {#if (coverSrcs[manga.id] ?? manga.coverUrl) && !failedCovers.has(manga.id)}<img
                                            src={coverSrcs[manga.id] ?? manga.coverUrl}
                                            alt={manga.title}
                                            data-source={manga.sourceId}
                                            class:nsfw-blur={manga.nsfw && (settings?.blurNsfw ?? true)}
                                            onerror={() => coverFailed(manga.id)} />{:else}<span
                                            class="cover-initial"
                                            style="--ph-hue:{coverHue(manga.title)}">{manga.title[0]}</span
                                        >{/if}
                                    {#if isSeedData(manga)}<span class="sample-chip">Sample</span>{/if}
                                    <div class="poster-badges">
                                        {#if manga.manualTracking}<span class="manual-chip">Manual</span>{/if}
                                        {#if !isSeedData(manga) && hasNewerChapters(manga)}
                                            <span class="new-chip">New ch</span>
                                        {:else if isRecentlyAdded(manga)}
                                            <span class="added-chip">New</span>
                                        {/if}
                                    </div>
                                </button>
                                <button
                                    type="button"
                                    class="poster-menu-btn"
                                    aria-label="Options"
                                    onclick={e => {
                                        e.stopPropagation()
                                        detailManga = manga
                                    }}>⋯</button>
                                {#if !isSeedData(manga)}
                                    <button
                                        type="button"
                                        class="poster-similar-btn"
                                        aria-label={`Find titles similar to ${manga.title}`}
                                        title="Find similar"
                                        onclick={e => {
                                            e.stopPropagation()
                                            discoverSimilarTo(manga.title)
                                        }}>≈</button>
                                {/if}
                                {#if selectMode}
                                    <span class="select-check" class:on={selectedIds.has(manga.id)} aria-hidden="true"
                                        >{selectedIds.has(manga.id) ? "✓" : ""}</span>
                                {/if}
                            </div>
                            <p class="poster-title">{manga.title}</p>
                            <p class="poster-sub">
                                {#if manga.mangaUrl}
                                    <button
                                        class="source-link"
                                        type="button"
                                        title="Open on source site"
                                        onclick={e => {
                                            e.stopPropagation()
                                            openExternal(manga.mangaUrl)
                                        }}>
                                        {sourceMeta.get(manga.sourceId)?.name ?? manga.sourceId}
                                    </button>
                                {:else}
                                    {sourceMeta.get(manga.sourceId)?.name ?? manga.sourceId}
                                {/if}
                            </p>
                            {#if !neverRead(manga) || manga.latestChapterNumber !== undefined}
                                <p class="poster-chapter">
                                    {readChapterLabel(manga)}{#if manga.latestChapterNumber !== undefined}<span
                                            class="muted">
                                            / {manga.latestChapterNumber}</span
                                        >{/if}
                                </p>
                            {/if}
                            <div class="poster-rating" role="group" aria-label={`Rate ${manga.title}`}>
                                {#each [1, 2, 3, 4, 5] as star}
                                    <button
                                        type="button"
                                        class="star"
                                        class:filled={(manga.rating ?? 0) >= star}
                                        aria-label={`${star} star${star > 1 ? "s" : ""}`}
                                        aria-pressed={(manga.rating ?? 0) >= star}
                                        onclick={() => void rate(manga, star)}>★</button>
                                {/each}
                            </div>
                        </article>
                    {/each}
                </div>
            {:else}
                <div class="list-view">
                    {#each pagedLibrary as manga (manga.id)}
                        {@const status = effectiveReadingStatus(manga, { autoPauseDays, now: Date.now() })}
                        <div class="list-row" class:selected={selectMode && selectedIds.has(manga.id)}>
                            {#if selectMode}
                                <span
                                    class="select-check list-select-check"
                                    class:on={selectedIds.has(manga.id)}
                                    aria-hidden="true">{selectedIds.has(manga.id) ? "✓" : ""}</span>
                            {/if}
                            <button
                                type="button"
                                class="list-cover"
                                class:sample={isSeedData(manga)}
                                onclick={e => openSeriesPage(manga, e)}
                                onauxclick={e => openSeriesPage(manga, e)}
                                aria-label={`Open ${manga.title}`}>
                                {#if (coverSrcs[manga.id] ?? manga.coverUrl) && !failedCovers.has(manga.id)}<img
                                        src={coverSrcs[manga.id] ?? manga.coverUrl}
                                        alt=""
                                        data-source={manga.sourceId}
                                        class:nsfw-blur={manga.nsfw && (settings?.blurNsfw ?? true)}
                                        onerror={() => coverFailed(manga.id)} />{:else}<span
                                        class="cover-initial"
                                        style="--ph-hue:{coverHue(manga.title)}">{manga.title[0]}</span
                                    >{/if}
                            </button>
                            <div class="list-main">
                                <button type="button" class="list-title" onclick={() => openSeriesPage(manga)}
                                    >{manga.title}</button>
                                <p class="muted list-meta">
                                    {#if manga.mangaUrl}
                                        <button
                                            class="source-link"
                                            type="button"
                                            title="Open on source site"
                                            onclick={e => {
                                                e.stopPropagation()
                                                openExternal(manga.mangaUrl)
                                            }}>
                                            {sourceMeta.get(manga.sourceId)?.name ?? manga.sourceId}
                                        </button>
                                    {:else}
                                        {sourceMeta.get(manga.sourceId)?.name ?? manga.sourceId}
                                    {/if}
                                    {#if manga.manualTracking}· manual{/if}
                                    {#if manga.notes}· 📝{/if}
                                </p>
                                {#if (!isSeedData(manga) && hasNewerChapters(manga)) || isRecentlyAdded(manga)}
                                    <div class="list-badges">
                                        {#if !isSeedData(manga) && hasNewerChapters(manga)}
                                            <span class="list-badge badge-unread">New ch</span>
                                        {:else if isRecentlyAdded(manga)}
                                            <span class="list-badge badge-added">New</span>
                                        {/if}
                                    </div>
                                {/if}
                                {#if rowMessage && rowMessage.id === manga.id}
                                    <p class="muted list-rowmsg">{rowMessage.text}</p>
                                {/if}
                            </div>
                            <span class="list-status status-{status}">{status}</span>
                            <span class="list-progress">
                                {readChapterLabel(manga)}{#if manga.latestChapterNumber !== undefined}<span
                                        class="muted">
                                        / {manga.latestChapterNumber}</span
                                    >{/if}
                            </span>
                            <div class="list-actions">
                                <button
                                    type="button"
                                    class="btn-sm"
                                    disabled={rowBusy === manga.id}
                                    title="Previous chapter"
                                    onclick={() => void openAdjacent(manga, "prev")}>‹ Prev</button>
                                <button
                                    type="button"
                                    class="btn-sm"
                                    disabled={rowBusy === manga.id}
                                    title="Next chapter"
                                    onclick={() => void openAdjacent(manga, "next")}>
                                    {rowBusy === manga.id ? "…" : "Next ›"}
                                </button>
                                <button
                                    type="button"
                                    class="btn-sm"
                                    disabled={manga.latestChapterNumber === undefined ||
                                        statusOf(manga) === "completed"}
                                    title="Mark caught up to the latest chapter"
                                    onclick={() => void markCaughtUp(manga)}>Caught up</button>
                                <button type="button" class="btn-sm" onclick={() => (detailManga = manga)}>⋯</button>
                            </div>
                        </div>
                    {/each}
                </div>
            {/if}
            {#if visibleLibrary.length > libraryLimit}
                <div class="load-more">
                    <button type="button" class="btn-sm" onclick={() => (libraryLimit += libraryPageSize)}>
                        Load more ({visibleLibrary.length - libraryLimit} left)
                    </button>
                </div>
            {/if}
        {:else if activeSection === "Activity"}
            <div class="activity-tabs">
                <button type="button" class:active={activityTab === "Updates"} onclick={() => (activityTab = "Updates")}
                    >Updates</button>
                <button type="button" class:active={activityTab === "History"} onclick={() => (activityTab = "History")}
                    >History</button>
                <button
                    type="button"
                    class:active={activityTab === "Bookmarks"}
                    onclick={() => (activityTab = "Bookmarks")}>Bookmarks</button>
            </div>
            {#if activityTab === "Bookmarks"}
                <p class="muted search-hint">
                    Pages you've saved while reading. Click a bookmark to jump straight to that page.
                </p>
                {#if !bookmarksLoaded}
                    <p class="muted">Loading…</p>
                {:else if bookmarks.length === 0}
                    <p class="muted">No bookmarks yet. Use the ☆ button in the reader to save a page.</p>
                {:else}
                    <ul class="bookmark-list">
                        {#each bookmarks as bm (bm.id)}
                            <li class="bookmark-card">
                                <div class="bookmark-info">
                                    <span class="bookmark-manga">{bm.mangaTitle}</span>
                                    <span class="bookmark-chapter muted"
                                        >{bm.chapterTitle} - page {bm.pageIndex + 1}</span>
                                    <span class="bookmark-date muted">{new Date(bm.addedAt).toLocaleDateString()}</span>
                                </div>
                                <div class="bookmark-actions">
                                    <a
                                        href={bookmarkReaderUrl(bm)}
                                        class="btn-sm btn-outline"
                                        onclick={e => {
                                            e.preventDefault()
                                            void browser.tabs.create({ url: bookmarkReaderUrl(bm) })
                                        }}>Open</a>
                                    <button
                                        type="button"
                                        class="btn-sm btn-ghost-danger"
                                        onclick={() => void deleteBookmark(bm.id)}>Remove</button>
                                </div>
                            </li>
                        {/each}
                    </ul>
                {/if}
            {:else if activityTab === "Updates"}
                <div class="page-head no-title">
                    <button
                        type="button"
                        onclick={() => void checkForUpdates()}
                        disabled={checkingUpdates}
                        aria-busy={checkingUpdates}>
                        {checkingUpdates ? "Checking..." : "Check all"}
                    </button>
                </div>
                {#if librarySources.length > 1}
                    <div class="source-refresh">
                        <span class="muted">Refresh one source:</span>
                        {#each librarySources as src}
                            <button
                                type="button"
                                class="btn-sm"
                                disabled={checkingUpdates}
                                onclick={() => void checkForUpdates(src)}>
                                {src}
                            </button>
                        {/each}
                    </div>
                {/if}
                {#if updateProgress && (updateProgress.running || updateProgress.done > 0)}
                    <div class="update-progress-wrap">
                        <div class="progress-track">
                            <div class="progress-fill" style="width: {updateProgressPct}%"></div>
                        </div>
                        <div class="progress-meta">
                            <span class="progress-count">
                                {updateProgress.done} / {updateProgress.total} checked
                                {#if updateProgress.sourceId}
                                    <span class="muted">({updateProgress.sourceId})</span>
                                {/if}
                            </span>
                            {#if updateProgress.running && updateProgress.currentTitle}
                                <span class="progress-current muted"
                                    >- currently checking {updateProgress.currentTitle}</span>
                            {:else if !updateProgress.running}
                                <span class="progress-done">Done ✓</span>
                            {/if}
                        </div>
                    </div>
                {/if}
                <p class="muted" style="margin-bottom:20px">
                    {updateStatus
                        ? `Last checked ${new Date(updateStatus.checkedAt).toLocaleString()} - ${updateStatus.updated} updated, ${updateStatus.failed} failed`
                        : "No update check has run yet. Click Check all to scan for new chapters."}
                </p>
                {@const skippedEntries = Object.entries(updateStatus?.skippedSources ?? {}).sort((a, b) => b[1] - a[1])}
                {@const relinkEntries = Object.entries(updateStatus?.needsRelink ?? {}).sort((a, b) => b[1] - a[1])}
                {#if (updateStatus?.errors && updateStatus.errors.length > 0) || skippedEntries.length > 0 || relinkEntries.length > 0}
                    <div class="error-panel">
                        <div class="error-panel-head">
                            <p class="row-label">Update check details</p>
                            <button type="button" class="btn-sm" onclick={() => void copyUpdateFailureLog()}>
                                {updateLogCopyState === "ok"
                                    ? "Copied ✓"
                                    : updateLogCopyState === "fail"
                                      ? "Copy failed"
                                      : "Copy log"}
                            </button>
                        </div>
                        {#if updateStatus?.errors && updateStatus.errors.length > 0}
                            <p class="row-sublabel">Titles that failed to update</p>
                            {#each updateStatus.errors as err}
                                <div class="error-row">
                                    <span class="error-title">{err.title}</span>
                                    <span class="muted">{err.message}</span>
                                </div>
                            {/each}
                        {/if}
                        {#if skippedEntries.length > 0}
                            <p class="row-sublabel">Skipped - these sites block automated checks (not a failure)</p>
                            {#each skippedEntries as [source, count]}
                                <div class="error-row">
                                    <span class="error-title">{source}</span>
                                    <span class="muted"
                                        >{count} title(s) skipped; chapters still load in the reader</span>
                                </div>
                            {/each}
                        {/if}
                        {#if relinkEntries.length > 0}
                            <p class="row-sublabel">Needs relinking - source retired or its link can't be read</p>
                            {#each relinkEntries as [source, count]}
                                <div class="error-row">
                                    <span class="error-title">{source}</span>
                                    <span class="muted"
                                        >{count} title(s) - open a title and use Re-link / Check mirrors to move it to a live
                                        source</span>
                                </div>
                            {/each}
                        {/if}
                    </div>
                {/if}
                {#if library.length === 0}
                    <p class="muted">No manga in library to check.</p>
                {:else if updatedManga.length === 0}
                    <p class="muted">Everything is up to date.</p>
                {:else}
                    <div class="update-groups">
                        {#each pagedUpdates as manga (manga.id)}
                            {@const open = expandedUpdates.has(manga.id)}
                            {@const titleNeverRead = neverRead(manga)}
                            {@const chapters = updatesNewChapters[manga.id]}
                            <div class="update-group" class:open>
                                <button type="button" class="update-group-head" onclick={() => toggleUpdate(manga.id)}>
                                    <div class="update-cover">
                                        {#if coverSrcs[manga.id] ?? manga.coverUrl}
                                            <img src={coverSrcs[manga.id] ?? manga.coverUrl} alt={manga.title} />
                                        {:else}
                                            <span class="cover-initial" style="--ph-hue:{coverHue(manga.title)}"
                                                >{manga.title[0]}</span>
                                        {/if}
                                    </div>
                                    <div class="update-info">
                                        <span class="update-title">{manga.title}</span>
                                        <span class="muted update-when"
                                            >{new Date(manga.updatedAt).toLocaleDateString()}</span>
                                    </div>
                                    {#if titleNeverRead}
                                        <span class="badge-unread">Unread</span>
                                    {:else if manga.latestChapterNumber != null && manga.lastReadChapterNumber != null}
                                        <span class="badge-new">
                                            +{Math.max(
                                                1,
                                                Math.round(manga.latestChapterNumber - manga.lastReadChapterNumber)
                                            )} ch
                                        </span>
                                    {:else}
                                        <span class="badge-new">New</span>
                                    {/if}
                                    <span class="update-caret">{open ? "▾" : "▸"}</span>
                                </button>
                                {#if open}
                                    <div class="update-chapters">
                                        {#if !chapters}
                                            <p class="muted update-loading">Loading…</p>
                                        {:else if chapters.length === 0}
                                            <p class="muted update-loading">
                                                No cached chapters - open the manga page to load them.
                                            </p>
                                        {:else}
                                            {#each chapters.slice().reverse() as ch (ch.id)}
                                                <div
                                                    class="update-chapter-row clickable"
                                                    role="button"
                                                    tabindex="0"
                                                    onclick={() => void readChapter(ch.url)}
                                                    onkeydown={e => e.key === "Enter" && void readChapter(ch.url)}>
                                                    <span class="update-ch-title">{ch.title}</span>
                                                    <span class="badge-new-sm">Read ›</span>
                                                </div>
                                            {/each}
                                        {/if}
                                    </div>
                                {/if}
                            </div>
                        {/each}
                    </div>
                    {#if updatedManga.length > updatesLimit}
                        <div class="load-more">
                            <button type="button" class="btn-sm" onclick={() => (updatesLimit += UPDATES_INITIAL)}>
                                Load more ({updatedManga.length - updatesLimit} left)
                            </button>
                        </div>
                    {/if}
                {/if}
            {:else if activityTab === "History"}
                <div class="page-head no-title">
                    <button type="button" class="btn-sm" onclick={() => void loadHistory()}>Refresh</button>
                </div>
                {#if !historyLoaded}
                    <p class="muted">Loading…</p>
                {:else if historyGroups.length === 0}
                    <p class="muted">No reading activity yet. Open a chapter to start tracking.</p>
                {:else}
                    <div class="history-groups">
                        {#each historyGroups as group (group.mangaId)}
                            {@const open = expandedHistory.has(group.mangaId)}
                            {@const last = group.events[0]}
                            <div class="history-group" class:open>
                                <button
                                    type="button"
                                    class="history-group-head"
                                    onclick={() => toggleHistoryGroup(group.mangaId)}>
                                    <span class="history-caret">{open ? "▾" : "▸"}</span>
                                    <span class="history-title">{group.title}</span>
                                    <span class="muted history-count">{group.events.length}</span>
                                    <span class="muted history-when">
                                        {last
                                            ? `${last.type === "completed" ? "read" : "started"} ${last.chapterNumber != null ? `ch ${last.chapterNumber} · ` : ""}${new Date(group.latest).toLocaleDateString()}`
                                            : ""}
                                    </span>
                                </button>
                                {#if open}
                                    <div class="history-events">
                                        {#each group.events as event}
                                            <div
                                                class="history-row"
                                                class:clickable={!!event.chapterUrl}
                                                role={event.chapterUrl ? "button" : undefined}
                                                tabindex={event.chapterUrl ? 0 : undefined}
                                                onclick={() => event.chapterUrl && void readChapter(event.chapterUrl)}
                                                onkeydown={e =>
                                                    e.key === "Enter" &&
                                                    event.chapterUrl &&
                                                    void readChapter(event.chapterUrl)}>
                                                <span class="history-dot" class:done={event.type === "completed"}
                                                ></span>
                                                <span class="history-ev-title">
                                                    {event.chapterNumber != null
                                                        ? `Chapter ${event.chapterNumber}`
                                                        : (event.chapterTitle ?? "Chapter")}
                                                </span>
                                                <span class="muted">
                                                    {event.type === "completed" ? "Completed" : "Started"}
                                                </span>
                                                <span class="muted history-when">
                                                    {new Date(event.occurredAt).toLocaleString()}
                                                </span>
                                            </div>
                                        {/each}
                                    </div>
                                {/if}
                            </div>
                        {/each}
                    </div>
                {/if}
            {/if}
        {:else if activeSection === "Stats"}
            <div class="stat-row">
                <div class="stat-box"><strong>{stats?.completedChapters ?? 0}</strong><span>Completed</span></div>
                <div class="stat-box"><strong>{stats?.mangaCount ?? 0}</strong><span>Saved</span></div>
                <div class="stat-box">
                    <strong>{stats?.readingDays ?? 0}</strong><span>Active days (all-time)</span>
                </div>
            </div>
            <div class="stat-row">
                <div class="stat-box"><strong>{stats?.currentStreak ?? 0}</strong><span>Day streak</span></div>
                <div class="stat-box"><strong>{stats?.longestStreak ?? 0}</strong><span>Longest streak</span></div>
                <div class="stat-box"><strong>{stats?.chaptersThisWeek ?? 0}</strong><span>This week</span></div>
            </div>
            <div class="stat-row">
                <div class="stat-box"><strong>{stats?.completedSeries ?? 0}</strong><span>Series done</span></div>
                <div class="stat-box"><strong>{stats?.sourcesUsed ?? 0}</strong><span>Sources</span></div>
                <div class="stat-box"><strong>{stats?.downloadedChapters ?? 0}</strong><span>Offline</span></div>
                <div class="stat-box"><strong>{stats?.ratedCount ?? 0}</strong><span>Rated</span></div>
            </div>
            <div class="stat-row">
                <div class="stat-box">
                    <strong>
                        {#if (stats?.estimatedMinutes ?? 0) >= 60}
                            {Math.round((stats?.estimatedMinutes ?? 0) / 60)}h
                        {:else}
                            {stats?.estimatedMinutes ?? 0}m
                        {/if}
                    </strong>
                    <span>Time read</span>
                </div>
                <div class="stat-box"><strong>{stats?.minutesThisWeek ?? 0}m</strong><span>This week</span></div>
            </div>
            {#if settings && settings.dailyGoal > 0}
                {@const today = stats?.chaptersToday ?? 0}
                {@const pct = Math.min(100, Math.round((today / settings.dailyGoal) * 100))}
                <div class="goal-card">
                    <div class="goal-head">
                        <span class="row-label">Today's goal</span>
                        <span class="muted"
                            >{today} / {settings.dailyGoal} chapters{today >= settings.dailyGoal ? " ✓" : ""}</span>
                    </div>
                    <div class="goal-bar"><div class="goal-fill" style="width:{pct}%"></div></div>
                </div>
            {/if}
            <p class="shelf-label" style="margin-top:24px">Top genres</p>
            {#if genreBreakdown.length === 0}
                <p class="muted">Genres fill in as titles are enriched.</p>
            {:else}
                {@const topCount = genreBreakdown[0]?.count ?? 1}
                <div class="insights-genre-grid">
                    {#each genreBreakdown.slice(0, 10) as g, i}
                        <div class="genre-entry">
                            <div class="genre-bar-row">
                                <span class="genre-label">{g.name}</span>
                                <div class="genre-bar-track">
                                    <div
                                        class="genre-bar-fill"
                                        style="width:{topCount > 0 ? Math.round((g.count / topCount) * 100) : 0}%">
                                    </div>
                                </div>
                                <span class="genre-count muted">{g.count}</span>
                            </div>
                            {#if i < 5}
                                <p class="genre-examples muted">{g.titles.join(", ")}</p>
                            {/if}
                        </div>
                    {/each}
                </div>
            {/if}

            <p class="shelf-label" style="margin-top:24px">Reading activity</p>
            <ActivityHeatmap data={activity} />

            <p class="muted" style="margin-top:24px">
                {stats?.achievements.filter(a => a.unlocked).length ?? 0} / {stats?.achievements.length ?? 0} unlocked
            </p>
            {#each achievementsByCategory as [category, items]}
                <p class="shelf-label ach-category">
                    {category}
                    <span class="muted">{items.filter(a => a.unlocked).length}/{items.length}</span>
                </p>
                <div class="achievement-list">
                    {#each items as a}
                        <div class="achievement" class:unlocked={a.unlocked}>
                            <span class="ach-icon">{a.unlocked ? "★" : "☆"}</span>
                            <div class="ach-body">
                                <p class="ach-title">{a.title}</p>
                                <p class="muted">{a.description}</p>
                                {#if !a.unlocked}
                                    <div class="progress-track">
                                        <div
                                            class="progress-fill"
                                            style="width:{a.target > 0
                                                ? Math.min(100, (a.progress / a.target) * 100)
                                                : 0}%">
                                        </div>
                                    </div>
                                    <span class="ach-progress muted">{a.progress} / {a.target}</span>
                                {/if}
                            </div>
                        </div>
                    {/each}
                </div>
            {/each}

            {#if analyticsSummary}
                <p class="shelf-label" style="margin-top:32px">
                    Usage insights <span class="muted">(last {analyticsSummary.days} days)</span>
                </p>
                <div class="stat-row">
                    <div class="stat-box">
                        <strong>{analyticsSummary.captureOk}</strong><span>Chapters captured</span>
                    </div>
                    <div class="stat-box">
                        <strong>{analyticsSummary.readerRate}%</strong><span>Opened in reader</span>
                    </div>
                    <div class="stat-box">
                        <strong>{analyticsSummary.onSiteTrack}</strong><span>Marked on-site</span>
                    </div>
                    <div class="stat-box" class:stat-warn={analyticsSummary.errorRate > 10}>
                        <strong>{analyticsSummary.errorRate}%</strong><span>Capture error rate</span>
                    </div>
                </div>
                <div class="stat-row">
                    <div class="stat-box">
                        <strong>{analyticsSummary.directResolves}</strong><span>Direct resolves</span>
                    </div>
                    <div class="stat-box" class:stat-warn={analyticsSummary.tabResolves > 0}>
                        <strong>{analyticsSummary.tabResolves}</strong><span>Tab fallbacks (CF)</span>
                    </div>
                </div>
                {#if analyticsSummary.topSources.length > 0}
                    <p class="shelf-label" style="margin-top:16px">Top sources</p>
                    <div class="insights-list">
                        {#each analyticsSummary.topSources as s}
                            <div class="insights-row">
                                <span class="insights-label">{s.sourceId}</span>
                                <span class="insights-count">{s.count}</span>
                            </div>
                        {/each}
                    </div>
                {/if}
                {#if analyticsSummary.topErrors.length > 0}
                    <p class="shelf-label" style="margin-top:16px">Sources with errors</p>
                    <div class="insights-list">
                        {#each analyticsSummary.topErrors as s}
                            <div class="insights-row insights-row-warn">
                                <span class="insights-label">{s.sourceId}</span>
                                <span class="insights-count">{s.count} errors</span>
                            </div>
                        {/each}
                    </div>
                {/if}
                {#if analyticsSummary.errorTypes.length > 0}
                    <p class="shelf-label" style="margin-top:12px">Error breakdown</p>
                    <div class="insights-list">
                        {#each analyticsSummary.errorTypes as e}
                            <div class="insights-row insights-row-warn">
                                <span class="insights-label"
                                    >{e.type === "bot-block"
                                        ? "CF / bot block"
                                        : e.type === "not-found"
                                          ? "404 not found"
                                          : e.type === "network"
                                            ? "Network / timeout"
                                            : e.type}</span>
                                <span class="insights-count">{e.count}</span>
                            </div>
                        {/each}
                    </div>
                {/if}
                {#if analyticsSummary.panelActions.length > 0}
                    <p class="shelf-label" style="margin-top:16px">Panel button usage</p>
                    <div class="insights-list">
                        {#each analyticsSummary.panelActions as a}
                            <div class="insights-row">
                                <span class="insights-label">{a.action}</span>
                                <span class="insights-count">{a.count}</span>
                            </div>
                        {/each}
                    </div>
                {/if}
                {#if analyticsSummary.topGenres.length > 0}
                    <p class="shelf-label" style="margin-top:16px">
                        Top genres <span class="muted">(from library titles with fetched genres)</span>
                    </p>
                    <div class="insights-genre-grid">
                        {#each analyticsSummary.topGenres as g}
                            {@const max = analyticsSummary.topGenres[0]?.count ?? 1}
                            <div class="genre-bar-row">
                                <span class="genre-label">{g.genre}</span>
                                <div class="genre-bar-track">
                                    <div class="genre-bar-fill" style="width:{Math.round((g.count / max) * 100)}%">
                                    </div>
                                </div>
                                <span class="genre-count muted">{g.count}</span>
                            </div>
                        {/each}
                    </div>
                {/if}
                {#if analyticsSummary.topAuthors.length > 0}
                    <p class="shelf-label" style="margin-top:16px">Top authors</p>
                    <div class="insights-list">
                        {#each analyticsSummary.topAuthors as a}
                            <div class="insights-row">
                                <span class="insights-label">{a.author}</span>
                                <span class="insights-count">{a.count} titles</span>
                            </div>
                        {/each}
                    </div>
                {/if}
                {#if analyticsSummary.statusBreakdown.length > 0}
                    <p class="shelf-label" style="margin-top:16px">Library by status</p>
                    <div class="insights-list">
                        {#each [...analyticsSummary.statusBreakdown].sort((a, b) => b.count - a.count) as s}
                            <div class="insights-row">
                                <span class="insights-label" style="text-transform:capitalize">{s.status}</span>
                                <span class="insights-count">{s.count} titles</span>
                            </div>
                        {/each}
                    </div>
                {/if}
            {/if}

            {#if communityProfile?.communityStats}
                <p class="shelf-label" style="margin-top:36px">Community</p>
                {#if communityProfile.communityRank}
                    <div class="stat-row">
                        <div class="stat-box">
                            <strong>#{communityProfile.communityRank}</strong><span>Your rank this week</span>
                        </div>
                        <div class="stat-box">
                            <strong>{communityProfile.communityStats.totalUsers}</strong><span>Total readers</span>
                        </div>
                    </div>
                {:else if communityProfile.userId}
                    <p class="muted">Read more chapters to appear on the leaderboard.</p>
                {:else if communityProfile.enabled}
                    <p class="muted">Set a username in Settings to join the community.</p>
                {/if}
                {#if communityProfile.communityStats.leaderboard.length > 0}
                    <p class="shelf-label" style="margin-top:16px">Weekly leaderboard</p>
                    <div class="insights-list">
                        {#each communityProfile.communityStats.leaderboard.slice(0, 10) as entry}
                            <div
                                class="insights-row"
                                class:insights-row-highlight={entry.username === communityProfile.username}>
                                <span class="insights-label">#{entry.rank} {entry.username}</span>
                                <span class="insights-count">{entry.chaptersWeek} ch</span>
                            </div>
                        {/each}
                    </div>
                {/if}
                {#if communityProfile.communityStats.trendingManga.length > 0}
                    <p class="shelf-label" style="margin-top:16px">Trending this week</p>
                    <div class="insights-list">
                        {#each communityProfile.communityStats.trendingManga.slice(0, 5) as manga}
                            <div class="insights-row">
                                <span class="insights-label">{manga.title}</span>
                                <span class="insights-count">{manga.count} readers</span>
                            </div>
                        {/each}
                    </div>
                {/if}
                {#if communityProfile.recommendations.length > 0}
                    <p class="shelf-label" style="margin-top:16px">Recommended for you</p>
                    <div class="insights-list">
                        {#each communityProfile.recommendations as rec}
                            <div class="insights-row">
                                <span class="insights-label">{rec.title}</span>
                                <span class="insights-count muted">{rec.sourceId}</span>
                            </div>
                        {/each}
                    </div>
                {/if}
            {:else if communityProfile?.enabled && communityProfile.userId}
                <p class="shelf-label" style="margin-top:36px">Community</p>
                <p class="muted">Syncing your reading history… stats appear after the first sync completes.</p>
                <button
                    class="btn-outline btn-sm"
                    style="margin-top:8px"
                    disabled={communitySyncing}
                    onclick={() => void syncNow()}>
                    {communitySyncing ? "Syncing…" : "Sync now"}
                </button>
            {:else if !communityProfile?.userId}
                <p class="shelf-label" style="margin-top:36px">Community</p>
                <p class="muted">
                    Set a community username in <button class="link-btn" onclick={() => (activeSection = "Settings")}
                        >Settings</button> to join the leaderboard.
                </p>
            {/if}
        {:else if activeSection === "Sources"}
            {#if !hasPermission}
                <div class="permission-banner">
                    <div>
                        <p class="row-label">Site access required</p>
                        <p class="muted">
                            Grant permissions to browse MangaDex and read chapters from all supported sites.
                        </p>
                    </div>
                    <button type="button" onclick={grantPermission}>Grant access</button>
                </div>
            {/if}

            <p class="muted search-hint">
                Use the search box on the Home tab to look up a title across every source. Below are all sites you can
                browse directly.
            </p>

            {#if sourcesList.length > 0}
                <div class="page-head">
                    <p class="shelf-label" style="margin-bottom:0">Browse a source ({sourcesList.length})</p>
                    <button
                        type="button"
                        class="btn-sm"
                        onclick={() => void pingSources()}
                        disabled={pinging}
                        aria-busy={pinging}>
                        {pinging ? "Checking…" : "Re-check sites"}
                    </button>
                </div>
                {#if searchCapableSources.length > 0}
                    <div class="source-search-bar">
                        <span class="source-search-summary muted">
                            Searching {searchEnabledCount} of {searchCapableSources.length} sources
                        </span>
                        <span class="source-search-actions">
                            <button type="button" class="btn-outline btn-sm" onclick={() => void enableAllSearch()}>
                                Enable all
                            </button>
                            <button type="button" class="btn-outline btn-sm" onclick={() => void disableAllSearch()}>
                                Disable all
                            </button>
                        </span>
                    </div>
                {/if}
                <p class="muted search-hint">
                    Open a site in a new tab, or toggle Search to pick which sources aggregate queries hit. The dot
                    shows reachability: green = live, yellow = bot-gated (chapters still load via tab), red =
                    unreachable, grey = not checked yet.
                </p>
                <div class="adapter-grid">
                    {#each sourcesListAlpha as src}
                        {@const pingStatus = pingState.get(src.id)}
                        {@const count = sourceTitleCounts.get(src.id) ?? 0}
                        {@const searchOn = !searchDisabledSet.has(src.id)}
                        <div class="adapter-chip">
                            <span class="adapter-head">
                                <span
                                    class="status-dot"
                                    class:alive={pingStatus === "live"}
                                    class:gated={pingStatus === "gated"}
                                    class:dead={pingStatus === "dead"}
                                    title={pingStatus === undefined
                                        ? "Not checked"
                                        : pingStatus === "live"
                                          ? "Live"
                                          : pingStatus === "gated"
                                            ? "Bot-gated - Cloudflare or rate-limited. Chapters still load via tab."
                                            : "Unreachable"}></span>
                                <span class="adapter-name">{src.name}</span>
                            </span>
                            <span class="adapter-caps muted">
                                {src.capabilities.join(", ")}{#if src.canSearch}
                                    · search{/if}
                            </span>
                            <div class="adapter-footer">
                                <button
                                    type="button"
                                    class="adapter-open"
                                    onclick={() => openSourceSite(src)}
                                    title={`Open ${src.name}`}>
                                    Open site ↗
                                </button>
                                {#if count > 0}
                                    <span class="adapter-count">{count} title{count !== 1 ? "s" : ""}</span>
                                {/if}
                            </div>
                            {#if src.canSearch}
                                <button
                                    type="button"
                                    role="switch"
                                    class="search-toggle"
                                    class:on={searchOn}
                                    aria-checked={searchOn}
                                    aria-label={`Search ${src.name}`}
                                    onclick={() => void toggleSourceSearch(src)}>
                                    <span class="search-toggle-track"><span class="search-toggle-thumb"></span></span>
                                    <span class="search-toggle-label">Search {searchOn ? "on" : "off"}</span>
                                </button>
                            {:else}
                                <span class="adapter-nosearch muted">No search</span>
                            {/if}
                        </div>
                    {/each}
                </div>
            {/if}
        {:else if activeSection === "Data"}
            <h1>Import & Export</h1>
            <div class="data-list">
                <div class="data-row">
                    <div>
                        <p class="row-label">Backup library</p>
                        <p class="muted">
                            Export manga, chapters, progress, and history as JSON. Add a passphrase to encrypt it
                            (AES-GCM) - you'll need the same passphrase to restore.
                        </p>
                        <input
                            type="password"
                            class="passphrase-input"
                            placeholder="Optional passphrase to encrypt"
                            autocomplete="new-password"
                            bind:value={exportPassphrase} />
                    </div>
                    <button type="button" onclick={() => void exportData()}>Export</button>
                </div>
                <div class="data-row">
                    <div>
                        <p class="row-label">Export diagnostic log</p>
                        <p class="muted">
                            A redacted text log of recent activity (chapter fetches, update checks, errors) to help
                            diagnose a problem. Includes your library's titles/sources but no tokens.
                        </p>
                    </div>
                    <button type="button" onclick={() => void exportLog()}>Export log</button>
                </div>
                <div class="data-row">
                    <div>
                        <p class="row-label">Restore backup</p>
                        <p class="muted">Import a previously exported StoryHoard backup file (plain or encrypted).</p>
                    </div>
                    <label class="file-label">
                        Import
                        <input
                            type="file"
                            accept="application/json,.json"
                            onchange={e => {
                                const input = e.currentTarget
                                const f = input.files?.[0]
                                // Reset so selecting the same file again (e.g. after a
                                // cancelled/failed import) still fires a change event.
                                input.value = ""
                                if (f) void importData(f)
                            }} />
                    </label>
                </div>
                <div class="data-row" style="flex-direction:column;align-items:flex-start;gap:8px">
                    <div>
                        <p class="row-label">Import from another reader</p>
                        <p class="muted">
                            Bring a library across from Mihon, Tachiyomi (SY, J2K, Aniyomi, Neko) or Mangayomi. Titles,
                            read progress, categories and AniList links import; a title whose source isn't supported
                            here comes in as tracking-only. This only adds to your library, it never wipes it.
                        </p>
                    </div>
                    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                        <select bind:value={readerImportFormat} aria-label="Backup format">
                            {#each IMPORT_FORMATS as f}
                                <option value={f.id}>{f.label}</option>
                            {/each}
                        </select>
                        <label class="file-label">
                            Choose file
                            <input
                                type="file"
                                accept={readerImportAccept}
                                onchange={e => {
                                    const input = e.currentTarget
                                    const f = input.files?.[0]
                                    input.value = ""
                                    if (f) void previewReaderImport(f)
                                }} />
                        </label>
                        {#if readerImportWorking && !readerImportPreview}<span class="muted">Reading…</span>{/if}
                    </div>
                    {#if readerImportPreview}
                        <div style="display:flex;flex-direction:column;gap:8px;width:100%">
                            <p class="muted">
                                {readerImportPreview.total} titles found: {readerImportPreview.withAniList} with an AniList
                                link, {readerImportPreview.trackingOnly} tracking-only, {readerImportPreview.withProgress}
                                with read progress.
                            </p>
                            <div style="display:flex;gap:8px">
                                <button
                                    type="button"
                                    disabled={readerImportWorking}
                                    onclick={() => void confirmReaderImport()}>
                                    {readerImportWorking ? "Importing…" : `Import ${readerImportPreview.total} titles`}
                                </button>
                                <button type="button" class="btn-outline" onclick={cancelReaderImport}>Cancel</button>
                            </div>
                        </div>
                    {/if}
                    {#if readerImportMessage}<p class="muted">{readerImportMessage}</p>{/if}
                </div>
                {#if pendingEncryptedText}
                    <div class="data-row" style="flex-direction:column;align-items:flex-start;gap:8px">
                        <div>
                            <p class="row-label">Encrypted backup</p>
                            <p class="muted">This file is encrypted. Enter its passphrase to restore.</p>
                        </div>
                        <div style="display:flex;gap:8px;align-items:center;width:100%">
                            <input
                                type="password"
                                class="passphrase-input"
                                style="flex:1"
                                placeholder="Passphrase"
                                autocomplete="off"
                                bind:value={importPassphrase}
                                onkeydown={e => {
                                    if (e.key === "Enter") void decryptAndImport()
                                }} />
                            <button
                                type="button"
                                disabled={importWorking || !importPassphrase}
                                onclick={() => void decryptAndImport()}>
                                {importWorking ? "Decrypting…" : "Decrypt & import"}
                            </button>
                            <button
                                type="button"
                                class="btn-outline"
                                onclick={() => {
                                    pendingEncryptedText = null
                                    importPassphrase = ""
                                    importError = ""
                                }}>Cancel</button>
                        </div>
                        {#if importError}<p class="muted" style="color:var(--color-warn)">{importError}</p>{/if}
                    </div>
                {/if}
                <div class="data-row">
                    <div>
                        <p class="row-label">Sample data</p>
                        <p class="muted">
                            Load test chapters from MangaDex, MangaRead, and Mgeko to explore the reader.
                        </p>
                    </div>
                    <button type="button" class="btn-outline" onclick={seedData}>Load samples</button>
                </div>
                <div class="data-row">
                    <div>
                        <p class="row-label">Repair auto-tracked entries</p>
                        <p class="muted">
                            Finds library titles that were created as a fallback when a chapter couldn't be matched to a
                            real source page (e.g. during a period a source was broken), and merges the duplicates into
                            one properly-linked title.
                        </p>
                    </div>
                    <button
                        type="button"
                        class="btn-outline"
                        disabled={cleanupScanning}
                        onclick={() => void runCleanupScan()}>
                        {cleanupScanning ? "Scanning…" : "Scan"}
                    </button>
                </div>
                <div class="data-row">
                    <div>
                        <p class="row-label">Offline downloads</p>
                        <p class="muted">
                            Chapters saved for offline reading, stored inside the extension (not a folder on disk).
                            Download from the reader's ⬇ button; they're served automatically when you reopen the
                            chapter. Use the reader's CBZ ⤓ button to export a downloaded chapter to a real CBZ file on
                            disk.
                        </p>
                    </div>
                    <span class="data-count">{downloadsCount} {downloadsCount === 1 ? "chapter" : "chapters"}</span>
                </div>
                <div class="data-row" style="flex-direction:column;align-items:flex-start;gap:10px">
                    <div>
                        <p class="row-label">Backups</p>
                        <p class="muted">
                            Automatic safety-net snapshots taken before imports, syncs, clears, and repairs. Restoring
                            replaces the current library with the snapshot (and itself takes a snapshot first, so a
                            restore is always undoable).
                        </p>
                    </div>
                    {#if backupsList.length === 0}
                        <p class="muted">No backups yet.</p>
                    {:else}
                        <div class="conflict-list" style="width:100%;max-height:none">
                            {#each backupsList as backup (backup.id)}
                                <div
                                    class="conflict-row"
                                    style="grid-template-columns:1fr auto;grid-template-rows:auto">
                                    <span class="conflict-name" style="grid-row:1">{backup.reason}</span>
                                    <span class="conflict-hint muted" style="grid-row:2">
                                        {new Date(backup.createdAt).toLocaleString()}
                                    </span>
                                    <div style="grid-column:2;grid-row:1 / 3;display:flex;gap:6px">
                                        {#if backupRestoreConfirm === backup.id}
                                            <button
                                                type="button"
                                                class="btn-outline"
                                                onclick={() => (backupRestoreConfirm = null)}>Cancel</button>
                                            <button
                                                type="button"
                                                class="btn-danger"
                                                disabled={backupRestoring}
                                                onclick={() => void restoreBackupById(backup.id)}>
                                                {backupRestoring ? "Restoring…" : "Yes, restore"}
                                            </button>
                                        {:else}
                                            <button
                                                type="button"
                                                class="btn-sm"
                                                onclick={() => (backupRestoreConfirm = backup.id)}>Restore</button>
                                        {/if}
                                    </div>
                                </div>
                            {/each}
                        </div>
                    {/if}
                    {#if backupMessage}
                        <p class="notice" role="status" aria-live="polite">{backupMessage}</p>
                    {/if}
                </div>
            </div>
            {#if cleanupResult}
                <div class="conflict-panel">
                    <p class="conflict-title">
                        {cleanupResult.groups.length} title{cleanupResult.groups.length !== 1 ? "s" : ""} found from
                        {cleanupResult.candidateCount} auto-tracked entr{cleanupResult.candidateCount !== 1
                            ? "ies"
                            : "y"}
                        {#if cleanupResult.unresolved.length > 0}
                            · {cleanupResult.unresolved.length} could not be resolved
                        {/if}
                    </p>
                    <div class="conflict-list" style="max-height:360px">
                        {#each cleanupResult.groups as group (group.canonicalId)}
                            <div
                                style="display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:6px;background:var(--surface-raised, rgba(255,255,255,0.03))">
                                <div style="display:flex;align-items:center;gap:8px">
                                    <input
                                        type="checkbox"
                                        checked={cleanupSelected[group.canonicalId] !== false}
                                        onchange={e =>
                                            (cleanupSelected = {
                                                ...cleanupSelected,
                                                [group.canonicalId]: e.currentTarget.checked
                                            })} />
                                    <span class="conflict-name" style="max-width:none">{group.canonicalTitle}</span>
                                    <span class="conflict-hint muted" style="max-width:none">
                                        {group.sourceId} · {group.records.length} entr{group.records.length !== 1
                                            ? "ies"
                                            : "y"}{group.selfHeal ? " · self-heal" : ""}{group.inLibrary
                                            ? " · already in library"
                                            : ""}
                                    </span>
                                    <button
                                        type="button"
                                        class="btn-sm"
                                        style="margin-left:auto"
                                        onclick={() =>
                                            (cleanupExpanded = {
                                                ...cleanupExpanded,
                                                [group.canonicalId]: !cleanupExpanded[group.canonicalId]
                                            })}>
                                        {cleanupExpanded[group.canonicalId] ? "Hide" : "Show"} entries
                                    </button>
                                </div>
                                {#if cleanupExpanded[group.canonicalId]}
                                    <div style="padding-left:26px;display:flex;flex-direction:column;gap:4px">
                                        {#each group.records as record (record.mangaId)}
                                            <p class="muted" style="font-size:12px;margin:0">
                                                {record.title} - {record.sourceUrl} - ch.
                                                {record.matchedChapterNumbers.join(", ") || "?"} ({record.matchedBy})
                                            </p>
                                        {/each}
                                        {#if group.overflowCount}
                                            <p class="muted" style="font-size:12px;margin:0">
                                                …and {group.overflowCount} more (picked up on a later scan)
                                            </p>
                                        {/if}
                                    </div>
                                {/if}
                            </div>
                        {/each}
                    </div>
                    {#if cleanupResult.unresolved.length > 0}
                        <p class="conflict-hint muted" style="margin:0">Unresolved:</p>
                        <div class="conflict-list">
                            {#each cleanupResult.unresolved as u (u.mangaId)}
                                <div class="conflict-row">
                                    <span class="conflict-name">{u.title}</span>
                                    <span class="conflict-hint muted">{u.sourceId} · {u.reason}</span>
                                </div>
                            {/each}
                        </div>
                    {/if}
                    <div class="conflict-actions">
                        <button type="button" class="btn-outline" onclick={cancelCleanup}>Cancel</button>
                        <button
                            type="button"
                            disabled={cleanupApplying || cleanupSelectedGroups.length === 0}
                            onclick={() => void applyCleanup()}>
                            {cleanupApplying
                                ? "Merging…"
                                : `Merge ${cleanupSelectedEntryCount} entries into ${cleanupSelectedGroups.length} titles`}
                        </button>
                    </div>
                </div>
            {:else if cleanupMessage}
                <p class="notice" role="status" aria-live="polite">
                    {cleanupMessage}
                    {#if cleanupBackupId !== null}
                        <button type="button" class="btn-sm" onclick={() => void undoCleanup()}>Undo</button>
                    {/if}
                </p>
            {/if}
            {#if importWorking && importConflicts.length === 0}
                <p class="notice muted" role="status" aria-live="polite">Working…</p>
            {:else if importConflicts.length > 0}
                <div class="conflict-panel">
                    <p class="conflict-title">
                        {importConflicts.length} conflict{importConflicts.length !== 1 ? "s" : ""} - {importConflicts.length}
                        title{importConflicts.length !== 1 ? "s" : ""} already exist in your library.
                    </p>
                    <div class="conflict-bulk">
                        <span class="muted">Apply to all:</span>
                        <button type="button" class="btn-sm" onclick={() => setAllResolutions("overwrite")}
                            >Overwrite all</button>
                        <button type="button" class="btn-sm" onclick={() => setAllResolutions("merge")}
                            >Merge all</button>
                        <button type="button" class="btn-sm" onclick={() => setAllResolutions("skip")}>Skip all</button>
                    </div>
                    <div class="conflict-list">
                        {#each importConflicts as conflict}
                            <div class="conflict-row">
                                <span class="conflict-name" title={conflict.mangaId}>{conflict.existingTitle}</span>
                                <span class="conflict-hint muted">
                                    {#if conflict.importedTitle !== conflict.existingTitle}
                                        "{conflict.importedTitle}" in backup ·
                                    {/if}
                                    {new Date(conflict.importedUpdatedAt).toLocaleDateString()} in backup
                                </span>
                                <select class="conflict-select" bind:value={importResolutions[conflict.mangaId]}>
                                    <option value="overwrite">Overwrite</option>
                                    <option value="merge">Merge</option>
                                    <option value="skip">Skip</option>
                                </select>
                            </div>
                        {/each}
                    </div>
                    {#if importError}
                        <p class="notice" role="alert" style="color:var(--error,#f87171);margin:0">{importError}</p>
                    {/if}
                    <div class="conflict-actions">
                        <button type="button" class="btn-outline" onclick={cancelImport}>Cancel</button>
                        <button type="button" disabled={importWorking} onclick={() => void confirmImport()}>
                            {importWorking ? "Importing…" : "Import"}
                        </button>
                    </div>
                </div>
            {:else if dataMessage}
                <p class="notice" role="status" aria-live="polite">{dataMessage}</p>
            {/if}
            {#if showImportBackupHint && !accountLinked}
                <div class="import-backup-hint">
                    <span
                        >Keep this safe: a free weeb.ltd account backs your library up automatically and syncs it across
                        devices.</span>
                    <div class="account-nudge-actions">
                        <button type="button" onclick={startSignIn}>Create a free account</button>
                        <button type="button" class="btn-outline" onclick={() => (showImportBackupHint = false)}>
                            Not now
                        </button>
                    </div>
                </div>
            {/if}

            <ImportReconcile
                mangas={library.filter(m => reconcileIds.includes(m.id) && !isReadOnlyDiscoverAdd(m))}
                onLinked={id => {
                    reconcileIds = reconcileIds.filter(rid => rid !== id)
                    if (reconcileIds.length === 0 && dataMessage.includes("need a live source")) {
                        dataMessage = dataMessage.replace(/\s*\d+ titles? need a live source[^.]*\.?/i, "").trim()
                    }
                    scheduleLoad()
                }} />

            <ImportReconcile
                mangas={library.filter(m => libScanIds.includes(m.id))}
                heading="Find better sources - {libScanIds.length} {libScanIds.length === 1 ? 'title' : 'titles'}"
                hint="Search all sources for each manga in your library. Use this to find a source with more chapters or better availability."
                isLibraryScan={true}
                onLinked={id => {
                    libScanIds = libScanIds.filter(lid => lid !== id)
                    scheduleLoad()
                }} />

            <h1 style="margin-top:32px">GitHub Gist sync</h1>
            <div class="data-list">
                <div class="data-row">
                    <div>
                        <p class="row-label">Personal access token</p>
                        <p class="muted">
                            A token with the <code>gist</code> scope. Stored locally on this device only.
                            {syncStatus?.hasToken ? " A token is saved." : ""}
                        </p>
                    </div>
                    <div class="sync-token">
                        <input
                            type="password"
                            placeholder={syncStatus?.hasToken ? "••••••• (saved)" : "ghp_…"}
                            bind:value={syncToken} />
                        <button type="button" onclick={saveSyncToken} disabled={!syncToken.trim()}>Save</button>
                    </div>
                </div>
                <div class="data-row">
                    <div>
                        <p class="row-label">Gist ID</p>
                        <p class="muted">Leave blank to create a new private gist on first push.</p>
                    </div>
                    <input class="sync-gist" placeholder="(auto)" bind:value={syncGistId} onchange={saveGistId} />
                </div>
                <div class="data-row">
                    <div>
                        <p class="row-label">Auto-sync</p>
                        <p class="muted">Push the backup to the gist hourly when enabled.</p>
                    </div>
                    <label class="toggle">
                        <input
                            type="checkbox"
                            checked={syncStatus?.autoSync ?? false}
                            disabled={!syncStatus?.hasToken}
                            onchange={e => void toggleAutoSync(e.currentTarget.checked)} />
                        <span class="track"></span>
                    </label>
                </div>
                <div class="data-row">
                    <div>
                        <p class="row-label">Sync now</p>
                        <p class="muted">
                            {syncStatus?.lastPushedAt
                                ? `Last pushed ${new Date(syncStatus.lastPushedAt).toLocaleString()}.`
                                : "Not pushed yet."}
                        </p>
                    </div>
                    <div class="sync-actions">
                        <button type="button" onclick={pushSync} disabled={!syncStatus?.hasToken || syncing}>
                            Push
                        </button>
                        <button
                            type="button"
                            class="btn-outline"
                            onclick={pullSync}
                            disabled={!syncStatus?.hasToken || !syncStatus?.gistId || syncing}>
                            Pull
                        </button>
                    </div>
                </div>
            </div>
            {#if syncMessage}<p class="notice">{syncMessage}</p>{/if}

            <h1 style="margin-top:32px">AniList sync</h1>
            <div class="data-list">
                <div class="data-row">
                    <div style="flex:1">
                        <p class="row-label">Account</p>
                        {#if anilistStatus?.hasToken}
                            <p class="muted">
                                {anilistStatus?.viewerName ? `Connected as ${anilistStatus.viewerName}.` : "Connected."} Token
                                stored locally on this device only.
                            </p>
                        {:else}
                            <p class="muted">
                                Connect AniList to sync your read progress. Your token is stored locally on this device
                                only and never sent anywhere but AniList.
                            </p>
                            <ol
                                class="anilist-steps"
                                style="margin:8px 0 0;padding-left:20px;line-height:1.9;max-width:580px">
                                <li>
                                    Open
                                    <a
                                        href="https://anilist.co/settings/developer"
                                        target="_blank"
                                        rel="noopener noreferrer">anilist.co/settings/developer</a>
                                    and click <strong>Create New Client</strong>.
                                </li>
                                <li><strong>Name:</strong> anything, for example <code>StoryHoard</code>.</li>
                                <li>
                                    <strong>Redirect URL:</strong> paste this exactly:
                                    <span
                                        class="copy-field"
                                        style="display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap">
                                        <code>{ANILIST_PIN_REDIRECT}</code>
                                        <button type="button" class="btn-sm" onclick={() => void copyAniListRedirect()}>
                                            {anilistRedirectCopied ? "Copied" : "Copy"}
                                        </button>
                                    </span>
                                </li>
                                <li>
                                    Click <strong>Save</strong>, then copy the <strong>Client ID</strong> it shows (a
                                    number, e.g. <code>47574</code>).
                                </li>
                                <li>
                                    Paste your <strong>Client ID</strong> here:
                                    <input
                                        type="text"
                                        inputmode="numeric"
                                        class="anilist-clientid"
                                        style="margin-left:6px;width:200px"
                                        placeholder="Client ID, e.g. 47574"
                                        bind:value={anilistClientId} />
                                </li>
                                {#if anilistAuthorizeUrl}
                                    <li>
                                        Copy this URL, open it in your browser, and approve. AniList then shows your
                                        <strong>access token</strong> - copy that.
                                        <span
                                            class="copy-field"
                                            style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:4px">
                                            <code style="word-break:break-all">{anilistAuthorizeUrl}</code>
                                            <button
                                                type="button"
                                                class="btn-sm"
                                                onclick={() => void copyAniListAuthorize()}>
                                                {anilistAuthorizeCopied ? "Copied" : "Copy"}
                                            </button>
                                            <a href={anilistAuthorizeUrl} target="_blank" rel="noopener noreferrer">
                                                Open
                                            </a>
                                        </span>
                                    </li>
                                {:else}
                                    <li class="muted">Enter your Client ID above to get your authorize URL.</li>
                                {/if}
                                <li>Paste the token in the box below and click <strong>Connect</strong>.</li>
                            </ol>
                            <div class="sync-token" style="margin-top:10px">
                                <input type="password" placeholder="AniList token" bind:value={anilistToken} />
                                <button
                                    type="button"
                                    onclick={() => void saveAniListToken()}
                                    disabled={!anilistToken.trim()}>
                                    Connect
                                </button>
                            </div>
                        {/if}
                    </div>
                    {#if anilistStatus?.hasToken}
                        <div class="sync-token">
                            <button type="button" class="btn-outline" onclick={() => void disconnectAniList()}>
                                Disconnect
                            </button>
                        </div>
                    {/if}
                </div>
                <div class="data-row">
                    <div>
                        <p class="row-label">Auto-sync</p>
                        <p class="muted">Push read progress to AniList every few hours when enabled.</p>
                    </div>
                    <label class="toggle">
                        <input
                            type="checkbox"
                            checked={anilistStatus?.autoSync ?? false}
                            disabled={!anilistStatus?.hasToken}
                            onchange={e => void toggleAniListAutoSync(e.currentTarget.checked)} />
                        <span class="track"></span>
                    </label>
                </div>
                <div class="data-row">
                    <div>
                        <p class="row-label">Sync library membership</p>
                        <p class="muted">
                            Also add titles to your AniList list (unread as Planning) and remove a title's entry when
                            you remove it here. This changes your AniList list, not just progress.
                        </p>
                    </div>
                    <label class="toggle">
                        <input
                            type="checkbox"
                            checked={anilistStatus?.syncMembership ?? false}
                            disabled={!anilistStatus?.hasToken}
                            onchange={e => void toggleAniListMembership(e.currentTarget.checked)} />
                        <span class="track"></span>
                    </label>
                </div>
                <div class="data-row">
                    <div>
                        <p class="row-label">Push status to AniList</p>
                        <p class="muted">
                            When you mark a title paused, dropped, planning, or completed here, set the same status on
                            its AniList entry.
                        </p>
                    </div>
                    <label class="toggle">
                        <input
                            type="checkbox"
                            checked={anilistStatus?.statusPush ?? false}
                            disabled={!anilistStatus?.hasToken}
                            onchange={e => void toggleAniListStatusSync("statusPush", e.currentTarget.checked)} />
                        <span class="track"></span>
                    </label>
                </div>
                <div class="data-row">
                    <div>
                        <p class="row-label">Pull status from AniList</p>
                        <p class="muted">
                            Apply the status you set on AniList back onto your library here. With both push and pull on,
                            the side you changed most recently wins.
                        </p>
                    </div>
                    <label class="toggle">
                        <input
                            type="checkbox"
                            checked={anilistStatus?.statusPull ?? false}
                            disabled={!anilistStatus?.hasToken}
                            onchange={e => void toggleAniListStatusSync("statusPull", e.currentTarget.checked)} />
                        <span class="track"></span>
                    </label>
                </div>
                <div class="data-row">
                    <div>
                        <p class="row-label">Sync now</p>
                        <p class="muted">
                            Pushes each title's chapter progress (whole numbers). Never lowers your AniList progress.
                            {anilistStatus?.lastSyncAt
                                ? `Last synced ${new Date(anilistStatus.lastSyncAt).toLocaleString()}.`
                                : ""}
                        </p>
                    </div>
                    <button
                        type="button"
                        onclick={() => void syncAniListNow()}
                        disabled={!anilistStatus?.hasToken || anilistSyncing}>
                        {anilistSyncing ? "Syncing…" : "Sync now"}
                    </button>
                </div>
                {#if anilistStatus?.hasToken}
                    <div class="data-row">
                        <div>
                            <p class="row-label">Import my AniList list</p>
                            <p class="muted">
                                Pull your AniList manga into the library. New titles are added without a source, then
                                appear in the reconcile panel so you can attach a mirror. Existing titles are skipped.
                            </p>
                        </div>
                        <button type="button" onclick={() => void importAniListNow()} disabled={anilistImporting}>
                            {anilistImporting ? "Importing…" : "Import"}
                        </button>
                    </div>
                    <div class="data-row">
                        <div>
                            <p class="row-label">What to import</p>
                            <p class="muted">Unchecking skips those entries from your AniList lists on import.</p>
                            <div class="detail-toggles" style="margin-top:8px">
                                <label class="menu-toggle">
                                    <input
                                        type="checkbox"
                                        checked={settings?.anilistImportPaused ?? true}
                                        onchange={e =>
                                            void updateSetting({ anilistImportPaused: e.currentTarget.checked })} />
                                    Import paused titles
                                </label>
                                <label class="menu-toggle">
                                    <input
                                        type="checkbox"
                                        checked={settings?.anilistImportDropped ?? true}
                                        onchange={e =>
                                            void updateSetting({ anilistImportDropped: e.currentTarget.checked })} />
                                    Import dropped titles
                                </label>
                                <label class="menu-toggle">
                                    <input
                                        type="checkbox"
                                        checked={settings?.anilistImportPlanning ?? false}
                                        onchange={e =>
                                            void updateSetting({ anilistImportPlanning: e.currentTarget.checked })} />
                                    Import planning titles
                                </label>
                            </div>
                        </div>
                    </div>
                {/if}
            </div>
            {#if anilistMessage}<p class="notice">{anilistMessage}</p>{/if}
        {:else}
            <h1>Settings</h1>
            {#if showAccountNudge}
                <div class="account-nudge">
                    <button type="button" class="account-nudge-x" aria-label="Dismiss" onclick={dismissAccountNudge}
                        >✕</button>
                    <p class="account-nudge-title">Get more from your library</p>
                    <p class="muted">
                        A free weeb.ltd account syncs your library across devices, keeps an automatic cloud backup, and
                        unlocks community features. Recommended.
                    </p>
                    <div class="account-nudge-actions">
                        <button type="button" onclick={startSignIn}>Create a free account</button>
                        <button type="button" class="btn-outline" onclick={() => jumpToSettings("account")}>
                            I already have a code
                        </button>
                    </div>
                </div>
            {/if}
            <div class="settings-shell">
                <aside class="settings-rail">
                    <input
                        class="settings-search"
                        type="search"
                        placeholder="Find a setting"
                        aria-label="Find a setting"
                        bind:value={settingsQuery} />
                    <nav aria-label="Settings sections">
                        {#each SETTINGS_SECTIONS as s (s.id)}
                            <button
                                type="button"
                                class:active={settingsActive === s.id}
                                class:danger={s.id === "danger"}
                                hidden={!sectionVisible(s.id)}
                                onclick={() => jumpToSettings(s.id)}>
                                {s.label}
                            </button>
                        {/each}
                    </nav>
                </aside>
                <div class="settings-body" use:settingsScrollSpy>
                    <section
                        id="settings-library"
                        class="settings-section"
                        data-settings-section="library"
                        hidden={!sectionVisible("library")}>
                        <header>
                            <h2>Library &amp; updates</h2>
                            <p class="muted">
                                What gets saved, how often we look for new chapters, and how the extension itself
                                updates.
                            </p>
                        </header>
                        <div class="settings-grid">
                            <div class="settings-row" hidden={!settingMatches("Auto-add manga")}>
                                <div>
                                    <p class="row-label">Auto-add manga</p>
                                    <p class="muted">Save titles automatically when a supported chapter is opened.</p>
                                </div>
                                <label class="toggle">
                                    <input
                                        type="checkbox"
                                        checked={settings?.autoAdd ?? true}
                                        onchange={e => changeAutoAdd(e.currentTarget.checked)} />
                                    <span class="track"></span>
                                </label>
                            </div>
                            <div class="settings-row" hidden={!settingMatches("Track reading on the source site")}>
                                <div>
                                    <p class="row-label">Track reading on the source site</p>
                                    <p class="muted">
                                        Mark a chapter read when you open it on the source site, not just in the
                                        StoryHoard reader. Only ever moves progress forward.
                                    </p>
                                </div>
                                <label class="toggle">
                                    <input
                                        type="checkbox"
                                        checked={settings?.markReadOnVisit ?? true}
                                        onchange={e =>
                                            void updateSetting({ markReadOnVisit: e.currentTarget.checked })} />
                                    <span class="track"></span>
                                </label>
                            </div>
                            <div class="settings-row" hidden={!settingMatches("Update schedule")}>
                                <div>
                                    <p class="row-label">Update schedule</p>
                                    <p class="muted">How often background checks run for new chapters.</p>
                                </div>
                                <div style="display:flex;gap:8px;align-items:center">
                                    <select
                                        aria-label="Update schedule"
                                        value={updateIntervalSelection}
                                        onchange={e => changeUpdateInterval(e.currentTarget.value)}>
                                        <option value={0}>Manual only</option>
                                        <option value={6}>Every 6 h</option>
                                        <option value={12}>Every 12 h</option>
                                        <option value={24}>Daily</option>
                                    </select>
                                    {#if updateIntervalSaved}<span class="saved-flash">✓ Saved</span>{/if}
                                </div>
                            </div>
                            <div class="settings-row" hidden={!settingMatches("Auto-pause after N days")}>
                                <div>
                                    <p class="row-label">Auto-pause after N days</p>
                                    <p class="muted">
                                        Titles with no reading for this many days show as paused. 0 disables auto-pause.
                                    </p>
                                </div>
                                <input
                                    type="number"
                                    min="0"
                                    step="1"
                                    aria-label="Auto-pause after days of no reading"
                                    style="width:96px"
                                    value={autoPauseDays}
                                    onchange={e => void changeAutoPauseDays(e.currentTarget.value)} />
                            </div>
                            <div class="settings-row" hidden={!settingMatches("New-chapter notifications")}>
                                <div>
                                    <p class="row-label">New-chapter notifications</p>
                                    <p class="muted">
                                        Show a desktop notification when an update check finds new chapters.
                                    </p>
                                </div>
                                <label class="toggle">
                                    <input
                                        type="checkbox"
                                        checked={settings?.notifyNewChapters ?? true}
                                        onchange={e =>
                                            void updateSetting({ notifyNewChapters: e.currentTarget.checked })} />
                                    <span class="track"></span>
                                </label>
                            </div>
                            <div class="settings-row" hidden={!settingMatches("Daily automatic backup")}>
                                <div>
                                    <p class="row-label">Daily automatic backup</p>
                                    <p class="muted">
                                        Keep a rolling on-device restore point, refreshed daily when your library
                                        changes. Restore from Data.
                                    </p>
                                </div>
                                <label class="toggle">
                                    <input
                                        type="checkbox"
                                        checked={settings?.autoBackup !== false}
                                        onchange={e => void updateSetting({ autoBackup: e.currentTarget.checked })} />
                                    <span class="track"></span>
                                </label>
                            </div>
                            <div class="settings-row" hidden={!settingMatches("Extension updates")}>
                                <div>
                                    <p class="row-label">Extension updates</p>
                                    <p class="muted">
                                        {#if extensionUpdate?.available}
                                            v{extensionUpdate.latestVersion} is available.
                                        {:else if extensionUpdate}
                                            Up to date (v{extensionUpdate.latestVersion}).
                                        {:else}
                                            Check for a new version of StoryHoard.
                                        {/if}
                                    </p>
                                </div>
                                <div style="display:flex;gap:8px;align-items:center">
                                    {#if extensionUpdate?.available}
                                        <button
                                            type="button"
                                            class="btn-sm"
                                            onclick={() =>
                                                void browser.tabs.create({ url: extensionUpdate!.releaseUrl })}>
                                            Download ↗
                                        </button>
                                    {/if}
                                    <button
                                        type="button"
                                        class="btn-outline btn-sm"
                                        disabled={checkingExtUpdate}
                                        onclick={() => void checkForExtensionUpdate()}>
                                        {checkingExtUpdate ? "Checking…" : "Check now"}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </section>
                    <section
                        id="settings-reader"
                        class="settings-section"
                        data-settings-section="reader"
                        hidden={!sectionVisible("reader")}>
                        <header>
                            <h2>Reader</h2>
                            <p class="muted">
                                Defaults for the reader. Each can still be changed per chapter from the reader toolbar.
                            </p>
                        </header>
                        <div class="settings-grid">
                            <div class="settings-row" hidden={!settingMatches("Default view")}>
                                <div>
                                    <p class="row-label">Default view</p>
                                    <p class="muted">
                                        How a title opens the first time. Strip is one continuous scroll; Single is one
                                        page at a time; Double shows two-page spreads. Your per-title choice in the
                                        reader is remembered and overrides this.
                                    </p>
                                </div>
                                <select
                                    aria-label="Default view"
                                    value={(settings?.readingSpread ?? 1) === 2
                                        ? "double"
                                        : (settings?.readingMode ?? "continuous") === "single"
                                          ? "single"
                                          : "strip"}
                                    onchange={e => {
                                        const v = e.currentTarget.value
                                        void updateSetting(
                                            v === "strip"
                                                ? { readingMode: "continuous", readingSpread: 1 }
                                                : v === "single"
                                                  ? { readingMode: "single", readingSpread: 1 }
                                                  : { readingMode: "single", readingSpread: 2 }
                                        )
                                    }}>
                                    <option value="strip">Strip (continuous scroll)</option>
                                    <option value="single">Single page</option>
                                    <option value="double">Double page</option>
                                </select>
                            </div>
                            <div class="settings-row" hidden={!settingMatches("Reading direction")}>
                                <div>
                                    <p class="row-label">Reading direction</p>
                                    <p class="muted">Left-to-right, right-to-left (manga), or vertical (webtoon).</p>
                                </div>
                                <select
                                    aria-label="Reading direction"
                                    value={settings?.readingDirection ?? "ltr"}
                                    onchange={e =>
                                        void updateSetting({
                                            readingDirection: e.currentTarget.value as "ltr" | "rtl" | "vertical"
                                        })}>
                                    <option value="ltr">Left to right</option>
                                    <option value="rtl">Right to left</option>
                                    <option value="vertical">Vertical</option>
                                </select>
                            </div>
                            <div class="settings-row" hidden={!settingMatches("Page fit")}>
                                <div>
                                    <p class="row-label">Page fit</p>
                                    <p class="muted">How pages are scaled to the viewport.</p>
                                </div>
                                <select
                                    aria-label="Page fit"
                                    value={settings?.pageFit ?? "width"}
                                    onchange={e =>
                                        void updateSetting({
                                            pageFit: e.currentTarget.value as
                                                | "width"
                                                | "height"
                                                | "contain"
                                                | "original"
                                                | "actual"
                                        })}>
                                    <option value="width">Fit width</option>
                                    <option value="height">Fit height</option>
                                    <option value="contain">Fit screen</option>
                                    <option value="original">Original size</option>
                                    <option value="actual">Actual size (native resolution)</option>
                                </select>
                            </div>
                            <div class="settings-row" hidden={!settingMatches("Page width")}>
                                <div>
                                    <p class="row-label">Page width</p>
                                    <p class="muted">
                                        How much of the width Fit-width fills: {settings?.pageWidthPct ?? 100}%. Lower
                                        it for long strips, raise it to fill the screen.
                                    </p>
                                </div>
                                <input
                                    type="range"
                                    min="30"
                                    max="100"
                                    step="5"
                                    aria-label="Page width percent"
                                    value={settings?.pageWidthPct ?? 100}
                                    onchange={e =>
                                        void updateSetting({ pageWidthPct: Number(e.currentTarget.value) })} />
                            </div>
                            <div class="settings-row" hidden={!settingMatches("Show page number")}>
                                <div>
                                    <p class="row-label">Show page number</p>
                                    <p class="muted">Overlay the current page number while reading.</p>
                                </div>
                                <label class="toggle">
                                    <input
                                        type="checkbox"
                                        checked={settings?.showPageNumber ?? true}
                                        onchange={e =>
                                            void updateSetting({ showPageNumber: e.currentTarget.checked })} />
                                    <span class="track"></span>
                                </label>
                            </div>
                            <div class="settings-row" hidden={!settingMatches("Double-page gap")}>
                                <div>
                                    <p class="row-label">Double-page gap</p>
                                    <p class="muted">
                                        Space between the two pages in Double-page mode: {settings?.spreadGapPx ?? 8}px.
                                        Seamless spreads ignore this.
                                    </p>
                                </div>
                                <input
                                    type="range"
                                    min="0"
                                    max="40"
                                    step="1"
                                    aria-label="Double-page gap in pixels"
                                    value={settings?.spreadGapPx ?? 8}
                                    onchange={e =>
                                        void updateSetting({ spreadGapPx: Number(e.currentTarget.value) })} />
                            </div>
                            <div
                                class="settings-row"
                                hidden={!settingMatches("Remove gaps between pages (continuous mode)")}>
                                <div>
                                    <p class="row-label">Remove gaps between pages (continuous mode)</p>
                                    <p class="muted">
                                        Seamless webtoon-style scroll with no vertical gap between page images.
                                    </p>
                                </div>
                                <div style="display:flex;gap:8px;align-items:center">
                                    <label class="toggle">
                                        <input
                                            type="checkbox"
                                            checked={noGapSelection}
                                            onchange={e => void changeNoGapContinuous(e.currentTarget.checked)} />
                                        <span class="track"></span>
                                    </label>
                                    {#if noGapSelectionSaved}<span class="saved-flash">✓ Saved</span>{/if}
                                </div>
                            </div>
                            <div class="settings-row" hidden={!settingMatches("Preload pages")}>
                                <div>
                                    <p class="row-label">Preload pages</p>
                                    <p class="muted">How many upcoming pages load eagerly (0-10).</p>
                                </div>
                                <input
                                    type="number"
                                    min="0"
                                    max="10"
                                    aria-label="Preload pages"
                                    value={settings?.preloadPages ?? 3}
                                    onchange={e =>
                                        void updateSetting({
                                            preloadPages: Math.max(0, Math.min(10, Number(e.currentTarget.value) || 0))
                                        })} />
                            </div>
                            <div class="settings-row" hidden={!settingMatches("Open chapters in")}>
                                <div>
                                    <p class="row-label">Open chapters in</p>
                                    <p class="muted">
                                        The built-in reader, or the source site in your browser. (Ctrl/middle-click
                                        always opens the source.)
                                    </p>
                                </div>
                                <select
                                    aria-label="Open chapters in"
                                    value={settings?.openChapterIn ?? "reader"}
                                    onchange={e =>
                                        void updateSetting({
                                            openChapterIn: e.currentTarget.value as "reader" | "browser"
                                        })}>
                                    <option value="reader">Built-in reader</option>
                                    <option value="browser">Source site</option>
                                </select>
                            </div>
                            <div class="settings-row" hidden={!settingMatches("Chapter language")}>
                                <div>
                                    <p class="row-label">Chapter language</p>
                                    <p class="muted">Preferred translation language for MangaDex chapter listings.</p>
                                </div>
                                <select
                                    aria-label="Chapter language"
                                    value={settings?.language ?? "en"}
                                    onchange={e => void updateSetting({ language: e.currentTarget.value })}>
                                    <option value="en">English</option>
                                    <option value="es">Spanish</option>
                                    <option value="es-la">Spanish (Latin America)</option>
                                    <option value="fr">French</option>
                                    <option value="pt-br">Portuguese (Brazil)</option>
                                    <option value="de">German</option>
                                    <option value="ru">Russian</option>
                                    <option value="id">Indonesian</option>
                                    <option value="it">Italian</option>
                                    <option value="pl">Polish</option>
                                    <option value="ja">Japanese</option>
                                    <option value="ko">Korean</option>
                                    <option value="zh">Chinese</option>
                                    <option value="zh-hk">Chinese (Hong Kong)</option>
                                    <option value="ar">Arabic</option>
                                    <option value="vi">Vietnamese</option>
                                </select>
                            </div>
                        </div>
                    </section>
                    <section
                        id="settings-appearance"
                        class="settings-section"
                        data-settings-section="appearance"
                        hidden={!sectionVisible("appearance")}>
                        <header>
                            <h2>Appearance &amp; habits</h2>
                            <p class="muted">Theme, your daily goal, and what stays blurred on the shelf.</p>
                        </header>
                        <div class="settings-grid">
                            <div class="settings-row" hidden={!settingMatches("Theme")}>
                                <div>
                                    <p class="row-label">Theme</p>
                                    <p class="muted">Dark, light, or follow your system setting.</p>
                                </div>
                                <select
                                    aria-label="Theme"
                                    value={settings?.theme ?? "dark"}
                                    onchange={e =>
                                        void updateSetting({
                                            theme: e.currentTarget.value as "dark" | "light" | "system"
                                        })}>
                                    <option value="dark">Dark</option>
                                    <option value="light">Light</option>
                                    <option value="system">System</option>
                                </select>
                            </div>
                            <div class="settings-row" hidden={!settingMatches("Start page")}>
                                <div>
                                    <p class="row-label">Start page</p>
                                    <p class="muted">Which page StoryHoard opens to.</p>
                                </div>
                                <select
                                    aria-label="Start page"
                                    value={settings?.startPage ?? "discover"}
                                    onchange={e =>
                                        void updateSetting({
                                            startPage: e.currentTarget.value as "discover" | "library"
                                        })}>
                                    <option value="discover">Discover</option>
                                    <option value="library">Library</option>
                                </select>
                            </div>
                            <div class="settings-row" hidden={!settingMatches("Community link")}>
                                <div>
                                    <p class="row-label">Show weeb.ltd Community link</p>
                                    <p class="muted">
                                        Adds a Community link to the sidebar and footer. Hides automatically if the site
                                        is unreachable.
                                    </p>
                                </div>
                                <label class="menu-toggle">
                                    <input
                                        type="checkbox"
                                        checked={settings?.showCommunity ?? true}
                                        onchange={e =>
                                            void updateSetting({ showCommunity: e.currentTarget.checked })} />
                                </label>
                            </div>
                            <div class="settings-row" hidden={!settingMatches("Daily reading goal")}>
                                <div>
                                    <p class="row-label">Daily reading goal</p>
                                    <p class="muted">
                                        Chapters per day to aim for (0 disables). Shown on the Stats tab.
                                    </p>
                                </div>
                                <input
                                    type="number"
                                    min="0"
                                    max="50"
                                    aria-label="Daily reading goal"
                                    value={settings?.dailyGoal ?? 0}
                                    onchange={e =>
                                        void updateSetting({
                                            dailyGoal: Math.max(0, Math.min(50, Number(e.currentTarget.value) || 0))
                                        })} />
                            </div>
                            <div class="settings-row" hidden={!settingMatches("Blur NSFW covers")}>
                                <div>
                                    <p class="row-label">Blur NSFW covers</p>
                                    <p class="muted">
                                        Blur covers of titles you've marked NSFW (from the detail view).
                                    </p>
                                </div>
                                <label class="toggle">
                                    <input
                                        type="checkbox"
                                        checked={settings?.blurNsfw ?? true}
                                        onchange={e => void updateSetting({ blurNsfw: e.currentTarget.checked })} />
                                    <span class="track"></span>
                                </label>
                            </div>
                        </div>
                    </section>
                    <section
                        id="settings-account"
                        class="settings-section"
                        data-settings-section="account"
                        hidden={!sectionVisible("account")}>
                        <header>
                            <h2>weeb.ltd account</h2>
                            <p class="muted">
                                Sync your library across browsers and devices through your weeb.ltd account.
                            </p>
                        </header>
                        <div class="settings-grid">
                            {#if accountProfile?.token}
                                <div class="settings-row" hidden={!settingMatches("weeb.ltd account")}>
                                    <div>
                                        <p class="row-label">
                                            Linked{accountProfile.name ? ` as ${accountProfile.name}` : ""}
                                            {#if accountProfile.invalid}<span class="muted"> · token revoked</span>{/if}
                                        </p>
                                        <p class="muted">
                                            {accountProfile.lastSyncAt
                                                ? `Last synced ${new Date(accountProfile.lastSyncAt).toLocaleString()} · ${accountProfile.itemCount ?? 0} titles on the account.`
                                                : "Not synced yet."}
                                        </p>
                                    </div>
                                    <div class="sync-actions">
                                        <button
                                            type="button"
                                            onclick={() => void syncAccountNow()}
                                            disabled={accountBusy || accountProfile.invalid}>
                                            {accountBusy ? "Syncing…" : "Sync now"}
                                        </button>
                                        <button type="button" class="btn-outline" onclick={() => void unlinkAccount()}
                                            >Unlink</button>
                                    </div>
                                </div>
                            {:else}
                                <div class="settings-row" hidden={!settingMatches("Link this device")}>
                                    <div>
                                        <p class="row-label">Link this device</p>
                                        <p class="muted">
                                            Sync your library across browsers and devices. Create a link token at
                                            <a href={`${SITE_BASE}/account`} target="_blank" rel="noopener noreferrer"
                                                >weeb.ltd/account</a>
                                            and paste it here. Stored locally on this device only.
                                        </p>
                                    </div>
                                    <div class="sync-token">
                                        <input
                                            type="password"
                                            placeholder="weeb_…"
                                            bind:value={accountToken}
                                            onkeydown={e => {
                                                if (e.key === "Enter") void linkAccount()
                                            }} />
                                        <button
                                            type="button"
                                            onclick={() => void linkAccount()}
                                            disabled={!accountToken.trim() || accountBusy}>
                                            {accountBusy ? "Linking…" : "Link"}
                                        </button>
                                    </div>
                                </div>
                            {/if}
                        </div>
                        {#if accountMessage}<p class="notice">{accountMessage}</p>{/if}
                    </section>
                    <section
                        id="settings-community"
                        class="settings-section"
                        data-settings-section="community"
                        hidden={!sectionVisible("community")}>
                        <header>
                            <h2>Privacy &amp; community</h2>
                            <p class="muted">
                                Community features are opt-in. Anonymous usage analytics is on by default (legitimate
                                interest) and can be turned off here; it never includes your titles, reading, or
                                account.
                            </p>
                        </header>
                        <div class="settings-grid">
                            {#if !communityConfigured}
                                <p class="muted">Community features are not configured in this build.</p>
                            {/if}
                            <div class="settings-row" hidden={!settingMatches("Community features")}>
                                <div>
                                    <p class="row-label">Community features</p>
                                    <p class="muted">
                                        Send anonymous usage and a username you choose to power install counts,
                                        leaderboards, and recommendations. We never sell your data.
                                    </p>
                                </div>
                                <label class="toggle">
                                    <input
                                        type="checkbox"
                                        checked={communityProfile?.enabled ?? false}
                                        onchange={e => void toggleCommunity(e.currentTarget.checked)} />
                                    <span class="track"></span>
                                </label>
                            </div>
                            {#if analyticsConfigured}
                                <div class="settings-row" hidden={!settingMatches("Usage analytics")}>
                                    <div>
                                        <p class="row-label">Usage analytics</p>
                                        <p class="muted">
                                            Anonymous counts of which screens and features you use, plus app version, to
                                            help improve the app. On by default; never your titles, reading, notes, or
                                            account. Turn it off any time.
                                        </p>
                                    </div>
                                    <label class="toggle">
                                        <input
                                            type="checkbox"
                                            checked={settings?.usageAnalytics ?? true}
                                            onchange={e =>
                                                void updateSetting({ usageAnalytics: e.currentTarget.checked })} />
                                        <span class="track"></span>
                                    </label>
                                </div>
                            {/if}
                            <div
                                class="settings-row"
                                style="flex-direction:column;align-items:flex-start;gap:6px"
                                hidden={!settingMatches("What we collect")}>
                                <p class="row-label">What we collect</p>
                                <ul class="policy-list">
                                    {#each DATA_COLLECTED as item}<li>{item}</li>{/each}
                                </ul>
                                <button type="button" class="link-btn" onclick={() => (showPolicy = !showPolicy)}>
                                    {showPolicy ? "Hide privacy policy" : "Read the full privacy policy"}
                                </button>
                                {#if showPolicy}
                                    <div class="policy-doc">
                                        {#each PRIVACY_POLICY as section}
                                            <h4>{section.heading}</h4>
                                            {#each section.body as line}<p class="muted">{line}</p>{/each}
                                        {/each}
                                        <p class="muted">
                                            Hosted copy:
                                            <a href={POLICY_URL} target="_blank" rel="noopener noreferrer"
                                                >{POLICY_URL}</a>
                                        </p>
                                    </div>
                                {/if}
                                {#if communityProfile}
                                    <p class="muted">
                                        {#if communityProfile.consentVersion > 0}
                                            You accepted v{communityProfile.consentVersion} on {new Date(
                                                communityProfile.consentAt
                                            ).toLocaleDateString()}.
                                        {:else}
                                            Community features are off. Nothing is collected.
                                        {/if}
                                    </p>
                                {/if}
                            </div>
                            {#if communityProfile?.enabled}
                                <div
                                    class="settings-row"
                                    style="flex-direction:column;align-items:flex-start;gap:8px"
                                    hidden={!settingMatches("Community username")}>
                                    <div>
                                        <p class="row-label">Community username</p>
                                        <p class="muted">
                                            {#if communityProfile.userId}
                                                Registered as <strong>{communityProfile.username}</strong>. Your reading
                                                data syncs hourly.
                                            {:else}
                                                Choose a display name for the leaderboard. Letters, numbers, emoji, _
                                                and - allowed.
                                            {/if}
                                        </p>
                                    </div>
                                    {#if !communityProfile.userId}
                                        <div style="display:flex;gap:8px;align-items:center;width:100%">
                                            <input
                                                type="text"
                                                placeholder="your-username"
                                                maxlength="30"
                                                style="flex:1"
                                                bind:value={communityUsernameInput}
                                                onkeydown={e => {
                                                    if (e.key === "Enter") void registerCommunity()
                                                }} />
                                            <button onclick={() => void registerCommunity()}>Join</button>
                                        </div>
                                        {#if communityRegisterError}
                                            <p class="muted" style="color:var(--color-warn)">
                                                {communityRegisterError}
                                            </p>
                                        {/if}
                                    {/if}
                                </div>
                            {/if}
                            {#if communityProfile?.userId}
                                <div
                                    class="settings-row"
                                    style="flex-direction:column;align-items:flex-start;gap:8px"
                                    hidden={!settingMatches("Delete my community data")}>
                                    <div>
                                        <p class="row-label">Delete my community data</p>
                                        <p class="muted">
                                            Permanently removes your username, votes, and reading events from our
                                            server.
                                        </p>
                                    </div>
                                    {#if deleteDataConfirm}
                                        <div style="display:flex;gap:8px">
                                            <button
                                                type="button"
                                                class="btn-sm confirm-remove-btn armed"
                                                disabled={deleteDataWorking}
                                                onclick={() => void deleteCommunityData()}
                                                >{deleteDataWorking ? "Deleting…" : "Confirm delete"}</button>
                                            <button
                                                type="button"
                                                class="btn-sm"
                                                onclick={() => (deleteDataConfirm = false)}>Cancel</button>
                                        </div>
                                    {:else}
                                        <button type="button" class="btn-sm" onclick={() => (deleteDataConfirm = true)}
                                            >Delete my community data</button>
                                    {/if}
                                </div>
                            {/if}
                        </div>
                    </section>
                    <section
                        id="settings-danger"
                        class="settings-section danger"
                        data-settings-section="danger"
                        hidden={!sectionVisible("danger")}>
                        <header>
                            <h2>Danger zone</h2>
                            <p class="muted">These cannot be undone. Take a backup from the Data tab first.</p>
                        </header>
                        <div class="settings-grid">
                            <div
                                class="settings-row"
                                style="flex-direction:column;align-items:flex-start;gap:10px"
                                hidden={!settingMatches("Clear reading history")}>
                                <div>
                                    <p class="row-label">Clear reading history</p>
                                    <p class="muted">
                                        Removes all history events and reading progress. Library manga and chapters are
                                        kept.
                                    </p>
                                </div>
                                {#if clearConfirm === "history"}
                                    <p class="muted" style="color:var(--color-warn)">
                                        This removes all history and progress and cannot be undone.
                                    </p>
                                    <div style="display:flex;gap:8px">
                                        <button class="btn-outline" onclick={() => (clearConfirm = "")}>Cancel</button>
                                        <button
                                            class="btn-danger"
                                            disabled={clearWorking}
                                            onclick={() => void executeClear("history")}>
                                            {clearWorking ? "Clearing…" : "Yes, clear history"}
                                        </button>
                                    </div>
                                {:else}
                                    <button class="btn-outline" onclick={() => (clearConfirm = "history")}
                                        >Clear history</button>
                                {/if}
                            </div>
                            <div
                                class="settings-row"
                                style="flex-direction:column;align-items:flex-start;gap:10px"
                                hidden={!settingMatches("Clear entire library")}>
                                <div>
                                    <p class="row-label">Clear entire library</p>
                                    <p class="muted">
                                        Wipes all manga, chapters, history, bookmarks, and covers from local storage.
                                        Cannot be undone.
                                    </p>
                                </div>
                                {#if clearConfirm === "all"}
                                    <p class="muted" style="color:var(--color-warn)">
                                        Everything will be deleted permanently.
                                    </p>
                                    <div style="display:flex;gap:8px">
                                        <button class="btn-outline" onclick={() => (clearConfirm = "")}>Cancel</button>
                                        <button
                                            class="btn-danger"
                                            disabled={clearWorking}
                                            onclick={() => void executeClear("all")}>
                                            {clearWorking ? "Clearing…" : "Yes, wipe everything"}
                                        </button>
                                    </div>
                                {:else}
                                    <button class="btn-danger" onclick={() => (clearConfirm = "all")}
                                        >Clear library</button>
                                {/if}
                            </div>
                        </div>
                    </section>
                </div>
            </div>
        {/if}
    </main>
</div>

{#if detailManga}
    <div
        class="detail-overlay"
        role="button"
        tabindex="0"
        onclick={closeDetail}
        onkeydown={e => {
            if (e.key === "Escape" || e.key === "Enter") closeDetail()
        }}>
        <div
            class="detail-card"
            role="dialog"
            aria-label={detailManga.title}
            tabindex="0"
            onclick={e => e.stopPropagation()}
            onkeydown={() => {}}>
            <div class="detail-cover">
                {#if (coverSrcs[detailManga.id] ?? detailManga.coverUrl) && !failedCovers.has(detailManga.id)}<img
                        src={coverSrcs[detailManga.id] ?? detailManga.coverUrl}
                        alt=""
                        class:nsfw-blur={detailManga.nsfw && (settings?.blurNsfw ?? true)}
                        onerror={() => detailManga && coverFailed(detailManga.id)} />{:else}<span
                        class="cover-initial"
                        style="--ph-hue:{coverHue(detailManga.title)}">{detailManga.title[0]}</span
                    >{/if}
            </div>
            <div class="detail-body">
                <h2>{detailManga.title}</h2>
                <p class="muted">{detailManga.sourceId} · {detailManga.status}</p>
                {#if detailManga.authors && detailManga.authors.length > 0}
                    <p class="muted">by {detailManga.authors.join(", ")}</p>
                {/if}
                <p class="detail-meta">
                    {readChapterLabel(detailManga, "Read ch")}{#if detailManga.latestChapterNumber !== undefined}
                        · latest ch {detailManga.latestChapterNumber}{/if}
                    {#if detailManga.manualTracking}
                        · manual{/if}
                </p>
                <div class="poster-rating" role="group" aria-label="Rate">
                    {#each [1, 2, 3, 4, 5] as star}
                        <button
                            type="button"
                            class="star"
                            class:filled={(detailManga.rating ?? 0) >= star}
                            aria-label={`${star} star`}
                            onclick={() => {
                                if (detailManga) void rate(detailManga, star)
                            }}>★</button>
                    {/each}
                </div>
                {#if detailCommunityStats && (detailCommunityStats.ratingCount > 0 || detailCommunityStats.readerCount > 0)}
                    <div class="community-stats-row">
                        {#if detailCommunityStats.ratingCount > 0}
                            <span class="community-stat">
                                ★ {detailCommunityStats.avgRating?.toFixed(1)}
                                <span class="muted">({detailCommunityStats.ratingCount} ratings)</span>
                            </span>
                        {/if}
                        {#if detailCommunityStats.readerCount > 0}
                            <span class="community-stat muted">{detailCommunityStats.readerCount} readers</span>
                        {/if}
                    </div>
                {/if}
                <div class="detail-categories detail-section">
                    <span class="muted">Tags</span>
                    {#if (detailManga.categories ?? []).length > 0}
                        <div class="tag-chips">
                            {#each detailManga.categories ?? [] as tag}
                                <span class="tag-chip">
                                    <button
                                        type="button"
                                        class="tag-chip-label"
                                        title={`Filter library by "${tag}"`}
                                        onclick={() => {
                                            filterByTag(tag)
                                            closeDetail()
                                        }}>{tag}</button>
                                    <button
                                        type="button"
                                        class="tag-x"
                                        aria-label={`Remove ${tag}`}
                                        onclick={() => detailManga && void removeTag(detailManga, tag)}>×</button>
                                </span>
                            {/each}
                        </div>
                    {:else}
                        <p class="muted" style="font-size:12px">No tags yet.</p>
                    {/if}

                    <div class="tag-add">
                        <input
                            type="text"
                            placeholder="Add tags (comma-separated)…"
                            bind:value={tagDraft}
                            onkeydown={e => {
                                if (e.key === "Enter") {
                                    e.preventDefault()
                                    if (detailManga) void addTagDraft(detailManga)
                                }
                            }} />
                        <button
                            type="button"
                            class="btn-sm"
                            disabled={!tagDraft.trim()}
                            onclick={() => detailManga && void addTagDraft(detailManga)}>Add</button>
                    </div>

                    {#if detailGenres(detailManga).length > 0}
                        <div class="tag-suggested">
                            <span class="muted suggested-label">Genres (from source / AniList):</span>
                            <div class="tag-chips">
                                {#each detailGenres(detailManga) as g}
                                    <span class="tag-chip genre-chip-ro">{g}</span>
                                {/each}
                            </div>
                        </div>
                    {:else if genresLoading}
                        <p class="muted" style="font-size:12px">Loading genres…</p>
                    {/if}
                </div>
                <div class="detail-section">
                    <div class="detail-options-row">
                        <div class="detail-toggles">
                            <label class="menu-toggle">
                                <input
                                    type="checkbox"
                                    checked={detailManga.manualTracking ?? false}
                                    onchange={e =>
                                        detailManga && void setManual(detailManga, e.currentTarget.checked)} />
                                Manual tracking
                            </label>
                            <label class="menu-toggle">
                                <input
                                    type="checkbox"
                                    checked={detailManga.nsfw ?? false}
                                    onchange={e => detailManga && void setNsfw(detailManga, e.currentTarget.checked)} />
                                NSFW (blur cover)
                            </label>
                        </div>
                        <div class="detail-ch-col">
                            <div class="detail-ch-row">
                                <label class="menu-num">
                                    Read ch
                                    <input
                                        type="number"
                                        min="0"
                                        step="0.1"
                                        value={detailManga.lastReadChapterNumber ?? ""}
                                        onchange={e =>
                                            detailManga &&
                                            void setNumber(
                                                detailManga,
                                                "lastReadChapterNumber",
                                                e.currentTarget.value
                                            )} />
                                </label>
                                <label class="menu-num">
                                    Latest ch
                                    <input
                                        type="number"
                                        min="0"
                                        step="0.1"
                                        value={detailManga.latestChapterNumber ?? ""}
                                        onchange={e =>
                                            detailManga &&
                                            void setNumber(
                                                detailManga,
                                                "latestChapterNumber",
                                                e.currentTarget.value
                                            )} />
                                </label>
                            </div>
                            {#if detailManga.latestChapterNumber !== undefined && detailManga.lastReadChapterNumber !== undefined && detailManga.latestChapterNumber > detailManga.lastReadChapterNumber}
                                <p class="detail-next-ch">
                                    Next: Ch {detailManga.lastReadChapterNumber + 1} of {detailManga.latestChapterNumber}
                                </p>
                            {/if}
                        </div>
                    </div>
                </div>
                <div class="detail-categories detail-section">
                    <span class="muted">Status</span>
                    <div class="detail-reading-row" style="align-items:center">
                        <div class="view-toggle">
                            <button
                                type="button"
                                class="btn-sm"
                                class:active={detailEff === "reading" ||
                                    detailEff === "unread" ||
                                    detailEff === "completed"}
                                title="Clear override (back to reading)"
                                onclick={() => detailManga && void detailSetStatus(detailManga, "reading")}
                                >Reading</button>
                            <button
                                type="button"
                                class="btn-sm"
                                class:active={detailEff === "on-hold"}
                                title="Skips update checks and hides from the Reading tab without removing the title"
                                onclick={() => detailManga && void detailSetStatus(detailManga, "on-hold")}
                                >On Hold</button>
                            <button
                                type="button"
                                class="btn-sm"
                                class:active={detailEff === "dropped"}
                                onclick={() => detailManga && void detailSetStatus(detailManga, "dropped")}
                                >Dropped</button>
                            <button
                                type="button"
                                class="btn-sm"
                                class:active={detailEff === "planning"}
                                onclick={() => detailManga && void detailSetStatus(detailManga, "planning")}
                                >Planning</button>
                        </div>
                        <span class="list-status status-{detailEff}">{detailEff}</span>
                    </div>
                </div>
                <div class="detail-categories detail-section">
                    <span class="muted">Reading (this title only)</span>
                    <div class="detail-reading-row">
                        <label class="menu-num">
                            Direction
                            <select
                                value={detailManga.readingDirection ?? ""}
                                onchange={e =>
                                    detailManga && void setReadingDirection(detailManga, e.currentTarget.value)}>
                                <option value="">Global default</option>
                                <option value="ltr">Left → Right</option>
                                <option value="rtl">Right → Left</option>
                                <option value="vertical">Vertical</option>
                            </select>
                        </label>
                        <label class="menu-num">
                            Zoom / fit
                            <select
                                value={detailManga.pageFit ?? ""}
                                onchange={e =>
                                    detailManga && void setReadingPageFit(detailManga, e.currentTarget.value)}>
                                <option value="">Global default</option>
                                <option value="width">Fit width</option>
                                <option value="height">Fit height</option>
                                <option value="contain">Contain</option>
                                <option value="original">Original size</option>
                                <option value="actual">Actual size</option>
                            </select>
                        </label>
                        <label class="menu-num">
                            Page width
                            <select
                                value={detailManga.pageWidthPct != null ? String(detailManga.pageWidthPct) : ""}
                                onchange={e =>
                                    detailManga && void setReadingPageWidth(detailManga, e.currentTarget.value)}>
                                <option value="">Global default</option>
                                <option value="100">100%</option>
                                <option value="90">90%</option>
                                <option value="80">80%</option>
                                <option value="70">70%</option>
                                <option value="60">60%</option>
                                <option value="50">50%</option>
                                <option value="40">40%</option>
                            </select>
                        </label>
                    </div>
                </div>
                <label class="detail-categories detail-section">
                    <span class="muted">Notes</span>
                    <textarea
                        class="detail-notes"
                        rows="3"
                        placeholder="Private notes about this title…"
                        bind:value={noteDraft}
                        onblur={() => detailManga && void saveNote(detailManga)}></textarea>
                </label>
                {#if entryNeedsSource(detailManga, Boolean(updateStatus?.needsRelink?.[detailManga.id]))}
                    <div class="detail-categories detail-section">
                        <span class="muted">Find a live source (keeps your progress)</span>
                        <FindSource manga={detailManga} {hasPermission} onAdopted={onSourceAdopted} />
                    </div>
                {/if}
                <label class="detail-categories detail-section">
                    <span class="muted">Re-link source (paste a chapter URL from a new mirror)</span>
                    <div class="sync-token">
                        <input
                            type="url"
                            placeholder="https://newmirror.example/manga/…/chapter-…/"
                            bind:value={relinkUrl} />
                        <button
                            type="button"
                            onclick={() => detailManga && void relink(detailManga)}
                            disabled={!relinkUrl.trim()}>
                            Re-link
                        </button>
                    </div>
                    {#if relinkMessage}<span class="muted">{relinkMessage}</span>{/if}
                </label>
                <div class="detail-mirrors">
                    <button
                        type="button"
                        class="btn-sm"
                        disabled={mirrorChecking || !hasPermission}
                        title={hasPermission
                            ? "Search every supported source for this title"
                            : "Grant source access first"}
                        onclick={() => detailManga && void checkMirrors(detailManga)}>
                        {mirrorChecking ? "Checking mirrors…" : "Check mirrors"}
                    </button>
                    {#if !mirrorChecking && mirrorCheckedFor === detailManga.id}
                        {#if mirrorResults.length === 0}
                            <span class="muted">No other supported mirror found.</span>
                        {:else}
                            <div class="mirror-list">
                                {#each mirrorResults as r}
                                    <div class="mirror-row">
                                        <span class="mirror-source">{r.sourceId}</span>
                                        <span class="muted"
                                            >{r.latestChapter ? `latest ch ${r.latestChapter}` : "-"}</span>
                                        {#if detailManga && r.sourceId !== detailManga.sourceId}
                                            <button
                                                type="button"
                                                class="btn-sm"
                                                disabled={mirrorSwitching !== null}
                                                onclick={() => detailManga && void switchMirror(detailManga, r)}>
                                                {mirrorSwitching === r.sourceId ? "Switching…" : "Switch"}
                                            </button>
                                        {:else}
                                            <span class="muted">current</span>
                                        {/if}
                                        <button type="button" class="btn-sm" onclick={() => openExternal(r.url)}
                                            >Open</button>
                                    </div>
                                {/each}
                            </div>
                        {/if}
                    {/if}
                </div>
                <div class="detail-actions">
                    <button type="button" onclick={() => detailManga && openInReader(detailManga)}>Open reader</button>
                    <button
                        type="button"
                        class="btn-outline"
                        onclick={() => detailManga && openInBrowser(detailManga, true, { fallback: true })}>
                        Open source
                    </button>
                    <button
                        type="button"
                        class="btn-outline"
                        onclick={() => {
                            if (detailManga) {
                                const t = detailManga.title
                                closeDetail()
                                discoverSimilarTo(t)
                            }
                        }}>
                        Find similar
                    </button>
                    {#if openSourceError}<span class="muted" style="color:var(--color-warn)">{openSourceError}</span
                        >{/if}
                    <div class="detail-actions-spacer"></div>
                    <button
                        type="button"
                        class="btn-danger"
                        onclick={() => {
                            if (detailManga) {
                                void remove(detailManga.id)
                                closeDetail()
                            }
                        }}>Remove</button>
                    <button type="button" class="btn-outline" onclick={closeDetail}>Close</button>
                </div>
            </div>
        </div>
    </div>
{/if}

{#if sugToast}
    <div class="sug-toast" role="status" aria-live="polite">
        <span>{sugToast}</span>
        {#if sugToastAction}
            <button
                type="button"
                class="sug-toast-action"
                onclick={() => {
                    sugToastAction?.run()
                    sugToast = ""
                    sugToastAction = null
                }}>{sugToastAction.label}</button>
        {/if}
    </div>
{/if}

{#if showConsentCard}
    <div class="consent-card" role="region" aria-label="Community data consent">
        <div class="consent-body">
            <p class="consent-title">Help improve StoryHoard (optional)</p>
            <p class="muted">{CONSENT_SUMMARY}</p>
            <button type="button" class="link-btn" onclick={() => (consentExpand = !consentExpand)}>
                {consentExpand ? "Hide details" : "What we collect"}
            </button>
            {#if consentExpand}
                <ul class="policy-list">
                    {#each DATA_COLLECTED as item}<li>{item}</li>{/each}
                </ul>
                <p class="muted">
                    Full policy in Settings, or at
                    <a href={POLICY_URL} target="_blank" rel="noopener noreferrer">{POLICY_URL}</a>.
                </p>
            {/if}
        </div>
        <div class="consent-actions">
            <button type="button" class="consent-accept" onclick={() => void acceptConsent()}
                >Accept &amp; turn on community</button>
            <button type="button" class="btn-sm" onclick={() => void declineConsent()}
                >Disable community features</button>
            <p class="consent-note muted">{DECLINE_EXPLAINER}</p>
        </div>
    </div>
{/if}

{#if paletteOpen}
    <div
        class="palette-overlay"
        role="button"
        tabindex="0"
        onclick={() => (paletteOpen = false)}
        onkeydown={e => {
            if (e.key === "Escape") paletteOpen = false
        }}>
        <div
            class="palette"
            role="dialog"
            aria-label="Command palette"
            tabindex="-1"
            onclick={e => e.stopPropagation()}
            onkeydown={() => {}}>
            <input
                use:autofocus
                class="palette-input"
                placeholder="Jump to a tab or title…"
                bind:value={paletteQuery}
                onkeydown={e => {
                    if (e.key === "Enter" && paletteResults[0]) runPalette(paletteResults[0])
                }} />
            <div class="palette-list">
                {#each paletteResults.slice(0, 12) as item}
                    <button type="button" class="palette-item" onclick={() => runPalette(item)}>
                        <span class="palette-kind">{item.kind === "tab" ? "Tab" : "Title"}</span>
                        <span class="palette-label">{item.label}</span>
                    </button>
                {/each}
                {#if paletteResults.length === 0}
                    <p class="muted" style="padding:10px 12px">No matches.</p>
                {/if}
            </div>
            <p class="muted palette-hint">Ctrl/⌘-K to toggle · Enter opens the first result · Esc closes</p>
        </div>
    </div>
{/if}
