import { SourceError } from "@amr/source-sdk"
import { db, deleteVersion, isHttpUrl, listVersionsByWork, listWorkOverrides, type LibraryManga } from "./database"
import { isDetectedSourceId } from "./detected-site"
import { getCachedOfficialSites } from "./official-sources"
import { matchReadChapterId } from "./reconcile-match"
import { listSourceLabels } from "./source-prefs"
import { findSource, getSourceById, listChaptersForSource, resolveChapterUrl, resolveMangaUrl } from "./sources"
import { ownSourceVersion, recordMirrorVersions, versionIdFor } from "./work-versions"
import { workKeyOf } from "./work-identity"

export type TitleSourceRow = {
    id: string
    sourceId: string
    sourceMangaId: string
    url: string
    label: string
    official: boolean
    latestChapterNumber?: number
    isMain: boolean
    isPreferred: boolean
    // The extension has no way to read this source right now (its adapter is gone, or it is not one the
    // extension reads), so it cannot be made main until the title is moved to a source it can.
    needsRelink: boolean
}

export type TitleSources = {
    mangaId: string
    rows: TitleSourceRow[]
    preferredSourceId?: string
    needsRelink: boolean
    // Last known page of the title, only ever an http(s) address.
    reopenUrl?: string
}

export type SourceCandidate = { sourceId: string; sourceMangaId: string; mangaUrl: string }

export type ChangePreview = {
    candidate: SourceCandidate
    currentLabel: string
    newLabel: string
    chapterCount: number | null
    latestChapterNumber: number | null
    currentLatestChapterNumber: number | null
    readChapterNumber: number | null
    // False when the read chapter cannot be mapped onto the new list.
    progressMapped: boolean
    // True when the new source's latest chapter is below what the user has read.
    behindProgress: boolean
    previewError?: string
}

export const OVERRIDE_PREFIX = "prefer:"

// A row the extension cannot read: its adapter is gone, or the title has no source link. A site the user
// followed by visiting it is tracked on purpose without an adapter, so it is not counted.
export function isUnresolvedTitle(manga: Pick<LibraryManga, "sourceId">, hasSourceLink: boolean): boolean {
    if (isDetectedSourceId(manga.sourceId)) return false
    return getSourceById(manga.sourceId) === undefined || !hasSourceLink
}

function canBeRead(sourceId: string): boolean {
    return getSourceById(sourceId) !== undefined
}

function reopenUrlOf(manga: LibraryManga): string | undefined {
    for (const url of [manga.mangaUrl, manga.sourceUrl]) {
        if (url && isHttpUrl(url)) return url
    }
    return undefined
}

function overrideIdFor(workKey: string): string {
    return `${OVERRIDE_PREFIX}${workKey}`
}

async function requireManga(mangaId: string): Promise<LibraryManga> {
    const manga = await db.manga.get(mangaId)
    if (!manga) throw new SourceError("not-found", "That title is not in your library")
    return manga
}

async function preferredFor(manga: LibraryManga, workKey: string): Promise<string | undefined> {
    const overrides = await listWorkOverrides()
    return overrides.find(o => o.preferredSourceId && (o.members.includes(workKey) || o.members.includes(manga.id)))
        ?.preferredSourceId
}

