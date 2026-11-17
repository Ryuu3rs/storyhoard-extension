// The chapter number an address names, read from a "chapter" keyword in its path. A series slug can
// itself start with a number ("/chapter/29-sai-.../chapter-44.2", "/chapter/1-2-prince/chapter-30-finale"),
// so the LAST path segment that names a chapter decides, never an earlier one. Within that segment a
// number that runs straight into a word ("chapter-1-the-beginning") is used only when nothing cleaner is
// there. The query string is not read here: query parameters have their own pattern at the call site,
// and a referrer-style "?from=chapter-11" must not override the path.
const CHAPTER_IN_SEGMENT = /(?<!\p{L})chapter[-_ ]?(\d+(?:\.\d+)?)/giu
const RUNS_INTO_WORD = /^[-_ ]?\p{L}/u
const KEYWORD_SEGMENT = /^chapter$/iu
// After a bare "/chapter/" the next segment is the chapter's number, or an opaque id the site gave it
// ("5e8a1b2c9d0f", a uuid) that only happens to start with a digit. A number may carry any non-word
// suffix ("12.html", "12.5.php", "12(1)", "12%20end"); digits running straight into a letter do not count.
const NUMBER_SEGMENT = /^(\d+(?:\.\d+)?)(?![\p{L}\d])/u
const HEX_ID_SEGMENT = /^(?=[\da-f-]*[a-f])[\da-f]{8,}(?:-[\da-f]+)*$/iu

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
        if (KEYWORD_SEGMENT.test(segment)) {
            const next = segments[i + 1] ?? ""
            if (HEX_ID_SEGMENT.test(next)) return undefined
            const digits = NUMBER_SEGMENT.exec(next)?.[1]
            if (digits !== undefined) return Number(digits)
            continue
        }
        const picked = numberInSegment(segment)
        if (picked !== undefined) return Number(picked)
    }
    return undefined
}
