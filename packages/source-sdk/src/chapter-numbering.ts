// Shared chapter-number / sortKey helpers for source adapters.
//
// Background - the "sortKey 0" bug class this module closes:
// An unparseable, oneshot, or missing chapter number used to default to
// `sortKey: 0` (via `parseFloat(x) || 0`, `?? 0`, or `: 0`). That is wrong two
// ways at once: 0 sorts BEFORE "Chapter 1", and downstream `Number.isFinite`
// progress guards treat 0 as a real number, so a bogus 0 clobbers stored reading
// progress. The codebase standardized on Number.POSITIVE_INFINITY as the "no
// number" sentinel; these helpers make that the only path.
//
// Contract:
//  - `parseChapterNumber` NEVER returns 0 for unparseable input (returns
//    undefined). A literal "0" input returns 0 - sortKey 0 may ONLY ever mean a
//    genuine "Chapter 0".
//  - In a LIST context an unnumbered chapter interpolates between its numbered
//    neighbours: `lastRealKey + unparsedRun / 1000`, walking the list in
//    chronological (oldest-first) order. `assignListSortKeys` does this; the
//    caller declares the document `order` so the walk is deterministic instead of
//    guessed per-page.
//  - In the SINGLE-chapter context (resolveChapter, with no surrounding list to
//    interpolate a position from) the caller uses `UNNUMBERED_SORT_KEY` so an
//    unnumbered chapter sorts to the END of the list rather than before every
//    real chapter.

// The "no parseable number" sentinel. An unnumbered single chapter sorts last,
// never before Chapter 1, and never collides with real reading progress.
export const UNNUMBERED_SORT_KEY = Number.POSITIVE_INFINITY

// Parse a chapter number out of an already-isolated numeric string (e.g. "12",
// "1.5", "0"). Returns undefined for null/undefined/empty/non-numeric input -
// crucially it NEVER coerces unparseable input to 0. A literal "0" returns 0.
export function parseChapterNumber(raw: string | null | undefined): number | undefined {
    if (raw === null || raw === undefined) return undefined
    const parsed = Number.parseFloat(raw)
    return Number.isFinite(parsed) ? parsed : undefined
}

// A bare integer at or above this is an internal database id, never a chapter number: no real series
// reaches 100_000 chapters. Mirrors the MangaHub internal-id floor used when tracking external chapters.
export const OPAQUE_ID_MIN = 100_000

export type ChapterLabelKind = "chapter" | "volume" | "season" | "unreliable"

export type ChapterLabel = { number?: number; kind: ChapterLabelKind; raw: string }

const LABEL_NUMBER = "(\\d{1,20}(?:\\.\\d{1,4})?)"
const VOLUME_LABEL = new RegExp(`\\bvol(?:ume)?\\.?\\s*${LABEL_NUMBER}`, "iu")
const SEASON_LABEL = new RegExp(`(?<![\\p{L}\\p{N}])s(?:eason)?\\s*(\\d{1,3})\\s*[e\\u00b7x]\\s*${LABEL_NUMBER}`, "iu")
const CHAPTER_LABEL = new RegExp(`(?:\\b(?:chapter|chap|ch|episode|ep|issue|no)\\b|#)\\s*\\.?\\s*${LABEL_NUMBER}`, "iu")
const LEADING_NUMBER = new RegExp(`^\\s*${LABEL_NUMBER}(?![\\p{L}\\p{N}])`, "u")
const TRAILING_NUMBER = new RegExp(`(?<![\\p{L}\\p{N}.])${LABEL_NUMBER}\\s*$`, "u")
const MAX_LABEL_LENGTH = 200

// Extract a chapter number and its kind from human-visible text (a link label, a page title, a
// dropdown entry): "Ch. 86", "Chapter 70", "Episode 12", "#86", "Vol. 3", "S2E5". Text-derived numbers
// are what a site shows the reader, so this is the right source when the URL carries only an internal
// id. First match wins, in the order volume, season-episode, labelled chapter, bare leading/trailing
// number. A bare integer at or above OPAQUE_ID_MIN with no label is an id, reported as "unreliable"
// with no number. Never coerces to 0: a literal "0" is a real Chapter 0, anything unparseable has no
// number.
export function parseChapterLabel(text: string): ChapterLabel {
    const raw = text
    const input = text.slice(0, MAX_LABEL_LENGTH)
    const result = (kind: ChapterLabelKind, captured: string | undefined): ChapterLabel => {
        const number = parseChapterNumber(captured)
        if (number === undefined || number >= OPAQUE_ID_MIN) return { kind: "unreliable", raw }
        return { number, kind, raw }
    }

    const volume = VOLUME_LABEL.exec(input)
    if (volume) return result("volume", volume[1])
    const season = SEASON_LABEL.exec(input)
    if (season) return result("season", season[2])
    const chapter = CHAPTER_LABEL.exec(input)
    if (chapter) return result("chapter", chapter[1])
    const bare = LEADING_NUMBER.exec(input) ?? TRAILING_NUMBER.exec(input)
    if (bare) return result("chapter", bare[1])
    return { kind: "chapter", raw }
}

