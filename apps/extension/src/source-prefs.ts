import { sourceRegistry } from "@amr/sources"
import { isDetectedSourceId, DETECTED_SOURCE_PREFIX } from "./detected-site"
import { rowOrigin } from "./arch-sources"
import { db, listArchProfileRows } from "./database"
import { getCachedOfficialSites, isVerifiedOfficialHost } from "./official-sources"
import {
    appendNewSources,
    buildLabelMap,
    moveInOrder,
    numberedLabel,
    orderedSourceIds,
    sanitizeSourceName,
    sortSourcePrefs,
    type SourceLabelInfo,
    type SourcePref
} from "./source-labels"

type KnownSource = {
    id: string
    domains: string[]
    suggestion?: string
    registered: boolean
    addedSite: boolean
    usage: number
}

function profileFields(profile: unknown): { id?: string; name?: string; domains: string[] } {
    const raw = (profile ?? {}) as { id?: unknown; name?: unknown; domains?: unknown }
    return {
        ...(typeof raw.id === "string" ? { id: raw.id } : {}),
        ...(typeof raw.name === "string" && raw.name.trim() ? { name: raw.name.trim() } : {}),
        domains: Array.isArray(raw.domains) ? raw.domains.filter((d): d is string => typeof d === "string") : []
    }
}

// Every source the user has or could see: titles filed under it, ranked versions, added sites, and the
// bundled registry. The registry is last in line when numbers are first handed out.
async function gatherKnownSources(): Promise<Map<string, KnownSource>> {
    const known = new Map<string, KnownSource>()
    const touch = (id: string): KnownSource => {
        let entry = known.get(id)
        if (!entry) {
            entry = { id, domains: [], registered: false, addedSite: false, usage: 0 }
            known.set(id, entry)
        }
        return entry
    }

    for (const id of (await db.manga.orderBy("sourceId").uniqueKeys()) as string[]) {
        if (typeof id !== "string" || id === "") continue
        touch(id).usage += await db.manga.where("sourceId").equals(id).count()
    }
    for (const id of (await db.versions.orderBy("sourceId").uniqueKeys()) as string[]) {
        if (typeof id === "string" && id !== "") touch(id).usage += 1
    }
    for (const row of await listArchProfileRows()) {
        if (rowOrigin(row) !== "user") continue
        const fields = profileFields(row.profile)
        const entry = touch(fields.id ?? row.id)
        entry.usage += 1
        entry.addedSite = true
        entry.domains = fields.domains
        if (fields.name) entry.suggestion = fields.name
    }
    for (const adapter of sourceRegistry.list()) {
        const entry = touch(adapter.manifest.id)
        entry.registered = true
        entry.domains = adapter.manifest.domains.length > 0 ? [...adapter.manifest.domains] : entry.domains
        if (adapter.manifest.name) entry.suggestion = adapter.manifest.name
    }
    for (const entry of known.values()) {
        if (isDetectedSourceId(entry.id) && entry.domains.length === 0) {
            entry.domains = [entry.id.slice(DETECTED_SOURCE_PREFIX.length)]
        }
    }
    return known
}

function firstSeenOrder(known: Map<string, KnownSource>, ids: string[]): string[] {
    return [...ids].sort((a, b) => known.get(b)!.usage - known.get(a)!.usage || (a < b ? -1 : a > b ? 1 : 0))
}

// Only sources the user actually has take a stored place, so a site they add next is numbered right
// after their own, not after the bundled ones they never touch. `also` forces one more id in.
function newRows(known: Map<string, KnownSource>, stored: readonly SourcePref[], also?: string): SourcePref[] {
    const have = new Set(stored.map(p => p.sourceId))
    const fresh = firstSeenOrder(
        known,
        [...known.keys()].filter(id => !have.has(id) && (known.get(id)!.usage > 0 || id === also))
    )
    return appendNewSources(stored, fresh, Date.now())
}

