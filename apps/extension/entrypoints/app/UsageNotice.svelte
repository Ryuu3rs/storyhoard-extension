<script lang="ts">
    import { onMount } from "svelte"
    import {
        analyticsConfigured,
        finishUsageNotice,
        firefoxDataGranted,
        getUsageNoticeState,
        markUsageNoticeShown,
        USAGE_DATA_PERMISSION
    } from "../../src/analytics-usage"
    import { USAGE_ANALYTICS_LINE } from "../../src/privacy-policy"
    import { sendRuntimeMessage } from "../../src/runtime"
    import type { AppSettings } from "../../src/settings"

    // The one-time usage analytics notice. Nothing is sent until it has been on screen (the flush checks the
    // stamp), and it stays up until the user answers it. Off here is the same as Off in Settings.
    let { onsettings }: { onsettings?: (settings: AppSettings) => void } = $props()

    let visible = $state(false)
    let busy = $state(false)

    onMount(() => {
        void (async () => {
            if (!analyticsConfigured) return
            try {
                if ((await getUsageNoticeState()).done) return
                const settings = await sendRuntimeMessage<AppSettings>({ type: "settings:get" })
                if (!settings.usageAnalytics) {
                    await finishUsageNotice()
                    return
                }
                if (import.meta.env.FIREFOX && !(await firefoxDataGranted())) return
                visible = true
                await markUsageNoticeShown()
            } catch {
                visible = false
            }
        })()
    })

    async function keepOn() {
        visible = false
        await finishUsageNotice().catch(() => {})
    }

    async function turnOff() {
        busy = true
        try {
            if (import.meta.env.FIREFOX) await browser.permissions.remove(USAGE_DATA_PERMISSION).catch(() => false)
            const settings = await sendRuntimeMessage<AppSettings>({
                type: "settings:update",
                settings: { usageAnalytics: false }
            })
            onsettings?.(settings)
            await finishUsageNotice()
            visible = false
        } catch {
            busy = false
        }
    }
</script>

{#if visible}
    <div class="usage-notice" role="region" aria-label="Usage analytics notice">
        <span class="usage-notice-text">{USAGE_ANALYTICS_LINE}</span>
        <button type="button" class="usage-notice-off" disabled={busy} onclick={() => void turnOff()}>Off</button>
        <button type="button" class="usage-notice-ok" disabled={busy} onclick={() => void keepOn()}>OK</button>
    </div>
{/if}

<style>
    .usage-notice {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 6px 4px 10px;
        margin-bottom: 8px;
        border-radius: 6px;
        background: var(--surface, #111929);
        border: 1px solid var(--border, #1b2538);
        font-size: 12px;
        line-height: 1.3;
    }
    .usage-notice-text {
        flex: 1 1 auto;
        min-width: 0;
        color: var(--muted, #8fa0b2);
    }
    .usage-notice button {
        flex-shrink: 0;
        min-height: 0;
        padding: 2px 8px;
        border-radius: 4px;
        border: 0;
        background: transparent;
        font: inherit;
        cursor: pointer;
    }
    .usage-notice-off {
        color: var(--muted, #8fa0b2);
    }
    .usage-notice-ok {
        color: var(--accent, #8b5cf6);
        font-weight: 600;
    }
    .usage-notice button:hover:not(:disabled) {
        background: var(--border, #1b2538);
    }
    .usage-notice button:disabled {
        opacity: 0.6;
        cursor: default;
    }
</style>
