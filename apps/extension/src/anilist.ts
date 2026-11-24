// AniList personal-list sync: stores a user access token (obtained via AniList's
// implicit-grant flow and pasted into Settings) and pushes per-title read progress.
// Mirrors sync.ts: token in the protected store, never shipped back to the page; the app
// sees only a token-free status view. Public metadata reads live separately in
// metadata/anilist.ts and need no token.

import type { MangaStatus } from "./metadata/provider"
import { getProtected, setProtected } from "./protected-store"

const GRAPHQL = "https://graphql.anilist.co"

export type AniListConfig = {
    token?: string
    autoSync: boolean
    // Mirror library membership to AniList: add titles (read -> progress, unread ->
    // PLANNING) and delete a title's list entry when it's removed from the library.
    // Off by default - it mutates the user's AniList list, not just progress.
    syncMembership: boolean
    // Bidirectional reading-status sync (part of membership sync). statusPush mirrors a
    // local paused/dropped/planning/completed onto the AniList entry; statusPull applies
    // the AniList entry's status back onto the library. With both on, the more recently
    // changed side wins (readingStatusUpdatedAt vs the entry's updatedAt). Both off by
    // default - like syncMembership they mutate state beyond plain progress.
    statusPush?: boolean
    statusPull?: boolean
    lastSyncAt?: number
    // The anilistIds the user has actually had on their AniList list, carried across
    // syncs. Reconcile treats a title as a genuine removal ONLY when its id is in this
    // set AND absent from the current remote list - so metadata enrichment stamping an
    // anilistId on a title the user never tracked can never trigger an auto-drop.
    knownMembership?: number[]
}

const defaultConfig: AniListConfig = { autoSync: false, syncMembership: false }

export async function getAniListConfig(): Promise<AniListConfig> {
    return { ...defaultConfig, ...(await getProtected<Partial<AniListConfig>>("anilistConfig")) }
}

export async function setAniListConfig(patch: Partial<AniListConfig>): Promise<AniListConfig> {
    const next = { ...(await getAniListConfig()), ...patch }
    await setProtected("anilistConfig", next)
    return next
}

// The set of anilistIds the user has actually had on their AniList list as of the last
// completed membership sync. Empty on a fresh install, so the first sync drops nothing.
export async function getKnownMembership(): Promise<number[]> {
    const c = await getAniListConfig()
    return c.knownMembership ?? []
}

export async function setKnownMembership(ids: number[]): Promise<void> {
    await setAniListConfig({ knownMembership: ids })
}

// Token-free view for the UI - never ship the token back to the page.
export async function getAniListStatus(): Promise<{
    hasToken: boolean
    autoSync: boolean
    syncMembership: boolean
    statusPush: boolean
    statusPull: boolean
    lastSyncAt?: number
}> {
    const c = await getAniListConfig()
    return {
        hasToken: Boolean(c.token),
        autoSync: c.autoSync,
        syncMembership: c.syncMembership,
        statusPush: c.statusPush ?? false,
        statusPull: c.statusPull ?? false,
        ...(c.lastSyncAt ? { lastSyncAt: c.lastSyncAt } : {})
    }
}

async function anilistFetch<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(GRAPHQL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json"
        },
        body: JSON.stringify({ query, variables }),
        credentials: "omit"
    })
    if (!res.ok) throw new Error(`AniList API ${res.status}`)
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] }
    if (json.errors?.length) throw new Error(`AniList: ${json.errors[0]?.message ?? "error"}`)
    if (json.data === undefined || json.data === null) throw new Error("AniList: empty response")
    return json.data
}

// The authed user's current progress for a media, or undefined when they have no
// list entry for it yet. Used to avoid ever lowering remote progress.
export async function getViewerProgress(token: string, mediaId: number): Promise<number | undefined> {
    const data = await anilistFetch<{ Media: { mediaListEntry: { progress: number } | null } | null }>(
        token,
        `query ($mediaId: Int) { Media(id: $mediaId, type: MANGA) { mediaListEntry { progress } } }`,
        { mediaId }
    )
    return data.Media?.mediaListEntry?.progress ?? undefined
}

