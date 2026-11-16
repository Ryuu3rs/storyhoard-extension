/// <reference types="node" />
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// Meta-guards: static assertions over the adapter source files themselves that
// permanently close two recurring bug classes. These do not exercise any adapter
// at runtime - they read the .ts files and assert the dangerous patterns are gone.

const SRC_DIR = dirname(fileURLToPath(import.meta.url))

// Adapter source files: every src/*.ts except this file, other tests, the
// __fixtures__ dir, and the package barrel. Tests/fixtures are excluded because
// they legitimately mention the bad patterns in comments/strings as documentation.
function adapterSourceFiles(): string[] {
    return readdirSync(SRC_DIR)
        .filter(name => name.endsWith(".ts"))
        .filter(name => !name.endsWith(".test.ts") && name !== "index.ts")
        .map(name => join(SRC_DIR, name))
}

// Scanning is line-by-line and raw (no comment stripping): a `[...]` char class
// and a `sortKey:` literal are single-line constructs, so a per-line scan needs
// no multi-line reasoning. Naive comment stripping is actively unsound here - the
// `*/*` in every adapter's Accept header reads as an opening `/*` block comment
// and would swallow real code. Test files are excluded (see adapterSourceFiles),
// so the only place these patterns are mentioned in prose - the regression-corpus
// comments in *.test.ts - never reaches this scan.

// ---- Class 4: malformed `[--|]` regex character class -----------------------
//
// `[--|]` parses as a code-point RANGE from "-" (0x2D) to "|" (0x7C), matching
// every digit, uppercase letter and assorted punctuation, NOT the intended
// alternation of "-" or "|". The signature is two consecutive unescaped hyphens
// inside a `[...]` character class. A correct class never needs that (a literal
// hyphen goes at the class boundary or is written once).

// Returns the offending char-class snippets found in `source`.
function findDoubleHyphenCharClasses(source: string): string[] {
    const hits: string[] = []
    // Match a `[...]` bracket expression, honouring escaped chars and an optional
    // leading `^`. Content that contains an unescaped `--` is a range bug.
    const classRe = /\[\^?((?:\\.|[^\]\\])*)\]/g
    for (const line of source.split(/\r?\n/)) {
        for (const m of line.matchAll(classRe)) {
            const content = m[1] ?? ""
            if (/(?:^|[^\\])--/.test(content)) hits.push(m[0])
        }
    }
    return hits
}

// ---- Class 1: `sortKey: 0` literal ------------------------------------------
//
// A literal `sortKey: 0` outside a genuine "Chapter 0" is the old bug: 0 sorts
// before Chapter 1 and clobbers reading progress. sortKey must come from
// parseChapterNumber / assignListSortKeys / UNNUMBERED_SORT_KEY.
function findSortKeyZeroLiterals(source: string): string[] {
    return [...source.matchAll(/\bsortKey\s*:\s*0\b(?!\.)/g)].map(m => m[0])
}

describe("meta-guard: the detectors fire on a known-bad pattern", () => {
    it("flags a `[--|]` range character class", () => {
        expect(findDoubleHyphenCharClasses(String.raw`const re = /\s+[--|]\s+/`)).toEqual([String.raw`[--|]`])
        expect(findDoubleHyphenCharClasses(String.raw`const re = /[a--z]/`)).toEqual([String.raw`[a--z]`])
    })

    it("does not flag a well-formed class with a boundary hyphen or an escaped range", () => {
        expect(findDoubleHyphenCharClasses(String.raw`/\s+[-|-]\s+/`)).toEqual([])
        expect(findDoubleHyphenCharClasses(String.raw`/[a-z0-9_-]/`)).toEqual([])
        // The `<!--`/`-->` HTML-comment regex (mangahub) is outside any char class.
        expect(findDoubleHyphenCharClasses(String.raw`/#(?:<!--\s*-->)?\s*(\d+)/`)).toEqual([])
        // A decrement is not a char class.
        expect(findDoubleHyphenCharClasses("depth--")).toEqual([])
    })

    it("flags a literal `sortKey: 0`", () => {
        expect(findSortKeyZeroLiterals("return { sortKey: 0, language }")).toEqual(["sortKey: 0"])
    })

    it("does not flag a non-zero or computed sortKey", () => {
        expect(findSortKeyZeroLiterals("sortKey: parseChapterNumber(n) ?? UNNUMBERED_SORT_KEY")).toEqual([])
        expect(findSortKeyZeroLiterals("sortKey: 1")).toEqual([])
        expect(findSortKeyZeroLiterals("sortKey: 0.5")).toEqual([])
    })
})

describe("meta-guard: adapter sources are clean", () => {
    const files = adapterSourceFiles()

    it("finds adapter source files to scan", () => {
        expect(files.length).toBeGreaterThanOrEqual(2)
    })

    it("has no `[--|]`-style range character class in any adapter regex (class 4)", () => {
        const offenders: Record<string, string[]> = {}
        for (const file of files) {
            const hits = findDoubleHyphenCharClasses(readFileSync(file, "utf8"))
            if (hits.length > 0) offenders[file] = hits
        }
        expect(offenders).toEqual({})
    })

    it("has no literal `sortKey: 0` outside test files (class 1)", () => {
        const offenders: Record<string, string[]> = {}
        for (const file of files) {
            const hits = findSortKeyZeroLiterals(readFileSync(file, "utf8"))
            if (hits.length > 0) offenders[file] = hits
        }
        expect(offenders).toEqual({})
    })
})
