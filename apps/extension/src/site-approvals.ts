// Which sites the user approved in this browser, kept apart from what the browser grants.
//
// With "Detect on all sites" on, the browser grants every https site, so "does the browser grant this
// site?" no longer means "did the user choose this site?". A site row that arrived through a backup
// restore, an import or a sync pull would then count as chosen, register, read its site in the
// background, and keep a per-site grant once the setting is turned off. A row counts as chosen only when
// the browser grants its exact pattern (a per-site grant the user gave) or the user approved it here.
//
// The record lives in storage.local under its own key, which no restore, import or sync path writes.

const KEY = "approvedSiteOrigins"

async function approvedOrigins(): Promise<Set<string>> {
    try {
        const stored = (await browser.storage.local.get(KEY))[KEY]
        return new Set(Array.isArray(stored) ? stored.filter((o): o is string => typeof o === "string") : [])
    } catch {
        return new Set()
    }
}

// Called only from flows the user started: adding or following a site.
export async function approveSiteOrigins(origins: readonly string[]): Promise<void> {
    if (origins.length === 0) return
    const approved = await approvedOrigins()
    const before = approved.size
    for (const origin of origins) approved.add(origin)
    if (approved.size !== before) await browser.storage.local.set({ [KEY]: [...approved] })
}

export async function forgetSiteOrigins(origins: readonly string[]): Promise<void> {
    const approved = await approvedOrigins()
    let changed = false
    for (const origin of origins) changed = approved.delete(origin) || changed
    if (changed) await browser.storage.local.set({ [KEY]: [...approved] })
}

// A grant whose host is a wildcard ("https://*/*", "https://*.com/*") covers sites the user never named.
function isWildcardHostGrant(pattern: string): boolean {
    return pattern === "<all_urls>" || /^[^:]+:\/\/\*/.test(pattern)
}

// The manifest's required wildcards (the official sources' image hosts) are fixed at install and cover
// only hosts no added site may claim, so they do not make other grants suspect.
function requiredGrants(): Set<string> {
    try {
        return new Set(browser.runtime.getManifest().host_permissions ?? [])
    } catch {
        return new Set()
    }
}

// True when the browser grants every origin AND each one was chosen by the user. Without a wildcard-host
// grant every grant the browser holds is one the user gave site by site. With one, an origin counts only
// when its exact pattern is a grant of its own or the user approved it in this browser.
export async function holdsChosenAccess(origins: readonly string[]): Promise<boolean> {
    if (origins.length === 0) return false
    try {
        if (!(await browser.permissions.contains({ origins: [...origins] }))) return false
        const granted = new Set((await browser.permissions.getAll()).origins ?? [])
        const required = requiredGrants()
        if (![...granted].some(pattern => isWildcardHostGrant(pattern) && !required.has(pattern))) return true
        if (origins.every(origin => granted.has(origin))) return true
        const approved = await approvedOrigins()
        return origins.every(origin => granted.has(origin) || approved.has(origin))
    } catch {
        return false
    }
}
