import { madaraOrigins, mangaStreamOrigins, mangaBuddyOrigins, fanfoxFamilyOrigins } from "@amr/sources"

// Single source of truth for source host origins. Consumed by the manifest
// (wxt.config.ts), the background permission helpers, and every UI grant prompt.
// Base origins are the bespoke adapters; the generic per-family sites (Madara,
// MangaStream, MangaBuddy, FanFox family) contribute their origins from the
// sources package, including each site's optional imageOrigins for a separate
// cover/page-image CDN host - see SourceManifest.imageOrigins in @amr/source-sdk.
// That keeps adding a site (and its image CDN) a config-row change instead of a
// manual BASE_SOURCE_ORIGINS patch every time a user hits a console CORS error.
const BASE_SOURCE_ORIGINS = [
    "https://mangadex.org/*",
    // mangadex.ts's manifest.domains also lists www.mangadex.org (match() accepts
    // it), but no permission pattern covered it - found by the new coverage test
    // in permissions.test.ts, not by a user report; fixed alongside the mfcdn.net gap.
    "https://www.mangadex.org/*",
    "https://api.mangadex.org/*",
    "https://uploads.mangadex.org/*",
    "*://*.mangadex.network/*",
    // mangaread.org - page images served from cdn.mangaread.org, and the adapter
    // accepts the bare domain too, so a single wildcard covers both.
    "*://*.mangaread.org/*",
    "https://www.mgeko.cc/*",
    "https://mgeko.cc/*",
    "*://*.imgsrv4.com/*",
    // Rolia Scan - series/chapter pages + JSON API on roliascan.com, page/cover images on
    // the sibling CDN host roliascan.org (bare domain, no subdomain).
    "https://roliascan.com/*",
    "https://www.roliascan.com/*",
    "https://roliascan.org/*",
    // Nyanu Kafe - series/chapter pages on the main domain, page images on cdn.meowing.org
    "https://nyanukafe.com/*",
    "https://www.nyanukafe.com/*",
    "*://*.meowing.org/*",
    // MangaNato - retired 2026-06: chapmanganato.to down, manganato.com hijacked - uncomment when a working domain is found
    // "https://chapmanganato.to/*",
    // "*://*.mkklcdnv6tempv3.com/*",
    // "*://*.mkklcdnv6temp.com/*",
    // Weeb Central (MangaSee successor) - main domain + image CDN subdomains
    "https://weebcentral.com/*",
    "https://www.weebcentral.com/*",
    "*://*.weebcentral.com/*",
    // Dynasty Scans - images served from the same origin, no separate CDN
    "https://dynasty-scans.com/*",
    "https://www.dynasty-scans.com/*",
    // MangaPark - retired 2026-06 (site down); uncomment when back
    // "https://mangapark.net/*",
    // "*://*.mangapark.net/*",
    // "*://*.mangapark.me/*",
    // AsuraComic - retired 2026-07-18: asuracomic.net permanently redirects to
    // asurascans.com (a different, already-registered adapter) - no active adapter
    // targets this domain or a subdomain of it, so the permission is removed rather
    // than kept for a shared CDN (verified: asurascans.ts only ever references
    // cdn.asurascans.com, never any asuracomic.net host).
    // AsuraScans (React RSC adapter) - chapter images served from cdn.asurascans.com
    "https://asurascans.com/*",
    "*://*.asurascans.com/*",
    // Flame Comics (Next.js adapter) - page images served from cdn.flamecomics.xyz
    "https://flamecomics.xyz/*",
    "*://*.flamecomics.xyz/*",
    // WEBTOON - images served from Naver's pstatic CDN (webtoon-phinf.pstatic.net)
    "https://www.webtoons.com/*",
    "https://webtoons.com/*",
    "*://*.pstatic.net/*",
    // MangaHub - manga list pages load without CF; chapter images from mhcdn/mghcdn CDN
    "https://mangahub.io/*",
    "https://www.mangahub.io/*",
    "*://*.mhcdn.net/*",
    "*://*.mghcdn.com/*",
    // OlympusStaff - Next.js SSR; images in standard src, full reader works
    "https://olympustaff.com/*",
    "https://www.olympustaff.com/*",
    // MangaK - server-rendered Next.js; page images load as <img> from rotating
    // rx.*.org CDN subdomains (obfuscated/rotating host, not a stable match pattern
    // and not needed for <img> rendering), so only the site origin is registered.
    "https://mangak.io/*",
    // FanFox / MangaHere family - chapter images JS-only (panel nav works via
    // listChapters); fanfox.net's covers come from fmcdn.mfcdn.net, folded in
    // automatically via the fanfox config's imageOrigins (see fanfox-sites.ts).
    ...fanfoxFamilyOrigins,
    "https://z-fanfox.net/*",
    // MangaHere cover CDN - separate host from the manga/chapter pages above
    "*://*.mangahere.com/*",
    "*://*.compsci88.com/*",
    // MangaFreak - all wwN mirrors + image CDN
    "*://*.mangafreak.me/*",
    "*://*.images.mangafreak.me/*",
    // Comix - images are JS-only; sidebar tracking works
    "https://comix.to/*",
    "https://www.comix.to/*",
    "*://*.static.comix.to/*",
    // MangaKatana - manga/chapter pages on the apex; covers on mangakatana.com/imgs,
    // page images on the token-gated i1/i2/... CDN subdomains (i*.mangakatana.com)
    "https://mangakatana.com/*",
    "https://www.mangakatana.com/*",
    "*://*.mangakatana.com/*",
    // LikeManga - retired 2026-07-19: likemanga.io permanently redirects to mgread.io
    // (a different, already-registered Madara adapter - see madara-sites.ts) - no
    // active adapter targets this domain, so the permission is removed rather than
    // kept.
    // Kagane - Next.js RSC adapter. kagane.to itself sits behind a Cloudflare
    // managed challenge (series/reader pages + /api/integrity); the data API
    // (yuzuki.kagane.to: series metadata, search, covers, DRM page manifest) and
    // the page-image CDN (kstatic.to) are not gated.
    "https://kagane.to/*",
    "https://yuzuki.kagane.to/*",
    "https://kstatic.to/*",
    // ARCHITECTURE TRACK A (dev demo, arch/source-engine branch only - never ships): the local
    // sample source the generic engine reads, so the demo can fetch it + render its page images.
    "http://localhost:8891/*"
    // Surya Toon - retired 2026-07: domain hijacked/stalled, serves a stuck "Loading..."
    // placeholder with no real content - uncomment if suryatoon.com is ever restored
    // "https://suryatoon.com/*",
    // "*://*.suryatoon.com/*",
    // Manga Galaxy - retired 2026-07: domain hijacked, redirects to an unrelated TikTok
    // video via a JS redirect chain - uncomment if mangagalaxy.me is ever restored
    // "https://mangagalaxy.me/*",
    // "*://*.mangagalaxy.me/*"
] as const

