import { SourceRegistry, type SourceAdapter } from "@amr/source-sdk"
import { kaganeAdapter } from "./kagane"
import { mangadexAdapter } from "./mangadex"
import { mangareadAdapter } from "./mangaread"
import { mgekoAdapter } from "./mgeko"
// import { manganatoAdapter } from "./manganato" // retired: chapmanganato.to down 2026-06, manganato.com hijacked - re-enable when a working domain is found
import { weebCentralAdapter } from "./weebcentral"
import { dynastyScansAdapter } from "./dynasty-scans"
// import { asuraComicAdapter } from "./asuracomic" // retired: asuracomic.net now permanently 301-redirects every path (root + /series/<slug>) to asurascans.com, verified live 2026-07-18 - the old origin/URL-shape assumptions no longer match anything real, and asuraScansAdapter (./asurascans.ts) already covers the real site under its current domain
import { asuraScansAdapter } from "./asurascans"
import { madaraAdapters } from "./madara-sites"
import { mangaStreamAdapters } from "./mangastream-sites"
import { mangaBuddyAdapters } from "./mangabuddy-sites"
// import { mangaparkAdapter } from "./mangapark" // retired: site down 2026-06 - re-enable when back
import { webtoonsAdapter } from "./webtoons"
import { mangahubAdapter } from "./mangahub"
import { fanfoxFamilyAdapters } from "./fanfox-sites"
import { olympusstaffAdapter } from "./olympustaff"
import { mangafreakAdapter } from "./mangafreak"
import { comixAdapter } from "./comix"
import { nyanukafeAdapter } from "./nyanukafe"
import { mangakatanaAdapter } from "./mangakatana"
import { flameComicsAdapter } from "./flamecomics"
import { mangakAdapter } from "./mangak"
import { roliascanAdapter } from "./roliascan"

export { kaganeAdapter } from "./kagane"
export { mangadexAdapter } from "./mangadex"
export { mangareadAdapter } from "./mangaread"
export { mgekoAdapter } from "./mgeko"
// export { manganatoAdapter } from "./manganato" // retired: chapmanganato.to down 2026-06
export { weebCentralAdapter } from "./weebcentral"
export { dynastyScansAdapter } from "./dynasty-scans"
// export { asuraComicAdapter } from "./asuracomic" // retired: asuracomic.net redirects to asurascans.com, verified live 2026-07-18
export { asuraScansAdapter } from "./asurascans"
export { createMadaraAdapter, type MadaraConfig } from "./madara"
export { madaraAdapters, madaraOrigins } from "./madara-sites"
export { createMangaStreamAdapter, type MangaStreamConfig } from "./mangastream"
export { mangaStreamAdapters, mangaStreamOrigins } from "./mangastream-sites"
export { createMangaBuddyAdapter, type MangaBuddyConfig } from "./mangabuddy"
export { mangaBuddyAdapters, mangaBuddyOrigins } from "./mangabuddy-sites"
// export { mangaparkAdapter } from "./mangapark" // retired: site down 2026-06
export { webtoonsAdapter } from "./webtoons"
export { mangahubAdapter } from "./mangahub"
export { createFanfoxFamilyAdapter, type FanfoxFamilyConfig } from "./fanfox"
export { fanfoxFamilyAdapters, fanfoxFamilyOrigins } from "./fanfox-sites"
export { olympusstaffAdapter } from "./olympustaff"
export { mangafreakAdapter } from "./mangafreak"
export { comixAdapter } from "./comix"
export { nyanukafeAdapter } from "./nyanukafe"
export { mangakatanaAdapter } from "./mangakatana"
export { flameComicsAdapter } from "./flamecomics"
export { mangakAdapter } from "./mangak"
export { roliascanAdapter } from "./roliascan"

export const sourceAdapters: readonly SourceAdapter[] = [
    kaganeAdapter,
    mangadexAdapter,
    mangareadAdapter,
    mgekoAdapter,
    // manganatoAdapter, // retired: chapmanganato.to down 2026-06 - re-enable when back
    weebCentralAdapter,
    dynastyScansAdapter,
    // asuraComicAdapter, // retired: asuracomic.net redirects to asurascans.com (already registered below), verified live 2026-07-18 - re-enable only if asuracomic.net is ever restored as a distinct site
    asuraScansAdapter,
    ...madaraAdapters,
    ...mangaStreamAdapters,
    ...mangaBuddyAdapters,
    // mangaparkAdapter, // retired: site down 2026-06 - re-enable when back
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
export const sourceRegistry = new SourceRegistry(sourceAdapters)
