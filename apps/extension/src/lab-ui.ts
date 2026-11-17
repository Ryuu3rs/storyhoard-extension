import type { Component } from "svelte"

// Lab-only UI. The store build keeps this module, so App.svelte renders none of it and the bundle carries
// none of its markup. The local testing build's wxt config swaps it for one that exports src/lab's components.
export const LabSampleRow: Component<{ onloaded: (message: string) => void | Promise<void> }> | undefined = undefined
