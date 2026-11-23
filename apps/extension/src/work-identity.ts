import { normalizeTitle } from "@amr/normalize"

// The logical-title identity layer. A "work" is one series that may exist as several source
// versions. There is no single canonical id across sources, so the key is an anchor ladder:
// the server-authoritative workId when the row has synced, else the AniList id, else a strict
// normalized-title key. All surfaces (library grouping, search grouping, ranker) key off this
// one function so grouping is consistent everywhere.

// Canonical title key for a title with no stronger anchor. Stricter than the stored
// normalizedTitle: strips punctuation as well as folding case/whitespace, so "Re:Zero" and
// "Re Zero" collapse. Unicode letters/numbers are kept so non-Latin titles survive. NFC first so a
// decomposed accent keys the same as its composed form. A missing/symbol-only title yields "" so
// the caller can give that row its own key instead of merging every title-less row together.
// Matching is exact-equality only (never substring) so distinct works stay apart.
export function titleKey(title: string | undefined): string {
    return normalizeTitle((title ?? "").normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, " "))
}

// The grouping key for a library/search row. workId > anilistId > titleKey. When the row has no
// anchor and no usable title, falls back to a per-row key built from fallbackId so unrelated
// title-less rows never collapse into one work.
export function workKeyOf(
    m: { workId?: string | undefined; anilistId?: number | undefined; title?: string | undefined },
    fallbackId?: string
): string {
    if (m.workId) return `work:${m.workId}`
    if (typeof m.anilistId === "number") return `anilist:${m.anilistId}`
    const tk = titleKey(m.title)
    if (tk) return `title:${tk}`
    return fallbackId ? `id:${fallbackId}` : ""
}

// A weeb.ltd catalog Work id, as the catalog and the sync contract (C4) hand it out.
export const WORK_ID = /^[A-Za-z0-9_-]{1,100}$/

export const isWorkId = (value: unknown): value is string => typeof value === "string" && WORK_ID.test(value)

// A title added from the catalog by its Work id alone, before AniList or any of the user's sites has it.
// The row id carries the Work id, so the row is rebuilt the same way on every device it syncs to.
export const WORK_SOURCE_ID = "weeb.ltd"
const WORK_ROW_PREFIX = "weeb:work:"

export const workRowId = (workId: string): string => `${WORK_ROW_PREFIX}${workId}`
export const workRowUrl = (workId: string): string => `amr:work:${workId}`

export function workIdOfRowId(id: string): string | undefined {
    if (!id.startsWith(WORK_ROW_PREFIX)) return undefined
    const workId = id.slice(WORK_ROW_PREFIX.length)
    return isWorkId(workId) ? workId : undefined
}
