// The chapter number an address names, read from a "chapter" keyword in its path. A series slug can
// itself start with a number ("/chapter/29-sai-.../chapter-44.2", "/chapter/1-2-prince/chapter-30-finale"),
// so the LAST path segment that names a chapter decides, never an earlier one. Within that segment a
// number that runs straight into a word ("chapter-1-the-beginning") is used only when nothing cleaner is
// there. The query string is not read here: query parameters have their own pattern at the call site,
// and a referrer-style "?from=chapter-11" must not override the path.
const CHAPTER_IN_SEGMENT = /(?<!\p{L})chapter[-_ ]?(\d+(?:\.\d+)?)/giu
const RUNS_INTO_WORD = /^[-_ ]?\p{L}/u
const KEYWORD_SEGMENT = /^chapter$/iu

function numberInSegment(text: string): string | undefined {
    let clean: string | undefined
    let loose: string | undefined
    for (const match of text.matchAll(CHAPTER_IN_SEGMENT)) {
        const digits = match[1]
        if (digits === undefined) continue
        const after = text.slice((match.index ?? 0) + match[0].length)
        loose = digits
        if (!RUNS_INTO_WORD.test(after)) clean = digits
    }
    return clean ?? loose
}

export function chapterNumberInPath(address: string): number | undefined {
    const segments = (address.split(/[?#]/u)[0] ?? "").split("/")
    for (let i = segments.length - 1; i >= 0; i -= 1) {
        const segment = segments[i] ?? ""
        // "/chapter/129": the keyword is its own segment and the number is the next one.
        const text = KEYWORD_SEGMENT.test(segment) ? `chapter-${segments[i + 1] ?? ""}` : segment
        const picked = numberInSegment(text)
        if (picked !== undefined) return Number(picked)
    }
    return undefined
}
