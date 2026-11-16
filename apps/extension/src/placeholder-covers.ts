// Covers a site served in place of the real one: a lazy-load spinner, a 1x1 spacer, an inline SVG
// loader. A site sends the same placeholder for every title it has no art for, so one image shared by
// titles with different names is a placeholder even when its address looks ordinary.

import { isAnimatedBlob } from "./animated-image"

type CoverRow = { id: string; title: string; coverUrl?: string | undefined }

const PLACEHOLDER_FILE = /^(1x1|blank|spacer|placeholder|loading|loader|spinner|lazy|default|no-?image|no-?cover)$/i

export function isPlaceholderCoverUrl(url: string | undefined): boolean {
    if (!url) return false
    if (/^data:image\/svg/i.test(url)) return true
    const path = url.split(/[?#]/)[0] ?? url
    const file = (path.split("/").pop() ?? "").replace(/\.[a-z0-9]+$/i, "")
    return PLACEHOLDER_FILE.test(file) || /^\d{1,3}x\d{1,3}$/.test(file)
}

const titleKey = (title: string) => title.toLocaleLowerCase("en").replace(/\s+/g, " ").trim()

// Ids whose key is shared with a title of a different name. Rows of one title on two sources share
// art legitimately and keep it.
function sharedAcrossTitles<T>(
    rows: readonly T[],
    keyOf: (row: T) => string | undefined,
    idOf: (row: T) => string,
    titleOf: (row: T) => string
): Set<string> {
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
        if (new Set(group.map(row => titleKey(titleOf(row)))).size < 2) continue
        for (const row of group) out.add(idOf(row))
    }
    return out
}

export function placeholderCoverIds(rows: readonly CoverRow[]): Set<string> {
    const out = sharedAcrossTitles(
        rows,
        row => row.coverUrl || undefined,
        row => row.id,
        row => row.title
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
export async function placeholderBlobIds(
    rows: ReadonlyArray<{ id: string; title: string; blob: Blob }>
): Promise<Set<string>> {
    const bySize = new Map<number, Array<{ id: string; title: string; blob: Blob }>>()
    for (const row of rows) {
        const group = bySize.get(row.blob.size)
        if (group) group.push(row)
        else bySize.set(row.blob.size, [row])
    }
    const hashed: Array<{ id: string; title: string; digest: string }> = []
    for (const group of bySize.values()) {
        if (group.length < 2 || new Set(group.map(row => titleKey(row.title))).size < 2) continue
        for (const row of group) hashed.push({ id: row.id, title: row.title, digest: await digestOf(row.blob) })
    }
    const out = sharedAcrossTitles(
        hashed,
        row => row.digest,
        row => row.id,
        row => row.title
    )
    for (const row of rows) if (!out.has(row.id) && (await isAnimatedBlob(row.blob))) out.add(row.id)
    return out
}
