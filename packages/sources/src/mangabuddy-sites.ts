import type { SourceAdapter } from "@amr/source-sdk"
import { createMangaBuddyAdapter, type MangaBuddyConfig } from "./mangabuddy"

// MangaBuddy-family mirrors flagged green (reachable, buddy reader) by the
// source-probe. Each is a config row over the shared factory. Confirm a live
// chapter before relying on any of them; mangaPath is tunable per config.
const SITES: MangaBuddyConfig[] = [
    // { id: "mangabuddy", name: "MangaBuddy", origin: "https://mangabuddy.com", domains: ["mangabuddy.com"] }, // retired: site down 2026-06 - re-enable when back
    // { id: "mangapuma", name: "MangaPuma", origin: "https://mangapuma.com", domains: ["mangapuma.com"] }, // retired: site down 2026-06 - re-enable when back
    // { id: "mangamirror", name: "MangaMirror", origin: "https://mangamirror.com", domains: ["mangamirror.com"] } // retired: site down 2026-06 - re-enable when back
]

export const mangaBuddySiteConfigs: readonly MangaBuddyConfig[] = SITES

export const mangaBuddyAdapters: readonly SourceAdapter[] = SITES.map(createMangaBuddyAdapter)

// flatMap over both each site's own domain(s) and its imageOrigins (if any) so a
// separate cover/page-image CDN host gets a host_permissions entry automatically.
export const mangaBuddyOrigins: readonly string[] = SITES.flatMap(s => [
    ...s.domains.map(d => `https://${d}/*`),
    ...(s.imageOrigins ?? [])
])