export async function listTitleSources(mangaId: string): Promise<TitleSources> {
    const manga = await requireManga(mangaId)
    const workKey = workKeyOf(manga, manga.id)
    const now = Date.now()
    const own = ownSourceVersion(manga, await getCachedOfficialSites(), now)
    const stored = await listVersionsByWork(workKey)
    const byId = new Map(stored.map(v => [v.id, v]))
    byId.set(own.id, { ...(byId.get(own.id) ?? own), ...own })
    const labels = new Map((await listSourceLabels()).map(info => [info.id, info.label]))
    const preferredSourceId = await preferredFor(manga, workKey)
    const hasLink = (await db.sourceLinks.get(manga.id)) !== undefined
    const rows: TitleSourceRow[] = [...byId.values()].map(v => ({
        id: v.id,
        sourceId: v.sourceId,
        sourceMangaId: v.sourceMangaId,
        url: v.url,
        label: labels.get(v.sourceId) ?? "Unlisted source",
        official: v.isOfficialAtObservation === true,
        ...(v.latestChapterNumber !== undefined ? { latestChapterNumber: v.latestChapterNumber } : {}),
        isMain: v.id === own.id,
        isPreferred: preferredSourceId !== undefined && v.sourceId === preferredSourceId,
        needsRelink: v.id === own.id ? isUnresolvedTitle(manga, hasLink) : !canBeRead(v.sourceId)
    }))
    rows.sort(
        (a, b) =>
            Number(b.isMain) - Number(a.isMain) ||
            (b.latestChapterNumber ?? -1) - (a.latestChapterNumber ?? -1) ||
            (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)
    )
    const reopenUrl = reopenUrlOf(manga)
    return {
        mangaId,
        rows,
        ...(preferredSourceId !== undefined ? { preferredSourceId } : {}),
        needsRelink: isUnresolvedTitle(manga, hasLink),
        ...(reopenUrl ? { reopenUrl } : {})
    }
}

export async function listUnresolvedTitles(): Promise<Array<{ mangaId: string; reopenUrl?: string }>> {
    const linked = new Set((await db.sourceLinks.toCollection().primaryKeys()) as string[])
    const out: Array<{ mangaId: string; reopenUrl?: string }> = []
    for (const manga of await db.manga.toArray()) {
        if (manga.id.startsWith("seed-") || !isUnresolvedTitle(manga, linked.has(manga.id))) continue
        const reopenUrl = reopenUrlOf(manga)
        out.push({ mangaId: manga.id, ...(reopenUrl ? { reopenUrl } : {}) })
    }
    return out
}

// "Prefer for this title" pins one source for the ranker; null clears the pin.
export async function setPreferredSource(mangaId: string, sourceId: string | null): Promise<TitleSources> {
    const manga = await requireManga(mangaId)
    const workKey = workKeyOf(manga, manga.id)
    const id = overrideIdFor(workKey)
    if (sourceId === null) {
        const stale = (await listWorkOverrides()).filter(
            o => o.preferredSourceId && (o.members.includes(workKey) || o.members.includes(manga.id))
        )
        await db.workOverrides.bulkDelete([...new Set([id, ...stale.map(o => o.id)])])
    } else {
        const known = (await listTitleSources(mangaId)).rows.some(row => row.sourceId === sourceId)
        if (!known) throw new SourceError("not-found", "That source is not one of this title's sources")
        await db.workOverrides.put({
            id,
            type: "merge",
            members: [workKey],
            preferredSourceId: sourceId,
            updatedAt: Date.now()
        })
    }
    return listTitleSources(mangaId)
}

export async function removeTitleVersion(mangaId: string, versionId: string): Promise<TitleSources> {
    const current = await listTitleSources(mangaId)
    const row = current.rows.find(r => r.id === versionId)
    if (!row) throw new SourceError("not-found", "That source is not listed for this title")
    if (row.isMain)
        throw new SourceError("invalid-input", "The main source cannot be removed. Make another one main first.")
    await deleteVersion(versionId)
    return listTitleSources(mangaId)
}

const NOT_READABLE =
    "The extension cannot read that site, so it cannot be linked or switched to here. Open the site and follow it from the page panel first."

function lastSegment(url: URL): string {
    const segments = url.pathname.split("/").filter(Boolean)
    return segments[segments.length - 1] ?? ""
}