// The user's full list entry for a media: progress, list status, and when the entry was
// last changed (updatedAt, epoch SECONDS) - plus the media's total chapter count, so a
// pulled COMPLETED can complete the local title against a real integer. undefined when the
// user has no entry for this title. One query powers the whole bidirectional status sync.
export async function getViewerListEntry(
    token: string,
    mediaId: number
): Promise<
    | { progress: number; status?: string; updatedAt?: number; totalChapters?: number; seriesFinished?: boolean }
    | undefined
> {
    const data = await anilistFetch<{
        Media: {
            chapters?: number | null
            status?: string | null
            mediaListEntry: { progress?: number | null; status?: string | null; updatedAt?: number | null } | null
        } | null
    }>(
        token,
        `query ($mediaId: Int) {
            Media(id: $mediaId, type: MANGA) {
                chapters
                status
                mediaListEntry { progress status updatedAt }
            }
        }`,
        { mediaId }
    )
    const entry = data.Media?.mediaListEntry
    if (!entry) return undefined
    const totalChapters =
        typeof data.Media?.chapters === "number" && Number.isFinite(data.Media.chapters) && data.Media.chapters > 0
            ? data.Media.chapters
            : undefined
    // Publication finished per AniList (FINISHED/CANCELLED) - a pulled COMPLETED only completes
    // the local title when the SERIES is actually finished, never from list-status alone (S7).
    const pub = mapMediaStatus(data.Media?.status)
    const seriesFinished = pub === "completed" || pub === "cancelled"
    return {
        progress: typeof entry.progress === "number" && Number.isFinite(entry.progress) ? entry.progress : 0,
        seriesFinished,
        ...(typeof entry.status === "string" && entry.status ? { status: entry.status } : {}),
        ...(typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
            ? { updatedAt: entry.updatedAt }
            : {}),
        ...(totalChapters !== undefined ? { totalChapters } : {})
    }
}

// The library reading-status states that participate in bidirectional status sync.
// "unread" is excluded (membership sync handles the PLANNING add for never-opened titles).
export type SyncStatusKind = "reading" | "completed" | "paused" | "dropped" | "planning"

// Local reading-status -> AniList MediaListStatus.
export function localStatusToAniList(kind: SyncStatusKind): string {
    switch (kind) {
        case "completed":
            return "COMPLETED"
        case "dropped":
            return "DROPPED"
        case "paused":
            return "PAUSED"
        case "planning":
            return "PLANNING"
        default:
            return "CURRENT"
    }
}

// AniList MediaListStatus -> the local change to apply on a pull. `readingStatus: null`
// clears the explicit override so the title derives reading/completed from progress.
// `completed: true` means "complete the local title against the AniList total" (the caller
// only does so when a total is known, otherwise it leaves the title alone).
export function aniListStatusToLocal(status: string): {
    readingStatus: "paused" | "dropped" | "planning" | null
    completed: boolean
} {
    switch (status) {
        case "PAUSED":
            return { readingStatus: "paused", completed: false }
        case "DROPPED":
            return { readingStatus: "dropped", completed: false }
        case "PLANNING":
            return { readingStatus: "planning", completed: false }
        case "COMPLETED":
            return { readingStatus: null, completed: true }
        default:
            // CURRENT / REPEATING: actively reading -> no override.
            return { readingStatus: null, completed: false }
    }
}

export type StatusSyncDecision =
    | { action: "none" }
    | { action: "push"; status: string }
    | { action: "pullLocal"; status: string }

