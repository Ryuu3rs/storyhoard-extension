// Works out whether a Firefox update will stop and ask users to approve it. An update that adds a
// prompting API permission or a required data type waits until each user accepts a prompt, and
// anyone who misses it stays on the old version (0.32.2 -> 0.33.0 added required websiteContent +
// searchTerms and stranded users that way). New MV3 host access never holds the update, but
// Firefox does not grant it either, so it is reported on its own.

// API permissions Firefox installs without showing a permission message. Anything not listed here
// is treated as prompting, so a new permission is flagged until someone checks it and adds it.
const SILENT_PERMISSIONS = new Set([
    "activeTab",
    "alarms",
    "captivePortal",
    "contextMenus",
    "contextualIdentities",
    "cookies",
    "declarativeNetRequestWithHostAccess",
    "dns",
    "identity",
    "idle",
    "menus",
    "menus.overrideContext",
    "offscreen",
    "scripting",
    "storage",
    "theme",
    "unlimitedStorage",
    "webRequest",
    "webRequestBlocking",
    "webRequestFilterResponse.serviceWorkerScript"
])

const isOrigin = entry => entry === "<all_urls>" || entry.includes("://")

function unique(values) {
    return [...new Set(values)].sort()
}

function split(entries = []) {
    return {
        permissions: entries.filter(entry => !isOrigin(entry)),
        origins: entries.filter(isOrigin)
    }
}

function dataTypes(values = []) {
    return unique(values.filter(value => value !== "none"))
}

// Normalises a built manifest.json into the shape the diff compares.
export function specFromManifest(manifest) {
    const required = split(manifest.permissions)
    const optional = split(manifest.optional_permissions)
    const data = manifest.browser_specific_settings?.gecko?.data_collection_permissions ?? {}
    return {
        version: manifest.version,
        permissions: unique(required.permissions),
        origins: unique([...required.origins, ...(manifest.host_permissions ?? [])]),
        optionalPermissions: unique([
            ...optional.permissions,
            ...optional.origins,
            ...(manifest.optional_host_permissions ?? [])
        ]),
        dataRequired: dataTypes(data.required),
        dataOptional: dataTypes(data.optional)
    }
}

// Normalises the `current_version` object from AMO's public addon API. The API does not report
// optional_host_permissions, so optional origins cannot be compared against it.
export function specFromAmoVersion(amoVersion) {
    const file = amoVersion.file ?? {}
    const required = split(file.permissions)
    const optional = split(file.optional_permissions)
    return {
        version: amoVersion.version,
        permissions: unique(required.permissions),
        origins: unique([...required.origins, ...(file.host_permissions ?? [])]),
        optionalPermissions: unique([...optional.permissions, ...optional.origins]),
        optionalOriginsUnknown: true,
        dataRequired: dataTypes(file.data_collection_permissions),
        dataOptional: dataTypes(file.optional_data_collection_permissions)
    }
}

function parsePattern(pattern) {
    if (pattern === "<all_urls>") return { scheme: "*", host: "*", path: "/*" }
    const match = /^([^:]+):\/\/([^/]*)(\/.*)?$/.exec(pattern)
    if (!match) return undefined
    return { scheme: match[1], host: match[2], path: match[3] ?? "/" }
}

function hostCovers(oldHost, newHost) {
    if (oldHost === "*" || oldHost === newHost) return true
    if (!oldHost.startsWith("*.")) return false
    const base = oldHost.slice(2)
    const host = newHost.startsWith("*.") ? newHost.slice(2) : newHost
    return host === base || host.endsWith(`.${base}`)
}

