import { sanitizePageText } from "@amr/source-sdk"

export { MAX_PAGE_TITLE_LENGTH, sanitizePageText } from "@amr/source-sdk"

// Two spellings of one name (another case, or accents composed differently) share a key.
const repeatKey = (name: string): string => name.normalize("NFKC").toLocaleLowerCase("en")

// A list of page or server text: each entry cleaned and capped, blanks and repeats dropped.
export function sanitizeTextList(value: unknown, max: number, each: number, exclude: readonly string[] = []): string[] {
    if (!Array.isArray(value)) return []
    const seen = new Set(exclude.map(repeatKey))
    const out: string[] = []
    for (const raw of value) {
        const name = sanitizePageText(raw, each)
        if (!name) continue
        const key = repeatKey(name)
        if (seen.has(key)) continue
        seen.add(key)
        out.push(name)
        if (out.length >= max) break
    }
    return out
}
