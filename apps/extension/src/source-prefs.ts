import { matchesSourceDomain } from "@amr/source-sdk"
import { sourceRegistry } from "@amr/sources"
import { isDetectedSourceId, DETECTED_SOURCE_PREFIX } from "./detected-site"
import { rowOrigin } from "./arch-sources"
import { db, listArchProfileRows } from "./database"
import { getCachedOfficialSites, isOfficialHost } from "./official-sources"
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
    // How often each address (scheme, host and port) on one of the source's own domains appears in the
    // user's saved links for it.
    origins: Map<string, number>
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
            entry = { id, domains: [], origins: new Map(), registered: false, addedSite: false, usage: 0 }
            known.set(id, entry)
        }
        return entry
    }

    for (const id of (await db.manga.orderBy("sourceId").uniqueKeys()) as string[]) {
        if (typeof id !== "string" || id === "") continue
        touch(id).usage += await db.manga.where("sourceId").equals(id).count()
    }
    // A title's own ranking row only repeats the title counted above, so one left behind after the title
    // moved or was removed does not keep its source listed. Neither does any ranking row of a detected site,
    // which only ever ranks its own titles.
    const ranked = new Set<string>()
    await db.versions.each(v => {
        if (v.observedVia !== "own-source" && !isDetectedSourceId(v.sourceId)) ranked.add(v.sourceId)
    })
    for (const id of ranked) {
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
    const links = new Map<string, URL[][]>()
    await db.manga.each(title => {
        if (typeof title.sourceId !== "string" || !known.has(title.sourceId)) return
        const urls = [webUrl(title.mangaUrl), webUrl(title.sourceUrl)].filter((u): u is URL => u !== undefined)
        if (urls.length === 0) return
        const list = links.get(title.sourceId) ?? []
        list.push(urls)
        links.set(title.sourceId, list)
    })
    for (const entry of known.values()) {
        const titles = links.get(entry.id) ?? []
        // A source with no domain of its own answers wherever its titles point.
        if (entry.domains.length === 0) entry.domains = [...new Set(titles.map(urls => bareHost(urls[0]!.hostname)))]
        // A title link outside the source's own domains never names or addresses the source.
        for (const urls of titles) {
            const url = urls.find(u => onSourceDomain(u.hostname, entry.domains))
            if (url) entry.origins.set(url.origin, (entry.origins.get(url.origin) ?? 0) + 1)
        }
    }
    return known
}

function webUrl(url: unknown): URL | undefined {
    if (typeof url !== "string") return undefined
    try {
        const parsed = new URL(url)
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : undefined
    } catch {
        return undefined
    }
}

function bareHost(host: string): string {
    return host
        .toLowerCase()
        .replace(/\.$/, "")
        .replace(/^www\./, "")
}

// True when a host is one of the domains, counting www.<domain> and <domain> as the same site.
export function onSourceDomain(host: string, domains: readonly string[]): boolean {
    if (matchesSourceDomain(host, domains)) return true
    return matchesSourceDomain(
        bareHost(host),
        domains.map(domain => (domain.startsWith("*.") ? domain : bareHost(domain)))
    )
}

function mostUsed(counts: Map<string, number>): string | undefined {
    let best: string | undefined
    let bestCount = 0
    for (const [key, count] of counts) {
        if (count > bestCount || (count === bestCount && best !== undefined && key < best)) {
            best = key
            bestCount = count
        }
    }
    return best
}

// The site the user's own saved titles on this source point at most, www and bare counted together.
function usedHost(source: KnownSource): string | undefined {
    const counts = new Map<string, number>()
    for (const [origin, count] of source.origins) {
        const host = bareHost(new URL(origin).hostname)
        counts.set(host, (counts.get(host) ?? 0) + count)
    }
    return mostUsed(counts)
}

// The exact address (scheme, host and port) the user's titles use most on that site.
function usedOrigin(source: KnownSource): string | undefined {
    const host = usedHost(source)
    if (!host) return undefined
    return mostUsed(new Map([...source.origins].filter(([origin]) => bareHost(new URL(origin).hostname) === host)))
}

// The address shown beside a source: the host the user's own saved titles point at most, else the
// first domain the source answers on.
function shownHost(source: KnownSource): string | undefined {
    return usedHost(source) ?? source.domains[0]?.replace(/^www\./, "")
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
    // Stored places can have gaps (a source the user no longer has keeps its row), so unplaced sources go
    // after the highest stored place, never into a gap where they would tie with and jump a stored one.
    const after = stored.reduce((max, p) => Math.max(max, p.position), -1) + 1
    const prefs: SourcePref[] = [
        ...stored,
        ...unplaced.map((sourceId, index) => ({ sourceId, position: after + index, updatedAt: 0 }))
    ]
    const sites = await getCachedOfficialSites()
    const labels = buildLabelMap(prefs)
    return prefs.map((pref, index) => {
        const source = known.get(pref.sourceId)!
        const candidate = shownHost(source)
        // An official site is never named in the app (D6), so it shows no address and suggests no name. Any
        // match counts, a site the weeb.ltd feed added included: hiding is the safe side.
        const official =
            source.domains.some(domain => isOfficialHost(domain, sites)) ||
            (candidate !== undefined && isOfficialHost(candidate, sites))
        const host = official ? undefined : candidate
        const suggestion = official ? undefined : (source.suggestion ?? host)
        return {
            id: pref.sourceId,
            position: index + 1,
            label: labels.get(pref.sourceId) ?? numberedLabel(index + 1),
            ...(pref.name !== undefined ? { name: pref.name } : {}),
            used: source.usage > 0,
            official,
            ...(suggestion ? { suggestion } : {}),
            ...(host ? { host } : {}),
            domains: source.domains,
            registered: source.registered || !source.addedSite
        }
    })
}

export type SourcePingTarget = { id: string; used: boolean; origin?: string; domains: string[] }

// What the reachability check may knock on for each source: its own domains, and the address on one of them
// the user's titles use most. Never an address from a title link outside those domains.
export async function listSourcePingTargets(): Promise<SourcePingTarget[]> {
    const known = await gatherKnownSources()
    return [...known.values()].map(source => {
        const origin = usedOrigin(source)
        return { id: source.id, used: source.usage > 0, ...(origin ? { origin } : {}), domains: source.domains }
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