// True when an existing match pattern already grants everything the new one asks for.
export function originCovers(oldPattern, newPattern) {
    const oldParts = parsePattern(oldPattern)
    const newParts = parsePattern(newPattern)
    if (!oldParts || !newParts) return oldPattern === newPattern
    if (newParts.scheme === "*" && oldParts.scheme !== "*") return false
    if (oldParts.scheme !== "*" && oldParts.scheme !== newParts.scheme) return false
    if (oldParts.scheme === "*" && !["*", "http", "https", "ws", "wss"].includes(newParts.scheme)) return false
    if (!hostCovers(oldParts.host, newParts.host)) return false
    return oldParts.path === "/*" || oldParts.path === newParts.path
}

export function diffPermissions(previous, next) {
    const addedPermissions = next.permissions.filter(permission => !previous.permissions.includes(permission))
    const prompting = {
        permissions: addedPermissions.filter(permission => !SILENT_PERMISSIONS.has(permission)),
        dataRequired: next.dataRequired.filter(type => !previous.dataRequired.includes(type))
    }
    // MV3: Firefox installs the update without asking and leaves new host access ungranted
    // (bug 1893232), so it never holds the update, but whatever needs those hosts fails.
    const hostsNotGranted = next.origins.filter(origin => !previous.origins.some(old => originCovers(old, origin)))
    return {
        from: previous.version,
        to: next.version,
        prompts: prompting.permissions.length + prompting.dataRequired.length > 0,
        prompting,
        hostsNotGranted,
        silentPermissions: addedPermissions.filter(permission => SILENT_PERMISSIONS.has(permission)),
        addedOptional: next.optionalPermissions.filter(
            entry =>
                !previous.optionalPermissions.includes(entry) && !(previous.optionalOriginsUnknown && isOrigin(entry))
        ),
        addedDataOptional: next.dataOptional.filter(type => !previous.dataOptional.includes(type)),
        removedPermissions: previous.permissions.filter(permission => !next.permissions.includes(permission)),
        removedOrigins: previous.origins.filter(origin => !next.origins.some(entry => originCovers(entry, origin))),
        removedDataRequired: previous.dataRequired.filter(type => !next.dataRequired.includes(type))
    }
}

// One line saying why an update prompts, for the CI warning annotation.
export function promptSummary(diff) {
    const parts = [
        ["permissions", diff.prompting.permissions],
        ["required data types", diff.prompting.dataRequired]
    ]
        .filter(([, values]) => values.length > 0)
        .map(([label, values]) => `${label}: ${values.join(", ")}`)
    return `${diff.from} -> ${diff.to} adds ${parts.join("; ")}. Users must approve the update; say so in the release notes.`
}

export function hostSummary(diff) {
    return `${diff.from} -> ${diff.to} adds host access: ${diff.hostsNotGranted.join(", ")}. Firefox updates without asking but does not grant it; request it with permissions.request or tell users to allow it in about:addons.`
}

export function formatReport(diff) {
    const lines = []
    const list = (label, values) => {
        if (values.length > 0) lines.push(`- ${label}: ${values.join(", ")}`)
    }
    if (diff.prompts) {
        lines.push(
            `Updating ${diff.from} -> ${diff.to} will ask every Firefox user to approve it. Until they accept, they stay on ${diff.from}. Say so in the release notes.`
        )
    } else {
        lines.push(
            `Updating ${diff.from} -> ${diff.to} applies without a prompt: no new prompting permissions or required data types.`
        )
    }
    list("New prompting permissions", diff.prompting.permissions)
    list("New required data types", diff.prompting.dataRequired)
    list("New host access (installed without asking, but NOT granted until the user allows it)", diff.hostsNotGranted)
    list("New permissions with no prompt", diff.silentPermissions)
    list("New optional permissions (asked at runtime, no update prompt)", diff.addedOptional)
    list("New optional data types (no update prompt)", diff.addedDataOptional)
    list("Removed permissions", diff.removedPermissions)
    // A count, not the list: CI logs are public and old host lists name sites.
    if (diff.removedOrigins.length > 0) lines.push(`- Removed host access: ${diff.removedOrigins.length} patterns`)
    list("Removed required data types", diff.removedDataRequired)
    return lines.join("\n")
}
