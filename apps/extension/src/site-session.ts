// The user's per-site choice to send their browser session with update checks. A site can only be turned
// on after a real check saw a challenge from it, and only by the user. This lives in storage.local under
// its own key, outside site profiles, settings, backups and sync, so no imported data can ever set it.

const STORE_KEY = "siteSessions"

type SeenSite = { seenAt: number; openUrl: string; sampleTitle: string }
type SiteSessionStore = { seen: Record<string, SeenSite>; enabled: Record<string, number> }

export type ChallengedSite = { origin: string; openUrl: string; sampleTitle: string }
export type SiteSessionRow = ChallengedSite & { enabled: boolean }

let enabledOrigins: readonly string[] = []

function isSiteOrigin(origin: unknown): origin is string {
    if (typeof origin !== "string") return false
    try {
        const url = new URL(origin)
        return url.protocol === "https:" && url.origin === origin
    } catch {
        return false
    }
}

async function readStore(): Promise<SiteSessionStore> {
    const raw = (await browser.storage.local.get(STORE_KEY))[STORE_KEY] as Partial<SiteSessionStore> | undefined
    const record = (value: unknown): Record<string, never> =>
        value !== null && typeof value === "object" ? (value as Record<string, never>) : {}
    return { seen: record(raw?.seen), enabled: record(raw?.enabled) }
}

// A hand-edited or corrupted entry never switches a session on: it must also name a site a check saw.
function activeOrigins(store: SiteSessionStore): string[] {
    return Object.keys(store.enabled).filter(origin => isSiteOrigin(origin) && store.seen[origin] !== undefined)
}

export async function loadSiteSessions(): Promise<void> {
    try {
        enabledOrigins = activeOrigins(await readStore())
    } catch (error) {
        enabledOrigins = []
        console.error("[AMR] Could not read site session choices", error)
    }
}

export function siteSessionOrigins(): readonly string[] {
    return enabledOrigins
}

export async function recordChallengedSites(sites: readonly ChallengedSite[]): Promise<void> {
    if (sites.length === 0) return
    try {
        const store = await readStore()
        for (const { origin, openUrl, sampleTitle } of sites) {
            if (isSiteOrigin(origin)) store.seen[origin] = { seenAt: Date.now(), openUrl, sampleTitle }
        }
        await browser.storage.local.set({ [STORE_KEY]: store })
    } catch (error) {
        console.error("[AMR] Could not record challenged sites", error)
    }
}

// Turning on refuses a site no check has seen a challenge from. Returns whether the choice was applied.
export async function setSiteSession(origin: string, enabled: boolean): Promise<boolean> {
    const store = await readStore()
    if (enabled) {
        if (!isSiteOrigin(origin) || store.seen[origin] === undefined) return false
        store.enabled[origin] = Date.now()
    } else {
        delete store.enabled[origin]
    }
    await browser.storage.local.set({ [STORE_KEY]: store })
    enabledOrigins = activeOrigins(store)
    return true
}

// Removing a site takes its session choice with it, so adding the site back later starts from off.
export async function revokeSiteSessions(origins: readonly string[]): Promise<void> {
    try {
        const store = await readStore()
        const held = origins.filter(origin => store.enabled[origin] !== undefined)
        if (held.length === 0) return
        for (const origin of held) delete store.enabled[origin]
        await browser.storage.local.set({ [STORE_KEY]: store })
        enabledOrigins = activeOrigins(store)
    } catch (error) {
        console.error("[AMR] Could not revoke site session choices", error)
    }
}

export async function listSiteSessions(): Promise<SiteSessionRow[]> {
    const store = await readStore()
    const active = new Set(activeOrigins(store))
    return Object.entries(store.seen)
        .filter(([origin]) => isSiteOrigin(origin))
        .map(([origin, site]) => ({
            origin,
            openUrl: site.openUrl,
            sampleTitle: site.sampleTitle,
            enabled: active.has(origin)
        }))
}
