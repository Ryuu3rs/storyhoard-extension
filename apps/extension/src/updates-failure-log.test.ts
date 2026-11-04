import { describe, it, expect } from "vitest"
import { formatUpdateFailureLog } from "./updates-failure-log"

const meta = { version: "0.13.0", checkedAt: Date.parse("2026-07-23T00:00:00Z"), checked: 10, updated: 7, failed: 2 }

describe("formatUpdateFailureLog", () => {
    it("renders a header and one line per failed title, without the internal id", () => {
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
        expect(log).toContain("- Title A: Request failed with status 500")
        expect(log).toContain("- Title B: blocked")
        // The internal id embeds the source id (a host for a detected site), so it is never printed.
        expect(log).not.toContain("mangadex")
        expect(log).not.toContain("kagane")
        expect(log).not.toContain("[")
        expect(log.split("\n").filter(l => l.startsWith("- "))).toHaveLength(2)
    })

    it("never names a source host; shows neutral Source N labels, worst first", () => {
        const log = formatUpdateFailureLog([{ mangaId: "asurascans:manga:a", title: "A", message: "404" }], {
            ...meta,
            failuresBySource: { aquamanga: 5, asurascans: 8, flamecomics: 1 }
        })
        expect(log).toContain("failures by source:")
        const tally = log
            .split("\n")
            .filter(l => /^- Source \d+: \d+$/.test(l))
            .map(l => l.replace(/^- /, ""))
        // Labels are assigned in render order, so the worst (sorted first) is Source 1.
        expect(tally).toEqual(["Source 1: 8", "Source 2: 5", "Source 3: 1"])
        for (const host of ["aquamanga", "asurascans", "flamecomics"]) expect(log).not.toContain(host)
    })

    it("omits the by-source section when no map is provided", () => {
        const log = formatUpdateFailureLog([{ mangaId: "s:x", title: "A", message: "m" }], meta)
        expect(log).not.toContain("failures by source:")
    })

    it("renders skipped (bot-blocked) sources in their own section with neutral labels", () => {
        const log = formatUpdateFailureLog([], {
            ...meta,
            failed: 0,
            skippedSources: { natomanga: 154, otherblocked: 3 }
        })
        expect(log).toContain("skipped (site blocks automated checks, not a failure):")
        expect(log).toContain("- Source 1: 154 title(s) - chapters still load in the reader")
        expect(log).toContain("- Source 2: 3 title(s) - chapters still load in the reader")
        for (const host of ["natomanga", "otherblocked"]) expect(log).not.toContain(host)
    })

    it("renders needs-verify sources host-free, with the recoverable hint and a header tally", () => {
        const log = formatUpdateFailureLog([], {
            ...meta,
            failed: 0,
            needsVerify: [
                { sourceId: "mangadex", count: 302 },
                { sourceId: "otherpow", count: 4 }
            ]
        })
        expect(log).toContain("needs verify (open the site once to let checks run again):")
        expect(log).toContain("- Source 1: 302 title(s) - open the site once to restore access, then re-check")
        expect(log).toContain("- Source 2: 4 title(s) -")
        expect(log).toContain("needs verify: 306")
        for (const host of ["mangadex", "otherpow"]) expect(log).not.toContain(host)
    })

    it("sums one source challenged on two origins into one row", () => {
        const log = formatUpdateFailureLog([], {
            ...meta,
            needsVerify: [
                { sourceId: "same", count: 3 },
                { sourceId: "same", count: 2 }
            ]
        })
        expect(log).toContain("- Source 1: 5 title(s) -")
        expect(log).not.toContain("- Source 2:")
    })

    it("tallies each source by cause, worst source first, without naming a host", () => {
        const log = formatUpdateFailureLog([], {
            ...meta,
            causesBySource: {
                smallsite: { timeout: 1 },
                bigsite: { challenge: 12, "http-500": 3, parse: 2, empty: 1 }
            }
        })
        expect(log).toContain(
            "causes by source:\n- Source 1: challenge 12, http-500 3, parse 2, empty 1\n- Source 2: timeout 1"
        )
        for (const host of ["bigsite", "smallsite"]) expect(log).not.toContain(host)
    })

    it("keeps one source's label the same across the tally and the other sections", () => {
        const log = formatUpdateFailureLog([], {
            ...meta,
            failuresBySource: { oneSite: 2 },
            causesBySource: { oneSite: { "http-500": 2 } },
            needsVerify: [{ sourceId: "otherSite", count: 1 }],
            skippedSources: { thirdSite: 4 }
        })
        expect(log).toContain("failures by source:\n- Source 1: 2")
        expect(log).toContain("causes by source:\n- Source 1: http-500 2")
        expect(log).toContain("- Source 2: 4 title(s) - chapters still load")
        expect(log).toContain("- Source 3: 1 title(s) - open the site once")
    })

    it("omits the cause tally when empty and tolerates garbage", () => {
        expect(formatUpdateFailureLog([], meta)).not.toContain("causes by source")
        expect(formatUpdateFailureLog([], { ...meta, causesBySource: { a: { timeout: Number.NaN } } })).not.toContain(
            "causes by source"
        )
        expect(formatUpdateFailureLog([], { ...meta, causesBySource: "nope" as never })).not.toContain(
            "causes by source"
        )
    })

    it("never carries a cookie, token or session value out of an error message", () => {
        const log = formatUpdateFailureLog(
            [
                { mangaId: "a", title: "One", message: "failed, Cookie: cf_clearance=SECRETA; other=SECRETB" },
                { mangaId: "b", title: "Two", message: "rejected Authorization: Bearer SECRETC" },
                { mangaId: "c", title: "Three", message: "bad token=SECRETD and session_id=SECRETE" },
                { mangaId: "d", title: "Four", message: "Set-Cookie: sid=SECRETF" },
                { mangaId: "e", title: "Five", message: "https://reader.example/x?token=SECRETG" }
            ],
            meta
        )
        expect(log).not.toMatch(/SECRET[A-G]/)
        expect(log).toContain("- One: failed, [redacted]")
    })

    it("leaves an ordinary message alone", () => {
        const log = formatUpdateFailureLog(
            [{ mangaId: "a", title: "One", message: "Request failed with status 500" }],
            meta
        )
        expect(log).toContain("- One: Request failed with status 500")
    })

    it("omits the needs-verify section and its tally when none is provided or counts are garbage", () => {
        expect(formatUpdateFailureLog([], meta)).not.toContain("needs verify")
        const log = formatUpdateFailureLog([], {
            ...meta,
            needsVerify: [{ sourceId: "ok", count: 3 }, { sourceId: "bad", count: Number.NaN } as never]
        })
        expect(log).toContain("- Source 1: 3 title(s) -")
        expect(log).toContain("needs verify: 3")
        expect(log).not.toContain("bad")
        expect(log).not.toContain("- Source 2:")
    })

    it("omits the skipped section when none is provided and tolerates garbage counts", () => {
        expect(formatUpdateFailureLog([], meta)).not.toContain("skipped (site blocks automated checks")
        const log = formatUpdateFailureLog([], {
            ...meta,
            skippedSources: { good: 2, bad: Number.NaN } as never
        })
        expect(log).toContain("- Source 1: 2 title(s)")
        expect(log).not.toContain("bad")
        expect(log).not.toContain("good")
    })

    it("lists the actual titles that need relinking, by name, never a host or 'mirror'", () => {
        const log = formatUpdateFailureLog([], {
            ...meta,
            failed: 0,
            needsRelink: { manganato: 2 },
            relinkTitles: [
                { mangaId: "manganato:manga:a", title: "Solo Leveling", sourceId: "manganato" },
                {
                    mangaId: "detected:evil.example:manga:b",
                    title: "Omniscient Reader",
                    sourceId: "detected:evil.example"
                }
            ]
        })
        expect(log).toContain("needs relink (2 titles; the source was retired or the link can't be read):")
        expect(log).toContain("- Solo Leveling - relink this title")
        expect(log).toContain("- Omniscient Reader - relink this title")
        expect(log).not.toContain("mirror")
        expect(log).not.toContain("manganato")
        expect(log).not.toContain("evil.example")
    })

    // BUGHUNT (numeric/label): the producer (handlers/updates-sources.ts) caps relinkTitles at
    // RELINK_TITLES_CAP = 200, but needsRelink counts EVERY title. When more than the cap need a
    // relink the formatter reports relinkTitles.length as the total and drops needsRelink entirely,
    // so a library with 350 relink candidates shows "needs relink (200 titles)" and the true total
    // is never surfaced. The support log understates the real work by 150 titles.
    it("surfaces the true needs-relink total when relinkTitles was capped below it", () => {
        const relinkTitles = Array.from({ length: 200 }, (_, i) => ({
            mangaId: `manganato:manga:${i}`,
            title: `Title ${i}`,
            sourceId: "manganato"
        }))
        const log = formatUpdateFailureLog([], {
            ...meta,
            failed: 0,
            // 350 titles actually need relinking across the library...
            needsRelink: { manganato: 350 },
            // ...but the listed sample was capped at 200.
            relinkTitles
        })
        // The heading currently reads "needs relink (200 titles; ...)" and 350 appears nowhere.
        expect(log).toContain("350")
    })

    it("uses the singular heading for a single relink title", () => {
        const log = formatUpdateFailureLog([], {
            ...meta,
            failed: 0,
            relinkTitles: [{ mangaId: "s:manga:a", title: "One Title", sourceId: "s" }]
        })
        expect(log).toContain("needs relink (1 title;")
        expect(log).toContain("- One Title - relink this title")
    })

    it("falls back to a neutral per-source count when the relink titles are not known", () => {
        const log = formatUpdateFailureLog([], {
            ...meta,
            failed: 0,
            needsRelink: { manganato: 342, mangapark: 5 }
        })
        expect(log).toContain("needs relink (source retired or link can't be read):")
        expect(log).toContain("- Source 1: 342 title(s) - relink these titles")
        expect(log).toContain("- Source 2: 5 title(s) - relink these titles")
        expect(log).not.toContain("mirror")
        for (const host of ["manganato", "mangapark"]) expect(log).not.toContain(host)
    })

    it("renders tracking-only and empty-list profile sources with neutral labels", () => {
        const log = formatUpdateFailureLog([], {
            ...meta,
            failed: 0,
            trackingOnly: { "site.example": 4 },
            emptyLists: { "other.example": 2 }
        })
        expect(log).toContain("tracking only (new chapters are not auto-detected):")
        expect(log).toContain("- Source 1: 4 title(s) - not checked for new chapters")
        expect(log).toContain("empty chapter list (the site profile may have stopped matching):")
        expect(log).toContain("- Source 2: 2 title(s) - returned no chapters")
        for (const host of ["site.example", "other.example"]) expect(log).not.toContain(host)
    })

    it("renders a list that stops short with a neutral label", () => {
        const log = formatUpdateFailureLog([], { ...meta, failed: 0, shortLists: { "short.example": 3 } })
        expect(log).toContain("chapter list stops short (new chapters past it cannot be seen):")
        expect(log).toContain("- Source 1: 3 title(s) - list ends below a chapter the title already has")
        expect(log).not.toContain("short.example")
    })

    it("gives one source the same neutral label across every section", () => {
        const log = formatUpdateFailureLog([], {
            ...meta,
            failed: 0,
            failuresBySource: { fanfox: 3 },
            skippedSources: { fanfox: 1 }
        })
        // fanfox is first rendered in the by-source section -> Source 1 there and in skipped too.
        expect(log).toContain("- Source 1: 3")
        expect(log).toContain("- Source 1: 1 title(s) - chapters still load in the reader")
        expect(log).not.toContain("fanfox")
    })

    it("tolerates a garbage failuresBySource without throwing", () => {
        expect(() =>
            formatUpdateFailureLog([], { ...meta, failuresBySource: { good: 3, bad: Number.NaN } as never })
        ).not.toThrow()
        const log = formatUpdateFailureLog([], { ...meta, failuresBySource: { good: 3, bad: Number.NaN } as never })
        expect(log).toContain("- Source 1: 3")
        expect(log).not.toContain("bad")
        expect(log).not.toContain("good")
    })

    it("flattens embedded newlines so a title or message can't forge a new log line", () => {
        const log = formatUpdateFailureLog(
            [{ mangaId: "s:manga:x", title: "Evil\n- Fake Title", message: "line1\nline2\n\nline3" }],
            meta
        )
        expect(log.split("\n").filter(l => l.startsWith("- "))).toHaveLength(1)
        expect(log).toContain("- Evil - Fake Title: line1 line2 line3")
    })

    it("never throws on an invalid checkedAt", () => {
        const log = formatUpdateFailureLog([], { ...meta, checkedAt: Number.NaN })
        expect(log).toContain("checked at: unknown")
        expect(log).toContain("(no per-title errors recorded)")
    })

    it("substitutes placeholders for empty title/message", () => {
        const log = formatUpdateFailureLog([{ mangaId: "", title: "  ", message: "" }], meta)
        expect(log).toContain("- (untitled): (no message)")
    })

    it("strips control, bidi, and zero-width characters (anti terminal-forge)", () => {
        const esc = String.fromCharCode(0x1b) // ESC - terminal escape
        const rlo = String.fromCharCode(0x202e) // right-to-left override
        const zwsp = String.fromCharCode(0x200b) // zero-width space
        const log = formatUpdateFailureLog([{ mangaId: "s:x", title: `A${esc}[2A${rlo}B${zwsp}`, message: "m" }], meta)
        for (const code of [0x1b, 0x202e, 0x200b]) {
            expect(log).not.toContain(String.fromCharCode(code))
        }
        expect(log).toContain("- A[2AB: m")
    })

    it("tolerates a null entry or a non-array without throwing", () => {
        expect(() => formatUpdateFailureLog([null as never], meta)).not.toThrow()
        const log = formatUpdateFailureLog([null as never, { mangaId: "s:y", title: "Kept", message: "m" }], meta)
        expect(log).toContain("- Kept: m")
        expect(() => formatUpdateFailureLog("nope" as never, meta)).not.toThrow()
    })

    it("preserves ZWJ emoji sequences instead of shattering them into separate glyphs", () => {
        const family = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)
        const log = formatUpdateFailureLog([{ mangaId: "s:z", title: family, message: "m" }], meta)
        expect(log).toContain(`- ${family}: m`)
    })

    it("does not let an invisible-but-non-empty title defeat the (untitled) fallback", () => {
        const wordJoiner = String.fromCodePoint(0x2060)
        const log = formatUpdateFailureLog([{ mangaId: "s:w", title: wordJoiner, message: "m" }], meta)
        expect(log).toContain("- (untitled): m")
    })

    it("treats a title of only joiners as blank", () => {
        const onlyZwj = String.fromCodePoint(0x200d, 0x200d)
        const log = formatUpdateFailureLog([{ mangaId: "s:j", title: onlyZwj, message: "m" }], meta)
        expect(log).toContain("- (untitled): m")
    })

    it("strips the Arabic Letter Mark like the other bidi marks", () => {
        const alm = String.fromCodePoint(0x061c)
        const log = formatUpdateFailureLog([{ mangaId: "s:alm", title: `A${alm}B`, message: "m" }], meta)
        expect(log).not.toContain(alm)
        expect(log).toContain("- AB: m")
    })

    it("removes lone surrogates so the log is valid UTF-16 for the clipboard", () => {
        const lone = String.fromCharCode(0xd800)
        const log = formatUpdateFailureLog([{ mangaId: "s:lone", title: `Title${lone}End`, message: "m" }], meta)
        expect(/[\ud800-\udfff]/.test(log)).toBe(false)
        expect(log).toContain("- TitleEnd: m")
    })

    it("keeps valid astral characters intact", () => {
        const astral = String.fromCodePoint(0x1f600) + String.fromCodePoint(0x20000)
        const log = formatUpdateFailureLog([{ mangaId: "s:a", title: astral, message: "m" }], meta)
        expect(log).toContain(`- ${astral}: m`)
    })

    it("does not glue words together when removing a C1 control that acts as a line break", () => {
        const nel = String.fromCharCode(0x85)
        const log = formatUpdateFailureLog([{ mangaId: "s:nel", title: `Vol.1${nel}Ch.2`, message: "m" }], meta)
        expect(log).toContain("- Vol.1 Ch.2: m")
    })

    it("does not let a Hangul-filler-only title defeat the (untitled) fallback", () => {
        const log = formatUpdateFailureLog(
            [{ mangaId: "s:hf", title: String.fromCodePoint(0x3164), message: "m" }],
            meta
        )
        expect(log).toContain("- (untitled): m")
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
        expect(log).toContain("- VisibleTitle: m")
    })

    it("maps IND and RI (C1 line controls) to a space, not deletion", () => {
        for (const code of [0x84, 0x8d]) {
            const log = formatUpdateFailureLog(
                [{ mangaId: "s:c1", title: `Vol.1${String.fromCharCode(code)}Ch.2`, message: "m" }],
                meta
            )
            expect(log).toContain("- Vol.1 Ch.2: m")
        }
    })

    it("keeps emoji variation-selector and skin-tone sequences intact", () => {
        const heart = "❤️"
        const thumb = String.fromCodePoint(0x1f44d) + String.fromCodePoint(0x1f3fb)
        const log = formatUpdateFailureLog([{ mangaId: "s:e", title: `${heart}${thumb}`, message: "m" }], meta)
        expect(log).toContain(`- ${heart}${thumb}: m`)
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
