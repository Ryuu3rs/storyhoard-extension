import { workKeyOf } from "./work-identity"
import { versionIdFor } from "./work-versions"
import type { LibraryManga, VersionRecord, WorkOverride } from "./database"

// ARCH TRACK A: the best-version ranking core. Pure functions over the version pool - no I/O, no
// browser, fully offline. Every surface (library card, search, panel hint, open-best) reads these
// so "best" means the same thing everywhere.
//
// Design (owner decisions): language is a GATE, not a weight - a version in the user's language
// always outranks one that is not, so language can never be bought by chapter count; within a
// language tier, chapter count is the PRIMARY score (log-shaped, capped at 1.25x the canonical
// count so filler-splitting cannot win), with official status, recency and health as tie-shapers
// and a penalty for non-chapter (volume/season/unreliable) numbering.

// Tuning dials (owner-set). Kept as named constants so they are easy to find and change.
export const CH_WEIGHT = 120 // primary: multiplies log(1 + effective chapter count)
export const OFFICIAL_BONUS = 300 // official/partner site (decision 1: 300, lets a far-more-complete source still win)
export const HEALTH_OK = 60
export const HEALTH_DEGRADED = 20
export const NUMBERING_PENALTY = 60 // volume/season/unreliable numbering is not comparable to chapter numbering
export const DEAD_SCORE = -1e6 // a dead source is never "best" (still shown under Advanced)
export const RECENCY_MAX = 80
export const CANONICAL_CAP_FACTOR = 1.25
export const HINT_DELTA = 150 // the panel "better version" hint fires only above this score gap

export type VersionCtx = {
    // Normalized 2-letter preferred language subtags (e.g. {"en"}). Empty = no preference.
    preferredLanguages: Set<string>
    now: number
    // Canonical chapter count (AniList) when known, for the filler-split cap.
    canonicalChapterCount?: number
    // The user's current read position for this work, so a version behind it is not surfaced.
    lastReadNumber?: number
}

export type ScoredVersion = { version: VersionRecord; tier: 0 | 1; score: number; eligible: boolean }

function normalizeLang(lang: string): string {
    return lang.toLowerCase().split(/[-_]/)[0] ?? lang.toLowerCase()
}

// tier 0 = in a preferred language. An untagged source (no languages) gets the benefit of the
// doubt as tier 0 rather than being stranded below every tagged one (most untagged sources in this
// ecosystem are the user's language, and a hard tier-1 would hide a user's only source).
function languageTier(version: VersionRecord, preferred: Set<string>): 0 | 1 {
    if (preferred.size === 0) return 0
    if (version.languages.length === 0) return 0
    return version.languages.some(l => preferred.has(normalizeLang(l))) ? 0 : 1
}

function recencyBonus(latestChapterAt: number | undefined, now: number): number {
    if (latestChapterAt === undefined) return 0
    const days = (now - latestChapterAt) / (1000 * 60 * 60 * 24)
    if (days < 7) return RECENCY_MAX
    if (days < 30) return 60
    if (days < 90) return 40
    if (days < 365) return 20
    return 0
}

export function scoreVersion(version: VersionRecord, ctx: VersionCtx): ScoredVersion {
    const tier = languageTier(version, ctx.preferredLanguages)
    const eligible =
        ctx.lastReadNumber === undefined ||
        version.latestChapterNumber === undefined ||
        version.latestChapterNumber >= ctx.lastReadNumber

    if (version.health === "dead") return { version, tier, score: DEAD_SCORE, eligible }

    const reported =
        version.latestChapterNumber !== undefined && Number.isFinite(version.latestChapterNumber)
            ? version.latestChapterNumber
            : 0
    const effective = ctx.canonicalChapterCount
        ? Math.min(reported, CANONICAL_CAP_FACTOR * ctx.canonicalChapterCount)
        : reported

    let score = CH_WEIGHT * Math.log(1 + Math.max(0, effective))
    if (version.isOfficialAtObservation) score += OFFICIAL_BONUS
    score += recencyBonus(version.latestChapterAt, ctx.now)
    score += version.health === "ok" ? HEALTH_OK : version.health === "degraded" ? HEALTH_DEGRADED : 0
    if (version.numberingKind !== "chapter") score -= NUMBERING_PENALTY

    return { version, tier, score, eligible }
}

