import { describe, expect, it } from "vitest"
import {
    groupLibraryIntoWorks,
    rankWorkVersions,
    scoreVersion,
    shouldShowBetterHint,
    type VersionCtx
} from "./work-ranking"
import type { LibraryManga, VersionRecord } from "./database"

function v(over: Partial<VersionRecord> = {}): VersionRecord {
    return {
        id: over.id ?? `${over.sourceId ?? "s"}:${over.sourceMangaId ?? "1"}`,
        workKey: "title:tower of god",
        sourceId: "s",
        sourceMangaId: "1",
        url: "https://example.com/x",
        languages: ["en"],
        health: "ok",
        numberingKind: "chapter",
        lastSeenAt: 1000,
        observedVia: "search",
        ...over
    }
}

const ctx = (over: Partial<VersionCtx> = {}): VersionCtx => ({
    preferredLanguages: new Set(["en"]),
    now: 2_000_000,
    ...over
})

describe("scoreVersion - language gate", () => {
    it("puts a preferred-language version in tier 0 and others in tier 1", () => {
        expect(scoreVersion(v({ languages: ["en"] }), ctx()).tier).toBe(0)
        expect(scoreVersion(v({ languages: ["es"] }), ctx()).tier).toBe(1)
    })

    it("gives an untagged source the benefit of the doubt (tier 0)", () => {
        expect(scoreVersion(v({ languages: [] }), ctx()).tier).toBe(0)
    })
})

describe("worked examples", () => {
    it("official 180 beats a 900-chapter filler-split, capped by canonical count", () => {
        const scanlation = v({
            id: "scan:1",
            sourceId: "scan",
            latestChapterNumber: 900,
            isOfficialAtObservation: false
        })
        const official = v({ id: "off:1", sourceId: "off", latestChapterNumber: 180, isOfficialAtObservation: true })
        const c = ctx({ canonicalChapterCount: 182 })
        const { best } = rankWorkVersions([scanlation, official], c)
        expect(best?.id).toBe("off:1")
        expect(scoreVersion(official, c).score).toBeGreaterThan(scoreVersion(scanlation, c).score)
    })

    it("derives the canonical cap from an official version when none is supplied (filler-split still loses)", () => {
        const scanlation = v({
            id: "scan:1",
            sourceId: "scan",
            latestChapterNumber: 900,
            isOfficialAtObservation: false
        })
        const official = v({ id: "off:1", sourceId: "off", latestChapterNumber: 180, isOfficialAtObservation: true })
        // no canonicalChapterCount in ctx - it should be derived from the official version's count
        const { best } = rankWorkVersions([scanlation, official], ctx())
        expect(best?.id).toBe("off:1")
    })

    it("an English scanlation (tier 0) beats a longer Spanish official (tier 1) for an English reader", () => {
        const enScan = v({ id: "en:1", languages: ["en"], latestChapterNumber: 150, isOfficialAtObservation: false })
        const esOff = v({ id: "es:1", languages: ["es"], latestChapterNumber: 180, isOfficialAtObservation: true })
        const { best } = rankWorkVersions([esOff, enScan], ctx())
        expect(best?.id).toBe("en:1")
    })

    it("falls back to a foreign official when no preferred-language version exists", () => {
        const esOff = v({ id: "es:1", languages: ["es"], latestChapterNumber: 180, isOfficialAtObservation: true })
        const { best } = rankWorkVersions([esOff], ctx())
        expect(best?.id).toBe("es:1")
    })

    it("a dead mirror with a high count is never best", () => {
        const dead = v({ id: "dead:1", sourceId: "dead", latestChapterNumber: 500, health: "dead" })
        const live = v({ id: "live:1", sourceId: "live", latestChapterNumber: 180, isOfficialAtObservation: true })
        const { best, ordered } = rankWorkVersions([dead, live], ctx())
        expect(best?.id).toBe("live:1")
        expect(ordered.some(o => o.version.id === "dead:1")).toBe(true) // still listed for Advanced
    })

    it("a single version is best by default", () => {
        const only = v({ id: "only:1" })
        expect(rankWorkVersions([only], ctx()).best?.id).toBe("only:1")
    })
})

