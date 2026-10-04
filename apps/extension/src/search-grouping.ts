import { titleKey } from "./work-identity"

// A per-source search hit, plus an optional resolved AniList id when metadata has been
// looked up for it. Mirrors App.svelte's SearchResult with the id added.
export type GroupableResult = {
    sourceId: string
    sourceMangaId: string
    title: string
    url: string
    coverUrl?: string
    latestChapter?: string
    anilistId?: number
}

// One "work" collapsing the same series across mirrors, carrying every source member.
export type WorkCard = {
    key: string
    anilistId?: number
    title: string
    coverUrl?: string
    // The representative member to surface as the single "best version" action; the rest stay
    // available under an Advanced disclosure.
    best: GroupableResult
    members: GroupableResult[]
}

export type GroupingOptions = {
    // Canonical title/cover per AniList id, used when metadata is available. Falls back
    // to the best member when a work has no id or no metadata entry.
    metadataByAnilistId?: Map<number, { title?: string; coverUrl?: string }>
}

function chapterValue(result: GroupableResult): number {
    return parseFloat(result.latestChapter ?? "0") || 0
}

// Picks the member whose title/cover best represents the work: the one with the highest
// latest chapter, tie-broken by first appearance, and preferring a member that has a cover.
function bestMember(members: GroupableResult[]): GroupableResult {
    let best = members[0]!
    for (const member of members) {
        const better = chapterValue(member) > chapterValue(best)
        const coverEdge = chapterValue(member) === chapterValue(best) && !best.coverUrl && !!member.coverUrl
        if (better || coverEdge) best = member
    }
    return best
}

export function groupSearchResultsIntoWorks(results: GroupableResult[], opts: GroupingOptions = {}): WorkCard[] {
    const order: string[] = []
    const groups = new Map<string, GroupableResult[]>()

    results.forEach((result, i) => {
        const tk = titleKey(result.title)
        // No id and no usable title (symbol/whitespace-only or missing) -> give this row
        // its own key so unrelated title-less hits never collapse into one card.
        const key =
            typeof result.anilistId === "number"
                ? `anilist:${result.anilistId}`
                : tk
                  ? `title:${tk}`
                  : `untitled:${result.sourceId}:${result.sourceMangaId}:${i}`
        const existing = groups.get(key)
        if (existing) {
            existing.push(result)
        } else {
            groups.set(key, [result])
            order.push(key)
        }
    })

    return order.map(key => {
        const members = groups.get(key)!
        const anilistId = members.find(m => typeof m.anilistId === "number")?.anilistId
        const meta = typeof anilistId === "number" ? opts.metadataByAnilistId?.get(anilistId) : undefined
        const fallback = bestMember(members)
        const title = meta?.title ?? fallback.title ?? ""
        const coverUrl = meta?.coverUrl ?? fallback.coverUrl
        return {
            key,
            ...(typeof anilistId === "number" ? { anilistId } : {}),
            title,
            ...(coverUrl ? { coverUrl } : {}),
            best: fallback,
            members
        }
    })
}
