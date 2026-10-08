// What a user-added source is allowed to be and to reach. A profile is untrusted data: it is built
// from a page the user visited, and it also comes back through backup restore and sync pull, which
// only re-check its shape. These checks are the scope gate that runs on every registration, so a
// tampered profile cannot claim a wildcard TLD, a loopback or private-network origin, or one of the
// extension's own hosts.

import {
    NUMBER_SOURCES,
    interpolate,
    regexComplexityIssue,
    type InterpolationScope,
    type SiteProfile
} from "@amr/source-engine"
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

// Hosts that are a registry or a shared-hosting suffix, not one site: whoever controls a name under
// them is unrelated to whoever controls the suffix, so a profile can never claim the suffix itself
// (and so can never scope itself over every tenant). A conservative screen, not a full public
// suffix list: country second-level registries (co.uk, com.au, ...) by shape, and the common
// shared-hosting suffixes by name. A site hosted AT a name under one (my-site.github.io) is fine.
const REGISTRY_SUFFIX = /^(?:ac|co|com|ed|edu|go|gov|gob|id|ltd|me|mil|ne|net|nom|or|org|plc|sch)\.[a-z]{2}$/
const SHARED_HOSTING_SUFFIXES = new Set([
    "github.io",
    "gitlab.io",
    "pages.dev",
    "workers.dev",
    "r2.dev",
    "vercel.app",
    "netlify.app",
    "herokuapp.com",
    "blogspot.com",
    "wordpress.com",
    "wixsite.com",
    "weebly.com",
    "web.app",
    "firebaseapp.com",
    "appspot.com",
    "onrender.com",
    "fly.dev",
    "glitch.me",
    "repl.co",
    "azurewebsites.net",
    "cloudfront.net",
    "amazonaws.com",
    "ngrok.io",
    "trycloudflare.com",
    "duckdns.org",
    "no-ip.org",
    "ddns.net",
    "myshopify.com",
    "tumblr.com"
])

function isPublicSuffixHost(host: string): boolean {
    return REGISTRY_SUFFIX.test(host) || SHARED_HOSTING_SUFFIXES.has(host)
}

function parsePublicHost(host: string): URL | undefined {
    if (!HOST_PATTERN.test(host)) return undefined
    try {
        return new URL(`https://${host}`)
    } catch {
        return undefined
    }
}

// A profile regex runs in the background worker over untrusted page HTML, so it must compile and pass
// the same ReDoS screen the profile schema applies, again here because a stored or synced profile
// reaches registration without going through that schema's refinements in every path.
function isSafeRegex(source: string): boolean {
    try {
        void new RegExp(source)
    } catch {
        return false
    }
    return regexComplexityIssue(source) === undefined
}

// A URL template must resolve to a URL on the profile's own origin (a protocol-relative
// `//evil.example/{slug}` or an absolute foreign URL does not), and may use only the placeholders the
// engine actually supplies for that template. It is resolved here with dummy values for exactly
// those, so an unknown placeholder, or one the engine never fills (which would throw at runtime),
// rejects the profile.
function templateStaysOnOrigin(template: string | undefined, origin: URL, scope: InterpolationScope): boolean {
    if (template === undefined) return true
    try {
        return new URL(interpolate(template, scope), origin).origin === origin.origin
    } catch {
        return false
    }
}

// A user-added profile is in scope only when every origin it will read or request is the origin it
// was added from, or its www twin:
//   * `origin` is a bare https origin that passes isAddableUrl and is not itself a public suffix
//   * `id` is the origin's host without "www." (that is how the add flow names a source)
//   * every `domain` is an exact host (no wildcard) that is the origin's host or `www.` + it, and
//     is itself addable
//   * every `origins` / `imageOrigins` entry is exactly `https://<one of the domains>/*`
//   * every URL template resolves on the origin
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
    if (isPublicSuffixHost(originHost) || isPublicSuffixHost(originHost.replace(/^www\./, ""))) return false
    if (profile.id !== originHost.replace(/^www\./, "")) return false

    if (profile.domains.length > MAX_DOMAINS) return false
    for (const host of profile.domains) {
        if (host.includes("*") || host !== host.toLowerCase()) return false
        const parsed = parsePublicHost(host)
        if (!parsed || !isAddableUrl(parsed)) return false
        if (host !== originHost && host !== `www.${originHost}`) return false
    }

    const allowedPatterns = new Set(profile.domains.map(domain => `https://${domain}/*`))
    const patterns = [...profile.origins, ...(profile.imageOrigins ?? [])]
    if (patterns.length > MAX_DOMAINS * 2) return false
    if (!patterns.every(pattern => allowedPatterns.has(pattern))) return false

    if (profile.numberSource !== undefined && !NUMBER_SOURCES.includes(profile.numberSource)) return false
    if (profile.list?.itemTextPattern !== undefined && !isSafeRegex(profile.list.itemTextPattern)) return false

    const seriesScope = { slug: "probe-slug" }
    return (
        templateStaysOnOrigin(profile.series.urlTemplate, origin, seriesScope) &&
        templateStaysOnOrigin(profile.list?.urlTemplate, origin, seriesScope) &&
        templateStaysOnOrigin(profile.search?.urlTemplate, origin, { query: "probe query" })
    )
}
