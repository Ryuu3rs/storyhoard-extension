<script lang="ts">
    import { sendRuntimeMessage } from "../runtime"

    // The local testing build's "Load samples" row. App.svelte imports it only behind LAB_BUILD, so the store
    // bundle carries none of this markup.
    let { onloaded }: { onloaded: (message: string) => void | Promise<void> } = $props()

    async function seedData() {
        try {
            await sendRuntimeMessage({ type: "data:seed" })
            await onloaded("Sample data loaded.")
        } catch (cause) {
            await onloaded(cause instanceof Error ? cause.message : "Failed to load samples.")
        }
    }
</script>

<div class="data-row">
    <div>
        <p class="row-label">Sample data</p>
        <p class="muted">Load test chapters to explore the app.</p>
    </div>
    <button type="button" class="btn-outline" onclick={seedData}>Load samples</button>
</div>