// Pure last-writer resolution for one title's status. No network. `local.ts` is the local
// change time (readingStatusUpdatedAt / lastReadAt), `remote.ts` the AniList entry's
// updatedAt - both epoch ms. When both directions are enabled the more recent change wins;
// with a single direction that side always wins. Returns "none" when the two already agree.
//
// `local.explicit` distinguishes a status the USER chose (paused/dropped/planning) from one
// merely DERIVED from reading progress (reading/completed). A derived status must never
// overwrite a deliberate remote hold/drop - reading one chapter of a title the user PAUSED
// or DROPPED on AniList should adopt that hold locally (when pull is on), never silently
// un-pause it by pushing CURRENT. This is the last-writer tiebreak's blind spot: reading
// activity churns the local timestamp but is not a status-change intent.
const DERIVED_PUSH_BLOCKED: Record<string, Set<string>> = {
    // A local re-read (derived "reading") leaves a remote hold/drop/finish alone.
    reading: new Set(["PAUSED", "DROPPED", "COMPLETED", "REPEATING"]),
    // Deriving "completed" (finished + caught up) still respects an explicit remote
    // hold/drop - the user parked it there on purpose.
    completed: new Set(["PAUSED", "DROPPED"])
}
export function resolveStatusSync(input: {
    local: { kind: SyncStatusKind; ts: number; explicit: boolean }
    remote: { status?: string; ts: number }
    push: boolean
    pull: boolean
}): StatusSyncDecision {
    const localAsAniList = localStatusToAniList(input.local.kind)
    if (localAsAniList === input.remote.status) return { action: "none" }
    const remote = input.remote.status

    // Guard: a derived local status may not push over a deliberate remote status it must
    // respect. Adopt the remote status locally when pull is enabled; otherwise leave both.
    if (input.push && !input.local.explicit && remote && DERIVED_PUSH_BLOCKED[input.local.kind]?.has(remote)) {
        if (input.pull) return { action: "pullLocal", status: remote }
        return { action: "none" }
    }

    let dir: "push" | "pull" | undefined
    if (input.push && input.pull) dir = input.local.ts >= input.remote.ts ? "push" : "pull"
    else if (input.push) dir = "push"
    else if (input.pull) dir = "pull"
    if (dir === "push") return { action: "push", status: localAsAniList }
    if (dir === "pull") {
        // Nothing to pull if the user has no entry / no status remotely.
        if (!input.remote.status) return { action: "none" }
        return { action: "pullLocal", status: input.remote.status }
    }
    return { action: "none" }
}

// Sets absolute chapter progress on the user's list entry (creating it if absent).
// Returns the stored progress AniList echoes back.
export async function saveViewerProgress(token: string, mediaId: number, progress: number): Promise<number> {
    const data = await anilistFetch<{ SaveMediaListEntry: { progress: number } }>(
        token,
        `mutation ($mediaId: Int, $progress: Int) {
            SaveMediaListEntry(mediaId: $mediaId, progress: $progress) { progress }
        }`,
        { mediaId, progress }
    )
    return data.SaveMediaListEntry.progress
}

// Validates a pasted token by querying the viewer's name; throws on an invalid token.
export async function getViewerName(token: string): Promise<string | undefined> {
    const data = await anilistFetch<{ Viewer: { name: string } | null }>(token, `query { Viewer { name } }`, {})
    return data.Viewer?.name
}

// The user's list-entry id for a media (needed to delete it), or undefined if the
// title isn't on their list.
export async function getMediaListEntryId(token: string, mediaId: number): Promise<number | undefined> {
    const data = await anilistFetch<{ Media: { mediaListEntry: { id: number } | null } | null }>(
        token,
        `query ($mediaId: Int) { Media(id: $mediaId, type: MANGA) { mediaListEntry { id } } }`,
        { mediaId }
    )
    return data.Media?.mediaListEntry?.id ?? undefined
}

// Adds/ensures the title on the user's list with a status (e.g. PLANNING for an
// unread library title). Does not touch progress.
export async function saveMediaStatus(token: string, mediaId: number, status: string): Promise<void> {
    await anilistFetch(
        token,
        `mutation ($mediaId: Int, $status: MediaListStatus) {
            SaveMediaListEntry(mediaId: $mediaId, status: $status) { id }
        }`,
        { mediaId, status }
    )
}

