import type { LibraryManga } from "./database"

const ACCOUNT_KEY = "account"
const TOMBSTONES_KEY = "accountTombstones"

// The weeb.ltd site base. Public, so the production URL is a safe default; VITE_WEEB_SITE_URL
// overrides it for local development against a dev server.
export const SITE_BASE = ((import.meta.env.VITE_WEEB_SITE_URL as string | undefined) ?? "https://weeb.ltd").replace(
    /\/+$/,
    ""
)

export type AccountProfile = {
    // The device link token pasted from weeb.ltd/account. Absent = not linked.
    token?: string
    userId?: string
    name?: string
    image?: string
    itemCount?: number
    // Local clock of the newest item pushed; the next push sends items updated after it.
    lastPushAt: number
    // Opaque keyset cursor from the last successful V2 pull; the next pull resumes strictly after
    // it. undefined = pull from the beginning (also the one-time full re-pull when upgrading from
    // the V1 `since`-based sync, which is safe: applies are last-writer-wins and re-adds idempotent).
    // Explicit `| undefined` so the link handler can reset it under exactOptionalPropertyTypes.
    pullCursor?: string | undefined
    lastSyncAt: number
    // Set when the server rejected the token (revoked on the site). Sync stops until re-linked.
    invalid: boolean
    autoSync: boolean
    // The community id last confirmed linked on the site; re-sent only when it changes.
    communityLinkedId?: string
}

const defaultProfile: AccountProfile = { lastPushAt: 0, lastSyncAt: 0, invalid: false, autoSync: true }

export async function getAccountProfile(): Promise<AccountProfile> {
    const stored = await browser.storage.local.get(ACCOUNT_KEY)
    return { ...defaultProfile, ...((stored[ACCOUNT_KEY] as Partial<AccountProfile> | undefined) ?? {}) }
}

export async function updateAccountProfile(patch: Partial<AccountProfile>): Promise<AccountProfile> {
    const next = { ...(await getAccountProfile()), ...patch }
    await browser.storage.local.set({ [ACCOUNT_KEY]: next })
    return next
}

export async function clearAccountProfile(): Promise<AccountProfile> {
    await browser.storage.local.remove([ACCOUNT_KEY])
    return { ...defaultProfile }
}

// Local removals must reach the server as tombstones, but library:remove deletes the row
// outright, so the id is parked here until the next successful push.
// The tombstone map is a read-modify-write on one storage key, and both recordTombstone
// (fired unawaited from library:remove) and clearTombstones (end of a sync push) touch it.
// Without serialization a removal made DURING an in-flight sync is clobbered when clear writes
// back its stale snapshot, so that deletion never reaches the server and the title resurrects
// on the next pull. This lock chains every mutation so their get+set pairs cannot interleave.
let tombstoneLock: Promise<unknown> = Promise.resolve()
function withTombstoneLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = tombstoneLock.then(fn, fn)
    tombstoneLock = next.then(
        () => {},
        () => {}
    )
    return next
}

export async function recordTombstone(mangaId: string): Promise<void> {
    const profile = await getAccountProfile()
    if (!profile.token) return
    await withTombstoneLock(async () => {
        const list = await getTombstones()
        list[mangaId] = Date.now()
        await browser.storage.local.set({ [TOMBSTONES_KEY]: list })
    })
}

export async function getTombstones(): Promise<Record<string, number>> {
    const stored = await browser.storage.local.get(TOMBSTONES_KEY)
    const raw = stored[TOMBSTONES_KEY]
    return raw && typeof raw === "object" ? (raw as Record<string, number>) : {}
}

// Clear only the tombstones that were actually pushed, and only if their timestamp is still
// the one we pushed - a re-removal that landed during the sync (a newer timestamp, or a
// brand-new id) is left parked for the next sync rather than dropped.
export async function clearTombstones(pushed: Record<string, number>): Promise<void> {
    await withTombstoneLock(async () => {
        const list = await getTombstones()
        let changed = false
        for (const [id, at] of Object.entries(pushed)) {
            if (list[id] === at) {
                delete list[id]
                changed = true
            }
        }
        if (changed) await browser.storage.local.set({ [TOMBSTONES_KEY]: list })
    })
}

