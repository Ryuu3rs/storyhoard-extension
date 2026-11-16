import type { SourceAdapter } from "@amr/source-sdk"

// What the shipped build loads in place of sites.ts (see the build in apps/extension/wxt.config.ts):
// no site adapters and no site hosts. Users add their sites themselves.

export const bundledAdapters: readonly SourceAdapter[] = []
export const siteOrigins: readonly string[] = []
export const siteExtraHosts: Readonly<Record<string, readonly string[]>> = {}