// One title pulled from the user's AniList manga list, flattened to the fields the
// library import needs. progress is the user's read chapter count on AniList.
export type AniListListEntry = {
    anilistId: number
    title: string
    coverUrl?: string
    status: MangaStatus
    genres: string[]
    progress: number
    // The user's list status on AniList (MediaListStatus), mapped to our explicit
    // reading-status overrides. Only paused/dropped/planning carry over; CURRENT /
    // COMPLETED / REPEATING stay undefined because our reading/completed status is
    // derived from read progress, not stored (see reading-status.ts).
    listStatus?: "paused" | "dropped" | "planning"
    // The raw MediaListStatus (CURRENT/PLANNING/COMPLETED/DROPPED/PAUSED/REPEATING),
    // preserved so import can special-case COMPLETED and membership status-sync can
    // reconcile every state - things the narrowed listStatus above deliberately drops.
    rawListStatus?: string
    // media.chapters: the total chapter count AniList knows for a finished series (null
    // for ongoing/unknown). Used to complete an imported COMPLETED title against a real
    // integer total instead of searching a mirror.
    totalChapters?: number
    // media.format (MANGA/NOVEL/LIGHT_NOVEL/ONE_SHOT/...). Import skips novels: AniList's
    // type:MANGA bucket includes light novels, which have no manga mirror to search.
    format?: string
    // media.isAdult - import sets the library nsfw (blur-cover) flag from it.
    nsfw?: boolean
    // Story / Art / Story & Art staff names, in relevance order. Populated from media.staff.
    authors?: string[]
}

type RawMediaListEntry = {
    progress?: number | null
    // MediaListStatus on the entry itself (CURRENT/PLANNING/COMPLETED/DROPPED/PAUSED/
    // REPEATING) - distinct from media.status below, which is the publication status.
    status?: string | null
    media?: {
        id?: number | null
        title?: { romaji?: string | null; english?: string | null; native?: string | null } | null
        coverImage?: { extraLarge?: string | null; large?: string | null } | null
        status?: string | null
        chapters?: number | null
        format?: string | null
        isAdult?: boolean | null
        genres?: (string | null)[] | null
        staff?: StaffConnection | null
    } | null
}

type StaffConnection = {
    edges?: ({ role?: string | null; node?: { name?: { full?: string | null } | null } | null } | null)[] | null
}

// AniList staff roles that count as an "author" for our purposes. Matches "Story", "Art",
// "Artist", "Story & Art", "Original Story" case-insensitively, tolerating trailing
// qualifiers like "Art (Ch. 1-10)".
const AUTHOR_ROLE_RE = /^\s*(story\s*&\s*art|original\s+story|story|artist|art)\b/i

function mapStaffToAuthors(staff: StaffConnection | null | undefined): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const edge of staff?.edges ?? []) {
        if (!edge || !AUTHOR_ROLE_RE.test(edge.role ?? "")) continue
        const name = edge.node?.name?.full
        // Dedup on the TRIMMED name (a solo creator often appears under separate Story and
        // Art edges with inconsistent surrounding whitespace) - keying on the raw value let
        // whitespace variants slip through and produced the same author twice.
        const trimmed = typeof name === "string" ? name.trim() : ""
        if (trimmed && !seen.has(trimmed)) {
            seen.add(trimmed)
            out.push(trimmed)
        }
    }
    return out
}

// AniList Media.status (MANGA) -> our publication-status enum. Mirrors mapStatus in
// metadata/anilist.ts so an imported title's status matches an enriched one.
function mapMediaStatus(status: string | null | undefined): MangaStatus {
    switch (status) {
        case "RELEASING":
            return "ongoing"
        case "FINISHED":
            return "completed"
        case "HIATUS":
            return "hiatus"
        case "CANCELLED":
            return "cancelled"
        default:
            return "unknown"
    }
}

// AniList MediaListStatus -> our explicit reading-status override. Only the states we
// can't derive from read progress carry over; CURRENT/COMPLETED/REPEATING map to
// undefined (derived from progress instead).
function mapListStatus(status: string | null | undefined): "paused" | "dropped" | "planning" | undefined {
    switch (status) {
        case "PAUSED":
            return "paused"
        case "DROPPED":
            return "dropped"
        case "PLANNING":
            return "planning"
        default:
            return undefined
    }
}

