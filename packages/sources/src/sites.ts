import type { SourceAdapter } from "@amr/source-sdk"
import { asuraScansAdapter } from "./asurascans"
import { comixAdapter } from "./comix"
import { dynastyScansAdapter } from "./dynasty-scans"
import { fanfoxFamilyAdapters, fanfoxFamilyOrigins } from "./fanfox-sites"
import { flameComicsAdapter } from "./flamecomics"
import { kaganeAdapter } from "./kagane"
import { madaraAdapters, madaraOrigins } from "./madara-sites"
import { mangaBuddyAdapters, mangaBuddyOrigins } from "./mangabuddy-sites"
import { mangafreakAdapter } from "./mangafreak"
import { mangahubAdapter } from "./mangahub"
import { mangakAdapter } from "./mangak"
import { mangakatanaAdapter } from "./mangakatana"
import { mangadexAdapter } from "./mangadex"
import { mangareadAdapter } from "./mangaread"
import { mangaStreamAdapters, mangaStreamOrigins } from "./mangastream-sites"
import { mgekoAdapter } from "./mgeko"
import { nyanukafeAdapter } from "./nyanukafe"
import { olympusstaffAdapter } from "./olympustaff"
import { roliascanAdapter } from "./roliascan"
import { weebCentralAdapter } from "./weebcentral"
import { webtoonsAdapter } from "./webtoons"

// Every bundled adapter, and the host patterns the ones not on an official site need. Only the
// local testing build (VITE_BUNDLED=1) and the unit tests load this module; the shipped build swaps it
// for sites.none.ts at build time, so none of this code or its hosts reach a store package.
// Retired adapters (asuracomic, manganato, mangapark) stay in the tree but are not listed.

export { kaganeAdapter } from "./kagane"
export { mangareadAdapter, mangareadConfig } from "./mangaread"
export { mgekoAdapter } from "./mgeko"
export { weebCentralAdapter } from "./weebcentral"
export { dynastyScansAdapter } from "./dynasty-scans"
export { asuraScansAdapter } from "./asurascans"
export { createMadaraAdapter, type MadaraConfig } from "./madara"
export { madaraAdapters, madaraOrigins, madaraSiteConfigs } from "./madara-sites"
export { createMangaStreamAdapter, type MangaStreamConfig } from "./mangastream"
export { mangaStreamAdapters, mangaStreamOrigins, mangaStreamSiteConfigs } from "./mangastream-sites"
export { createMangaBuddyAdapter, type MangaBuddyConfig } from "./mangabuddy"
export { mangaBuddyAdapters, mangaBuddyOrigins, mangaBuddySiteConfigs } from "./mangabuddy-sites"
export { mangahubAdapter } from "./mangahub"
export { createFanfoxFamilyAdapter, type FanfoxFamilyConfig } from "./fanfox"
export { fanfoxFamilyAdapters, fanfoxFamilyOrigins, fanfoxFamilySiteConfigs } from "./fanfox-sites"
export { olympusstaffAdapter } from "./olympustaff"
export { mangafreakAdapter } from "./mangafreak"
export { comixAdapter } from "./comix"
export { nyanukafeAdapter } from "./nyanukafe"
export { mangakatanaAdapter } from "./mangakatana"
export { flameComicsAdapter } from "./flamecomics"
export { mangakAdapter } from "./mangak"
export { roliascanAdapter } from "./roliascan"

// Every bundled adapter, the official ones included, in the order they have always registered in.
export const bundledAdapters: readonly SourceAdapter[] = [
    kaganeAdapter,
    mangadexAdapter,
    mangareadAdapter,
    mgekoAdapter,
    weebCentralAdapter,
    dynastyScansAdapter,
    asuraScansAdapter,
    ...madaraAdapters,
    ...mangaStreamAdapters,
    ...mangaBuddyAdapters,
    webtoonsAdapter,
    mangahubAdapter,
    ...fanfoxFamilyAdapters,
    olympusstaffAdapter,
    mangafreakAdapter,
    comixAdapter,
    nyanukafeAdapter,
    mangakatanaAdapter,
    flameComicsAdapter,
    mangakAdapter,
    roliascanAdapter
]

// Host patterns the site adapters need. The family sites add their own (and their image CDNs) from
// their config rows; the rest are listed by hand.
export const siteOrigins: readonly string[] = [
    // mangaread.org - page images served from cdn.mangaread.org, and the adapter accepts the bare
    // domain too, so a single wildcard covers both.
    "*://*.mangaread.org/*",
    "https://www.mgeko.cc/*",
    "https://mgeko.cc/*",
    "*://*.imgsrv4.com/*",
    // Rolia Scan - series/chapter pages + JSON API on roliascan.com, page/cover images on the sibling
    // CDN host roliascan.org.
    "https://roliascan.com/*",
    "https://www.roliascan.com/*",
    "https://roliascan.org/*",
    // Nyanu Kafe - page images on cdn.meowing.org
    "https://nyanukafe.com/*",
    "https://www.nyanukafe.com/*",
    "*://*.meowing.org/*",
    // Weeb Central - main domain + image CDN subdomains
    "https://weebcentral.com/*",
    "https://www.weebcentral.com/*",
    "*://*.weebcentral.com/*",
    // Dynasty Scans - images served from the same origin
    "https://dynasty-scans.com/*",
    "https://www.dynasty-scans.com/*",
    // AsuraScans - chapter images served from cdn.asurascans.com
    "https://asurascans.com/*",
    "*://*.asurascans.com/*",
    // Flame Comics - page images served from cdn.flamecomics.xyz
    "https://flamecomics.xyz/*",
    "*://*.flamecomics.xyz/*",
    // MangaHub - chapter images from the mhcdn/mghcdn CDN
    "https://mangahub.io/*",
    "https://www.mangahub.io/*",
    "*://*.mhcdn.net/*",
    "*://*.mghcdn.com/*",
    "https://olympustaff.com/*",
    "https://www.olympustaff.com/*",
    // MangaK - page images come from rotating CDN hosts that need no grant for <img>
    "https://mangak.io/*",
    // FanFox / MangaHere family; fanfox.net's cover CDN comes in through its config's imageOrigins.
    ...fanfoxFamilyOrigins,
    "https://z-fanfox.net/*",
    // MangaHere cover CDN - separate host from the manga/chapter pages
    "*://*.mangahere.com/*",
    "*://*.compsci88.com/*",
    // MangaFreak - all wwN mirrors + image CDN
    "*://*.mangafreak.me/*",
    "*://*.images.mangafreak.me/*",
    "https://comix.to/*",
    "https://www.comix.to/*",
    "*://*.static.comix.to/*",
    // MangaKatana - covers on the apex, page images on the i*.mangakatana.com CDN
    "https://mangakatana.com/*",
    "https://www.mangakatana.com/*",
    "*://*.mangakatana.com/*",
    // Kagane - the data API (yuzuki) and the page-image CDN (kstatic.to)
    "https://kagane.to/*",
    "https://yuzuki.kagane.to/*",
    "https://kstatic.to/*",
    ...madaraOrigins,
    ...mangaStreamOrigins,
    ...mangaBuddyOrigins
]

// Hosts a site adapter reaches that its manifest does not name, so a pattern traces back to it.
export const siteExtraHosts: Readonly<Record<string, readonly string[]>> = {
    mgeko: ["imgsrv4.com"],
    nyanukafe: ["meowing.org"],
    mangahub: ["mhcdn.net", "mghcdn.com"],
    fanfox: ["z-fanfox.net"],
    mangahere: ["mangahere.com", "compsci88.com"],
    kagane: ["kstatic.to"]
}