describe("numbering and eligibility", () => {
    it("penalizes non-chapter numbering", () => {
        const chap = v({ id: "a", latestChapterNumber: 100, numberingKind: "chapter" })
        const vol = v({ id: "b", latestChapterNumber: 100, numberingKind: "volume" })
        expect(scoreVersion(chap, ctx()).score).toBeGreaterThan(scoreVersion(vol, ctx()).score)
    })

    it("does not surface a version behind the read position as best", () => {
        const behind = v({ id: "behind", sourceId: "b", latestChapterNumber: 10 })
        const ahead = v({ id: "ahead", sourceId: "a", latestChapterNumber: 200 })
        const { best } = rankWorkVersions([behind, ahead], ctx({ lastReadNumber: 50 }))
        expect(best?.id).toBe("ahead")
    })

    it("honors a user-pinned preferred source over the score", () => {
        const pinnedLow = v({ id: "pin:1", sourceId: "pin", latestChapterNumber: 10, isOfficialAtObservation: false })
        const other = v({ id: "oth:1", sourceId: "oth", latestChapterNumber: 500, isOfficialAtObservation: true })
        const { best } = rankWorkVersions([pinnedLow, other], ctx(), "pin")
        expect(best?.id).toBe("pin:1")
    })
})

describe("shouldShowBetterHint", () => {
    const current = v({ id: "cur", sourceId: "cur", latestChapterNumber: 100, isOfficialAtObservation: false })
    it("fires when clearly better (big score gap, same tier, not behind)", () => {
        const best = v({ id: "best", sourceId: "best", latestChapterNumber: 180, isOfficialAtObservation: true })
        expect(shouldShowBetterHint(current, best, ctx())).toBe(true)
    })
    it("stays silent for a trivial lead", () => {
        const best = v({ id: "best", sourceId: "best", latestChapterNumber: 101, isOfficialAtObservation: false })
        expect(shouldShowBetterHint(current, best, ctx())).toBe(false)
    })
    it("never nudges toward a different language", () => {
        const best = v({
            id: "best",
            sourceId: "best",
            languages: ["es"],
            latestChapterNumber: 900,
            isOfficialAtObservation: true
        })
        expect(shouldShowBetterHint(current, best, ctx())).toBe(false)
    })
    it("never nudges to a version behind the current chapter", () => {
        const best = v({ id: "best", sourceId: "best", latestChapterNumber: 50, isOfficialAtObservation: true })
        expect(shouldShowBetterHint(current, best, ctx())).toBe(false)
    })
})

describe("groupLibraryIntoWorks", () => {
    function m(over: Partial<LibraryManga> = {}): LibraryManga {
        return {
            id: over.id ?? "s:manga:1",
            sourceId: over.sourceId ?? "s",
            sourceUrl: over.sourceUrl ?? "https://example.com/x",
            title: over.title ?? "Tower of God",
            normalizedTitle: "tower of god",
            authors: [],
            status: "ongoing",
            addedAt: 1,
            updatedAt: over.updatedAt ?? 1,
            ...over
        }
    }

    it("collapses same-title rows from different sources into one card", () => {
        const rows = [
            m({ id: "a:manga:1", sourceId: "a", updatedAt: 2 }),
            m({ id: "b:manga:1", sourceId: "b", updatedAt: 5 })
        ]
        const cards = groupLibraryIntoWorks(rows, [], [], ctx())
        expect(cards).toHaveLength(1)
        expect(cards[0]!.tracked.id).toBe("b:manga:1") // most recently updated
        expect(cards[0]!.versionCount).toBe(2) // both synthesized from the rows
    })

    it("keeps distinct titles apart", () => {
        const rows = [m({ id: "a:1", title: "Naruto" }), m({ id: "b:1", title: "Bleach" })]
        expect(groupLibraryIntoWorks(rows, [], [], ctx())).toHaveLength(2)
    })

    it("splits a row out when a split override targets it", () => {
        const rows = [
            m({ id: "a:manga:1", sourceId: "a", updatedAt: 2 }),
            m({ id: "b:manga:1", sourceId: "b", updatedAt: 5 })
        ]
        const cards = groupLibraryIntoWorks(
            rows,
            [],
            [{ id: "ov", type: "split", members: ["a:manga:1"], updatedAt: 1 }],
            ctx()
        )
        expect(cards).toHaveLength(2)
    })
})