export type SyncItem = {
    clientId: string
    title: string
    normalizedTitle: string
    anilistId?: number | null
    sourceId?: string | null
    sourceMangaId?: string | null
    mangaUrl?: string | null
    coverUrl?: string | null
    genres?: string[] | null
    status?: string | null
    readingStatus?: string | null
    // When readingStatus was last explicitly set. Must cross devices: the AniList sync uses it as
    // the last-writer tiebreak (readingStatusUpdatedAt ?? lastReadAt ?? 0) and deliberately refuses
    // to fall back to updatedAt, so without it a status synced to another device reads as ts 0 and
    // AniList silently clobbers it.
    readingStatusUpdatedAt?: number | null
    rating?: number | null
    lastReadChapterNumber?: number | null
    latestChapterNumber?: number | null
    lastReadAt?: number | null
    // User-owned library metadata + per-title reader overrides. Synced so a library carries
    // its notes, tags, flags and reader tweaks across devices, not just read progress.
    notes?: string | null
    categories?: string[] | null
    onHold?: boolean | null
    manualTracking?: boolean | null
    nsfw?: boolean | null
    pageWidthPct?: number | null
    readingDirection?: string | null
    pageFit?: string | null
    noGapContinuous?: boolean | null
    continuousScroll?: boolean | null
    readerTheme?: string | null
    deleted?: boolean
    clientUpdatedAt: number
    // Read-only extras carried by a V2 pull / rejected-push server copy. Server-authoritative:
    // the client never sends these (a client-sent workId is stripped server-side). workId is the
    // canonical Work bridge (C4), null until the server resolves it; mediaType comes from the Work.
    workId?: string | null
    mediaType?: string | null
}

const isHttpUrl = (v: string | undefined): v is string => typeof v === "string" && /^https?:\/\//.test(v)

export function toSyncItem(m: LibraryManga): SyncItem {
    const mangaUrl = m.mangaUrl ?? m.sourceUrl
    return {
        clientId: m.id,
        title: m.title,
        normalizedTitle: m.normalizedTitle,
        anilistId: m.anilistId ?? null,
        sourceId: m.sourceId,
        sourceMangaId: m.sourceMangaId ?? null,
        mangaUrl: isHttpUrl(mangaUrl) ? mangaUrl : null,
        coverUrl: isHttpUrl(m.coverUrl) ? m.coverUrl : null,
        genres: m.genres ?? null,
        status: m.status,
        readingStatus: m.readingStatus ?? null,
        readingStatusUpdatedAt: m.readingStatusUpdatedAt ?? null,
        rating: m.rating ?? null,
        lastReadChapterNumber: m.lastReadChapterNumber ?? null,
        latestChapterNumber: m.latestChapterNumber ?? null,
        lastReadAt: m.lastReadAt ?? null,
        notes: m.notes ?? null,
        categories: m.categories ?? null,
        onHold: m.onHold ?? null,
        manualTracking: m.manualTracking ?? null,
        nsfw: m.nsfw ?? null,
        pageWidthPct: m.pageWidthPct ?? null,
        readingDirection: m.readingDirection ?? null,
        pageFit: m.pageFit ?? null,
        noGapContinuous: m.noGapContinuous ?? null,
        continuousScroll: m.continuousScroll ?? null,
        readerTheme: m.readerTheme ?? null,
        clientUpdatedAt: m.updatedAt
    }
}

export class AccountAuthError extends Error {}

async function request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${SITE_BASE}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) }
    })
    if (res.status === 401) throw new AccountAuthError("This link token is no longer valid.")
    if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `weeb.ltd request failed: ${res.status}`)
    }
    return res.json() as Promise<T>
}

export type AccountStatus = { userId: string; name: string | null; image: string | null; itemCount: number }

export function apiAccountStatus(token: string): Promise<AccountStatus> {
    return request<AccountStatus>(token, "/api/sync/status")
}

// Sync V2 (/api/sync/v2) per-record push result. `accepted` is the clientIds the server stored;
// `rejected` lost the last-writer compare and carry the newer server copy to adopt; `invalid`
// failed validation and never reached the merge. `?preview=1` computes the merge and writes
// nothing (dry-run) - same shape with `preview: true`.
export type PushResult = {
    accepted: string[]
    rejected: Array<{ clientId: string; server: SyncItem }>
    invalid: Array<{ clientId: string | null; issues: string[] }>
    serverTime: number
    preview?: boolean
}

export function apiPush(token: string, items: SyncItem[], preview = false): Promise<PushResult> {
    const q = preview ? "?preview=1" : ""
    return request<PushResult>(token, `/api/sync/v2${q}`, { method: "POST", body: JSON.stringify({ items }) })
}

// One keyset page of a V2 pull. Loop on `hasMore`, passing `nextCursor` back in, until it is false;
// persist the final cursor so the next sync resumes strictly after the last row seen.
export type PullPage = { items: SyncItem[]; nextCursor: string | null; hasMore: boolean; serverTime: number }

export function apiPull(token: string, cursor?: string): Promise<PullPage> {
    const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""
    return request<PullPage>(token, `/api/sync/v2${q}`)
}

// Ties this device's anonymous community id (amr-api) to the account so the site can own the
// community history. Only sent when community features are enabled here.
export function apiLinkCommunity(token: string, communityUserId: string): Promise<{ ok: boolean }> {
    return request(token, "/api/sync/link", { method: "POST", body: JSON.stringify({ communityUserId }) })
}