// Assign a sortKey to every item in a scraped chapter list, interpolating a
// position for unnumbered entries (bonus/extra/oneshot) between their numbered
// neighbours instead of collapsing them to 0.
//
// `order` declares the document order the list is in:
//   - "newest-first"  the page lists the newest chapter first (descending number)
//   - "oldest-first"  the page lists Chapter 1 first (ascending number)
// The walk always proceeds chronologically (oldest -> newest) so an unnumbered
// run gets `lastRealKey + n/1000`, keeping it sandwiched between the real
// chapters it sits next to regardless of how the page happens to order rows.
//
// Returns an array of sortKeys parallel to `items` (result[i] belongs to
// items[i]), so the caller keeps its own document order untouched.
export function assignListSortKeys<T>(
    items: readonly T[],
    getNumber: (item: T) => number | undefined,
    order: "newest-first" | "oldest-first"
): number[] {
    const indices = [...items.keys()]
    const chronological = order === "newest-first" ? indices.reverse() : indices

    const sortKeys = new Array<number>(items.length)
    let lastRealKey: number | undefined = undefined
    let unparsedRun = 0
    // Unnumbered entries seen BEFORE the first real chapter can't interpolate off a
    // preceding key, so they're held until the first real key is known and then
    // placed just below it. A `lastRealKey + n/1000` here would put a Prologue ABOVE
    // Chapter 0 (0.001 > 0); a negative epsilon off the first real key keeps it below.
    const leading: number[] = []
    for (const index of chronological) {
        const number = getNumber(items[index] as T)
        if (number !== undefined && Number.isFinite(number)) {
            if (lastRealKey === undefined && leading.length > 0) {
                const n = leading.length
                leading.forEach((idx, j) => {
                    sortKeys[idx] = number - (n - j) / 1000
                })
                leading.length = 0
            }
            sortKeys[index] = number
            lastRealKey = number
            unparsedRun = 0
        } else if (lastRealKey === undefined) {
            leading.push(index)
        } else {
            unparsedRun += 1
            sortKeys[index] = lastRealKey + unparsedRun / 1000
        }
    }
    // No real chapter ever appeared: fall back to a strictly increasing 0.001, 0.002…
    // run so nothing collapses to a bare 0.
    leading.forEach((idx, j) => {
        sortKeys[idx] = (j + 1) / 1000
    })
    return sortKeys
}

// True when a sortKey is a genuinely parsed chapter number rather than the
// UNNUMBERED_SORT_KEY sentinel (or a stray null/undefined/NaN). Ordering is exempt
// from this check - unnumbered chapters sorting last via Infinity is correct - but
// every AGGREGATION or COMPARISON over sortKey ("which chapter is latest", "is this
// newer than X") must filter to finite first, or Infinity (the maximum of the numeric
// domain) makes "unknown" win the contest.
export const isNumberedChapter = (sortKey: number | null | undefined): sortKey is number =>
    typeof sortKey === "number" && Number.isFinite(sortKey)

// Highest finite sortKey among `chapters`, ignoring unnumbered ones entirely - the
// finite-filtering counterpart to a plain `Math.max(...chapters.map(c => c.sortKey))`
// or a `reduce` keyed on `>`, either of which lets a single UNNUMBERED_SORT_KEY chapter
// win the aggregation.
//
// Returns undefined when nothing in `chapters` is numbered - a meaningful result, not
// an error. Callers must SKIP the latest-chapter write they were about to make rather
// than falling back to the first chapter or to the unnumbered one.
export function latestNumberedChapter<T extends { sortKey: number }>(chapters: readonly T[]): T | undefined {
    let best: T | undefined
    for (const chapter of chapters) {
        if (!isNumberedChapter(chapter.sortKey)) continue
        if (best === undefined || chapter.sortKey > best.sortKey) best = chapter
    }
    return best
}
