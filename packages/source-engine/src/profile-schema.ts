// ARCHITECTURE TRACK A - experimental.
//
// The user-supplied Site Profile format. A profile is DATA, interpreted by the generic
// engine (create-adapter-from-profile.ts) into a SourceAdapter. Design rules baked in here,
// straight from the council review:
//
//   * Deny-by-default: every object is `.strict()`, so an unknown field is REJECTED, never
//     ignored. A poisoned profile cannot carry a field we did not plan for. (council S6/B2)
//   * NO circumvention primitives. There is deliberately no "signatures" / token-recipe /
//     anti-scrape-nonce field, and no DRM or challenge-bypass hook. A site that needs a
//     circumvention token to be read is simply INEXPRESSIBLE in this format, by design.
//     (council hard-ban B1 - this is also the DMCA 1201 line; do not add it back.)
//   * Capped DSL: the only behaviours a profile can express are regex extraction + closed
//     template interpolation. No arbitrary code, no branching, no arithmetic. Keeping the
//     format reviewer-legible is the whole legal point; do not grow it into code-in-JSON.
//     (council A2)
//
// Format version is a single integer; the engine refuses an unknown major.

import { z } from "zod"

export const MAX_REGEX_LENGTH = 1000

// `/[^/]+` or `?:/[^/]+` (a group body): one literal delimiter followed by a negated class that
// excludes that same delimiter. Repeating it is safe: every iteration must consume its own
// delimiter, so there is only one way to split the input. This is the shape the migration seed uses
// for "any number of leading path segments", so the nested-quantifier screen below exempts it.
const DELIMITED_REPEAT = /^(?:\?:)?(\\?[^\\.*+?^$|()[\]{}])\[\^((?:\\.|[^\]\\])*)\][+*]$/

function isDelimitedRepeat(body: string): boolean {
    const m = DELIMITED_REPEAT.exec(body)
    if (!m) return false
    const literal = m[1]!.replace(/^\\/, "")
    return (m[2] ?? "").replace(/\\(.)/g, "$1").includes(literal)
}

// Conservative ReDoS screen for a profile regex. A profile is untrusted data (it can arrive via a
// backup restore or a sync pull) and its regexes run in the background worker, so a catastrophic
// pattern would freeze it. Rejects the two shapes that make backtracking blow up without any need
// for a real regex analyser:
//   * a quantified group that itself contains an unbounded quantifier: `(a+)+`, `(a*)*`, `(?:x+)*`
//   * backreferences (`\1`, `\k<name>`), which defeat linear-time reasoning
// It is a heuristic, not a proof: it will not catch every ambiguous alternation such as `(a|aa)+`,
// and it errs towards rejecting. The length cap and the per-page match cap bound the rest.
export function regexComplexityIssue(source: string): string | undefined {
    const unboundedBrace = /^\{\d+,\}/
    const groups: Array<{ unbounded: boolean; start: number }> = []
    let inClass = false
    let afterRiskyGroup = false
    for (let i = 0; i < source.length; i++) {
        const ch = source[i]!
        if (ch === "\\") {
            const next = source[i + 1]
            if (!inClass && next !== undefined) {
                if (/[1-9]/.test(next)) return "backreferences are not allowed"
                if (next === "k" && source[i + 2] === "<") return "backreferences are not allowed"
            }
            i++
            afterRiskyGroup = false
            continue
        }
        if (inClass) {
            if (ch === "]") inClass = false
            continue
        }
        if (ch === "[") {
            inClass = true
            afterRiskyGroup = false
            continue
        }
        if (ch === "(") {
            groups.push({ unbounded: false, start: i + 1 })
            afterRiskyGroup = false
            continue
        }
        if (ch === ")") {
            const closed = groups.pop()
            const parent = groups[groups.length - 1]
            const risky = !!closed?.unbounded && !isDelimitedRepeat(source.slice(closed.start, i))
            if (risky && parent) parent.unbounded = true
            afterRiskyGroup = risky
            continue
        }
        const braceQuantifier = ch === "{" && unboundedBrace.test(source.slice(i))
        if (ch === "+" || ch === "*" || braceQuantifier) {
            if (afterRiskyGroup) return "nested quantifiers are not allowed"
            const top = groups[groups.length - 1]
            if (top) top.unbounded = true
        }
        afterRiskyGroup = false
    }
    return undefined
}

const regexString = z
    .string()
    .min(1)
    .max(MAX_REGEX_LENGTH)
    .superRefine((value, ctx) => {
        try {
            void new RegExp(value)
        } catch (error) {
            ctx.addIssue({
                code: "custom",
                message: `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`
            })
            return
        }
        const issue = regexComplexityIssue(value)
        if (issue) ctx.addIssue({ code: "custom", message: `Regular expression too complex: ${issue}` })
    })

// A regex that the engine runs with the global flag to pull repeated items (chapters, pages,
// search results). Named capture groups are how a profile labels what it extracted.
const globalRegexString = regexString

const matchSchema = z
    .object({
        manga: regexString,
        chapter: regexString.optional()
    })
    .strict()

