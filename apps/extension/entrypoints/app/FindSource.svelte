<script lang="ts">
    import type { LibraryManga } from "../../src/database"
    import type { ResolveResult } from "../../src/source-resolver"
    import { sendRuntimeMessage } from "../../src/runtime"
    import { buildLabelMapFromInfos, labelFromMap, type SourceLabelInfo } from "../../src/source-labels"
    import { onMount } from "svelte"
    import { buildResolveRequest, type MangaSearchResult } from "../../src/find-source"

    // Manual, per-title "Find source" flow for a library row that has no live readable
    // source (a tracking-only anilist.co/import entry, a manual dead-source import, or a
    // needs-relink row). Resolves candidates tracker-first via source:resolve (read-only)
    // and, on an explicit pick, hands the candidate to the shared Change source dialog, which previews it and
    // applies it with library:switch. It never touches the entry until the user confirms there.
    type Props = {
        manga: LibraryManga
        // Tracker title variants (english/romaji/synonyms) when the caller already has
        // them - lets the resolver skip a metadata lookup. Optional.
        searchTitles?: string[]
        hasPermission: boolean
        onPick: (candidate: { sourceId: string; sourceMangaId: string; mangaUrl: string }) => void
    }

    let { manga, searchTitles, hasPermission, onPick }: Props = $props()

    let resolving = $state(false)
    let resolved = $state(false)
    let candidates = $state<MangaSearchResult[]>([])
    let message = $state("")
    let error = $state(false)
    let sourceLabels = $state<Map<string, string>>(new Map())
    function sourceName(sourceId: string): string {
        return labelFromMap(sourceLabels, sourceId)
    }
    onMount(() => {
        void sendRuntimeMessage<SourceLabelInfo[]>({ type: "source:labels" })
            .then(infos => (sourceLabels = buildLabelMapFromInfos(infos)))
            .catch(() => {})
    })

    // sendRuntimeMessage rejects with raw network text for source/timeout failures
    // ("Request failed with status 403 [https://…]") that isn't meant to be read as-is.
    // Swap those for a friendly line; curated messages pass through unchanged.
    const RAW_ERROR_PATTERN = /\[https?:\/\/|\brequest (failed|timed out)\b|\bstatus \d{3}\b/i
    function describeError(cause: unknown, fallback: string): string {
        const raw = cause instanceof Error ? cause.message : ""
        if (!raw || RAW_ERROR_PATTERN.test(raw)) return fallback
        return raw
    }

    async function findSource() {
        resolving = true
        error = false
        message = ""
        candidates = []
        resolved = false
        // buildResolveRequest reads only primitives / rebuilds the variants array, so no
        // $state proxy crosses the message boundary. searchTitles (a $state array when the
        // caller passed one) is spread to a plain array inside the builder.
        const request = buildResolveRequest(
            { title: manga.title, ...(manga.anilistId !== undefined ? { anilistId: manga.anilistId } : {}) },
            searchTitles
        )
        try {
            const result = await sendRuntimeMessage<ResolveResult>(request)
            candidates = result.candidates
            resolved = true
            if (!result.matched || result.candidates.length === 0) {
                message = "No live source found for this title. Track it manually or re-link a chapter URL."
            }
        } catch (cause) {
            error = true
            message = describeError(cause, "Search failed - you may be offline. Try again in a moment.")
        } finally {
            resolving = false
        }
    }

    function pick(candidate: MangaSearchResult) {
        onPick({
            sourceId: candidate.sourceId,
            sourceMangaId: candidate.sourceMangaId,
            mangaUrl: candidate.url
        })
    }

    function openCandidate(candidate: MangaSearchResult) {
        void browser.tabs.create({ url: candidate.url })
    }
</script>

<div class="find-source">
    <button
        type="button"
        class="btn-sm"
        disabled={resolving || !hasPermission}
        title={hasPermission
            ? "Look up a live source for this tracked title and adopt it, keeping your progress"
            : "Grant source access first"}
        onclick={() => void findSource()}>
        {resolving ? "Finding source…" : "Find source"}
    </button>

    {#if message}
        <p class="find-source-msg" class:find-source-error={error}>{message}</p>
    {/if}

    {#if candidates.length > 0}
        <ul class="find-source-list">
            {#each candidates as candidate (candidate.sourceId + candidate.sourceMangaId)}
                <li class="find-source-row">
                    {#if candidate.coverUrl}
                        <img class="find-source-cover" src={candidate.coverUrl} alt={candidate.title} loading="lazy" />
                    {/if}
                    <div class="find-source-info">
                        <span class="find-source-name">{sourceName(candidate.sourceId)}</span>
                        <span class="find-source-title muted">{candidate.title}</span>
                        <span class="find-source-ch muted">ch {candidate.latestChapter ?? "?"}</span>
                    </div>
                    <button
                        type="button"
                        class="btn-ghost btn-sm"
                        title="Open this candidate in a new tab"
                        onclick={() => openCandidate(candidate)}>
                        Open
                    </button>
                    <button type="button" class="btn-sm" onclick={() => pick(candidate)}>Use this source</button>
                </li>
            {/each}
        </ul>
    {:else if resolved && !resolving && !message}
        <p class="find-source-msg muted">No live source found for this title.</p>
    {/if}
</div>

<style>
    .find-source {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .find-source-msg {
        font-size: 0.82rem;
        margin: 0;
        color: var(--text-muted, #888);
    }

    .find-source-error {
        color: var(--error, #ef4444);
        font-weight: 500;
    }

    .find-source-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .find-source-row {
        display: flex;
        align-items: center;
        gap: 10px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 8px 10px;
    }

    .find-source-cover {
        width: 36px;
        height: 50px;
        object-fit: cover;
        border-radius: 3px;
        flex-shrink: 0;
    }

    .find-source-info {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
    }

    .find-source-name {
        font-weight: 500;
        font-size: 0.85rem;
    }

    .find-source-title {
        font-size: 0.78rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .find-source-ch {
        font-size: 0.78rem;
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
</style>
