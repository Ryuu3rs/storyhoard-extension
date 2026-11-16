import type { SourceAdapter } from "@amr/source-sdk"

// No site adapters and no site hosts: users add their sites themselves. The site adapters live in the
// private site lab, and only the local testing build (VITE_BUNDLED=1) and the lab tests swap this module
// for the lab's own (see apps/extension/wxt.config.ts).

export const siteAdapters: readonly SourceAdapter[] = []
export const siteOrigins: readonly string[] = []
export const siteExtraHosts: Readonly<Record<string, readonly string[]>> = {}
