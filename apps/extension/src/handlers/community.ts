import { db } from "../database"
import {
    apiRegister,
    apiSyncEvents,
    apiFetchCommunityStats,
    apiRate,
    apiFetchMangaStats,
    apiPing,
    apiDeleteMe,
    apiGetAnnouncements,
    type Announcement,
    generateAnonymousUsername,
    getCommunityProfile,
    updateCommunityProfile,
    CONSENT_VERSION,
    type CommunityEvent,
    type CommunityProfile
} from "../community"
import { configureCommunityAlarm, communityAlarmName } from "../background/alarms"
import type { HandlerMap } from "../background/handler-types"
import { userSourcesReady } from "../background/user-sources-ready"

let communityRunning = false
let autoRegistering = false

const MAX_AUTO_REGISTER_ATTEMPTS = 5

// Auto-registration once the user has OPTED IN (enabled): the community API requires a
// userId, so rather than making them also type a name and click "Join", we register a
// generic anonymous handle the first time we see enabled && !userId. It never fires
// while enabled is false (the opt-in default), so nothing is registered or uploaded
// without consent. Manual registration (community:register) still works for a custom name.
async function ensureRegistered(profile: CommunityProfile): Promise<CommunityProfile> {
    if (!profile.enabled || profile.userId) return profile
    if (autoRegistering) return await getCommunityProfile()
    autoRegistering = true
    try {
        // Re-read in case a concurrent manual "Join" completed while we were waiting.
        const current = await getCommunityProfile()
        if (current.userId) return current

        for (let attempt = 0; attempt < MAX_AUTO_REGISTER_ATTEMPTS; attempt++) {
            const username = generateAnonymousUsername()
            try {
                const { userId } = await apiRegister(username)
                const updated = await updateCommunityProfile({ username, userId, lastSyncAt: 0 })
                await configureCommunityAlarm()
                return updated
            } catch (error) {
                // The community server responds 409 with { error: "Username already taken" }
                // for collisions - retry with a freshly generated name. Any other failure
                // (network down, server error, etc.) should fail soft, not spin the retry loop.
                const isCollision = error instanceof Error && /taken/i.test(error.message)
                if (!isCollision) {
                    console.warn("[AMR] Community auto-registration failed", error)
                    return current
                }
            }
        }
        console.warn(
            `[AMR] Community auto-registration gave up after ${MAX_AUTO_REGISTER_ATTEMPTS} username collisions`
        )
        return current
    } finally {
        autoRegistering = false
    }
}

// A per-chapter dedup key for the community server. The chapter number when the source
// numbers its chapters, otherwise a short hash of the chapter id so no URL leaves the device.
export function chapterLabel(chapterId: string, sortKey: number | undefined): string {
    if (sortKey !== undefined && Number.isFinite(sortKey)) return String(sortKey)
    let h = 5381
    for (let i = 0; i < chapterId.length; i++) h = ((h * 33) ^ chapterId.charCodeAt(i)) >>> 0
    return "h" + h.toString(16)
}

export async function runCommunitySync() {
    await userSourcesReady()
    if (communityRunning) return
    communityRunning = true
    try {
        let profile = await getCommunityProfile()
        if (!profile.enabled) return
        // Anonymous install/active ping (fire-and-forget). Only after the user opted in, so
        // nothing is sent without consent; wrapped so neither a synchronous throw (e.g. no
        // manifest) nor a rejected fetch can ever block the sync.
        try {
            void apiPing(import.meta.env.BROWSER ?? "unknown", browser.runtime.getManifest().version).catch(() => {})
        } catch {
            /* ping is best-effort; never let it break the sync */
        }
        if (!profile.userId) {
            profile = await ensureRegistered(profile)
            if (!profile.userId) return
        }

        // Capture the watermark before the read/network calls below, not after - a
        // history event recorded while this sync is in flight has occurredAt <= syncStartedAt,
        // so the next sync still picks it up. The read uses aboveOrEqual (not the strict above)
        // so an event whose occurredAt lands exactly on the previous watermark millisecond is
        // not skipped forever; the one-event re-send that creates is absorbed by the server's
        // per-chapter INSERT OR IGNORE dedup. Using Date.now() at the END would skip it.
        const syncStartedAt = Date.now()

        const newHistory = await db.historyEvents
            .where("occurredAt")
            .aboveOrEqual(profile.lastSyncAt)
            .filter(h => h.type === "completed")
            .toArray()

        const mangaIds = [...new Set(newHistory.map(h => h.mangaId))]
        const mangaList = await db.manga.where("id").anyOf(mangaIds).toArray()
        const mangaMap = new Map(mangaList.map(m => [m.id, m]))
        const chapterIds = [...new Set(newHistory.map(h => h.chapterId))]
        const chapterList = await db.chapters.where("id").anyOf(chapterIds).toArray()
        const chapterMap = new Map(chapterList.map(c => [c.id, c]))

        const events: CommunityEvent[] = newHistory
            .map((h): CommunityEvent | null => {
                const manga = mangaMap.get(h.mangaId)
                if (!manga) return null
                return {
                    type: "chapter_read" as const,
                    sourceId: manga.sourceId,
                    mangaTitle: manga.title,
                    genres: manga.genres ?? [],
                    date: new Date(h.occurredAt).toISOString().slice(0, 10),
                    chapter: chapterLabel(h.chapterId, chapterMap.get(h.chapterId)?.sortKey)
                }
            })
            .filter((e): e is CommunityEvent => e !== null)

        let rank = profile.communityRank
        let recommendations = profile.recommendations ?? []
        let newAchievements: string[] = []
        if (events.length > 0) {
            const result = await apiSyncEvents(profile.userId, events)
            rank = result.rank
            recommendations = result.recommendations
            newAchievements = result.newAchievements
        }
        const communityStats = await apiFetchCommunityStats().catch(() => profile.communityStats)

        await updateCommunityProfile({
            lastSyncAt: syncStartedAt,
            communityRank: rank,
            recommendations,
            newAchievements: [...(profile.newAchievements ?? []), ...newAchievements],
            communityStats
        })
    } catch (error) {
        console.warn("[AMR] Community sync failed", error)
    } finally {
        communityRunning = false
    }
}

