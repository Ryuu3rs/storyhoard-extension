import { z } from "zod"
import { SITE_BASE } from "./account"

// Shared official/partner-site allowlist. A single source of truth consumed by the on-site panel
// (overlay-only treatment), the library/search surfacing, and the best-version ranker. The baked
// default is the floor; weeb.ltd may ADD sites or fix a label via the public feed, but can never
// REMOVE a baked site, and a site the feed introduces that is not baked is overlay-eligible but
// NOT eligible for the user-facing "Read on <name>" credit until it is baked/reviewed (verified).
export type OfficialSite = {
    domain: string
    name: string
    // true = baked or a feed label-fix of a baked domain (trusted for the named credit line).
    // false = introduced only by the remote feed (overlay treatment yes, named credit no).
    verified?: boolean
}

// Display names power the official-only credit line (decision D2). Keep conservative and accurate.
export const OFFICIAL_SITES_DEFAULT: readonly OfficialSite[] = [
    { domain: "webtoons.com", name: "WEBTOON", verified: true },
    { domain: "mangadex.org", name: "MangaDex", verified: true },
    { domain: "mangaplus.shueisha.co.jp", name: "MANGA Plus", verified: true },
    { domain: "tapas.io", name: "Tapas", verified: true },
    { domain: "comikey.com", name: "Comikey", verified: true },
    { domain: "inkr.com", name: "INKR", verified: true }
]

const CACHE_KEY = "officialSitesCache"
const FEED_PATH = "/api/public/official-sites"
const MAX_REMOTE_SITES = 200

const officialSiteSchema = z.object({ domain: z.string().min(1).max(255), name: z.string().min(1).max(80) })
const feedSchema = z.object({ sites: z.array(officialSiteSchema).max(MAX_REMOTE_SITES) })

type OfficialSitesCache = { sites: OfficialSite[]; fetchedAt: number; etag?: string }

function normalizeDomain(d: string): string {
    return d
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/\/.*$/, "")
}

// Host match: exact domain or any subdomain. www is stripped on both sides.
export function isOfficialHost(host: string, sites: readonly OfficialSite[]): boolean {
    return officialSiteForHost(host, sites) !== undefined
}

// The matching entry (carries name + verified), or undefined. Callers that render the named credit
// line must additionally check `verified`; overlay treatment applies to any match.
export function officialSiteForHost(host: string, sites: readonly OfficialSite[]): OfficialSite | undefined {
    // Strip a trailing dot (absolute FQDN form, e.g. "webtoons.com.") and a leading www before matching.
    const h = host
        .replace(/\.$/, "")
        .replace(/^www\./, "")
        .toLowerCase()
    for (const s of sites) {
        const d = normalizeDomain(s.domain)
        if (d && (h === d || h.endsWith("." + d))) return s
    }
    return undefined
}

// Name for the credit line, only when the match is verified (R4: the feed cannot name an arbitrary
// domain as official). Returns undefined for overlay-only (unverified) matches.
export function officialNameForHost(host: string, sites: readonly OfficialSite[]): string | undefined {
    const match = officialSiteForHost(host, sites)
    return match?.verified ? match.name : undefined
}

// Union by normalized domain. Baked is the floor and is never dropped. A feed entry whose domain
// matches a baked one may fix the label and stays verified; a feed entry with a new domain is added
// as unverified (overlay yes, named credit no).
export function mergeOfficialSites(baked: readonly OfficialSite[], remote: readonly OfficialSite[]): OfficialSite[] {
    const byDomain = new Map<string, OfficialSite>()
    for (const s of baked) {
        const d = normalizeDomain(s.domain)
        if (d) byDomain.set(d, { domain: d, name: s.name, verified: true })
    }
    for (const s of remote) {
        const d = normalizeDomain(s.domain)
        if (!d) continue
        const existing = byDomain.get(d)
        byDomain.set(d, { domain: d, name: s.name, verified: existing?.verified === true })
    }
    return [...byDomain.values()]
}

// The effective list: baked merged with the last-cached remote feed. Pure read; never fetches.
// Falls back to the baked default on any storage/parse trouble, so officialness never breaks.
export async function getCachedOfficialSites(): Promise<OfficialSite[]> {
    try {
        const stored = await browser.storage.local.get(CACHE_KEY)
        const cache = stored[CACHE_KEY] as OfficialSitesCache | undefined
        if (cache?.sites?.length) return mergeOfficialSites(OFFICIAL_SITES_DEFAULT, cache.sites)
    } catch {
        // fall through to baked default
    }
    return [...OFFICIAL_SITES_DEFAULT]
}

// Fetch the public feed and cache it. Zod-validated and size-capped (R4/R5); a 304, a non-OK
// status, a validation failure, or a network error all leave the existing cache untouched so a
// bad or hostile response can only ever fall back to known-good data, never corrupt it.
export async function refreshOfficialSites(): Promise<void> {
    try {
        const stored = await browser.storage.local.get(CACHE_KEY)
        const prev = stored[CACHE_KEY] as OfficialSitesCache | undefined
        const headers: Record<string, string> = {}
        if (prev?.etag) headers["If-None-Match"] = prev.etag
        const res = await fetch(`${SITE_BASE}${FEED_PATH}`, { headers, credentials: "omit" })
        if (res.status === 304 || !res.ok) return
        const parsed = feedSchema.safeParse(await res.json())
        if (!parsed.success) return
        const etag = res.headers.get("etag") ?? undefined
        const cache: OfficialSitesCache = { sites: parsed.data.sites, fetchedAt: Date.now(), ...(etag ? { etag } : {}) }
        await browser.storage.local.set({ [CACHE_KEY]: cache })
    } catch {
        // keep the existing cache
    }
}