// Pure mapping - exported for tests, no network.
export function mapMediaListEntry(raw: RawMediaListEntry): AniListListEntry {
    const media = raw.media ?? {}
    const listStatus = mapListStatus(raw.status)
    // Romaji first: it matches the title AniList shows on the entry page and is what
    // scanlation sources index under, so mirror search finds far more hits than the
    // official English title (which often differs from the scanlation name).
    const title = media.title?.romaji ?? media.title?.english ?? media.title?.native ?? ""
    const coverUrl = media.coverImage?.extraLarge ?? media.coverImage?.large ?? undefined
    const genres = (media.genres ?? []).filter((g): g is string => typeof g === "string" && g.length > 0)
    const totalChapters =
        typeof media.chapters === "number" && Number.isFinite(media.chapters) && media.chapters > 0
            ? media.chapters
            : undefined
    const authors = mapStaffToAuthors(media.staff)
    return {
        anilistId: media.id ?? 0,
        title,
        ...(coverUrl ? { coverUrl } : {}),
        status: mapMediaStatus(media.status),
        genres,
        progress: typeof raw.progress === "number" && Number.isFinite(raw.progress) ? raw.progress : 0,
        ...(listStatus ? { listStatus } : {}),
        ...(typeof raw.status === "string" && raw.status ? { rawListStatus: raw.status } : {}),
        ...(totalChapters !== undefined ? { totalChapters } : {}),
        ...(typeof media.format === "string" && media.format ? { format: media.format } : {}),
        ...(media.isAdult ? { nsfw: true } : {}),
        ...(authors.length > 0 ? { authors } : {})
    }
}

// Pulls the authed user's whole manga list. Two steps: resolve the viewer id, then
// fetch every list (Reading/Completed/Planning/...) and flatten its entries. Reuses
// anilistFetch's auth + error handling.
export async function getViewerMangaList(token: string): Promise<AniListListEntry[]> {
    const viewer = await anilistFetch<{ Viewer: { id: number | null } | null }>(token, `query { Viewer { id } }`, {})
    const userId = viewer.Viewer?.id
    if (typeof userId !== "number") throw new Error("AniList: could not resolve the viewer id")
    const data = await anilistFetch<{
        MediaListCollection: { lists: ({ entries: RawMediaListEntry[] | null } | null)[] | null } | null
    }>(
        token,
        `query ($userId: Int) {
            MediaListCollection(userId: $userId, type: MANGA) {
                lists {
                    entries {
                        progress
                        status
                        media {
                            id
                            title { romaji english native }
                            coverImage { extraLarge large }
                            status
                            chapters
                            format
                            isAdult
                            genres
                            staff(sort: RELEVANCE, perPage: 8) {
                                edges { role node { name { full } } }
                            }
                        }
                    }
                }
            }
        }`,
        { userId }
    )
    // AniList returns one MediaListGroup per status PLUS one per user-defined custom list, so a
    // title tagged into a custom list (e.g. "Favorites") appears in both its status group and the
    // custom-list group - the identical entry, twice. Dedup by anilistId (copies are identical)
    // so callers get distinct titles; otherwise import's total/skipped counts are inflated by a
    // phantom "skip" for every custom-list-tagged title.
    const byId = new Map<number, AniListListEntry>()
    for (const list of data.MediaListCollection?.lists ?? []) {
        for (const raw of list?.entries ?? []) {
            const entry = mapMediaListEntry(raw)
            byId.set(entry.anilistId, entry)
        }
    }
    return [...byId.values()]
}

// Removes a title from the user's list by its list-entry id.
export async function deleteMediaListEntry(token: string, entryId: number): Promise<boolean> {
    const data = await anilistFetch<{ DeleteMediaListEntry: { deleted: boolean } }>(
        token,
        `mutation ($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }`,
        { id: entryId }
    )
    return data.DeleteMediaListEntry.deleted
}
