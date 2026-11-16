import type { SourceAdapter } from "@amr/source-sdk"
import {
    buildScope,
    isScopeActive,
    isSourceInScope,
    mangadexAdapter,
    siteAdapters,
    siteExtraHosts,
    siteOrigins,
    webtoonsAdapter,
    type BuildScope
} from "@amr/sources"

// Single source of truth for source host origins. Consumed by the manifest (wxt.config.ts), the
// background permission helpers, and every UI grant prompt. The official sources' hosts live here;
// site hosts come only from the private site lab, in the local testing build.
const OFFICIAL_SOURCE_ORIGINS = [
    "https://mangadex.org/*",
    // mangadex.ts's manifest.domains also lists www.mangadex.org (match() accepts it).
    "https://www.mangadex.org/*",
    "https://api.mangadex.org/*",
    "https://uploads.mangadex.org/*",
    "*://*.mangadex.network/*",
    // WEBTOON - images served from Naver's pstatic CDN (webtoon-phinf.pstatic.net)
    "https://www.webtoons.com/*",
    "https://webtoons.com/*",
    "*://*.pstatic.net/*"
] as const

// The sites a source reaches that its manifest does not name, so a pattern can be traced to the
// source that needs it.
const OFFICIAL_EXTRA_HOSTS: Readonly<Record<string, readonly string[]>> = {
    mangadex: ["mangadex.network"],
    webtoons: ["pstatic.net"]
}

// What a build bundles beyond the official sources: nothing in a shipped build, the lab's site
// adapters in the local testing build.
export type SiteSet = {
    siteAdapters: readonly SourceAdapter[]
    siteOrigins: readonly string[]
    siteExtraHosts: Readonly<Record<string, readonly string[]>>
}

function siteOfPattern(pattern: string): string {
    const host = /^[^:]+:\/\/(?:\*\.)?([^/]+)\//.exec(pattern)?.[1] ?? ""
    return host.split(".").slice(-2).join(".").toLowerCase()
}

function owningSources(pattern: string, sites: SiteSet): string[] {
    const site = siteOfPattern(pattern)
    const extra = { ...OFFICIAL_EXTRA_HOSTS, ...sites.siteExtraHosts }
    return [mangadexAdapter, webtoonsAdapter, ...sites.siteAdapters]
        .filter(({ manifest }) =>
            [
                ...manifest.domains.map(domain => siteOfPattern(`https://${domain.replace(/^\*\./, "")}/`)),
                ...(manifest.imageOrigins ?? []).map(siteOfPattern),
                ...(extra[manifest.id] ?? [])
            ].includes(site)
        )
        .map(({ manifest }) => manifest.id)
}

// The host patterns a build with these sites requests. A testing build that drops an adapter also
// drops its site's host access, so that site gets the same one-time grant and "add site" path as any
// site the extension has never heard of.
export function sourceOriginsFor(sites: SiteSet, scope: BuildScope): readonly string[] {
    const origins = [...OFFICIAL_SOURCE_ORIGINS, ...sites.siteOrigins]
    if (!isScopeActive(scope)) return origins
    return origins.filter(pattern => owningSources(pattern, sites).some(id => isSourceInScope(id, scope)))
}

const BUNDLED_SITES: SiteSet = { siteAdapters, siteOrigins, siteExtraHosts }

// The ids of the bundled sources a host pattern belongs to.
export function sourcesOwningOrigin(pattern: string): string[] {
    return owningSources(pattern, BUNDLED_SITES)
}

export function originsInScope(origins: readonly string[], scope: BuildScope): readonly string[] {
    if (!isScopeActive(scope)) return origins
    return origins.filter(pattern => sourcesOwningOrigin(pattern).some(id => isSourceInScope(id, scope)))
}

export const SOURCE_ORIGINS: readonly string[] = sourceOriginsFor(BUNDLED_SITES, buildScope)

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

// The single optional pattern behind both the per-site "Add site" grant and the opt-in "Detect on
// all sites" setting. Granted whole, it lets the reader-page check run on any https site the user
// opens without a per-site prompt. Never granted at install.
export const ALL_SITES_ORIGIN = "https://*/*" as const

export function allSitesPermission(): { origins: string[] } {
    return { origins: [ALL_SITES_ORIGIN] }
}

// Mutable copy for the browser.permissions APIs, which expect string[].
export function sourceOrigins(): string[] {
    return [...SOURCE_ORIGINS]
}

export function syncOrigins(): string[] {
    return [...SYNC_ORIGINS]
}