// A series or chapter address, turned into the source and series it belongs to. Reads the page only for a
// chapter address, which is the only kind the site has to be asked about to find its series.
export async function resolveCandidate(rawUrl: string): Promise<SourceCandidate> {
    if (!isHttpUrl(rawUrl)) {
        throw new SourceError("invalid-input", "Enter a web address that starts with http:// or https://")
    }
    const url = new URL(rawUrl)
    const adapter = findSource(url)
    if (!adapter) throw new SourceError("unsupported-url", NOT_READABLE)
    const kind = adapter.match(url)
    if (kind === "chapter") {
        const resolved = await resolveChapterUrl(rawUrl)
        const sourceMangaId = resolved.manga.sourceMangaId || lastSegment(new URL(resolved.manga.url))
        if (!sourceMangaId || !isHttpUrl(resolved.manga.url)) {
            throw new SourceError("invalid-response", "Could not find the series for that chapter")
        }
        return { sourceId: resolved.manga.sourceId, sourceMangaId, mangaUrl: resolved.manga.url }
    }
    if (kind === "manga") {
        let sourceMangaId: string
        try {
            sourceMangaId = await resolveMangaUrl(url)
        } catch {
            sourceMangaId = lastSegment(url)
        }
        if (!sourceMangaId) throw new SourceError("invalid-input", "Could not tell which series that address is")
        return { sourceId: adapter.manifest.id, sourceMangaId, mangaUrl: rawUrl }
    }
    throw new SourceError("unsupported-url", "That address is not a series or chapter page")
}

export async function linkAnotherSite(mangaId: string, rawUrl: string): Promise<TitleSources> {
    const manga = await requireManga(mangaId)
    const candidate = await resolveCandidate(rawUrl)
    if (candidate.sourceId === manga.sourceId) {
        throw new SourceError("invalid-input", "That site is already this title's main source")
    }
    await recordMirrorVersions(mangaId, [
        { sourceId: candidate.sourceId, sourceMangaId: candidate.sourceMangaId, url: candidate.mangaUrl }
    ])
    const id = versionIdFor(candidate.sourceId, candidate.sourceMangaId, candidate.mangaUrl)
    const saved = await db.versions.get(id)
    if (!saved) throw new SourceError("invalid-input", "That address could not be recorded")
    return listTitleSources(mangaId)
}

async function labelOf(sourceId: string): Promise<string> {
    return (await listSourceLabels()).find(info => info.id === sourceId)?.label ?? "Unlisted source"
}

export type PreviewInput = {
    url?: string | undefined
    sourceId?: string | undefined
    sourceMangaId?: string | undefined
    mangaUrl?: string | undefined
}

export async function candidateFromInput(input: PreviewInput): Promise<SourceCandidate> {
    if (input.url) return resolveCandidate(input.url)
    if (input.sourceId && input.sourceMangaId && input.mangaUrl) {
        if (!isHttpUrl(input.mangaUrl)) {
            throw new SourceError("invalid-input", "Enter a web address that starts with http:// or https://")
        }
        return { sourceId: input.sourceId, sourceMangaId: input.sourceMangaId, mangaUrl: input.mangaUrl }
    }
    throw new SourceError("invalid-input", "Choose a source or paste a series or chapter address")
}

// What the title would look like on the other source, read without storing anything.
export async function previewChange(mangaId: string, input: PreviewInput): Promise<ChangePreview> {
    const manga = await requireManga(mangaId)
    const candidate = await candidateFromInput(input)
    if (!canBeRead(candidate.sourceId)) throw new SourceError("unsupported-url", NOT_READABLE)
    const readNumber = manga.lastReadChapterNumber ?? null
    const base = {
        candidate,
        currentLabel: await labelOf(manga.sourceId),
        newLabel: await labelOf(candidate.sourceId),
        currentLatestChapterNumber: manga.latestChapterNumber ?? null,
        readChapterNumber: readNumber
    }
    try {
        const chapters = await listChaptersForSource(
            manga,
            candidate.sourceId,
            candidate.sourceMangaId,
            candidate.mangaUrl,
            { timeoutMs: 10_000, maxRetries: 1 }
        )
        const numbers = chapters.map(c => c.sortKey).filter(n => Number.isFinite(n))
        const latest = numbers.length > 0 ? Math.max(...numbers) : null
        const mapped = readNumber === null || readNumber <= 0 || matchReadChapterId(chapters, readNumber) !== undefined
        return {
            ...base,
            chapterCount: chapters.length,
            latestChapterNumber: latest,
            progressMapped: mapped,
            behindProgress: readNumber !== null && latest !== null && latest < readNumber
        }
    } catch {
        return {
            ...base,
            chapterCount: null,
            latestChapterNumber: null,
            progressMapped: true,
            behindProgress: false,
            previewError: "The chapter list could not be loaded for a preview. You can still change the source."
        }
    }
}