// Rank a work's versions. Comparator: lower tier wins, then higher score, then official-first, then
// most-recently-seen, then a stable id - deterministic so the UI never flickers. `best` is the
// top ELIGIBLE, non-dead version (a version behind the read position, or dead, is never surfaced
// as best but still appears in `ordered` for the Advanced disclosure).
// Fill in the canonical chapter count from the pool when the caller did not supply one: the
// highest finite chapter count among official versions of this work. Official sites do not
// filler-split, so their count is a good proxy for the true total, which is exactly what the cap
// needs to stop a split-inflated unofficial source from winning on raw count. No effect when the
// work has no official version (then there is nothing to cap against, and the official bonus and
// log shape still bound the inflation).
export function withDerivedCanonical(versions: readonly VersionRecord[], ctx: VersionCtx): VersionCtx {
    if (ctx.canonicalChapterCount !== undefined) return ctx
    let max: number | undefined
    for (const v of versions) {
        if (
            v.isOfficialAtObservation &&
            v.latestChapterNumber !== undefined &&
            Number.isFinite(v.latestChapterNumber)
        ) {
            max = max === undefined ? v.latestChapterNumber : Math.max(max, v.latestChapterNumber)
        }
    }
    return max === undefined ? ctx : { ...ctx, canonicalChapterCount: max }
}

export function rankWorkVersions(
    versions: readonly VersionRecord[],
    ctxIn: VersionCtx,
    preferredSourceId?: string
): { best: VersionRecord | undefined; ordered: ScoredVersion[] } {
    const ctx = withDerivedCanonical(versions, ctxIn)
    const scored = versions.map(v => scoreVersion(v, ctx))
    scored.sort((a, b) => {
        if (a.tier !== b.tier) return a.tier - b.tier
        if (a.score !== b.score) return b.score - a.score
        const ao = a.version.isOfficialAtObservation ? 1 : 0
        const bo = b.version.isOfficialAtObservation ? 1 : 0
        if (ao !== bo) return bo - ao
        if (a.version.lastSeenAt !== b.version.lastSeenAt) return b.version.lastSeenAt - a.version.lastSeenAt
        return a.version.id < b.version.id ? -1 : a.version.id > b.version.id ? 1 : 0
    })
    // A user-pinned source is an absolute winner when present and viable (not dead).
    const pinned =
        preferredSourceId !== undefined
            ? scored.find(s => s.version.sourceId === preferredSourceId && s.version.health !== "dead")
            : undefined
    const best = pinned?.version ?? scored.find(s => s.eligible && s.version.health !== "dead")?.version
    return { best, ordered: scored }
}

// Whether the on-site panel should show the quiet "a more complete version is available" hint while
// the user reads `current`. Silent unless clearly better (owner decision 3): same-or-better
// language tier, not behind the current chapter, a healthy best, and a score gap over HINT_DELTA.
export function shouldShowBetterHint(
    current: VersionRecord,
    best: VersionRecord | undefined,
    ctx: VersionCtx
): boolean {
    if (!best || best.id === current.id) return false
    if (best.health !== "ok") return false
    const bc = scoreVersion(current, ctx)
    const bb = scoreVersion(best, ctx)
    if (bb.tier > bc.tier) return false
    const curLatest = current.latestChapterNumber ?? 0
    const bestLatest = best.latestChapterNumber ?? 0
    if (bestLatest < curLatest) return false
    return bb.score - bc.score >= HINT_DELTA
}

