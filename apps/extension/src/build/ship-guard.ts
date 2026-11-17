import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

// Node-side checks for the shipped (store) build, run by wxt.config.ts. The shipped build carries the
// official sources only: no site profile for any other site, no chapter-list rule, and none of their
// hostnames anywhere in the bundle.

type ProfileShape = { id?: unknown; domains?: unknown; list?: unknown }

// A profile the shipped build could carry: an official source with no chapter-list rule.
export function isShippableProfile(raw: unknown, officialIds: readonly string[]): boolean {
    const profile = raw as ProfileShape | null
    return typeof profile?.id === "string" && officialIds.includes(profile.id) && profile.list === undefined
}

// The profiles a JSON text holds, or undefined when the text is not a profile file.
export function profilesIn(text: string): unknown[] | undefined {
    try {
        const parsed = JSON.parse(text) as { profiles?: unknown } | null
        return Array.isArray(parsed?.profiles) ? parsed.profiles : undefined
    } catch {
        return undefined
    }
}

// A profile file as the shipped build loads it: the same file with no profiles. Undefined for any other text.
export function emptiedProfileFile(text: string): string | undefined {
    if (!profilesIn(text)) return undefined
    return JSON.stringify({ ...(JSON.parse(text) as object), profiles: [] })
}

export function unshippableProfileIds(profiles: readonly unknown[], officialIds: readonly string[]): string[] {
    return profiles
        .filter(profile => !isShippableProfile(profile, officialIds))
        .map(profile => String((profile as ProfileShape | null)?.id ?? "?"))
}

export function bareHost(host: string): string {
    return host
        .trim()
        .toLowerCase()
        .replace(/^\*\./, "")
        .replace(/^www\./, "")
}

export function unshippableProfileHosts(profiles: readonly unknown[], officialIds: readonly string[]): string[] {
    const hosts = profiles
        .filter(profile => !isShippableProfile(profile, officialIds))
        .flatMap(profile => {
            const domains = (profile as ProfileShape | null)?.domains
            return Array.isArray(domains) ? domains.filter((d): d is string => typeof d === "string") : []
        })
        .map(bareHost)
    return [...new Set(hosts)].filter(host => host.includes("."))
}

// Every file of a package, as paths relative to it with forward slashes. node_modules is skipped.
export function packageFiles(dir: string): string[] {
    const walk = (current: string): string[] =>
        readdirSync(current).flatMap(name => {
            if (name === "node_modules") return []
            const path = join(current, name)
            return statSync(path).isDirectory() ? walk(path) : [relative(dir, path).replace(/\\/g, "/")]
        })
    return walk(dir)
}

// The hostnames of every non-official profile in every JSON file of the package.
export function forbiddenPackageHosts(dir: string, officialIds: readonly string[]): string[] {
    const hosts = packageFiles(dir)
        .filter(file => file.endsWith(".json"))
        .flatMap(file => unshippableProfileHosts(profilesIn(readFileSync(join(dir, file), "utf8")) ?? [], officialIds))
    return [...new Set(hosts)]
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// The hosts that occur in `text` as a whole hostname (so "site.to" does not match "site.tools").
export function hostsIn(text: string, hosts: readonly string[]): string[] {
    const lower = text.toLowerCase()
    return hosts.filter(host => new RegExp(`(?<![a-z0-9-])${escapeRegExp(host)}(?![a-z0-9-])`).test(lower))
}