export const communityHandlers: HandlerMap = {
    // Settings/Achievements load this on every visit - since the alarm-driven sync
    // can't run before a userId exists, this doubles as the main opportunistic
    // trigger for silent first-time registration.
    "community:status": async () => {
        const profile = await getCommunityProfile()
        if (profile.enabled && !profile.userId) {
            const updated = await ensureRegistered(profile)
            if (updated.userId) void runCommunitySync()
            return updated
        }
        return profile
    },
    "community:register": async request => {
        const existing = await getCommunityProfile()
        if (existing.userId) return existing
        const { userId } = await apiRegister(request.username)
        const updated = await updateCommunityProfile({
            username: request.username,
            userId,
            enabled: true,
            lastSyncAt: 0,
            consentVersion: CONSENT_VERSION,
            consentAt: Date.now(),
            declined: false
        })
        await configureCommunityAlarm()
        void runCommunitySync()
        return updated
    },
    "community:sync": async () => {
        await runCommunitySync()
        return null
    },
    "community:toggle": async request => {
        // Turning community ON is a consent action - stamp the version/date the user agreed to
        // and clear any prior "declined" so the state is coherent.
        let updated = await updateCommunityProfile({
            enabled: request.enabled,
            ...(request.enabled ? { consentVersion: CONSENT_VERSION, consentAt: Date.now(), declined: false } : {})
        })
        if (request.enabled) {
            if (!updated.userId) updated = await ensureRegistered(updated)
            await configureCommunityAlarm()
            if (updated.userId) void runCommunitySync()
        } else {
            await browser.alarms.clear(communityAlarmName)
        }
        return updated
    },
    // The user tapped "Disable" on the first-run consent card. Record the explicit decline so
    // the card never nags again (they re-enable from Settings). Sends nothing.
    "community:decline": async () => {
        return await updateCommunityProfile({ enabled: false, declined: true })
    },
    // GDPR erasure from Settings: delete server-side data (if registered), then reset the
    // local profile to a clean, disabled, non-nagging state.
    "community:delete-data": async () => {
        const profile = await getCommunityProfile()
        if (profile.userId) await apiDeleteMe(profile.userId)
        await browser.alarms.clear(communityAlarmName)
        return await updateCommunityProfile({
            enabled: false,
            declined: true,
            username: "",
            userId: "",
            lastSyncAt: 0,
            communityRank: null,
            recommendations: [],
            newAchievements: [],
            communityStats: null,
            consentVersion: 0,
            consentAt: 0
        })
    },
    "community:rate": async request => {
        const profile = await getCommunityProfile()
        if (!profile.enabled || !profile.userId) return null
        await apiRate(profile.userId, request.mangaTitle, request.rating)
        return null
    },
    "community:manga-stats": async request => {
        return await apiFetchMangaStats(request.mangaTitle)
    },
    // Owner broadcast messages for this build. Read-only, consent-independent, never throws.
    "community:announcements": async (): Promise<Announcement[]> => {
        try {
            return await apiGetAnnouncements(
                import.meta.env.BROWSER ?? "unknown",
                browser.runtime.getManifest().version
            )
        } catch {
            return []
        }
    },
    // What the community is reading right now, for the Discover "Trending" rail. Public
    // aggregate data (no user data sent), so it needs no opt-in - only a configured API.
    // Never throws: a failure just means no rail this visit.
    "community:trending": async () => {
        try {
            const stats = await apiFetchCommunityStats()
            return stats.trendingManga
        } catch {
            return []
        }
    }
}