// A logical work surfaced as one card: the tracked library row, the best version to open, and the
// full ranked version list for the Advanced disclosure.
export type LibraryWorkCard = {
    workKey: string
    tracked: LibraryManga
    best: VersionRecord | undefined
    ordered: ScoredVersion[]
    versionCount: number
}

// Resolve a member key (a library row's workKey or id) to the canonical workKey it belongs to,
// honoring merge overrides. A merge override lists members that should share one work; the first
// member is treated as canonical.
function buildMergeMap(overrides: readonly WorkOverride[]): Map<string, string> {
    const map = new Map<string, string>()
    for (const o of overrides) {
        if (o.type !== "merge" || o.members.length < 2) continue
        const canonical = o.members[0]!
        for (const m of o.members) map.set(m, canonical)
    }
    return map
}

function splitMembers(overrides: readonly WorkOverride[]): Set<string> {
    const out = new Set<string>()
    for (const o of overrides) if (o.type === "split") for (const m of o.members) out.add(m)
    return out
}

// Group library rows into one card per logical work, attaching the ranked version pool. Grouping is
// derived (workKeyOf) with user merge/split overrides applied; nothing here is persisted. `best` is
// advisory only - it never repoints the tracked row.
export function groupLibraryIntoWorks(
    rows: readonly LibraryManga[],
    pool: readonly VersionRecord[],
    overrides: readonly WorkOverride[],
    ctx: VersionCtx
): LibraryWorkCard[] {
    const mergeMap = buildMergeMap(overrides)
    const splits = splitMembers(overrides)

    // Map each row to its (possibly merged, possibly split) group key.
    const rowKey = (m: LibraryManga): string => {
        const own = workKeyOf(m, m.id)
        if (splits.has(m.id)) return `split:${m.id}`
        return mergeMap.get(own) ?? own
    }

    const poolByWork = new Map<string, VersionRecord[]>()
    for (const v of pool) {
        const key = mergeMap.get(v.workKey) ?? v.workKey
        const arr = poolByWork.get(key)
        if (arr) arr.push(v)
        else poolByWork.set(key, [v])
    }

    const order: string[] = []
    const groups = new Map<string, LibraryManga[]>()
    for (const m of rows) {
        const key = rowKey(m)
        const arr = groups.get(key)
        if (arr) arr.push(m)
        else {
            groups.set(key, [m])
            order.push(key)
        }
    }

    return order.map(key => {
        const members = groups.get(key)!
        // The tracked row is the most-recently-updated member (stable, matches library sort).
        const tracked = members.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a), members[0]!)
        const preferred = overrides.find(
            o => o.preferredSourceId && (o.members.includes(key) || o.members.includes(tracked.id))
        )
        // Versions for this work: the pool rows under this key, plus a synthesized own-source row
        // for each member not yet in the pool (cold start, before the backfill has run).
        const poolVersions = poolByWork.get(key) ?? []
        const haveIds = new Set(poolVersions.map(v => v.id))
        const synthesized: VersionRecord[] = members
            .filter(m => !haveIds.has(versionIdFor(m.sourceId, m.sourceMangaId, m.id)))
            .map(m => ({
                id: versionIdFor(m.sourceId, m.sourceMangaId, m.id),
                workKey: key,
                sourceId: m.sourceId,
                sourceMangaId: m.sourceMangaId ?? m.id,
                url: m.sourceUrl,
                languages: [],
                ...(m.latestChapterNumber !== undefined && Number.isFinite(m.latestChapterNumber)
                    ? { latestChapterNumber: m.latestChapterNumber }
                    : {}),
                health: "unknown" as const,
                numberingKind: m.chapterNumberingUnreliable ? ("unreliable" as const) : ("chapter" as const),
                lastSeenAt: m.updatedAt,
                observedVia: "own-source" as const
            }))
        const versions = [...poolVersions, ...synthesized]
        const { best, ordered } = rankWorkVersions(versions, ctx, preferred?.preferredSourceId)
        return { workKey: key, tracked, best, ordered, versionCount: versions.length }
    })
}