export const SOURCE_ORIGINS: readonly string[] = [
    ...BASE_SOURCE_ORIGINS,
    ...madaraOrigins,
    ...mangaStreamOrigins,
    ...mangaBuddyOrigins
]

// GitHub API is a required host permission (update checks + Gist sync).
// Listed here for reference; added to host_permissions in wxt.config.ts, so it
// is NOT repeated in optional_host_permissions to avoid manifest conflicts.
export const GITHUB_API_ORIGIN = "https://api.github.com/*" as const

// AniList GraphQL is a required host permission for the metadata-enrichment pass
// (status/cover/genres) and, later, personal-list sync. Public reads need no auth.
// Added to host_permissions in wxt.config.ts, so NOT repeated in optional origins.
export const ANILIST_API_ORIGIN = "https://graphql.anilist.co/*" as const

// Cover-image CDNs for the metadata catalog: AniList serves covers from s4.anilist.co
// and MAL/Jikan from cdn.myanimelist.net. Required so the cover backfill can fetch and
// cache those blobs (a service-worker fetch needs the host permission, unlike an <img>
// hotlink). Added to host_permissions in wxt.config.ts.
export const METADATA_COVER_ORIGINS = ["https://s4.anilist.co/*", "https://cdn.myanimelist.net/*"] as const

// Gist sync origins - still requested optionally in the UI so the user knows
// they are authorising Gist access (the network-level permission is already
// granted via host_permissions; this optional grant is for the UI prompt only).
export const SYNC_ORIGINS = [GITHUB_API_ORIGIN] as const

// All optional host origins for the manifest (source sites only - GitHub API
// is in required host_permissions instead).
export const ALL_OPTIONAL_ORIGINS: readonly string[] = [...SOURCE_ORIGINS]

// Mutable copy for the browser.permissions APIs, which expect string[].
export function sourceOrigins(): string[] {
    return [...SOURCE_ORIGINS]
}

export function syncOrigins(): string[] {
    return [...SYNC_ORIGINS]
}
