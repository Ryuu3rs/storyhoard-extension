const COMMUNITY_KEY = "community"
const INSTALL_KEY = "installId"

// The privacy-policy / consent version this build asks users to agree to. Bump it when the
// policy materially changes so the client re-prompts and the server re-stamps. Must match
// CURRENT_CONSENT_VERSION on the community server.
export const CONSENT_VERSION = 1

// Injected at build time from .env locally and from the VITE_COMMUNITY_API_URL repo
// variable in CI (see .github/workflows/release-please.yml) - never hardcoded in source.
const COMMUNITY_API_BASE = (import.meta.env.VITE_COMMUNITY_API_URL as string | undefined) ?? ""

// True only when a base URL was baked into this build. When false, every network call
// would resolve against the extension's own origin and fail with an opaque
// "NetworkError when attempting to fetch resource"; callers should surface a clear
// "not configured in this build" state instead of letting the raw fetch throw.
export const communityConfigured = COMMUNITY_API_BASE.length > 0

function assertCommunityConfigured() {
    if (!COMMUNITY_API_BASE) {
        throw new Error("The community server is not configured in this build.")
    }
}

export type CommunityRecommendation = {
    title: string
    sourceId: string
}

export type LeaderboardEntry = {
    rank: number
    username: string
    chaptersWeek: number
}

export type CommunityStats = {
    leaderboard: LeaderboardEntry[]
    trendingManga: Array<{ title: string; sourceId: string; count: number }>
    topGenres: Array<{ genre: string; count: number }>
    topRated: Array<{ title: string; avgRating: number; ratingCount: number }>
    totalUsers: number
}

export type CommunityMangaStats = {
    avgRating: number | null
    ratingCount: number
    readerCount: number
}

export type CommunityProfile = {
    enabled: boolean
    username: string
    userId: string
    // Proves this device owns userId. Empty until the server has issued one.
    secret: string
    lastSyncAt: number
    communityRank: number | null
    recommendations: CommunityRecommendation[]
    newAchievements: string[]
    communityStats: CommunityStats | null
    // The consent-card version the user agreed to (0 = never agreed). When this is below
    // CONSENT_VERSION the client re-prompts before sending anything.
    consentVersion: number
    // When they agreed, epoch ms. 0 if never.
    consentAt: number
    // True once the user has explicitly tapped "Disable" on the consent card, so it is not
    // shown again (they re-enable from Settings). Distinct from "never seen it" (both leave
    // enabled false), so a first-run user still gets the card exactly once.
    declined: boolean
}

const defaultProfile: CommunityProfile = {
    // Opt-IN: reading activity (titles/genres/dates) must not leave the device until the
    // user explicitly enables community features. Was opt-out, which auto-registered and
    // uploaded history with no consent. Existing users keep their stored setting.
    enabled: false,
    username: "",
    userId: "",
    secret: "",
    lastSyncAt: 0,
    communityRank: null,
    recommendations: [],
    newAchievements: [],
    communityStats: null,
    consentVersion: 0,
    consentAt: 0,
    declined: false
}

// What community features send, in Firefox's data-collection categories (all optional in the manifest):
// reading activity (browsingActivity), the install id and version (technicalAndInteraction) and the
// username (personallyIdentifyingInfo). The opt-in asks Firefox for them, and nothing is sent without them.
export const COMMUNITY_DATA_PERMISSION = {
    data_collection: ["browsingActivity", "technicalAndInteraction", "personallyIdentifyingInfo"]
} as never
// Given back when community features are turned off. technicalAndInteraction stays: usage analytics uses it.
export const COMMUNITY_ONLY_DATA_PERMISSION = {
    data_collection: ["browsingActivity", "personallyIdentifyingInfo"]
} as never

// True when the user opted in and, on Firefox, the browser's data permission allows the upload too.
export async function communityAllowed(profile: Pick<CommunityProfile, "enabled">): Promise<boolean> {
    if (!profile.enabled) return false
    if (import.meta.env.BROWSER !== "firefox") return true
    try {
        return await browser.permissions.contains(COMMUNITY_DATA_PERMISSION)
    } catch {
        return false
    }
}

export async function getCommunityProfile(): Promise<CommunityProfile> {
    const stored = await browser.storage.local.get(COMMUNITY_KEY)
    return { ...defaultProfile, ...(stored[COMMUNITY_KEY] as Partial<CommunityProfile> | undefined) }
}

