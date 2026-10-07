import seedJson from "../../sources/migration-seed.json"
import { describe, expect, it } from "vitest"
import { MAX_REGEX_LENGTH, parseProfile, regexComplexityIssue } from "./profile-schema"

const base = {
    profileFormat: 2,
    id: "reader-example",
    name: "Reader Example",
    engine: "generic",
    origin: "https://reader.example",
    domains: ["reader.example"],
    languages: ["en"],
    capabilities: ["chapters", "manga"],
    requestRateLimit: { requests: 3, intervalMs: 1000 },
    origins: ["https://reader.example/*"],
    match: { manga: "^/manga/([^/]+)/?$" },
    series: { titlePattern: "<title>(?<title>[^<]+)</title>" }
}

describe("regexComplexityIssue", () => {
    it.each(["(a+)+$", "(a*)*", "(?:x+)*y", "((a+)b)+", "(\\d+)+", "(a+){2,}", "(?<n>[a-z]+)*", "(?:/[^x]+)*"])(
        "rejects nested quantifier %s",
        pattern => {
            expect(regexComplexityIssue(pattern)).toMatch(/nested/)
        }
    )

    it.each([
        "(a+){1,3}",
        "(a+){1,40}$",
        "(.*a){8}$",
        "((a+)b){2}",
        "(?:\\d+\\.){1,3}x",
        "(a{1,5})+",
        "((a|b)c)+",
        "((a|b)?c)*"
    ])("rejects a repeated group that contains another repeat or an alternation %s", pattern => {
        expect(regexComplexityIssue(pattern)).toBeDefined()
    })

    it.each(["(a|aa)+$", "(a|a)+$", "(.|\\s)*x", "(\\w|\\d)+$", "(?:a|b){2,}", "(x|y)*z", "(?:ab|a){1,40}$"])(
        "rejects an alternation inside a repeated group %s",
        pattern => {
            expect(regexComplexityIssue(pattern)).toMatch(/alternation/)
        }
    )

    it.each([".*.*.*.*x", ".*.*.*x", ".+.+.+x", ".*?.*?.*?x", "\\s*\\s*\\s*x", "[^/]*[^/]*[^/]+x", ".{2,}.*.*x"])(
        "rejects three or more chained unbounded repeats %s",
        pattern => {
            expect(regexComplexityIssue(pattern)).toMatch(/chained/)
        }
    )

    it("rejects each measured catastrophic pattern through the profile schema", () => {
        for (const pattern of [
            "(a|aa)+$",
            "(a|a)+$",
            "(.|\\s)*x",
            "(\\w|\\d)+$",
            "(a+){1,40}$",
            "(.*a){8}$",
            ".*.*.*.*x"
        ]) {
            expect(parseProfile({ ...base, series: { titlePattern: pattern } }).ok).toBe(false)
        }
    })

    it.each(["(a)\\1", "(?<n>a)\\k<n>", "(.)(.)\\2"])("rejects backreference %s", pattern => {
        expect(regexComplexityIssue(pattern)).toMatch(/backreference/)
    })

    it.each([
        "^/manga/([a-z0-9-]+)/?$",
        'href="(?<chapterUrl>/manga/[a-z0-9-]+/ch-(?<chapterNumber>[0-9.]+))"',
        "(?:https?:)?//[^\"'/]+",
        "(a+)?",
        "(a|b)?",
        "(?:a|b)c",
        "(?:ab)+",
        "(?:-(\\d+))?",
        "\\s*,?\\s*",
        ".*a.*b",
        "[(+]+",
        "\\(a+\\)+",
        "{slug}",
        "^(?:/[^/]+)*?/title/([0-9a-f]+)(?:/|$)"
    ])("accepts the ordinary pattern %s", pattern => {
        expect(regexComplexityIssue(pattern)).toBeUndefined()
    })
})

describe("profile regex limits", () => {
    function withTitlePattern(titlePattern: string) {
        return parseProfile({ ...base, series: { titlePattern } })
    }

    it("accepts a normal profile", () => {
        expect(parseProfile(base).ok).toBe(true)
    })

    it("rejects a catastrophic-backtracking regex", () => {
        expect(withTitlePattern("(a+)+$").ok).toBe(false)
        const result = withTitlePattern("(a+)+$")
        expect(!result.ok && result.error).toMatch(/too complex/)
    })

    it("rejects a regex backreference", () => {
        expect(withTitlePattern("(a)\\1").ok).toBe(false)
    })

    it("rejects a regex over the length cap", () => {
        expect(withTitlePattern("a".repeat(MAX_REGEX_LENGTH + 1)).ok).toBe(false)
        expect(withTitlePattern("a".repeat(MAX_REGEX_LENGTH)).ok).toBe(true)
    })

    it("applies to every regex field, including list and match", () => {
        expect(parseProfile({ ...base, match: { manga: "(a+)+" } }).ok).toBe(false)
        expect(parseProfile({ ...base, list: { itemPattern: "(?<chapterUrl>(x*)*)" } }).ok).toBe(false)
    })

    it("still accepts every committed migration-seed profile", () => {
        const profiles = (seedJson as { profiles: unknown[] }).profiles
        expect(profiles.length).toBeGreaterThan(0)
        for (const raw of profiles) {
            const parsed = parseProfile(raw)
            expect(parsed.ok, JSON.stringify((raw as { id?: string }).id)).toBe(true)
        }
    })
})
