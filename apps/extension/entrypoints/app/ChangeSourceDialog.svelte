<script lang="ts">
    import { sendRuntimeMessage } from "../../src/runtime"
    import type { ChangePreview, SourceCandidate } from "../../src/title-sources"

    // The one place a title's source is changed: from the title page's "Change source", a mirror's
    // "Switch", the "Find source" pick and "Make main" on a listed version. It shows what the other source
    // has before anything is stored, warns when the read chapter cannot be carried over, applies the change
    // through library:switch (progress is mapped by chapter number) and then offers Undo, which restores
    // the title from the restore point taken just before.
    type Props = {
        mangaId: string
        title: string
        // A source already chosen by the caller. Without one the user pastes a series or chapter address.
        candidate?: SourceCandidate | null
        onChanged: (mangaId: string) => void
        onClose: () => void
    }

    let { mangaId, title, candidate = null, onChanged, onClose }: Props = $props()

    const RAW_ERROR_PATTERN = /\[https?:\/\/|\brequest (failed|timed out)\b|\bstatus \d{3}\b/i
    function describeError(cause: unknown, fallback: string): string {
        const raw = cause instanceof Error ? cause.message : ""
        if (!raw || RAW_ERROR_PATTERN.test(raw)) return fallback
        return raw
    }

    let address = $state("")
    let preview = $state<ChangePreview | null>(null)
    let loading = $state(false)
    let applying = $state(false)
    let undoing = $state(false)
    let error = $state("")
    let backupId = $state<number | null>(null)
    let undone = $state(false)

    async function runPreview(input: { url: string } | SourceCandidate) {
        loading = true
        error = ""
        preview = null
        try {
            const request =
                "url" in input
                    ? { type: "title:source-preview" as const, mangaId, url: input.url }
                    : {
                          type: "title:source-preview" as const,
                          mangaId,
                          sourceId: input.sourceId,
                          sourceMangaId: input.sourceMangaId,
                          mangaUrl: input.mangaUrl
                      }
            preview = await sendRuntimeMessage<ChangePreview>(request)
        } catch (cause) {
            error = describeError(cause, "Could not look at that source. It may be slow or unavailable.")
        } finally {
            loading = false
        }
    }

    $effect(() => {
        if (candidate) void runPreview(candidate)
    })

    async function apply() {
        if (!preview) return
        applying = true
        error = ""
        try {
            const result = await sendRuntimeMessage<{ backupId: number }>({
                type: "title:source-change",
                mangaId,
                sourceId: preview.candidate.sourceId,
                sourceMangaId: preview.candidate.sourceMangaId,
                mangaUrl: preview.candidate.mangaUrl,
                allowTabFallback: true
            })
            backupId = result.backupId
            onChanged(mangaId)
        } catch (cause) {
            error = describeError(cause, "The change failed. That source may be temporarily unavailable.")
        } finally {
            applying = false
        }
    }

    async function undo() {
        if (backupId === null) return
        undoing = true
        error = ""
        try {
            await sendRuntimeMessage({ type: "title:source-undo", mangaId, backupId })
            undone = true
            backupId = null
            onChanged(mangaId)
        } catch (cause) {
            error = describeError(cause, "Could not undo the change.")
        } finally {
            undoing = false
        }
    }

    function fmt(value: number | null): string {
        return value === null ? "unknown" : String(value)
    }
</script>

<div
    class="detail-overlay change-source-overlay"
    role="button"
    tabindex="0"
    onclick={onClose}
    onkeydown={e => {
        if (e.key === "Escape") onClose()
    }}>
    <div
        class="change-source-card"
        role="dialog"
        aria-label="Change source for {title}"
        tabindex="0"
        onclick={e => e.stopPropagation()}
        onkeydown={() => {}}>
        <h3>Change source</h3>
        <p class="muted">{title}</p>

        {#if backupId === null && !undone}
            {#if !candidate}
                <label class="change-source-field">
                    <span class="muted">Paste a series or chapter address from the new source</span>
                    <div class="sync-token">
                        <input type="url" placeholder="https://" bind:value={address} />
                        <button
                            type="button"
                            disabled={!address.trim() || loading}
                            onclick={() => void runPreview({ url: address.trim() })}>
                            {loading ? "Looking…" : "Preview"}
                        </button>
                    </div>
                </label>
            {:else if loading}
                <p class="muted">Looking at the new source…</p>
            {/if}

            {#if preview}
                <p class="change-source-arrow">
                    <strong>{preview.currentLabel}</strong> → <strong>{preview.newLabel}</strong>
                </p>
                <ul class="change-source-facts">
                    {#if preview.chapterCount !== null}
                        <li>{preview.chapterCount} chapters on the new source</li>
                        <li>Latest chapter there: {fmt(preview.latestChapterNumber)}</li>
                    {/if}
                    <li>Latest chapter now: {fmt(preview.currentLatestChapterNumber)}</li>
                    <li>You have read up to chapter {fmt(preview.readChapterNumber)}</li>
                </ul>
                {#if preview.previewError}
                    <p class="change-source-warn">{preview.previewError}</p>
                {/if}
                {#if !preview.progressMapped}
                    <p class="change-source-warn">
                        Your read chapter is not in the new list, so your place in this title cannot be carried over.
                        Your read number is kept, but no chapter will be marked as the one you were on.
                    </p>
                {/if}
                {#if preview.behindProgress}
                    <p class="change-source-warn">
                        The new source is behind where you have read. It may be missing chapters.
                    </p>
                {/if}
                <div class="detail-actions">
                    <button type="button" disabled={applying} onclick={() => void apply()}>
                        {applying ? "Changing…" : "Change source"}
                    </button>
                    <button type="button" class="btn-outline" onclick={onClose}>Cancel</button>
                </div>
            {:else}
                <div class="detail-actions">
                    <button type="button" class="btn-outline" onclick={onClose}>Cancel</button>
                </div>
            {/if}
        {:else if undone}
            <p>The change was undone. The title is back on its old source.</p>
            <div class="detail-actions">
                <button type="button" class="btn-outline" onclick={onClose}>Close</button>
            </div>
        {:else}
            <p>Source changed. Your progress was carried over by chapter number.</p>
            <div class="detail-actions">
                <button type="button" class="btn-outline" disabled={undoing} onclick={() => void undo()}>
                    {undoing ? "Undoing…" : "Undo"}
                </button>
                <button type="button" onclick={onClose}>Done</button>
            </div>
        {/if}

        {#if error}<p class="change-source-warn">{error}</p>{/if}
    </div>
</div>

<style>
    .change-source-overlay {
        z-index: 70;
    }

    .change-source-card {
        display: grid;
        gap: 10px;
        max-width: 520px;
        width: 100%;
        max-height: calc(100vh - 48px);
        overflow: auto;
        padding: 20px;
        border-radius: 14px;
        background: var(--panel, #11161d);
        border: 1px solid var(--border, #29313b);
    }

    .change-source-card h3,
    .change-source-card p {
        margin: 0;
    }

    .change-source-field {
        display: grid;
        gap: 6px;
    }

    .change-source-arrow {
        font-size: 1rem;
    }

    .change-source-facts {
        margin: 0;
        padding-left: 18px;
        font-size: 0.85rem;
    }

    .change-source-warn {
        font-size: 0.82rem;
        color: var(--color-warn, #f59e0b);
    }
</style>
