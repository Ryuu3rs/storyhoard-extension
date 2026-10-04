import { sourceRegistry } from "@amr/sources"
import { getCachedOfficialSites, isOfficialHost, type OfficialSite } from "./official-sources"
import { workKeyOf } from "./work-identity"
import { db, isHttpUrl, listAllVersions, putVersions, type LibraryManga, type VersionRecord } from "./database"

// ARCH TRACK A: write-through helpers that populate the best-version pool. Own-source rows come from
// the library (ensureOwnSourceVersions); cross-source rows come from an explicit mirror-check of a
// tracked title (recordMirrorVersions) so the ranker and the on-site "better version" hint have
// real alternatives to compare, without recording every random search hit (which would bloat the
// pool with titles the user does not track). The pool is a device-local cache the ranker reads.

// Stable version id. Matches the manga-id convention so a title's own source maps to one row.
export function versionIdFor(sourceId: string, sourceMangaId: string | undefined, mangaId: string): string {
    return sourceMangaId ? `${sourceId}:${sourceMangaId}` : mangaId
}

function hostOf(url: string): string {
    try {
        return new URL(url).hostname
    } catch {
        return ""
    }
}

// Build the own-source VersionRecord for a library row. Language comes from the registered source
// adapter's manifest (a user-added profile carries its own languages too). Officialness is keyed
// off the real host of the stored source URL, never a profile's self-declared domain (R3).
export function ownSourceVersion(m: LibraryManga, officialSites: readonly OfficialSite[], now: number): VersionRecord {
    const languages = sourceRegistry.get(m.sourceId)?.manifest.languages ?? []
    const latest =
        m.latestChapterNumber !== undefined && Number.isFinite(m.latestChapterNumber)
            ? m.latestChapterNumber
            : undefined
    return {
        id: versionIdFor(m.sourceId, m.sourceMangaId, m.id),
        workKey: workKeyOf(m, m.id),
        sourceId: m.sourceId,
        sourceMangaId: m.sourceMangaId ?? m.id,
        url: m.sourceUrl,
        languages: [...languages],
        ...(latest !== undefined ? { latestChapterNumber: latest } : {}),
        ...(m.latestChapterAt !== undefined ? { latestChapterAt: m.latestChapterAt } : {}),
        isOfficialAtObservation: isOfficialHost(hostOf(m.sourceUrl), officialSites),
        health: "unknown",
        numberingKind: m.chapterNumberingUnreliable ? "unreliable" : "chapter",
        lastSeenAt: now,
        observedVia: "own-source"
    }
}

// Keep every library row's own-source version row present AND current. Reads the pool once and
// writes only rows that are new or whose tracked fields changed (latest chapter, release time,
// officialness, numbering, languages), so a title that advances from ch 100 to ch 300 updates its
// pool row instead of ranking forever against a stale count. Cheap (writes only on change) and safe
// to call fire-and-forget from library:list. Only ever touches own-source ids; cross-source pool
// rows (different source) are left untouched.
export async function ensureOwnSourceVersions(rows: LibraryManga[]): Promise<void> {
    if (rows.length === 0) return
    const existing = new Map((await listAllVersions()).map(v => [v.id, v]))
    const officialSites = await getCachedOfficialSites()
    const now = Date.now()
    const toWrite: VersionRecord[] = []
    for (const m of rows) {
        const desired = ownSourceVersion(m, officialSites, now)
        const prev = existing.get(desired.id)
        const changed =
            !prev ||
            prev.latestChapterNumber !== desired.latestChapterNumber ||
            prev.latestChapterAt !== desired.latestChapterAt ||
            prev.isOfficialAtObservation !== desired.isOfficialAtObservation ||
            prev.numberingKind !== desired.numberingKind ||
            prev.languages.join("\u0000") !== desired.languages.join("\u0000")
        if (changed) toWrite.push(desired)
    }
    if (toWrite.length > 0) await putVersions(toWrite)
}

// A mirror-finder result: another source that carries the same title.
export type MirrorInput = {
    sourceId: string
    sourceMangaId?: string | undefined
    url: string
    latestChapter?: string | undefined
}

// Record cross-source versions for a tracked title, from a mirror check. Each mirror becomes a
// VersionRecord under the tracked work's key so the ranker/hint can compare it against the user's
// own source. http(s) urls only; the tracked source itself is skipped (its own-source row is
// authoritative and already maintained by ensureOwnSourceVersions).
export async function recordMirrorVersions(mangaId: string, mirrors: readonly MirrorInput[]): Promise<void> {
    const manga = await db.manga.get(mangaId)
    if (!manga) return
    const workKey = workKeyOf(manga, manga.id)
    const officialSites = await getCachedOfficialSites()
    const now = Date.now()
    const rows: VersionRecord[] = []
    for (const m of mirrors) {
        if (m.sourceId === manga.sourceId || !isHttpUrl(m.url)) continue
        const sourceMangaId = m.sourceMangaId ?? m.url
        const languages = sourceRegistry.get(m.sourceId)?.manifest.languages ?? []
        const n = m.latestChapter ? parseFloat(m.latestChapter) : NaN
        rows.push({
            id: versionIdFor(m.sourceId, sourceMangaId, m.url),
            workKey,
            sourceId: m.sourceId,
            sourceMangaId,
            url: m.url,
            languages: [...languages],
            ...(Number.isFinite(n) ? { latestChapterNumber: n } : {}),
            isOfficialAtObservation: isOfficialHost(hostOf(m.url), officialSites),
            health: "unknown",
            numberingKind: "chapter",
            lastSeenAt: now,
            observedVia: "mirror-check"
        })
    }
    if (rows.length > 0) await putVersions(rows)
}
