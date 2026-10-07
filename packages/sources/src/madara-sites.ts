import type { SourceAdapter } from "@amr/source-sdk"
import { createMadaraAdapter, type MadaraConfig } from "./madara"

// Additional Madara-theme sites - each is a config row over the shared factory.
// All use the default Madara `/manga/<slug>/chapter-N/` URL scheme. Flagged green
// (reachable, Madara template) by the source-probe; confirm a live chapter before
// relying on any of them, and tune mangaPath/chapterPrefix if a site differs.
const SITES: MadaraConfig[] = [
    // { id: "arvenscans", name: "Arven Scans", origin: "https://arvenscans.org", domains: ["arvenscans.org"] }, // retired: site down 2026-07 - TLS certificate expired, verified 2026-07-11
    // { id: "arvencomics", name: "Arven Comics", origin: "https://arvencomics.com", domains: ["arvencomics.com"] }, // retired: site down 2026-07 - TLS handshake fails, verified 2026-07-11
    // { id: "novelmic", name: "Novelmic", origin: "https://novelmic.com", domains: ["novelmic.com"] }, // retired 2026-07-19: novelmic.com is now an openresty domain-parking lander with no manga content - zero wp-manga/wp-content markup, no /manga/<slug>/ pages resolve. Verified live 2026-07-19.
    // Renamed 2026-07-11: aryascans.com now redirects to brainrotcomics.com. Verified it's
    // the same Madara-engine site (still /manga/<slug>/ URLs, wp-manga-chapter list markup,
    // ?post_type=wp-manga search) - just a rebrand, not a hijack. id kept stable so existing
    // library links still resolve; origin/domains/name updated to the new host.
    {
        id: "aryascans",
        name: "BrainRotComics",
        origin: "https://brainrotcomics.com",
        domains: ["brainrotcomics.com"]
    },
    // { id: "agrcomics", name: "AGR Comics", origin: "https://agrcomics.com", domains: ["agrcomics.com"] }, // retired: site down 2026-06 - re-enable when back
    // { id: "manhuaplus", name: "ManhuaPlus", origin: "https://manhuaplus.org", domains: ["manhuaplus.org"] }, // retired 2026-07-14: fully migrated off WordPress/Madara to a custom "liliana" theme - verified live: no wp-content/wp-json/wp-admin markers anywhere on the site, chapter pages have zero wp-manga-chapter/reading-content/wp-manga-chapter-img markup, and POSTing to /wp-admin/admin-ajax.php (both manga_get_chapters and manga_get_chapter_img_list) 302-redirects to /home since the endpoint no longer exists - matches the user's reported redirect exactly. Not a same-engine rebrand like aryascans; the whole template changed, so re-adding needs a bespoke adapter, not a config row.
    // { id: "rawkuma", name: "Rawkuma", origin: "https://rawkuma.com", domains: ["rawkuma.com"] }, // retired 2026-07-19: rawkuma moved its catalog to rawkuma.net with a non-Madara query-string URL scheme; rawkuma.com no longer serves manga content (no wp-manga /manga/<slug>/ pages). Re-adding the .net site needs a bespoke adapter, not this config row. Verified live 2026-07-19.
    // { id: "hivetoon", name: "HiveToon", origin: "https://hivetoon.com", domains: ["hivetoon.com"], imageOrigins: ["*://*.hivetoon.com/*"] }, // retired 2026-07-16: hivetoon.com 301-redirects to a different domain, hivetoons.org - verified live it is NOT a same-engine rebrand like aryascans->brainrotcomics: hivetoons.org runs Astro (astro-view-transitions markers, astro-island hydration islands, /_vcomics/*.js module scripts), zero wp-manga-chapter/reading-content/c-tabs-item/manga-chapters-holder markup anywhere, and chapter URLs are /series/<slug>/chapter-N with no trailing slash - a full engine change like the manhuaplus/templescan precedent above, so re-adding needs a bespoke adapter, not a config row.
    {
        id: "lhtranslation",
        name: "LHTranslation",
        origin: "https://lhtranslation.net",
        domains: ["lhtranslation.net"],
        // From their /donate/ page (Ko-fi + Patreon), verified 2026-09-07.
        supportUrl: "https://ko-fi.com/lhtranslation"
    },
    // Added 2026-09-07 (user request). Translation group publishing both manga (/manga/) and
    // novels (/novel/); novel chapters are text, so the reader shows "open on site" for them
    // while tracking and the on-page panel work. Cloudflare-gated for headless fetches, fine
    // from the user's own browser. Ko-fi surfaced via supportUrl.
    {
        id: "dragontea",
        name: "DragonTea",
        origin: "https://dragontea.ink",
        domains: ["dragontea.ink"],
        altMangaPaths: ["novel"],
        supportUrl: "https://ko-fi.com/dragontea"
    },
    // { id: "harimanga", name: "HariManga", origin: "https://harimanga.me", domains: ["harimanga.me"] }, // retired: site down 2026-06 - re-enable when back
    // { id: "utoon", name: "UToon", origin: "https://utoon.net", domains: ["utoon.net"] }, // retired 2026-07-19: utoon.net hijacked - serves a fake ransom/invoice page, no Madara markup or manga content. Verified live 2026-07-19.
    {
        id: "mangasushi",
        name: "MangaSushi",
        origin: "https://mangasushi.org",
        domains: ["mangasushi.org"],
        // From their /donations/ page (Ko-fi + Patreon), verified 2026-09-07.
        supportUrl: "https://ko-fi.com/mangasushi"
    },
    // chapters-only: chapter pages are ad-gated; sidebar tracking works, reader shows "open on site"
    {
        id: "manhuatop",
        name: "ManhuaTop",
        origin: "https://manhuatop.org",
        domains: ["manhuatop.org"],
        mangaPath: "manhua",
        capabilities: ["chapters"]
    },
    // Replacements for dead sites + new user-requested sources
    // { id: "saucemanhwa", name: "SauceManhwa", origin: "https://saucemanhwa.org", domains: ["saucemanhwa.org"] }, // retired: site down 2026-06 - re-enable when back
    {
        id: "mangadistrict",
        name: "Manga District",
        origin: "https://mangadistrict.com",
        domains: ["mangadistrict.com"],
        // Live-verified 2026-07-16: /manga/<slug>/ 301-redirects to /series/<slug>/
        // (X-Redirect-By: WordPress), and /manga/<slug>/chapter-N/ 404s outright since
        // the redirect rule doesn't cover nested chapter paths - the real permalink base
        // is "series", not the default "manga".
        mangaPath: "series"
    },
    // { id: "manytoon", name: "ManyToon", origin: "https://manytoon.com", domains: ["manytoon.com"] }, // retired: domain hijacked 2026-07 - resolves and returns 200 but redirects to an unrelated adult popunder ad network (purplesacam.com), verified 2026-07-11
    // { id: "omegascans", name: "Omega Scans", origin: "https://omegascans.org", domains: ["omegascans.org"] }, // retired 2026-07-16: omegascans.org has been fully rewritten as a Next.js/HeanCMS site - verified live zero wp-manga/wp-content/wp-admin/wp-json markers anywhere on the homepage, real content lives under /series/<slug> URLs served by Next.js (_next/static assets, image optimizer at /_next/image). A full engine change like the manhuaplus/templescan precedent above, not a same-engine rebrand like aryascans->brainrotcomics, so re-adding needs a bespoke adapter, not a config row. NOTE: apps/extension/src/database.ts's seedDatabase has a sample entry "seed-oms-001" pointing at an omegascans.org /manga/ URL that will now 404 and reference an unregistered sourceId - flagged for the owning agent, not edited here.
    // { id: "kunmanga", name: "KunManga", origin: "https://kunmanga.com", domains: ["kunmanga.com"] }, // retired: site down 2026-06 - re-enable when back
    // { id: "vortexscans", name: "Vortex Scans", origin: "https://vortexscans.org", domains: ["vortexscans.org"], mangaPath: "series", imageOrigins: ["*://*.vortexscans.org/*"] }, // retired 2026-07-19: vortexscans.org migrated off WordPress/Madara to an Astro SPA (data-astro markers, /_vcomics/ scripts, zero wp-manga markup) - a full engine change like the manhuaplus/omegascans precedent above, not a same-engine rebrand, so re-adding needs a bespoke adapter, not a config row. Supersedes the earlier "images confirmed live 2026-07-14" note - the whole template changed since. Verified live 2026-07-19.
    // { id: "casacomic", name: "Casa Comic", origin: "https://casacomic.com", domains: ["casacomic.com"] }, // retired: site down 2026-06 - re-enable when back
    {
        id: "natomanga",
        name: "NatoManga",
        origin: "https://www.natomanga.com",
        domains: ["natomanga.com", "www.natomanga.com"]
    },
    { id: "hentairead", name: "HentaiRead", origin: "https://hentairead.com", domains: ["hentairead.com"] },
    // { id: "hentai20", name: "Hentai20", origin: "https://hentai20.io", domains: ["hentai20.io"], imageOrigins: ["https://img.hentai1.io/*"] }, // retired 2026-08-17: hentai20.io homepage 200s but series pages now serve a parked "adultCasinoRedirect" hijack page (source-health verdict: hijacked). Domain compromised, no real content. Verified live 2026-08-17.
    // { id: "oppaistream", name: "Oppai Stream", origin: "https://read.oppai.stream", domains: ["read.oppai.stream"] }, // retired 2026-08-17: read.oppai.stream is now a Next.js SPA (__NEXT_DATA__/_next static, no /manga/<slug> server markup) - the Madara scraper matches nothing. Same engine-migration class as phoenixscans/templescan. Verified live 2026-08-17.
    // { id: "eahentai", name: "EA Hentai", origin: "https://eahentai.com", domains: ["eahentai.com"] }, // retired 2026-08-17: eahentai.com is a doujin gallery site keyed on /a/<id>, not a Madara /manga/<slug> reader - the adapter never matched its structure. Verified live 2026-08-17.
    // { id: "hentalk", name: "HenTalk", origin: "https://hentalk.pw", domains: ["hentalk.pw"] }, // retired 2026-08-17: hentalk.pw resets the connection (ECONNRESET) on every request across two runs - unreachable, no longer serving. Verified live 2026-08-17.
    // { id: "likemanga", name: "LikeManga", origin: "https://likemanga.io", domains: ["likemanga.io"] }, // retired 2026-07-19: likemanga.io now permanently 301-redirects every path (root, /manga/<slug>/, ?s=<query> search) to the bare root of https://mgread.io/ - not a path-preserving redirect, the path and query are dropped entirely. mgread.io is already registered below as its own working source (id: "mgread"), so this isn't a same-engine rebrand needing a new entry (like aryascans->brainrotcomics) - it's a dead domain merged into an already-registered site. Verified live 2026-07-19.
    // { id: "suryatoon", name: "Surya Toon", origin: "https://suryatoon.com", domains: ["suryatoon.com"] }, // retired: domain hijacked/stalled 2026-07 - 200s but body is a bare stuck "Loading..." placeholder, no real content, verified 2026-07-11
    // { id: "mangagalaxy", name: "Manga Galaxy", origin: "https://mangagalaxy.me", domains: ["mangagalaxy.me"] }, // retired: domain hijacked 2026-07 - homepage 200s with a JS redirect chain that lands on an unrelated TikTok video, verified 2026-07-11
    {
        id: "tritinia",
        // Patreon link in the site footer, verified 2026-09-07.
        supportUrl: "https://www.patreon.com/tritiniascans",
        name: "Tritinia Scans",
        origin: "https://tritinia.org",
        domains: ["tritinia.org", "tritinia.com"],
        // Tritinia chapter permalinks are /manga/<slug>/ch-N/, not the Madara
        // default /chapter-N/ - without this the chapter URL matches neither the
        // chapter nor the manga regex and the reader can't resolve it.
        chapterPrefix: "ch"
    },
    { id: "manhuaus", name: "ManhuaUS", origin: "https://manhuaus.com", domains: ["manhuaus.com"] },
    {
        id: "gdscans",
        name: "GD Scans",
        origin: "https://gdscans.com",
        domains: ["gdscans.com"],
        // GD Scans (WordPress/Madara) nests chapters under a volume segment,
        // e.g. /manga/<slug>/volume-9/chapter-71/ - live-verified 2026-08-05.
        volumePath: true
    },
    { id: "mgread", name: "MgRead", origin: "https://mgread.io", domains: ["mgread.io"] },
    // { id: "aquascans", name: "Aqua Scans", origin: "https://aquascans.com", domains: ["aquascans.com"] }, // retired: site down 2026-07 - domain has a registrar SOA record but no A/AAAA (doesn't resolve to a host), verified 2026-07-11
    // { id: "s2manga", name: "S2Manga", origin: "https://s2manga.com", domains: ["s2manga.com"] }, // retired: site down 2026-07 - NXDOMAIN, verified 2026-07-11
    {
        id: "manhwatop",
        name: "ManhwaTop",
        origin: "https://manhwatop.com",
        domains: ["manhwatop.com"],
        // Chapter images are served from a numbered CDN subdomain (e.g. c4.manhwatop.com),
        // not covered by "https://manhwatop.com/*". Confirmed live 2026-07-14.
        imageOrigins: ["*://*.manhwatop.com/*"]
    }
    // { id: "aquamanga", name: "Aqua Manga", origin: "https://aquamanga.com", domains: ["aquamanga.com"], mangaPath: "read" }, // retired 2026-07-19: aquamanga.com redirects through parklogic.com ad-arbitrage, no Madara markup or manga content. Verified live 2026-07-19.
    // { id: "manhwahentai", name: "Manhwa Hentai", origin: "https://manhwahentai.me", domains: ["manhwahentai.me"], mangaPath: "webtoon" }, // retired: domain hijacked 2026-07 - resolves and returns 200 but redirects to the same unrelated adult popunder ad network as manytoon (purplesacam.com), verified 2026-07-11
]

export const madaraSiteConfigs: readonly MadaraConfig[] = SITES

export const madaraAdapters: readonly SourceAdapter[] = SITES.map(createMadaraAdapter)

// Origins for these sites - flatMap over all domains so multi-domain configs
// (e.g. natomanga.com + www.natomanga.com) all get host_permissions entries. Also
// folds in each site's imageOrigins (if any) so a separate cover/page-image CDN
// host is granted automatically instead of needing a one-off hand patch in
// permissions.ts BASE_SOURCE_ORIGINS.
export const madaraOrigins: readonly string[] = SITES.flatMap(s => [
    ...s.domains.map(d => `https://${d}/*`),
    ...(s.imageOrigins ?? [])
])
