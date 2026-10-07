// What a user-added source is allowed to be and to reach. A profile is untrusted data: it is built
// from a page the user visited, and it also comes back through backup restore and sync pull, which
// only re-check its shape. These checks are the scope gate that runs on every registration, so a
// tampered profile cannot claim a wildcard TLD, a loopback or private-network origin, or one of the
// extension's own hosts.

import type { SiteProfile } from "@amr/source-engine"
import { isNonPublicHost } from "@amr/source-sdk"
import { ANILIST_API_ORIGIN, GITHUB_API_ORIGIN, METADATA_COVER_ORIGINS, SOURCE_ORIGINS } from "./permissions"

// The extension's own services and accounts, never a reader to add.
const FIRST_PARTY_HOSTS = ["weeb.ltd", "anilist.co", "myanimelist.net", "github.com"]

// "https://*.host/*", "*://host/*", "https://host:8443/x" -> "host". Undefined for anything else.
function hostOfOriginPattern(pattern: string): string | undefined {
    const match = /^(?:\*|https?):\/\/(?:\*\.)?([^/*:]+)(?::\d+)?(?:\/.*)?$/i.exec(pattern.trim())
    return match?.[1]?.toLowerCase()
}

function envOrigins(): string[] {
    const env = import.meta.env as Record<string, string | undefined>
    return [env["VITE_COMMUNITY_API_ORIGIN"], env["VITE_METADATA_API_ORIGIN"], env["VITE_WEEB_SITE_ORIGIN"]].filter(
        (value): value is string => typeof value === "string" && value !== ""
    )
}

// Every host the manifest holds required host access to (bundled sources, GitHub, AniList, cover
// CDNs) plus the build-time service origins, plus the first-party hosts. A user-added source can
// never be one of these or a subdomain of one. Built per call so a build-time env value is honoured.
export function reservedHosts(): Set<string> {
    const patterns = [
        ...SOURCE_ORIGINS,
        GITHUB_API_ORIGIN,
        ANILIST_API_ORIGIN,
        ...METADATA_COVER_ORIGINS,
        "https://weeb.ltd/*",
        ...envOrigins()
    ]
    const hosts = new Set<string>(FIRST_PARTY_HOSTS)
    for (const pattern of patterns) {
        const host = hostOfOriginPattern(pattern)
        if (host) hosts.add(host)
    }
    return hosts
}

function isReservedHost(host: string): boolean {
    for (const reserved of reservedHosts()) {
        if (host === reserved || host.endsWith(`.${reserved}`)) return true
    }
    return false
}

// Only a public https site with a real hostname can be added: no loopback, private-network,
// IP-literal, trailing-dot or explicit-port origins, no embedded credentials, and none of the
// extension's own services or already-supported sources.
export function isAddableUrl(url: URL): boolean {
    if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return false
    const host = url.hostname.toLowerCase()
    if (isNonPublicHost(host)) return false
    return !isReservedHost(host)
}

const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const MAX_DOMAINS = 10

function parsePublicHost(host: string): URL | undefined {
    if (!HOST_PATTERN.test(host)) return undefined
    try {
        return new URL(`https://${host}`)
    } catch {
        return undefined
    }
}

// A user-added profile is in scope only when every origin it will read or request is the origin it
// was added from, or a subdomain of it:
//   * `origin` is a bare https origin that passes isAddableUrl
//   * every `domain` is an exact host, or `*.` + host, that is the origin's host or a subdomain of
//     it and is itself addable (so `*.com`, `*`, other sites and reserved hosts are out)
//   * every `origins` / `imageOrigins` entry is exactly `https://<one of the domains>/*`
export function validateProfileScope(profile: SiteProfile): boolean {
    let origin: URL
    try {
        origin = new URL(profile.origin)
    } catch {
        return false
    }
    if (origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") return false
    if (!isAddableUrl(origin)) return false
    const originHost = origin.hostname.toLowerCase()

    if (profile.domains.length > MAX_DOMAINS) return false
    for (const domain of profile.domains) {
        const host = domain.startsWith("*.") ? domain.slice(2) : domain
        if (host !== host.toLowerCase()) return false
        const parsed = parsePublicHost(host)
        if (!parsed || !isAddableUrl(parsed)) return false
        if (host !== originHost && !host.endsWith(`.${originHost}`)) return false
    }

    const allowedPatterns = new Set(profile.domains.map(domain => `https://${domain}/*`))
    const patterns = [...profile.origins, ...(profile.imageOrigins ?? [])]
    if (patterns.length > MAX_DOMAINS * 2) return false
    return patterns.every(pattern => allowedPatterns.has(pattern))
}
