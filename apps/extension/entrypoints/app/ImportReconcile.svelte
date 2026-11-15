<script lang="ts">
    import type { LibraryManga } from "../../src/database"
    import { sendRuntimeMessage } from "../../src/runtime"
    import { buildLabelMapFromInfos, labelFromMap, type SourceLabelInfo } from "../../src/source-labels"
    import { runSettled } from "../../src/bulk"
    import { untrack, onMount } from "svelte"
    import {
        cleanQuery,
        normTitle,
        wordOverlap,
        dedupeCandidates,
        candidateSortByChapter,
        selectExactMatches,
        selectCloseMatches,
        scoreOverlapFallback,
        rankCandidates,
        filterEligibleCandidates,
        formatReconcileLog,
        type LinkAttempt,
        type TitleLogEntry,
        type SweepMeta
    } from "../../src/reconcile-match"

    type SearchResult = {
        title: string
        url: string
        sourceId: string
        sourceMangaId: string
        latestChapter?: string
        coverUrl?: string
    }

    type Props = {
        mangas: LibraryManga[]
        onLinked: (mangaId: string) => void
        heading?: string
        hint?: string
        // "Find better sources" scans the whole library, including titles with
        // perfectly working sources - unlike the dead-source reconcile flow, a
        // wrong-series exact-title collision there would silently repoint a WORKING
        // title's source (library:switch deletes the old source's cached chapter
        // records). Auto-link applies a stricter "strictly more chapters" rule
        // whenever this is true.
        isLibraryScan?: boolean
    }

    let { mangas, onLinked, heading, hint, isLibraryScan = false }: Props = $props()

    type CardState = {
        searching: boolean
        results: SearchResult[]
        linking: string | null
        message: string
        error: boolean
        searched: boolean
        urlInput: string
        urlLinking: boolean
        copied: boolean
    }

    const cards: Record<string, CardState> = $state({})
    // Per-manga "Copied" flash timers - keyed outside $state since the timer handle
    // itself isn't rendered, only the `copied` flag on the card is.
    const copyTimers: Record<string, ReturnType<typeof setTimeout>> = {}

    const PAGE_SIZE = 20
    let visibleCount = $state(PAGE_SIZE)
    const visible = $derived(mangas.slice(0, visibleCount))
    const hasMore = $derived(visibleCount < mangas.length)

    // Search-all progress state
    let searchingAll = $state(false)
    let stopRequested = $state(false)
    let searchProgress = $state({ done: 0, total: 0, current: "" })
    let autoLinkedCount = $state(0)
    let autoLinkEnabled = $state(true)
    let autoLinkedSummary = $state<Array<{ title: string; sourceId: string }>>([])

    // Sweep-scoped switch-failure memo: persists across the sequential
    // candidate-retry loop within one title AND across the worker pool within one
    // "Search all" run, but is cleared at the start of findAllSources() so it never
    // leaks into a later separate run. Not $state - only consulted internally by
    // the auto-link ranking below, never rendered. The manual per-result Link
    // button calls linkSource() directly and never reads this memo.
    const switchFailures = new Map<string, number>()

    // Structured "copy/download debug log" of what happened during search/link
    // attempts, for handing to a developer. Keyed by mangaId (not an array) since
    // findAllSources() runs a concurrent worker pool - a keyed record avoids
    // order-scrambling from concurrent appends. `let` (not `const`) so a fresh
    // sweep can reset it wholesale. Deliberately NOT reset when `mangas` empties
    // out (e.g. every title in a sweep successfully links) - see the template's
    // debug-log guard below, which renders this independently of `mangas.length`.
    let debugLog = $state<Record<string, TitleLogEntry>>({})
    let sweepMeta = $state<SweepMeta | null>(null)
    let debugLogCopied = $state(false)
    let debugLogCopyTimer: ReturnType<typeof setTimeout> | null = null

    function cardOf(id: string): CardState {
        if (!cards[id]) {
            untrack(() => {
                cards[id] = {
                    searching: false,
                    results: [],
                    linking: null,
                    message: "",
                    error: false,
                    searched: false,
                    urlInput: "",
                    urlLinking: false,
                    copied: false
                }
            })
        }
        return cards[id]!
    }

    // Auto-vivifies a TitleLogEntry the same way cardOf() auto-vivifies a
    // CardState. In practice this is always called after findSources() has
    // already run for this manga (the manual Link button only appears once
    // card.searched is true), so the "never had an entry" case described in the
    // LinkAttempt trigger contract is theoretical - but auto-vivifying here is
    // still correct even then, it just produces a log entry with empty search
    // fields rather than a true no-op.
    function entryOf(manga: LibraryManga): TitleLogEntry {
        if (!debugLog[manga.id]) {
            untrack(() => {
                debugLog[manga.id] = {
                    mangaId: manga.id,
                    title: manga.title,
                    deadSource: sourceDomain(manga),
                    lastReadChapterNumber: manga.lastReadChapterNumber ?? null,
                    latestChapterNumber: manga.latestChapterNumber ?? null,
                    cleanedQuery: "",
                    officialMarkerStripped: false,
                    rawTitleFallbackUsed: false,
                    searchErrors: [],
                    autoLink: null,
                    finalOutcome: "no-results",
                    finalMessage: ""
                }
            })
        }
        return debugLog[manga.id]!
    }

    function rawErrorMessage(cause: unknown): string {
        return cause instanceof Error ? cause.message : String(cause)
    }

    // Sources whose adapter manifest declares the "pages" capability, fetched once
    // from sources:list rather than plumbed through the search response schema.
    // Used purely as a rankCandidates tie-breaker (see reconcile-match.ts) - the
    // real fix for a single bad candidate (like kagane, which can silently return
    // an empty chapter list from a background-context Cloudflare 403, and always
    // fails library:switch as a result) is the retry loop below trying the next
    // ranked candidate rather than giving up after one linkSource() call.
    let pagesCapableSourceIds: Set<string> = new Set()
    let sourcesListPromise: Promise<void> | null = null

    function ensureSourcesList(): Promise<void> {
        if (!sourcesListPromise) {
            sourcesListPromise = sendRuntimeMessage<Array<{ id: string; capabilities: string[] }>>({
                type: "sources:list"
            })
                .then(list => {
                    pagesCapableSourceIds = new Set(list.filter(s => s.capabilities.includes("pages")).map(s => s.id))
                })
                .catch(() => {
                    pagesCapableSourceIds = new Set()
                })
        }
        return sourcesListPromise
    }

    let sourceLabels = $state<Map<string, string>>(new Map())
    function sourceName(sourceId: string): string {
        return labelFromMap(sourceLabels, sourceId)
    }
    async function loadSourceLabels() {
        try {
            sourceLabels = buildLabelMapFromInfos(
                await sendRuntimeMessage<SourceLabelInfo[]>({ type: "source:labels" })
            )
        } catch {
            // labels are cosmetic
        }
    }

    onMount(() => {
        void ensureSourcesList()
        void loadSourceLabels()
    })

    // sendRuntimeMessage() rejects with whatever message the background dispatcher
    // forwarded verbatim (see src/background/handler-types.ts's failure()) - for
    // network-layer failures (a source timing out, 403ing, etc.) that's raw debug
    // text like "Request failed with status 403 [https://kagane.to/series/…]",
    // never meant for a user to read as-is. Curated SourceError messages (e.g.
    // "No chapters on that mirror") have no such bracketed/status-coded suffix and
    // pass through unchanged; only the raw, technical-looking ones get swapped for
    // a friendly fallback. The raw message is still logged for our own debugging.
    const RAW_ERROR_PATTERN = /\[https?:\/\/|\brequest (failed|timed out)\b|\bstatus \d{3}\b/i
    function describeError(cause: unknown, fallback: string): string {
        console.warn("[AMR] reconcile action failed:", cause)
        const raw = cause instanceof Error ? cause.message : ""
        if (!raw || RAW_ERROR_PATTERN.test(raw)) return fallback
        return raw
    }

    async function dismissManual(manga: LibraryManga) {
        const card = cardOf(manga.id)
        card.searching = true
        card.error = false
        card.message = ""
        try {
            await sendRuntimeMessage({ type: "library:dismiss", mangaId: manga.id })
            onLinked(manga.id)
        } catch (cause) {
            card.error = true
            card.message = cause instanceof Error ? cause.message : "Failed to dismiss."
        } finally {
            card.searching = false
        }
    }

    async function removeTitle(manga: LibraryManga) {
        const card = cardOf(manga.id)
        card.searching = true
        card.error = false
        card.message = ""
        try {
            await sendRuntimeMessage({ type: "library:remove", mangaId: manga.id })
            onLinked(manga.id)
        } catch (cause) {
            card.error = true
            card.message = cause instanceof Error ? cause.message : "Failed to remove."
        } finally {
            card.searching = false
        }
    }

    let removingAll = $state(false)
    let removeAllMessage = $state("")
    let removeAllError = $state(false)

    // Each title is removed independently - a mid-loop failure (SW restart,
    // transient error, one bad id) must not stop the batch or silently swallow the
    // error. Only the ids that actually succeeded are handed to onLinked() (which
    // drops them from the reconcile list); failed ones stay on screen with a
    // partial-failure message so the user can retry just those.
    async function removeAll() {
        const targets = [...mangas]
        if (!confirm(`Remove all ${targets.length} titles from your library? This cannot be undone.`)) return
        removingAll = true
        removeAllMessage = ""
        removeAllError = false
        try {
            const { succeeded, failed } = await runSettled(targets, async manga => {
                await sendRuntimeMessage({ type: "library:remove", mangaId: manga.id })
            })
            for (const manga of succeeded) onLinked(manga.id)
            if (failed.length > 0) {
                removeAllError = true
                removeAllMessage = `Removed ${succeeded.length} of ${targets.length}. ${failed.length} failed - try again.`
            }
        } finally {
            removingAll = false
        }
    }

    // Titles like "Uncle from Another World (Official)" carry a bracketed
    // "official" marker that most scanlation-aggregator listings won't have. When
    // search comes back empty for one of these, say so plainly instead of implying
    // the match algorithm failed.
    const OFFICIAL_MARKER_PATTERN = /[(\[«][^)\]»]*\bofficial\b/i
    function noLiveSourceMessage(title: string): string {
        return OFFICIAL_MARKER_PATTERN.test(title)
            ? "This looks like an official/licensed release - it may not exist on any scanlation source. Track it manually or remove it."
            : "No live source found for this title."
    }

    async function findSources(manga: LibraryManga) {
        const card = cardOf(manga.id)
        const entry = entryOf(manga)
        card.searching = true
        card.message = ""
        card.error = false
        // Clear stale results from a previous attempt - otherwise a retry that finds
        // nothing (or errors) leaves the old, no-longer-relevant results on screen
        // alongside a message saying no match was found.
        card.results = []
        // Reset the per-search-attempt fields, but deliberately leave entry.autoLink
        // untouched - a manual "Retry search" shouldn't erase the auto-link history
        // (ranked/benched candidates, attempts) a prior sweep may have recorded for
        // this same manga.
        entry.title = manga.title
        entry.deadSource = sourceDomain(manga)
        entry.lastReadChapterNumber = manga.lastReadChapterNumber ?? null
        entry.latestChapterNumber = manga.latestChapterNumber ?? null
        entry.searchErrors = []
        delete entry.rawResultCount
        delete entry.closeMatchCount
        delete entry.displayedResultCount
        try {
            const cleanedQuery = cleanQuery(manga.title)
            entry.cleanedQuery = cleanedQuery
            entry.officialMarkerStripped = cleanedQuery !== manga.title
            entry.rawTitleFallbackUsed = false
            let all: SearchResult[]
            try {
                all = await sendRuntimeMessage<SearchResult[]>({ type: "manga:search", query: cleanedQuery })
            } catch (cause) {
                entry.searchErrors.push(rawErrorMessage(cause))
                await new Promise(r => setTimeout(r, 500))
                all = await sendRuntimeMessage<SearchResult[]>({ type: "manga:search", query: cleanedQuery })
            }
            // Retry with the untouched title if the cleaned query found nothing - guards
            // against a title where "Official" is genuinely load-bearing, not decoration.
            if (all.length === 0 && cleanedQuery !== manga.title) {
                entry.rawTitleFallbackUsed = true
                try {
                    all = await sendRuntimeMessage<SearchResult[]>({ type: "manga:search", query: manga.title })
                } catch (cause) {
                    entry.searchErrors.push(rawErrorMessage(cause))
                    all = []
                }
            }
            entry.rawResultCount = all.length
            const want = normTitle(cleanQuery(manga.title))
            const close = selectCloseMatches(all, want)
            entry.closeMatchCount = close.length
            if (close.length > 0) {
                card.results = dedupeCandidates(close).sort(candidateSortByChapter)
            } else if (all.length > 0) {
                const scored = scoreOverlapFallback(all, want)
                card.results = scored
                if (scored.length === 0) {
                    card.message = noLiveSourceMessage(manga.title)
                } else {
                    card.message = "No close title match found - pick manually if any look right."
                }
            } else {
                card.message = noLiveSourceMessage(manga.title)
            }
            card.searched = true
            if (card.results.length === 0) card.message = noLiveSourceMessage(manga.title)
            entry.displayedResultCount = card.results.length
            entry.finalOutcome = card.results.length === 0 ? "no-results" : "manual-candidates"
            entry.finalMessage =
                card.message || (card.results.length > 0 ? `${card.results.length} candidate(s) found.` : "")
        } catch (cause) {
            entry.searchErrors.push(rawErrorMessage(cause))
            card.error = true
            card.message = describeError(cause, "Search failed - try again in a moment.")
            entry.finalOutcome = "search-failed"
            entry.finalMessage = card.message
        } finally {
            card.searching = false
        }
    }

    // Returns true if the manga was auto-linked
    async function findSourcesWithAutoLink(manga: LibraryManga): Promise<boolean> {
        await findSources(manga)
        const entry = entryOf(manga)
        if (!autoLinkEnabled) return false
        const card = cardOf(manga.id)
        if (card.results.length === 0 || card.error) return false
        await ensureSourcesList()

        const want = normTitle(cleanQuery(manga.title))
        const exactMatches = selectExactMatches(card.results, want)
        // Preserve the old single-result >=85% word-overlap fallback for near-title
        // matches that don't normalize to an exact match, but keep it subject to the
        // exact same downstream eligibility/safety filters as an exact match - no
        // bypass around the libScan strictly-better check below.
        const overlapFallback =
            exactMatches.length === 0 &&
            card.results.length === 1 &&
            wordOverlap(normTitle(cleanQuery(card.results[0]!.title)), want) >= 0.85
                ? card.results
                : []
        const candidates = [...exactMatches, ...overlapFallback]
        const exactMatchSet = new Set(exactMatches)
        // "Find better sources" (isLibraryScan) can touch WORKING titles, unlike the
        // normal dead-source reconcile flow - a wrong-series exact-title collision
        // there would silently repoint a working source and library:switch deletes
        // the old source's chapter cache. Require a strictly-better candidate (more
        // chapters than what's already linked) in that context, on top of the shared
        // eligibility filters - see filterEligibleCandidates.
        const { eligible, filtered } = filterEligibleCandidates(candidates, manga, isLibraryScan, exactMatchSet)

        const ranked = rankCandidates(filtered, pagesCapableSourceIds)
        // Sources that have already failed library:switch repeatedly this sweep are
        // dropped entirely past 3 failures, and pushed to the back of the try-order
        // (rather than dropped) once they've failed once or twice - see
        // switchFailures above.
        const usable = ranked.filter(r => (switchFailures.get(r.sourceId) ?? 0) < 3)
        const benchedSourceIds = ranked.filter(r => (switchFailures.get(r.sourceId) ?? 0) >= 3).map(r => r.sourceId)
        const ordered = [
            ...usable.filter(r => (switchFailures.get(r.sourceId) ?? 0) < 2),
            ...usable.filter(r => (switchFailures.get(r.sourceId) ?? 0) >= 2)
        ].slice(0, 3)

        // Populate the debug-log funnel BEFORE the retry loop runs, and even on the
        // empty-eligible-pool path below - so "why didn't this auto-link" is always
        // answerable, not just recorded on a successful run. rankedSourceIds is
        // `ordered` (not `ranked`) deliberately: it must reflect the FINAL order
        // actually attempted, after both rankCandidates() and the switchFailures
        // reorder/filter above, not the pre-filter rank.
        entry.autoLink = {
            exactMatchCount: exactMatches.length,
            overlapFallbackUsed: overlapFallback.length > 0,
            eligibleCount: eligible.length,
            filteredCount: filtered.length,
            rankedSourceIds: ordered.map(r => r.sourceId),
            benchedSourceIds,
            attempts: []
        }

        if (filtered.length === 0) {
            entry.finalOutcome = "auto-link-exhausted"
            entry.finalMessage =
                "Search found results, but none passed the exact-match/eligibility filters for auto-link."
            return false
        }

        for (const candidate of ordered) {
            if (await linkSource(manga, candidate, "auto")) {
                autoLinkedSummary = [...autoLinkedSummary, { title: manga.title, sourceId: candidate.sourceId }]
                return true
            }
        }
        entry.finalOutcome = "auto-link-exhausted"
        entry.finalMessage = `Tried ${ordered.length} candidate(s), all failed to link.`
        return false
    }

    async function findAllSources() {
        searchingAll = true
        stopRequested = false
        autoLinkedCount = 0
        autoLinkedSummary = []
        switchFailures.clear()
        // Reset the debug-log accumulator wholesale for this sweep - a fresh run's
        // log shouldn't inherit stale entries from a previous run.
        debugLog = {}
        const queue = mangas.filter(m => {
            const c = cardOf(m.id)
            return !c.searched && !c.searching
        })
        searchProgress = { done: 0, total: queue.length, current: "" }
        sweepMeta = {
            startedAt: Date.now(),
            finishedAt: null,
            stopped: false,
            autoLinkEnabled,
            isLibraryScan,
            total: queue.length
        }

        // Safe at 6 only combined with sources.ts's searchManga skip-memo (repeated
        // race-timeouts bench a source for the rest of the sweep) and the mangahub
        // race-timeout exemption - both land alongside this change.
        const CONCURRENCY = 6
        let idx = 0

        async function worker() {
            while (idx < queue.length && !stopRequested) {
                const manga = queue[idx++]!
                searchProgress.current = manga.title
                const linked = await findSourcesWithAutoLink(manga)
                if (linked) autoLinkedCount++
                searchProgress.done++
            }
        }

        await Promise.all(Array.from({ length: CONCURRENCY }, worker))
        // One untargeted, fire-and-forget backfill at the end of the sweep -
        // preserves the incidental full-batch dead-cover drain that used to happen
        // on every single per-link backfill, without paying for it per-link.
        void sendRuntimeMessage({ type: "library:covers:backfill" }).catch(() => {})
        // Read stopRequested (the stop flag) BEFORE resetting it below, so a
        // user-stopped sweep is recorded as such rather than always reading false.
        if (sweepMeta) sweepMeta = { ...sweepMeta, finishedAt: Date.now(), stopped: stopRequested }
        searchingAll = false
        stopRequested = false
        searchProgress.current = ""
    }

    function stopSearch() {
        stopRequested = true
    }

    // Returns true on success, false on failure - lets the auto-link retry loop in
    // findSourcesWithAutoLink know whether to fall through to the next candidate.
    // card.linking is cleared on BOTH branches (not just the catch) since a
    // sequential multi-attempt caller needs the loading flag to never get stuck
    // true, whether the attempt that finally lands is the first one or the third.
    async function linkSource(
        manga: LibraryManga,
        result: SearchResult,
        trigger: "auto" | "manual" = "manual"
    ): Promise<boolean> {
        const card = cardOf(manga.id)
        const entry = entryOf(manga)
        card.linking = result.sourceId
        card.message = ""
        card.error = false
        try {
            await sendRuntimeMessage({
                type: "library:switch",
                mangaId: manga.id,
                sourceId: result.sourceId,
                sourceMangaId: result.sourceMangaId,
                mangaUrl: result.url,
                allowTabFallback: trigger === "manual"
            })
            switchFailures.delete(result.sourceId)
            const attempt: LinkAttempt = {
                sourceId: result.sourceId,
                resultTitle: result.title,
                latestChapter: result.latestChapter ?? null,
                outcome: "linked",
                trigger
            }
            entry.autoLink?.attempts.push(attempt)
            // A manual click that lands (whether or not this card ever went through
            // the auto-link path) is what actually resolved the title - overwrite
            // finalOutcome so the log doesn't stay stuck at a stale sweep result
            // like "auto-link-exhausted" after the user fixed it by hand.
            entry.finalOutcome = trigger === "manual" ? "manually-linked" : "auto-linked"
            entry.finalMessage = `Linked to ${sourceName(result.sourceId)} (${trigger}).`
            void sendRuntimeMessage({ type: "library:covers:backfill", mangaId: manga.id }).catch(() => {})
            onLinked(manga.id)
            card.linking = null
            return true
        } catch (cause) {
            switchFailures.set(result.sourceId, (switchFailures.get(result.sourceId) ?? 0) + 1)
            const attempt: LinkAttempt = {
                sourceId: result.sourceId,
                resultTitle: result.title,
                latestChapter: result.latestChapter ?? null,
                outcome: "failed",
                failureReason: rawErrorMessage(cause),
                trigger
            }
            entry.autoLink?.attempts.push(attempt)
            card.error = true
            card.message = describeError(cause, "Link failed - the source may be unreachable.")
            card.linking = null
            return false
        }
    }

    async function linkByUrl(manga: LibraryManga) {
        const card = cardOf(manga.id)
        let url = card.urlInput.trim()
        if (!url) return
        if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://" + url
        card.urlLinking = true
        card.message = ""
        card.error = false
        try {
            await sendRuntimeMessage({ type: "library:link-url", mangaId: manga.id, mangaUrl: url })
            void sendRuntimeMessage({ type: "library:covers:backfill", mangaId: manga.id }).catch(() => {})
            onLinked(manga.id)
        } catch (cause) {
            card.error = true
            card.message = describeError(cause, "Could not link that URL - the source may be unavailable.")
            card.urlLinking = false
        }
    }

    function sourceDomain(manga: LibraryManga): string {
        try {
            return new URL(manga.mangaUrl ?? manga.sourceUrl).hostname.replace(/^www\./, "")
        } catch {
            return manga.sourceId
        }
    }

    // Always render an explicit statement of progress - "no recorded progress" instead
    // of just omitting the line - so absence of data reads as a fact, not a silent gap.
    function progressLine(manga: LibraryManga): string {
        if (manga.lastReadChapterNumber != null) return `read ch ${manga.lastReadChapterNumber}`
        if (manga.latestChapterNumber != null) return `latest ch ${manga.latestChapterNumber}`
        return "no recorded progress"
    }

    async function copyTitle(manga: LibraryManga) {
        const card = cardOf(manga.id)
        try {
            await navigator.clipboard.writeText(manga.title)
        } catch {
            return // clipboard access denied/unavailable - nothing more we can do
        }
        card.copied = true
        if (copyTimers[manga.id]) clearTimeout(copyTimers[manga.id])
        copyTimers[manga.id] = setTimeout(() => {
            card.copied = false
        }, 1500)
    }

    function openResult(result: SearchResult) {
        void browser.tabs.create({ url: result.url })
    }

    // Mirrors copyTitle()'s copied-flash-then-reset UX exactly. Works during an
    // in-progress sweep too - the log is append-only, and a partial log is still
    // useful for a bug report (the header's counts make partiality self-evident).
    async function copyDebugLog() {
        const text = formatReconcileLog(Object.values(debugLog), sweepMeta, browser.runtime.getManifest().version)
        try {
            await navigator.clipboard.writeText(text)
        } catch {
            return // clipboard access denied/unavailable - nothing more we can do
        }
        debugLogCopied = true
        if (debugLogCopyTimer) clearTimeout(debugLogCopyTimer)
        debugLogCopyTimer = setTimeout(() => {
            debugLogCopied = false
        }, 1500)
    }

    // Mirrors App.svelte's exportData(): Blob -> object URL -> anchor with
    // `download` -> click -> revoke. $state.snapshot() strips the reactive proxy
    // before stringifying so JSON.stringify sees plain data, not Svelte internals.
    function downloadDebugLog() {
        const meta = sweepMeta ? $state.snapshot(sweepMeta) : null
        const entries = Object.values($state.snapshot(debugLog))
        const blob = new Blob([JSON.stringify({ meta, entries }, null, 2)], { type: "application/json" })
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = `amr-reconcile-log-${new Date().toISOString().slice(0, 10)}.json`
        a.click()
        URL.revokeObjectURL(url)
    }

    const progressPct = $derived(
        searchProgress.total > 0 ? Math.round((searchProgress.done / searchProgress.total) * 100) : 0
    )
</script>

{#if mangas.length > 0 || Object.keys(debugLog).length > 0}
    <section class="reconcile-section">
        {#if mangas.length > 0}
            <h2 class="reconcile-heading">
                {heading ??
                    `Source issues - ${mangas.length} ${mangas.length === 1 ? "title needs" : "titles need"} a live source`}
            </h2>
            <p class="reconcile-hint muted">
                {hint ??
                    "These titles were imported but their original source couldn't be matched. Find them on a live source and link to preserve your progress."}
            </p>

            <div class="reconcile-bulk-actions">
                <button
                    type="button"
                    class="btn-outline btn-sm"
                    disabled={searchingAll}
                    onclick={() => void findAllSources()}>
                    {searchingAll ? "Searching…" : `Search all ${mangas.length}`}
                </button>
                {#if searchingAll}
                    <button type="button" class="btn-ghost btn-sm stop-btn" onclick={stopSearch}> Stop </button>
                {/if}
                <label class="auto-link-toggle">
                    <input type="checkbox" bind:checked={autoLinkEnabled} disabled={searchingAll} />
                    <span>Auto-link confident matches</span>
                </label>
                <button
                    type="button"
                    class="btn-ghost btn-sm reconcile-remove-all"
                    disabled={removingAll}
                    onclick={() => void removeAll()}>
                    {removingAll ? "Removing…" : `Remove all ${mangas.length}`}
                </button>
            </div>

            {#if removeAllMessage}
                <p class="reconcile-msg" class:reconcile-error={removeAllError}>{removeAllMessage}</p>
            {/if}

            {#if searchingAll || (searchProgress.total > 0 && searchProgress.done > 0)}
                <div class="search-progress-wrap">
                    <div class="progress-track">
                        <div class="progress-fill" style="width: {progressPct}%"></div>
                    </div>
                    <div class="progress-meta">
                        <span class="progress-count">
                            {searchProgress.done} / {searchProgress.total} searched
                            {#if autoLinkedCount > 0}
                                · <strong>{autoLinkedCount} auto-linked</strong>
                            {/if}
                        </span>
                        {#if searchProgress.current && searchingAll}
                            <span class="progress-current muted">- {searchProgress.current}</span>
                        {/if}
                        {#if !searchingAll && searchProgress.done >= searchProgress.total && searchProgress.total > 0}
                            <span class="progress-done">Done ✓</span>
                        {/if}
                        {#if stopRequested && searchingAll}
                            <span class="muted">Stopping…</span>
                        {/if}
                    </div>
                </div>
            {/if}

            {#if autoLinkedSummary.length > 0}
                <div class="auto-link-summary-wrap">
                    <p class="auto-link-summary-heading">Auto-linked this run</p>
                    <ul class="auto-link-summary-list">
                        {#each autoLinkedSummary as item, i (i)}
                            <li class="auto-link-summary-item">
                                <span class="auto-link-summary-title">{item.title}</span>
                                <span class="muted">→ {sourceName(item.sourceId)}</span>
                            </li>
                        {/each}
                    </ul>
                </div>
            {/if}

            <ul class="reconcile-list">
                {#each visible as manga (manga.id)}
                    {@const card = cardOf(manga.id)}
                    <li class="reconcile-card">
                        <div class="reconcile-meta">
                            <span class="reconcile-title-row">
                                <span class="reconcile-title">{manga.title}</span>
                                <button
                                    type="button"
                                    class="btn-ghost btn-sm copy-title-btn"
                                    title="Copy title to clipboard"
                                    onclick={() => void copyTitle(manga)}>
                                    {card.copied ? "Copied" : "Copy title"}
                                </button>
                                {#if card.copied}<span class="saved-flash">✓</span>{/if}
                            </span>
                            <span class="reconcile-source muted">
                                Could not find: {sourceName(manga.sourceId)} · {progressLine(manga)}
                            </span>
                        </div>
                        <div class="reconcile-actions">
                            {#if !card.searched || card.searching}
                                <div class="reconcile-btns">
                                    <button
                                        type="button"
                                        class="btn-outline btn-sm"
                                        disabled={card.searching}
                                        onclick={() => findSources(manga)}>
                                        {card.searching ? "Searching…" : "Find on other sources"}
                                    </button>
                                    <button
                                        type="button"
                                        class="btn-ghost btn-sm"
                                        disabled={card.searching}
                                        onclick={() => dismissManual(manga)}>
                                        Mark as manual
                                    </button>
                                    <button
                                        type="button"
                                        class="btn-ghost btn-sm btn-danger-ghost"
                                        disabled={card.searching}
                                        onclick={() => removeTitle(manga)}>
                                        Remove
                                    </button>
                                </div>
                            {/if}
                            {#if card.message}
                                <p class="reconcile-msg" class:reconcile-error={card.error}>{card.message}</p>
                            {/if}
                            {#if card.searched && card.results.length === 0 && !card.searching}
                                <div class="reconcile-btns">
                                    <button
                                        type="button"
                                        class="btn-outline btn-sm"
                                        onclick={() => {
                                            cards[manga.id]!.searched = false
                                            void findSources(manga)
                                        }}>
                                        Retry search
                                    </button>
                                    <button type="button" class="btn-ghost btn-sm" onclick={() => dismissManual(manga)}>
                                        Mark as manual
                                    </button>
                                    <button
                                        type="button"
                                        class="btn-ghost btn-sm btn-danger-ghost"
                                        onclick={() => removeTitle(manga)}>
                                        Remove
                                    </button>
                                </div>
                            {/if}
                            {#if card.searched && !card.searching}
                                <form
                                    class="link-url-form"
                                    onsubmit={e => {
                                        e.preventDefault()
                                        void linkByUrl(manga)
                                    }}>
                                    <input
                                        class="link-url-input"
                                        type="url"
                                        placeholder="Or paste a manga page URL to link directly…"
                                        bind:value={card.urlInput}
                                        disabled={card.urlLinking} />
                                    <button
                                        type="submit"
                                        class="btn-outline btn-sm"
                                        disabled={!card.urlInput.trim() || card.urlLinking}>
                                        {card.urlLinking ? "Linking…" : "Link"}
                                    </button>
                                </form>
                            {/if}
                            {#if card.results.length > 0}
                                <ul class="mirror-results">
                                    {#each card.results as result}
                                        <li class="mirror-result">
                                            {#if result.coverUrl}
                                                <img
                                                    class="mirror-cover"
                                                    src={result.coverUrl}
                                                    alt={result.title}
                                                    loading="lazy" />
                                            {/if}
                                            <div class="mirror-info">
                                                <span class="mirror-source">{sourceName(result.sourceId)}</span>
                                                <span class="mirror-title muted">{result.title}</span>
                                                <span class="mirror-ch muted">ch {result.latestChapter ?? "?"}</span>
                                            </div>
                                            <button
                                                type="button"
                                                class="btn-ghost btn-sm"
                                                title="Open this result in a new tab"
                                                onclick={() => openResult(result)}>
                                                Open
                                            </button>
                                            <button
                                                type="button"
                                                class="btn-sm"
                                                disabled={card.linking !== null}
                                                onclick={() => void linkSource(manga, result, "manual")}>
                                                {card.linking === result.sourceId ? "Linking…" : "Link"}
                                            </button>
                                        </li>
                                    {/each}
                                </ul>
                            {/if}
                        </div>
                    </li>
                {/each}
            </ul>
            {#if hasMore}
                <button type="button" class="btn-outline show-more" onclick={() => (visibleCount += PAGE_SIZE)}>
                    Show more ({mangas.length - visibleCount} remaining)
                </button>
            {/if}
        {/if}

        {#if Object.keys(debugLog).length > 0}
            <div class="debug-log-wrap">
                <p class="debug-log-heading">
                    Debug log · {Object.keys(debugLog).length}
                    {Object.keys(debugLog).length === 1 ? "title" : "titles"} recorded
                </p>
                <div class="debug-log-actions">
                    <button type="button" class="btn-outline btn-sm" onclick={() => void copyDebugLog()}>
                        {debugLogCopied ? "Copied" : "Copy debug log"}
                    </button>
                    {#if debugLogCopied}<span class="saved-flash">✓</span>{/if}
                    <button type="button" class="btn-ghost btn-sm" onclick={downloadDebugLog}> Download .json </button>
                </div>
            </div>
        {/if}
    </section>
{/if}

<style>
    .reconcile-section {
        display: flex;
        flex-direction: column;
        margin-top: 24px;
        border-top: 1px solid var(--border);
        padding-top: 20px;
    }

    .reconcile-heading {
        font-size: 1rem;
        font-weight: 600;
        margin: 0 0 4px;
        color: var(--warning, #f59e0b);
    }

    .reconcile-hint {
        margin: 0 0 16px;
        font-size: 0.85rem;
    }

    .reconcile-bulk-actions {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-bottom: 10px;
        flex-wrap: wrap;
    }

    .stop-btn {
        color: var(--error, #ef4444);
    }

    .auto-link-toggle {
        display: flex;
        align-items: center;
        gap: 5px;
        font-size: 0.82rem;
        color: var(--text-muted, #888);
        cursor: pointer;
        user-select: none;
        margin-left: 4px;
    }

    .auto-link-toggle input {
        cursor: pointer;
    }

    .reconcile-remove-all {
        color: var(--error, #ef4444);
        opacity: 0.75;
        font-size: 0.8rem;
        margin-left: auto;
    }

    .reconcile-remove-all:hover:not(:disabled) {
        opacity: 1;
    }

    /* Progress bar */
    .search-progress-wrap {
        background: var(--surface-2, var(--surface));
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 10px 14px;
        margin-bottom: 14px;
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .progress-track {
        height: 6px;
        background: var(--border);
        border-radius: 99px;
        overflow: hidden;
    }

    .progress-fill {
        height: 100%;
        background: var(--accent, #3b82f6);
        border-radius: 99px;
        transition: width 0.3s ease;
    }

    .progress-meta {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.82rem;
        flex-wrap: wrap;
    }

    .progress-count {
        font-weight: 500;
    }

    .progress-current {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 260px;
    }

    .progress-done {
        color: var(--success, #22c55e);
        font-weight: 500;
    }

    /* Auto-link summary */
    .auto-link-summary-wrap {
        background: var(--surface-2, var(--surface));
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 10px 14px;
        margin-bottom: 14px;
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .auto-link-summary-heading {
        margin: 0;
        font-size: 0.82rem;
        font-weight: 500;
    }

    .auto-link-summary-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 3px;
        max-height: 140px;
        overflow-y: auto;
    }

    .auto-link-summary-item {
        display: flex;
        gap: 6px;
        align-items: baseline;
        font-size: 0.8rem;
    }

    .auto-link-summary-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    /* Card list */
    .reconcile-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 12px;
    }

    .reconcile-card {
        background: var(--surface-2, var(--surface));
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    .reconcile-meta {
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    .reconcile-title-row {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .reconcile-title {
        font-weight: 500;
        font-size: 0.95rem;
    }

    .copy-title-btn {
        padding: 2px 6px;
        font-size: 0.75rem;
    }

    .saved-flash {
        font-size: 12px;
        color: var(--success);
        white-space: nowrap;
    }

    .reconcile-source {
        font-size: 0.8rem;
    }

    .reconcile-actions {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .reconcile-btns {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
    }

    .btn-ghost {
        background: none;
        border: none;
        color: var(--text-muted, #888);
        cursor: pointer;
    }

    .btn-ghost:hover:not(:disabled) {
        color: var(--text, inherit);
    }

    .btn-danger-ghost:hover:not(:disabled) {
        color: var(--error, #ef4444);
    }

    .reconcile-msg {
        font-size: 0.82rem;
        margin: 0;
        color: var(--text-muted, #888);
    }

    .reconcile-error {
        color: var(--error, #ef4444);
        font-weight: 500;
    }

    .mirror-results {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .mirror-result {
        display: flex;
        align-items: center;
        gap: 10px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 8px 10px;
    }

    .mirror-cover {
        width: 36px;
        height: 50px;
        object-fit: cover;
        border-radius: 3px;
        flex-shrink: 0;
    }

    .mirror-info {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
    }

    .mirror-source {
        font-weight: 500;
        font-size: 0.85rem;
    }

    .mirror-title {
        font-size: 0.78rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .mirror-ch {
        font-size: 0.78rem;
    }

    .btn-sm {
        padding: 4px 10px;
        font-size: 0.82rem;
    }

    .show-more {
        margin-top: 12px;
        width: 100%;
    }

    /* Debug log */
    .debug-log-wrap {
        background: var(--surface-2, var(--surface));
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 10px 14px;
        margin-top: 14px;
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .debug-log-heading {
        margin: 0;
        font-size: 0.82rem;
        font-weight: 500;
    }

    .debug-log-actions {
        display: flex;
        gap: 8px;
        align-items: center;
    }

    .link-url-form {
        display: flex;
        gap: 6px;
        align-items: center;
        margin-top: 4px;
    }

    .link-url-input {
        flex: 1;
        min-width: 0;
        padding: 4px 8px;
        font-size: 0.8rem;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--surface);
        color: var(--text);
    }

    .link-url-input:disabled {
        opacity: 0.5;
    }
</style>
