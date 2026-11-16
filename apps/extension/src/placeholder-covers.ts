// Covers a site served in place of the real one: a lazy-load spinner, a 1x1 spacer, an inline SVG
// loader. A site sends the same placeholder for every title it has no art for, so one image shared by
// different works is a placeholder even when its address looks ordinary.

import { normalizeTitle } from "@amr/normalize"
import { SITE_BASE } from "./account"
import { isAnimatedBlob } from "./animated-image"

type CoverRow = {
    id: string
    title: string
    coverUrl?: string | undefined
    anilistId?: number | undefined
    workId?: string | undefined
}

const PLACEHOLDER_FILE = /^(1x1|blank|spacer|placeholder|loading|loader|spinner|lazy|default|no-?image|no-?cover)$/i

export function isPlaceholderCoverUrl(url: string | undefined): boolean {
    if (!url) return false
    if (/^data:image\/svg/i.test(url)) return true
    const path = url.split(/[?#]/)[0] ?? url
    const file = (path.split("/").pop() ?? "").replace(/\.[a-z0-9]+$/i, "")
    return PLACEHOLDER_FILE.test(file) || /^\d{1,3}x\d{1,3}$/.test(file)
}

// The metadata catalogs and weeb.ltd serve one cover per work, never a site's stand-in image, so a
// cover from them that several entries share is the same work's art.
function catalogCoverHosts(): string[] {
    const hosts = ["anilist.co", "myanimelist.net", "weeb.ltd"]
    try {
        hosts.push(new URL(SITE_BASE).hostname)
    } catch {
        // A malformed dev override leaves the built-in hosts.
    }
    return hosts
}

export function isCatalogCoverUrl(url: string | undefined): boolean {
    if (!url) return false
    let host: string
    try {
        host = new URL(url).hostname.toLowerCase()
    } catch {
        return false
    }
    return catalogCoverHosts().some(known => host === known || host.endsWith(`.${known}`))
}

function workKeys(row: CoverRow): string[] {
    const keys = [`title:${normalizeTitle(row.title)}`]
    if (row.anilistId !== undefined) keys.push(`anilist:${row.anilistId}`)
    if (row.workId) keys.push(`work:${row.workId}`)
    return keys
}

// How many works the rows stand for. One work is often tracked under two names (an English and a
// romaji title on different sites), so rows sharing a name, an AniList id or a work id, directly or
// through another row, count once.
function distinctWorks(rows: readonly CoverRow[]): number {
    const parent = rows.map((_, i) => i)
    const find = (i: number): number => {
        let root = i
        while (parent[root] !== root) root = parent[root]!
        return root
    }
    const owner = new Map<string, number>()
    rows.forEach((row, i) => {
        for (const key of workKeys(row)) {
            const first = owner.get(key)
            if (first === undefined) owner.set(key, i)
            else parent[find(i)] = find(first)
        }
    })
    return new Set(rows.map((_, i) => find(i))).size
}

// Ids whose key is shared by more than one work. Entries of one work share art legitimately and keep it.
function sharedAcrossWorks<T extends CoverRow>(rows: readonly T[], keyOf: (row: T) => string | undefined): Set<string> {
    const groups = new Map<string, T[]>()
    for (const row of rows) {
        const key = keyOf(row)
        if (key === undefined) continue
        const group = groups.get(key)
        if (group) group.push(row)
        else groups.set(key, [row])
    }
    const out = new Set<string>()
    for (const group of groups.values()) {
        if (distinctWorks(group) < 2) continue
        for (const row of group) out.add(row.id)
    }
    return out
}

export function placeholderCoverIds(rows: readonly CoverRow[]): Set<string> {
    const out = sharedAcrossWorks(rows, row =>
        row.coverUrl && !isCatalogCoverUrl(row.coverUrl) ? row.coverUrl : undefined
    )
    for (const row of rows) if (isPlaceholderCoverUrl(row.coverUrl)) out.add(row.id)
    return out
}

async function digestOf(blob: Blob): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("")
}

// The same check over cached images, for a placeholder whose address differed per title. Only blobs
// of equal size are hashed. An animated image is a loading animation on its own (see animated-image.ts).
export async function placeholderBlobIds(rows: ReadonlyArray<CoverRow & { blob: Blob }>): Promise<Set<string>> {
    const bySize = new Map<number, Array<CoverRow & { blob: Blob }>>()
    for (const row of rows) {
        if (isCatalogCoverUrl(row.coverUrl)) continue
        const group = bySize.get(row.blob.size)
        if (group) group.push(row)
        else bySize.set(row.blob.size, [row])
    }
    const hashed: Array<CoverRow & { digest: string }> = []
    for (const group of bySize.values()) {
        if (group.length < 2 || distinctWorks(group) < 2) continue
        for (const { blob, ...row } of group) hashed.push({ ...row, digest: await digestOf(blob) })
    }
    const out = sharedAcrossWorks(hashed, row => row.digest)
    for (const row of rows) if (!out.has(row.id) && (await isAnimatedBlob(row.blob))) out.add(row.id)
    return out
}