const seriesSchema = z
    .object({
        // Template that builds the series page URL from a bare {slug}, so a search result or a
        // chapter URL can resolve back to the series. Optional: when a series URL is already in
        // hand (the user opened it) the engine uses that instead.
        urlTemplate: z.string().min(1).optional(),
        // Capture group 1 (or a named group `title`/`cover`) is the extracted value.
        titlePattern: regexString,
        coverPattern: regexString.optional()
    })
    .strict()

const listSchema = z
    .object({
        // Template for the chapter-list page/endpoint URL, interpolated against {slug}/{page}.
        // When omitted the engine lists from the series page HTML itself.
        urlTemplate: z.string().min(1).optional(),
        // Global regex; must expose named groups `chapterUrl` and `chapterNumber`
        // (and optionally `chapterTitle`).
        itemPattern: globalRegexString,
        // Optional query-param pagination: fetch the list URL with `?{param}=1..maxPages`,
        // accumulating items until a page yields nothing new. For sites whose chapter list
        // spans several pages (e.g. a webtoon with hundreds of episodes).
        pagination: z
            .object({ param: z.string().min(1), maxPages: z.number().int().positive().max(100) })
            .strict()
            .optional()
    })
    .strict()

const pagesSchema = z
    .object({
        // Ordered strategy chain: the engine tries each regex in turn and uses the first that
        // yields page URLs. Mirrors the existing adapters' extract-image fallback ladder.
        imagePatterns: z.array(globalRegexString).min(1),
        // Optional post-filters on the extracted URLs.
        include: regexString.optional(),
        exclude: regexString.optional()
    })
    .strict()

const searchSchema = z
    .object({
        // Interpolated against {query}/{page} only.
        urlTemplate: z.string().min(1),
        // Global regex exposing named groups `url` and `title` (optionally `cover`).
        itemPattern: globalRegexString
    })
    .strict()

export const PROFILE_FORMAT = 1
// Format 2 is the on-site-pivot shape: the shipped engine resolves chapter LISTS (so background
// update-checks keep working) but never extracts page images (the panel reads the user's own
// rendered tab), so `pages` is optional and inert in a shipped build. Format 1 stays accepted so
// an arch-only sideload "Classic reader" (which does render images) keeps working unchanged, and
// so an older binary's own stored profiles still parse. `numberingKind` (format 2) feeds the
// version-ranking pool, matching VersionRecord.numberingKind.
export const PROFILE_FORMAT_2 = 2
export const PROFILE_FORMATS = [PROFILE_FORMAT, PROFILE_FORMAT_2] as const

export const profileSchema = z
    .object({
        profileFormat: z.union([z.literal(PROFILE_FORMAT), z.literal(PROFILE_FORMAT_2)]),
        id: z
            .string()
            .min(1)
            .regex(/^[a-z0-9][a-z0-9.-]*$/, "id must be lowercase slug-like (matches the stored sourceId)"),
        name: z.string().min(1),
        engine: z.literal("generic"),
        // How this source numbers chapters, so the version-ranking pool can compare like with like
        // (a volume-numbered mirror must not be scored against a chapter-numbered one). Optional for
        // format-1 back-compat; format-2 profiles should set it. Defaults to "chapter" downstream.
        numberingKind: z.enum(["chapter", "volume", "season", "unreliable"]).optional(),
        // Base URL the engine resolves relative links against and builds templated URLs from
        // (real sites vary: http vs https, apex vs www, a port). Must be a valid absolute URL.
        origin: z.string().url(),
        domains: z.array(z.string().min(1)).min(1),
        languages: z.array(z.string().min(1)).min(1),
        capabilities: z.array(z.enum(["chapters", "manga", "pages"])).min(1),
        requestRateLimit: z
            .object({ requests: z.number().int().positive(), intervalMs: z.number().int().positive() })
            .strict(),
        // Host-permission patterns this profile needs. The engine + the (future) importer
        // intersect these with what the browser actually granted; the import-time origin-shape
        // policy (council S4) rejects first-party/private/loopback origins - enforced at import,
        // not here.
        origins: z.array(z.string().min(1)).min(1),
        imageOrigins: z.array(z.string().min(1)).optional(),
        match: matchSchema,
        series: seriesSchema,
        // Optional: a RECOGNITION-ONLY profile (match + series, no list) keeps a library row
        // resolving and trackable while the engine lists no chapters for it. Used by the
        // migration seed for sources whose chapter list cannot be expressed as a plain fetch +
        // regex (token / challenge / RSC gated); such a source is tracking-only, never deleted.
        list: listSchema.optional(),
        pages: pagesSchema.optional(),
        search: searchSchema.optional()
    })
    .strict()

export type SiteProfile = z.infer<typeof profileSchema>

export type ProfileParseResult = { ok: true; profile: SiteProfile } | { ok: false; error: string }

// Parse untrusted input into a profile. Returns a result rather than throwing so the importer
// can show a specific, human error. Rejects unknown fields (strict) and unknown format majors.
export function parseProfile(input: unknown): ProfileParseResult {
    const result = profileSchema.safeParse(input)
    if (result.success) return { ok: true, profile: result.data }
    const first = result.error.issues[0]
    const where = first?.path.length ? ` at ${first.path.join(".")}` : ""
    return { ok: false, error: `${first?.message ?? "Invalid profile"}${where}` }
}
