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
    import { POLICY_URL } from "../../src/privacy-policy"
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
        <div class="usage-notice-body">
            <strong>Usage analytics is on</strong>
            <span>
                StoryHoard sends counts of which screens and features you use, with your app version, browser and a
                random install id, to help improve the app. Never your titles, what you read, or your notes. If you link
                a weeb.ltd account, these counts are tied to it.
                <a href={POLICY_URL} target="_blank" rel="noopener noreferrer">Privacy policy</a>
            </span>
        </div>
        <div class="usage-notice-actions">
            <button type="button" class="usage-notice-off" disabled={busy} onclick={() => void turnOff()}
                >Turn off</button>
            <button type="button" class="usage-notice-ok" disabled={busy} onclick={() => void keepOn()}>OK</button>
        </div>
    </div>
{/if}

<style>
    .usage-notice {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
        padding: 12px 14px;
        margin-bottom: 12px;
        border-radius: 10px;
        background: var(--surface, #111929);
        border: 1px solid var(--border, #1b2538);
        border-left: 4px solid var(--accent, #8b5cf6);
        color: var(--text, #f0f4fa);
    }
    .usage-notice-body {
        display: flex;
        flex-direction: column;
        gap: 4px;
        flex: 1 1 220px;
        min-width: 0;
    }
    .usage-notice-body span {
        color: var(--muted, #8fa0b2);
        font-size: 13px;
        line-height: 1.4;
    }
    .usage-notice-body a {
        color: var(--accent, #8b5cf6);
    }
    .usage-notice-actions {
        display: flex;
        gap: 8px;
        flex-shrink: 0;
        align-self: center;
    }
    .usage-notice-actions button {
        padding: 6px 12px;
        border-radius: 8px;
        font: inherit;
        font-size: 13px;
        cursor: pointer;
    }
    .usage-notice-off {
        background: transparent;
        color: var(--text, #f0f4fa);
        border: 1px solid var(--border, #2a3446);
    }
    .usage-notice-ok {
        background: var(--accent, #8b5cf6);
        color: #fff;
        border: 1px solid transparent;
    }
    .usage-notice-actions button:disabled {
        opacity: 0.6;
        cursor: default;
    }
</style>
