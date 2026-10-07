import { describe, it, expect } from "vitest"
import { formatUpdateFailureLog } from "./updates-failure-log"

const meta = { version: "0.13.0", checkedAt: Date.parse("2026-07-23T00:00:00Z"), checked: 10, updated: 7, failed: 2 }

describe("formatUpdateFailureLog", () => {
    it("renders a header and one line per failed title", () => {
        const log = formatUpdateFailureLog(
            [
                { mangaId: "mangadex:manga:a", title: "Title A", message: "Request failed with status 500" },
                { mangaId: "kagane:manga:b", title: "Title B", message: "blocked" }
            ],
            meta
        )
        expect(log).toContain("StoryHoard update-failure log")
        expect(log).toContain("checked at: 2026-07-23T00:00:00.000Z")
        expect(log).toContain("extension version: 0.13.0")
        expect(log).toContain("checked: 10 | updated: 7 | failed: 2")
        expect(log).toContain("- Title A [mangadex:manga:a]: Request failed with status 500")
        expect(log).toContain("- Title B [kagane:manga:b]: blocked")
        expect(log.split("\n").filter(l => l.startsWith("- "))).toHaveLength(2)
    })

    it("renders a failures-by-source tally sorted worst-first", () => {
        const log = formatUpdateFailureLog([{ mangaId: "asurascans:manga:a", title: "A", message: "404" }], {
            ...meta,
            failuresBySource: { aquamanga: 5, asurascans: 8, flamecomics: 1 }
        })
        expect(log).toContain("failures by source:")
        const tally = log
            .split("\n")
            .filter(l => /^- \w+: \d+$/.test(l))
            .map(l => l.replace(/^- /, ""))
        expect(tally).toEqual(["asurascans: 8", "aquamanga: 5", "flamecomics: 1"])
    })

    it("omits the by-source section when no map is provided", () => {
        const log = formatUpdateFailureLog([{ mangaId: "s:x", title: "A", message: "m" }], meta)
        expect(log).not.toContain("failures by source:")
    })

    it("renders skipped (bot-blocked) sources in their own section, not as failures", () => {
        const log = formatUpdateFailureLog([], {
            ...meta,
            failed: 0,
            skippedSources: { natomanga: 154, otherblocked: 3 }
        })
        expect(log).toContain("skipped (site blocks automated checks, not a failure):")
        expect(log).toContain("- natomanga: 154 title(s) - chapters still load in the reader")
        // Sorted worst-first.
        const idx = (s: string) => log.indexOf(s)
        expect(idx("natomanga")).toBeLessThan(idx("otherblocked"))
        // A skip is never emitted as a plain failure row.
        expect(log).not.toContain("natomanga: 154\n")
    })

    it("omits the skipped section when none is provided and tolerates garbage counts", () => {
        expect(formatUpdateFailureLog([], meta)).not.toContain("skipped (site blocks automated checks")
        const log = formatUpdateFailureLog([], {
            ...meta,
            skippedSources: { good: 2, bad: Number.NaN } as never
        })
        expect(log).toContain("- good: 2 title(s)")
        expect(log).not.toContain("bad")
    })

    it("renders needs-relink sources (retired/unparseable) in their own actionable section", () => {
        const log = formatUpdateFailureLog([], {
            ...meta,
            failed: 0,
            needsRelink: { manganato: 342, mangapark: 5 }
        })
        expect(log).toContain("needs relink (source retired or link unparseable):")
        expect(log).toContain("- manganato: 342 title(s) - relink to a live mirror")
        const idx = (s: string) => log.indexOf(s)
        expect(idx("manganato")).toBeLessThan(idx("mangapark"))
    })

    it("renders tracking-only and empty-list profile sources in their own sections", () => {
        const log = formatUpdateFailureLog([], {
            ...meta,
            failed: 0,
            trackingOnly: { "site.example": 4 },
            emptyLists: { "other.example": 2 }
        })
        expect(log).toContain("tracking only (new chapters are not auto-detected):")
        expect(log).toContain("- site.example: 4 title(s) - not checked for new chapters")
        expect(log).toContain("empty chapter list (the site profile may have stopped matching):")
        expect(log).toContain("- other.example: 2 title(s) - returned no chapters")
    })

    it("tolerates a garbage failuresBySource without throwing", () => {
        expect(() =>
            formatUpdateFailureLog([], { ...meta, failuresBySource: { good: 3, bad: Number.NaN } as never })
        ).not.toThrow()
        const log = formatUpdateFailureLog([], { ...meta, failuresBySource: { good: 3, bad: Number.NaN } as never })
        expect(log).toContain("- good: 3")
        expect(log).not.toContain("bad")
    })

    it("flattens embedded newlines so a title or message can't forge a new log line", () => {
        const log = formatUpdateFailureLog(
            [{ mangaId: "s:manga:x", title: "Evil\n- Fake Title [forged]", message: "line1\nline2\n\nline3" }],
            meta
        )
        expect(log.split("\n").filter(l => l.startsWith("- "))).toHaveLength(1)
        expect(log).toContain("- Evil - Fake Title [forged] [s:manga:x]: line1 line2 line3")
    })

    it("never throws on an invalid checkedAt", () => {
        const log = formatUpdateFailureLog([], { ...meta, checkedAt: Number.NaN })
        expect(log).toContain("checked at: unknown")
        expect(log).toContain("(no per-title errors recorded)")
    })

    it("substitutes placeholders for empty title/message/id", () => {
        const log = formatUpdateFailureLog([{ mangaId: "", title: "  ", message: "" }], meta)
        expect(log).toContain("- (untitled): (no message)")
        expect(log).not.toContain("[]")
    })

    it("strips control, bidi, and zero-width characters (anti terminal-forge)", () => {
        const esc = String.fromCharCode(0x1b) // ESC - terminal escape
        const rlo = String.fromCharCode(0x202e) // right-to-left override
        const zwsp = String.fromCharCode(0x200b) // zero-width space
        const log = formatUpdateFailureLog([{ mangaId: "s:x", title: `A${esc}[2A${rlo}B${zwsp}`, message: "m" }], meta)
        for (const code of [0x1b, 0x202e, 0x200b]) {
            expect(log).not.toContain(String.fromCharCode(code))
        }
        expect(log).toContain("- A[2AB [s:x]: m")
    })

    it("tolerates a null entry or a non-array without throwing", () => {
        expect(() => formatUpdateFailureLog([null as never], meta)).not.toThrow()
        const log = formatUpdateFailureLog([null as never, { mangaId: "s:y", title: "Kept", message: "m" }], meta)
        expect(log).toContain("- Kept [s:y]: m")
        expect(() => formatUpdateFailureLog("nope" as never, meta)).not.toThrow()
    })

    it("preserves ZWJ emoji sequences instead of shattering them into separate glyphs", () => {
        const family = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)
        const log = formatUpdateFailureLog([{ mangaId: "s:z", title: family, message: "m" }], meta)
        expect(log).toContain(`- ${family} [s:z]: m`)
    })

    it("does not let an invisible-but-non-empty title defeat the (untitled) fallback", () => {
        const wordJoiner = String.fromCodePoint(0x2060)
        const log = formatUpdateFailureLog([{ mangaId: "s:w", title: wordJoiner, message: "m" }], meta)
        expect(log).toContain("- (untitled) [s:w]: m")
    })

    it("treats a title of only joiners as blank", () => {
        const onlyZwj = String.fromCodePoint(0x200d, 0x200d)
        const log = formatUpdateFailureLog([{ mangaId: "s:j", title: onlyZwj, message: "m" }], meta)
        expect(log).toContain("- (untitled) [s:j]: m")
    })

    it("strips the Arabic Letter Mark like the other bidi marks", () => {
        const alm = String.fromCodePoint(0x061c)
        const log = formatUpdateFailureLog([{ mangaId: "s:alm", title: `A${alm}B`, message: "m" }], meta)
        expect(log).not.toContain(alm)
        expect(log).toContain("- AB [s:alm]: m")
    })

    it("removes lone surrogates so the log is valid UTF-16 for the clipboard", () => {
        const lone = String.fromCharCode(0xd800)
        const log = formatUpdateFailureLog([{ mangaId: "s:lone", title: `Title${lone}End`, message: "m" }], meta)
        expect(/[\ud800-\udfff]/.test(log)).toBe(false)
        expect(log).toContain("- TitleEnd [s:lone]: m")
    })

    it("keeps valid astral characters intact", () => {
        const astral = String.fromCodePoint(0x1f600) + String.fromCodePoint(0x20000)
        const log = formatUpdateFailureLog([{ mangaId: "s:a", title: astral, message: "m" }], meta)
        expect(log).toContain(`- ${astral} [s:a]: m`)
    })

    it("does not glue words together when removing a C1 control that acts as a line break", () => {
        const nel = String.fromCharCode(0x85)
        const log = formatUpdateFailureLog([{ mangaId: "s:nel", title: `Vol.1${nel}Ch.2`, message: "m" }], meta)
        expect(log).toContain("- Vol.1 Ch.2 [s:nel]: m")
    })

    it("does not let a Hangul-filler-only title defeat the (untitled) fallback", () => {
        const log = formatUpdateFailureLog(
            [{ mangaId: "s:hf", title: String.fromCodePoint(0x3164), message: "m" }],
            meta
        )
        expect(log).toContain("- (untitled) [s:hf]: m")
    })

    it("strips invisible Unicode tag characters so no hidden payload rides along", () => {
        const tagEncode = (ascii: string) =>
            String.fromCodePoint(0xe0001) +
            [...ascii].map(c => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("") +
            String.fromCodePoint(0xe007f)
        const log = formatUpdateFailureLog(
            [{ mangaId: "s:tag", title: `Visible${tagEncode("payload")}Title`, message: "m" }],
            meta
        )
        expect(/[\u{E0000}-\u{E007F}]/u.test(log)).toBe(false)
        expect(log).toContain("- VisibleTitle [s:tag]: m")
    })

    it("maps IND and RI (C1 line controls) to a space, not deletion", () => {
        for (const code of [0x84, 0x8d]) {
            const log = formatUpdateFailureLog(
                [{ mangaId: "s:c1", title: `Vol.1${String.fromCharCode(code)}Ch.2`, message: "m" }],
                meta
            )
            expect(log).toContain("- Vol.1 Ch.2 [s:c1]: m")
        }
    })

    it("keeps emoji variation-selector and skin-tone sequences intact", () => {
        const heart = "❤️"
        const thumb = String.fromCodePoint(0x1f44d) + String.fromCodePoint(0x1f3fb)
        const log = formatUpdateFailureLog([{ mangaId: "s:e", title: `${heart}${thumb}`, message: "m" }], meta)
        expect(log).toContain(`- ${heart}${thumb} [s:e]: m`)
    })

    it("prints ? for non-finite meta counts instead of 'undefined'", () => {
        const log = formatUpdateFailureLog([], {
            version: "1",
            checkedAt: 0,
            checked: undefined as never,
            updated: Number.NaN,
            failed: 2
        })
        expect(log).toContain("checked: ? | updated: ? | failed: 2")
    })
})