export async function updateCommunityProfile(patch: Partial<CommunityProfile>): Promise<CommunityProfile> {
    const profile = { ...(await getCommunityProfile()), ...patch }
    await browser.storage.local.set({ [COMMUNITY_KEY]: profile })
    return profile
}

export type CommunityEvent = {
    type: "chapter_read"
    sourceId: string
    mangaTitle: string
    genres: string[]
    date: string
    // Chapter number, or a short hash of the chapter id when the source has no numbering.
    chapter?: string
}

// Silent auto-registration uses a generic, clearly-anonymous handle - never
// anything that could pass for a real username someone chose deliberately.
export function generateAnonymousUsername(): string {
    return `Reader${1000 + Math.floor(Math.random() * 9000)}`
}

export class CommunityAuthError extends Error {}

function withSecret(secret: string): Record<string, string> {
    return { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }
}

// Swaps an id from before secrets existed for a secret, once.
export async function apiClaim(userId: string): Promise<{ secret: string }> {
    assertCommunityConfigured()
    const res = await fetch(`${COMMUNITY_API_BASE}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId })
    })
    if (!res.ok) throw new Error(`Claim failed: ${res.status}`)
    return res.json() as Promise<{ secret: string }>
}

export async function apiRegister(username: string): Promise<{ userId: string; secret?: string }> {
    assertCommunityConfigured()
    const res = await fetch(`${COMMUNITY_API_BASE}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Consent is declared to the server, which refuses to register (and so to collect
        // anything) without the current version. installId links this install to the account
        // for the install dashboard.
        body: JSON.stringify({ username, consentVersion: CONSENT_VERSION, installId: await getInstallId() })
    })
    if (!res.ok) {
        const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string }
        throw new Error(body.error ?? `Registration failed: ${res.status}`)
    }
    return res.json() as Promise<{ userId: string; secret?: string }>
}

// A random, anonymous per-install id (not a user identifier). Generated once and kept in
// storage.local; a reinstall/clear makes a new one, which is the honest way to count installs.
// Deliberately NOT included in the export/backup envelope so restoring a backup on a new
// machine does not carry the old install's id (that would undercount installs).
export async function getInstallId(): Promise<string> {
    const stored = await browser.storage.local.get(INSTALL_KEY)
    const existing = stored[INSTALL_KEY] as string | undefined
    if (existing) return existing
    const id = crypto.randomUUID()
    await browser.storage.local.set({ [INSTALL_KEY]: id })
    return id
}

// Anonymous install/active ping. Fire-and-forget from the background; caller gates on consent.
export async function apiPing(browserName: string, version: string): Promise<void> {
    assertCommunityConfigured()
    await fetch(`${COMMUNITY_API_BASE}/ping`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installId: await getInstallId(), browser: browserName, version })
    })
}

export type Announcement = {
    id: string
    title: string
    body: string
    level: string
    startsAt: number
    endsAt: number | null
    createdAt: number
}

// Owner broadcast messages for this build's browser/version. A read-only fetch (like an
// update check) - it sends no user data beyond the anonymous browser/version filter, so it
// runs regardless of the community consent toggle, only gated on the server being configured.
export async function apiGetAnnouncements(browserName: string, version: string): Promise<Announcement[]> {
    if (!communityConfigured) return []
    const url = `${COMMUNITY_API_BASE}/announcements?browser=${encodeURIComponent(browserName)}&version=${encodeURIComponent(version)}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Announcements fetch failed: ${res.status}`)
    const data = (await res.json()) as { announcements?: unknown } | null
    return parseAnnouncements(data?.announcements)
}

const finiteOr = <T>(v: unknown, fallback: T): number | T =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

// The app keys its announcement list by id, so a non-list, an entry without a string id or text,
// or a repeated id is dropped here rather than breaking the page render.
export function parseAnnouncements(raw: unknown): Announcement[] {
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    const out: Announcement[] = []
    for (const a of raw) {
        if (!isRecord(a)) continue
        const { id, title, body, level } = a
        if (typeof id !== "string" || !id || seen.has(id)) continue
        if (typeof title !== "string" || typeof body !== "string") continue
        seen.add(id)
        out.push({
            id,
            title,
            body,
            level: typeof level === "string" ? level : "info",
            startsAt: finiteOr(a["startsAt"], 0),
            endsAt: finiteOr(a["endsAt"], null),
            createdAt: finiteOr(a["createdAt"], 0)
        })
    }
    return out
}

