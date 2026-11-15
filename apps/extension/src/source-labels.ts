// Neutral source labels. A source is shown as "Source N" unless the user typed a name for it; N is the
// source's place in the user's own order. Pure and dependency-free so the background, the app and the
// popup all derive the same label from the same rows.

export type SourcePref = {
    sourceId: string
    // Zero-based place in the user's order. Ties and gaps are tolerated and resolved by sourceId.
    position: number
    // Only ever set from text the user typed.
    name?: string
    // True once the user has put the sources in an order of their own: only then does the order steer
    // which source is opened first. Sources seen later are appended without it.
    ranked?: boolean
    updatedAt: number
}

export type SourceLabelInfo = {
    id: string
    // One-based place in the user's order.
    position: number
    label: string
    // The name the user typed, when there is one.
    name?: string
    official: boolean
    // True when the user has titles, versions or an added site under it, so the order list can leave the
    // sources they never touched out of sight.
    used: boolean
    // The site's own name, offered as a one-click rename suggestion and never shown as a label.
    suggestion?: string
    domains: string[]
    // False for an added site that currently has no host access, so it is not in the live registry.
    registered: boolean
}

export const MAX_SOURCE_NAME_LENGTH = 40
export const UNLISTED_SOURCE_LABEL = "Unlisted source"

export function numberedLabel(position: number): string {
    return `Source ${position}`
}

// Plain text only: control characters and angle brackets are dropped, whitespace collapsed, length
// capped. Empty after cleaning means "no name".
export function sanitizeSourceName(raw: unknown): string | undefined {
    if (typeof raw !== "string") return undefined
    const cleaned = raw
        .replace(/[\u0000-\u001f\u007f<>]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    if (cleaned === "") return undefined
    return cleaned.slice(0, MAX_SOURCE_NAME_LENGTH).trim()
}

export function sortSourcePrefs(prefs: readonly SourcePref[]): SourcePref[] {
    return [...prefs].sort(
        (a, b) => a.position - b.position || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0)
    )
}

export function orderedSourceIds(prefs: readonly SourcePref[]): string[] {
    return sortSourcePrefs(prefs).map(p => p.sourceId)
}

// The label for one source: the user's name, else "Source N" by place in their order.
export function sourceLabel(sourceId: string, prefs: readonly SourcePref[]): string {
    const sorted = sortSourcePrefs(prefs)
    const index = sorted.findIndex(p => p.sourceId === sourceId)
    if (index < 0) return UNLISTED_SOURCE_LABEL
    return sorted[index]!.name ?? numberedLabel(index + 1)
}

export function buildLabelMap(prefs: readonly SourcePref[]): Map<string, string> {
    const map = new Map<string, string>()
    sortSourcePrefs(prefs).forEach((p, index) => map.set(p.sourceId, p.name ?? numberedLabel(index + 1)))
    return map
}

export function buildLabelMapFromInfos(infos: readonly SourceLabelInfo[]): Map<string, string> {
    return new Map(infos.map(info => [info.id, info.label]))
}

// Label lookup for the UI: never falls back to the raw id.
export function labelFromMap(labels: ReadonlyMap<string, string>, sourceId: string): string {
    return labels.get(sourceId) ?? UNLISTED_SOURCE_LABEL
}

// Rows for sources seen for the first time, placed after every existing row in the order given. Existing
// rows are never touched, so adding a source cannot reshuffle the numbers the user already knows.
export function appendNewSources(prefs: readonly SourcePref[], newIds: readonly string[], now: number): SourcePref[] {
    const have = new Set(prefs.map(p => p.sourceId))
    let next = prefs.reduce((max, p) => Math.max(max, p.position), -1) + 1
    const rows: SourcePref[] = []
    for (const sourceId of newIds) {
        if (have.has(sourceId)) continue
        have.add(sourceId)
        rows.push({ sourceId, position: next++, updatedAt: now })
    }
    return rows
}

// Move one id to a one-based target place, clamped to the list.
export function moveInOrder(ids: readonly string[], id: string, to: number): string[] {
    const from = ids.indexOf(id)
    if (from < 0) return [...ids]
    const out = [...ids]
    out.splice(from, 1)
    const target = Math.min(Math.max(Math.trunc(to) - 1, 0), out.length)
    out.splice(target, 0, id)
    return out
}