// Hands a place in the order to every source seen for the first time, after all existing ones, and
// returns the rows for the sources that exist now. Rows for sources that no longer exist stay stored
// (so their place returns with them) but take no number.
async function syncPrefs(known: Map<string, KnownSource>, also?: string): Promise<SourcePref[]> {
    return db.transaction("rw", db.sourcePrefs, async () => {
        const stored = await db.sourcePrefs.toArray()
        const added = newRows(known, stored, also)
        if (added.length > 0) await db.sourcePrefs.bulkPut(added)
        return sortSourcePrefs([...stored, ...added]).filter(p => known.has(p.sourceId))
    })
}

export async function listSourceLabels(): Promise<SourceLabelInfo[]> {
    const known = await gatherKnownSources()
    const stored = await syncPrefs(known)
    const placed = new Set(stored.map(p => p.sourceId))
    const unplaced = [...known.keys()].filter(id => !placed.has(id)).sort()
    const prefs: SourcePref[] = [
        ...stored,
        ...unplaced.map((sourceId, index) => ({ sourceId, position: stored.length + index, updatedAt: 0 }))
    ]
    const sites = await getCachedOfficialSites()
    const labels = buildLabelMap(prefs)
    return prefs.map((pref, index) => {
        const source = known.get(pref.sourceId)!
        return {
            id: pref.sourceId,
            position: index + 1,
            label: labels.get(pref.sourceId) ?? numberedLabel(index + 1),
            ...(pref.name !== undefined ? { name: pref.name } : {}),
            used: source.usage > 0,
            official: source.domains.some(domain => isVerifiedOfficialHost(domain, sites)),
            ...(source.suggestion ? { suggestion: source.suggestion } : {}),
            domains: source.domains,
            registered: source.registered || !source.addedSite
        }
    })
}

export async function labelForSource(sourceId: string): Promise<string> {
    const infos = await listSourceLabels()
    return infos.find(info => info.id === sourceId)?.label ?? numberedLabel(infos.length + 1)
}

export async function setSourceName(sourceId: string, rawName: string | null): Promise<void> {
    const known = await gatherKnownSources()
    if (!known.has(sourceId)) throw new Error("Unknown source")
    await syncPrefs(known, sourceId)
    const name = rawName === null ? undefined : sanitizeSourceName(rawName)
    await db.transaction("rw", db.sourcePrefs, async () => {
        const row = await db.sourcePrefs.get(sourceId)
        if (!row) return
        const { name: _drop, ...rest } = row
        await db.sourcePrefs.put({ ...rest, ...(name !== undefined ? { name } : {}), updatedAt: Date.now() })
    })
}

// Moves one source to a one-based place. Every source is then marked as ordered by the user.
export async function moveSource(sourceId: string, to: number): Promise<void> {
    const known = await gatherKnownSources()
    if (!known.has(sourceId)) throw new Error("Unknown source")
    await db.transaction("rw", db.sourcePrefs, async () => {
        const stored = await db.sourcePrefs.toArray()
        const all = sortSourcePrefs([...stored, ...newRows(known, stored, sourceId)])
        const live = all.filter(p => known.has(p.sourceId))
        const stale = all.filter(p => !known.has(p.sourceId))
        const nextIds = moveInOrder(
            live.map(p => p.sourceId),
            sourceId,
            to
        )
        const byId = new Map(all.map(p => [p.sourceId, p]))
        const now = Date.now()
        const rows: SourcePref[] = [
            ...nextIds.map(id => ({ ...byId.get(id)!, ranked: true as const, updatedAt: now })),
            ...stale
        ].map((row, position) => ({ ...row, position }))
        await db.sourcePrefs.bulkPut(rows)
    })
}

// The sources the user has put in an order, best first. Empty until they reorder, so the ranker keeps
// its own judgement for anyone who never has.
export async function getRankedSourceOrder(): Promise<string[]> {
    return orderedSourceIds((await db.sourcePrefs.toArray()).filter(p => p.ranked === true))
}