function parseCommunityStats(raw: unknown): CommunityStats {
    const r = isRecord(raw) ? raw : {}
    const records = (v: unknown) => (Array.isArray(v) ? v.filter(isRecord) : [])
    return {
        leaderboard: records(r["leaderboard"]) as LeaderboardEntry[],
        trendingManga: records(r["trendingManga"]).flatMap(t =>
            typeof t["title"] === "string" && t["title"]
                ? [{ title: t["title"], sourceId: String(t["sourceId"] ?? ""), count: finiteOr(t["count"], 0) }]
                : []
        ),
        topGenres: records(r["topGenres"]).flatMap(g =>
            typeof g["genre"] === "string" ? [{ genre: g["genre"], count: finiteOr(g["count"], 0) }] : []
        ),
        topRated: records(r["topRated"]).flatMap(t =>
            typeof t["title"] === "string"
                ? [
                      {
                          title: t["title"],
                          avgRating: finiteOr(t["avgRating"], 0),
                          ratingCount: finiteOr(t["ratingCount"], 0)
                      }
                  ]
                : []
        ),
        totalUsers: finiteOr(r["totalUsers"], 0)
    }
}

// GDPR erasure: delete all of this user's community data from the server.
export async function apiDeleteMe(userId: string, secret = ""): Promise<void> {
    assertCommunityConfigured()
    const res = await fetch(`${COMMUNITY_API_BASE}/me`, {
        method: "DELETE",
        headers: withSecret(secret),
        body: JSON.stringify({ userId })
    })
    if (!res.ok) throw new Error(`Data deletion failed: ${res.status}`)
}

// The server stores at most 500 events per POST (index.ts .slice(0, 500)). Sending more in
// one request silently dropped the overflow while the caller still advanced its sync
// watermark - permanently losing events 501+ on the first sync of an established library.
// Chunk at the same size so every event is stored; the final chunk's response carries the
// up-to-date rank/achievements/recommendations. A mid-run failure throws before the caller
// advances the watermark, so the next sync re-sends everything (the server dedups).
const EVENT_CHUNK = 500

export async function apiSyncEvents(
    userId: string,
    events: CommunityEvent[],
    secret = ""
): Promise<{
    rank: number | null
    newAchievements: string[]
    recommendations: CommunityRecommendation[]
}> {
    assertCommunityConfigured()
    type SyncResult = { rank: number | null; newAchievements: string[]; recommendations: CommunityRecommendation[] }
    // At least one request even with no events, so the caller still gets the current rank.
    const batches: CommunityEvent[][] = []
    for (let i = 0; i < events.length; i += EVENT_CHUNK) batches.push(events.slice(i, i + EVENT_CHUNK))
    if (batches.length === 0) batches.push([])

    let last: SyncResult = { rank: null, newAchievements: [], recommendations: [] }
    const achievements = new Set<string>()
    for (const batch of batches) {
        const res = await fetch(`${COMMUNITY_API_BASE}/events`, {
            method: "POST",
            headers: withSecret(secret),
            body: JSON.stringify({ userId, events: batch })
        })
        if (res.status === 401) throw new CommunityAuthError("The community server refused this device.")
        if (!res.ok) throw new Error(`Event sync failed: ${res.status}`)
        last = (await res.json()) as SyncResult
        for (const a of last.newAchievements) achievements.add(a)
    }
    // newAchievements can unlock on any chunk - union them so none is lost across batches.
    return { ...last, newAchievements: [...achievements] }
}

export async function apiFetchCommunityStats(): Promise<CommunityStats> {
    assertCommunityConfigured()
    const res = await fetch(`${COMMUNITY_API_BASE}/community`)
    if (!res.ok) throw new Error(`Community stats fetch failed: ${res.status}`)
    return parseCommunityStats(await res.json())
}

export async function apiRate(userId: string, mangaTitle: string, rating: number, secret = ""): Promise<void> {
    assertCommunityConfigured()
    const res = await fetch(`${COMMUNITY_API_BASE}/rate`, {
        method: "POST",
        headers: withSecret(secret),
        body: JSON.stringify({ userId, mangaTitle, rating })
    })
    if (!res.ok) throw new Error(`Rating sync failed: ${res.status}`)
}

export async function apiFetchMangaStats(mangaTitle: string): Promise<CommunityMangaStats> {
    assertCommunityConfigured()
    const res = await fetch(`${COMMUNITY_API_BASE}/manga?title=${encodeURIComponent(mangaTitle)}`)
    if (!res.ok) throw new Error(`Manga stats fetch failed: ${res.status}`)
    return res.json() as Promise<CommunityMangaStats>
}
