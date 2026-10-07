import type { SourceAdapter } from "@amr/source-sdk"
import { createFanfoxFamilyAdapter, type FanfoxFamilyConfig } from "./fanfox"

// FanFox / MangaHere family - same platform, same HTML structure, config-driven.
// Images load via JavaScript; resolveChapter returns empty pages.
// On-page panel (prev/next navigation) fully works via listChapters.
const SITES: FanfoxFamilyConfig[] = [
    {
        id: "fanfox",
        name: "FanFox",
        origin: "https://fanfox.net",
        domains: ["fanfox.net", "www.fanfox.net"],
        // Cover images (og:image / detail-info-cover-img) are served from fmcdn.mfcdn.net,
        // a completely different host from fanfox.net - confirmed live 2026-07-14 after a
        // user hit a real console CORS error fetching a cover from this host. Not covered
        // by any existing origin pattern before this fix.
        imageOrigins: ["*://*.mfcdn.net/*"]
    },
    {
        id: "mangahere",
        name: "MangaHere",
        origin: "https://www.mangahere.cc",
        domains: ["mangahere.cc", "www.mangahere.cc"]
        // MangaHere's cover CDN (fmcdn.mangahere.com) is already covered by the
        // "*://*.mangahere.com/*" entry in permissions.ts BASE_SOURCE_ORIGINS - confirmed
        // live 2026-07-14, no imageOrigins needed here.
    }
]

export const fanfoxFamilySiteConfigs: readonly FanfoxFamilyConfig[] = SITES

export const fanfoxFamilyAdapters: readonly SourceAdapter[] = SITES.map(createFanfoxFamilyAdapter)

// flatMap over both the site's own domain(s) and its imageOrigins (if any) so a
// separate cover/page-image CDN host gets a host_permissions entry automatically
// instead of needing a one-off hand patch in permissions.ts BASE_SOURCE_ORIGINS.
export const fanfoxFamilyOrigins: readonly string[] = SITES.flatMap(s => [
    ...s.domains.map(d => `https://${d}/*`),
    ...(s.imageOrigins ?? [])
])
