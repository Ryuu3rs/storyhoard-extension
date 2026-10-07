import type { SourceAdapter } from "@amr/source-sdk"
import { createMangaStreamAdapter, type MangaStreamConfig } from "./mangastream"

// MangaStream/ts-theme sites flagged green (reachable, ts template) by the
// source-probe. Each is a config row over the shared factory. Confirm a live
// chapter before relying on any of them; mangaPath is tunable per config.
const SITES: MangaStreamConfig[] = [
    // { id: "drakecomic", name: "Drake Comic", origin: "https://drakecomic.com", domains: ["drakecomic.com"] }, // retired: site down 2026-06 - re-enable when back
    {
        id: "thunderscans",
        name: "Thunder Scans EN",
        origin: "https://en-thunderscans.com",
        domains: ["en-thunderscans.com"],
        // Series moved from /manga/<slug> to /comics/<slug> (still the ts-theme engine:
        // ts_reader.run()/#readerarea markup intact). Verified live 2026-08-17.
        mangaPath: "comics"
    },
    {
        id: "kappabeast",
        name: "Kappa Beast",
        origin: "https://kappabeast.com",
        domains: ["kappabeast.com"],
        mangaPath: "reader",
        chapterFormat: "hierarchical"
    },
    // { id: "phoenixscans", name: "Phoenix Scans", origin: "https://www.phoenixscans.com", domains: ["phoenixscans.com", "www.phoenixscans.com"] }, // retired 2026-07-19: phoenixscans.com is now a Vue SPA backed by a client-side API - no server-rendered ts_reader.run()/#readerarea markup at all, so the shared MangaStream scraper matches nothing. A full engine change like the templescan precedent above, needs a bespoke adapter, not a config row. Verified live 2026-07-19.
    { id: "spiderscans", name: "Spider Scans", origin: "https://spiderscans.xyz", domains: ["spiderscans.xyz"] }
    // Probe-green by homepage; needs live chapter confirmation (mangaPath/chapterPrefix may need tuning per site).
    // asuracomic migrated to Next.js - removed from MangaStream; see asuracomic.ts
    // flamecomics migrated to Next.js SPA - search returns [] silently; removed
    // { id: "templescan", name: "Temple Scan", origin: "https://templescan.net", domains: ["templescan.net"] }, // retired 2026-07-14: templescan.net 302-redirects to templetoons.com (same "Temple Scan" branding), but the new host is a Next.js app (X-Powered-By: Next.js, RSC headers, /_next/static assets) with /comic/<slug>/chapter-N URLs and no ts_reader.run()/#readerarea markup at all - a full engine migration, not a same-engine rebrand like aryascans→brainrotcomics. Matches the asuracomic/flamecomics precedent above: needs a bespoke Next.js adapter to re-add, not a config row.
]

export const mangaStreamSiteConfigs: readonly MangaStreamConfig[] = SITES

export const mangaStreamAdapters: readonly SourceAdapter[] = SITES.map(createMangaStreamAdapter)

// flatMap over both each site's own domain(s) and its imageOrigins (if any) so a
// separate cover/page-image CDN host gets a host_permissions entry automatically.
export const mangaStreamOrigins: readonly string[] = SITES.flatMap(s => [
    ...s.domains.map(d => `https://${d}/*`),
    ...(s.imageOrigins ?? [])
])
