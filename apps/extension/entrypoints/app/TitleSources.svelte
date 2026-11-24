<script lang="ts">
    import { sendRuntimeMessage } from "../../src/runtime"
    import type { SourceCandidate, TitleSourceRow, TitleSources } from "../../src/title-sources"

    // The "Sources" section of a title: the current (main) source and every other known version of the
    // same work. Each source is only ever named by its label. Making one main goes through the shared
    // Change source dialog, so the user sees what they would get before anything moves.
    type Props = {
        mangaId: string
        // Bumped by the parent after any change so the list re-reads.
        refreshKey?: number
        onMakeMain: (candidate: SourceCandidate) => void
        onChangeSource: () => void
        onChanged: () => void
    }

    let { mangaId, refreshKey = 0, onMakeMain, onChangeSource, onChanged }: Props = $props()

    let data = $state<TitleSources | null>(null)
    let message = $state("")
    let linkUrl = $state("")
    let busy = $state(false)

    const RAW_ERROR_PATTERN = /\[https?:\/\/|\brequest (failed|timed out)\b|\bstatus \d{3}\b/i
    function describeError(cause: unknown, fallback: string): string {
        const raw = cause instanceof Error ? cause.message : ""
        if (!raw || RAW_ERROR_PATTERN.test(raw)) return fallback
        return raw
    }

    async function load() {
        try {
            data = await sendRuntimeMessage<TitleSources>({ type: "title:sources", mangaId })
        } catch (cause) {
            message = describeError(cause, "Could not load this title's sources.")
        }
    }

    $effect(() => {
        void refreshKey
        void mangaId
        void load()
    })

    async function run(action: () => Promise<TitleSources>, done: string): Promise<boolean> {
        busy = true
        message = ""
        try {
            data = await action()
            message = done
            onChanged()
            return true
        } catch (cause) {
            message = describeError(cause, "That did not work.")
            return false
        } finally {
            busy = false
        }
    }

    function togglePrefer(row: TitleSourceRow) {
        void run(
            () =>
                sendRuntimeMessage<TitleSources>({
                    type: "title:source-prefer",
                    mangaId,
                    sourceId: row.isPreferred ? null : row.sourceId
                }),
            row.isPreferred ? "Preference cleared." : `${row.label} is now preferred for this title.`
        )
    }

    function remove(row: TitleSourceRow) {
        void run(
            () => sendRuntimeMessage<TitleSources>({ type: "title:source-remove", mangaId, versionId: row.id }),
            `${row.label} was removed from this title's list.`
        )
    }

    function makeMain(row: TitleSourceRow) {
        onMakeMain({ sourceId: row.sourceId, sourceMangaId: row.sourceMangaId, mangaUrl: row.url })
    }

    function link() {
        const url = linkUrl.trim()
        if (!url) return
        void run(
            () => sendRuntimeMessage<TitleSources>({ type: "title:source-link", mangaId, url }),
            "Added to this title's sources."
        ).then(ok => {
            if (ok) linkUrl = ""
        })
    }

    function reopen(url: string) {
        if (!/^https?:\/\//i.test(url)) return
        void browser.tabs.create({ url })
    }

    function openRow(row: TitleSourceRow) {
        reopen(row.url)
    }
</script>

<div class="title-sources">
    <div class="title-sources-head">
        <p class="detail-sec-h">Where you read it</p>
        {#if data && !data.needsRelink}
            <button type="button" class="btn-sm btn-plain" onclick={onChangeSource}>Change source</button>
        {/if}
    </div>

    {#if data}
        {#if data.needsRelink}
            <div class="title-sources-relink">
                <p>
                    <strong>Needs relink.</strong> The extension can no longer read this title's source. Your progress is
                    kept.
                </p>
                <div class="title-sources-actions">
                    {#if data.reopenUrl}
                        <button type="button" class="btn-sm" onclick={() => reopen(data!.reopenUrl!)}>
                            Open the site to re-detect
                        </button>
                    {/if}
                    <button type="button" class="btn-sm btn-secondary" onclick={onChangeSource}>Change source</button>
                </div>
            </div>
        {/if}

        <ul class="title-sources-list">
            {#each data.rows as row (row.id)}
                <li class="title-sources-row" class:is-main={row.isMain}>
                    <div class="title-sources-info">
                        <span class="title-sources-name">{row.label}</span>
                        {#if row.official}<span class="where-badge">Official</span>{/if}
                        {#if row.isMain}<span class="where-badge where-badge-library">Main</span>{/if}
                        {#if row.isPreferred}<span class="where-badge where-badge-library">Preferred</span>{/if}
                        {#if row.needsRelink && !row.isMain}<span class="muted">Needs relink</span>{/if}
                        <span class="muted">
                            {row.latestChapterNumber !== undefined
                                ? `latest ch ${row.latestChapterNumber}`
                                : "latest chapter not known"}
                        </span>
                    </div>
                    <div class="title-sources-actions">
                        {#if !row.isMain}
                            <button
                                type="button"
                                class="btn-sm btn-plain"
                                disabled={busy || row.needsRelink}
                                onclick={() => makeMain(row)}>
                                Make main
                            </button>
                        {/if}
                        <button
                            type="button"
                            class="btn-sm btn-plain"
                            disabled={busy}
                            onclick={() => togglePrefer(row)}>
                            {row.isPreferred ? "Clear preference" : "Prefer for this title"}
                        </button>
                        <button type="button" class="btn-sm btn-outline" onclick={() => openRow(row)}>Open</button>
                        {#if !row.isMain}
                            <button
                                type="button"
                                class="btn-sm btn-text-danger"
                                disabled={busy}
                                onclick={() => remove(row)}>
                                Remove
                            </button>
                        {/if}
                    </div>
                </li>
            {/each}
        </ul>

        <label class="title-sources-link">
            <span class="muted">Link another site (paste a series or chapter address)</span>
            <div class="tag-add">
                <input type="url" placeholder="https://" bind:value={linkUrl} />
                <button type="button" class="btn-sm btn-outline" disabled={busy || !linkUrl.trim()} onclick={link}
                    >Link</button>
            </div>
        </label>
    {/if}
    {#if message}<span class="muted" role="status">{message}</span>{/if}
</div>

<style>
    .title-sources {
        display: grid;
        gap: 8px;
    }

    .title-sources-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 6px;
    }

    .title-sources-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
    }

    .title-sources-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 10px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
    }

    .title-sources-row.is-main {
        border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
    }

    .title-sources-info,
    .title-sources-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
    }

    .title-sources-name {
        font-weight: 600;
    }

    .title-sources-relink {
        display: grid;
        gap: 8px;
        padding: 10px 12px;
        border-radius: 8px;
        border-left: 3px solid var(--color-warn, #f59e0b);
        background: color-mix(in srgb, var(--color-warn, #f59e0b) 10%, transparent);
        font-size: 12px;
    }

    .title-sources-relink p {
        margin: 0;
    }

    .title-sources-relink strong {
        color: var(--color-warn, #f59e0b);
    }

    .title-sources-link {
        display: grid;
        gap: 6px;
    }
</style>
