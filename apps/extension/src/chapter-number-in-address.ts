// The chapter number an address names, read from a "chapter" keyword in its path. A series slug can
// itself start with a number ("/chapter/29-sai-.../chapter-44.2"), so the last keyword match wins, and
// a number that runs straight into a word ("29-sai") is only used when no clean match exists at all.
const CHAPTER_IN_PATH = /chapter[-_/ ]?(\d+(?:\.\d+)?)/giu
const RUNS_INTO_WORD = /^[-_ ]?\p{L}/u

export function chapterNumberInPath(path: string): number | undefined {
    let clean: string | undefined
    let loose: string | undefined
    for (const match of path.matchAll(CHAPTER_IN_PATH)) {
        const digits = match[1]
        if (digits === undefined) continue
        const after = path.slice((match.index ?? 0) + match[0].length)
        loose = digits
        if (!RUNS_INTO_WORD.test(after)) clean = digits
    }
    const picked = clean ?? loose
    return picked === undefined ? undefined : Number(picked)
}
