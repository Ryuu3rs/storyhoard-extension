import { describe, expect, it, vi } from "vitest"
import {
    CHAPTER_ID,
    CHAPTER_URL,
    ORIGIN,
    SERIES_ID,
    SERIES_URL,
    bonusChapterTitlesById,
    bonusSeriesHtml,
    bonusSeriesId,
    episodeChapterNumberById,
    episodeSeriesHtml,
    episodeSeriesId,
    chapterPageHtml,
    chapterPageHtmlUnparseableTitle,
    imagesHtml,
    searchHtml,
    seriesHtml
} from "./__fixtures__/weebcentral"
import { weebCentralAdapter as adapter } from "./weebcentral"

function makeContext(responses: Record<string, string>) {
    return {
        request: {
            getText: vi.fn(async (url: URL) => {
                const key = url.toString().split("?")[0] ?? url.toString()
                const html = responses[key]
                if (html === undefined) throw new Error(`No fixture for ${key}`)
                return html
            })
        },
        now: () => 1_000_000,
        logger: { debug: vi.fn(), warn: vi.fn() }
    }
}

describe("weebCentralAdapter.match", () => {
    it("identifies series URLs as manga", () => {
        expect(adapter.match(new URL(SERIES_URL))).toBe("manga")
    })

    it("identifies bare series URL (no slug) as manga", () => {
        expect(adapter.match(new URL(`${ORIGIN}/series/${SERIES_ID}`))).toBe("manga")
    })

    it("identifies chapter URLs as chapter", () => {
        expect(adapter.match(new URL(CHAPTER_URL))).toBe("chapter")
    })

    it("returns none for unrelated URLs", () => {
        expect(adapter.match(new URL("https://mangadex.org/title/abc"))).toBe("none")
        expect(adapter.match(new URL("https://weebcentral.com/search"))).toBe("none")
    })
})

describe("weebCentralAdapter.resolveManga", () => {
    it("parses title and cover from series page", async () => {
        const ctx = makeContext({ [`${ORIGIN}/series/${SERIES_ID}`]: seriesHtml })
        const result = await adapter.resolveManga({ url: new URL(SERIES_URL) }, ctx as never)
        expect(result.manga.title).toBe("Solo Leveling")
        expect(result.manga.coverUrl).toContain("cover.jpg")
        expect(result.sourceMangaId).toBe(SERIES_ID)
        expect(result.sourceId).toBe("weebcentral")
    })

    it.each(["Hiding Out | Weeb Central", "Hiding Out - Weeb Central", "Hiding Out | WeebCentral"])(
        "drops the site from the title %s",
        async ogTitle => {
            const ctx = makeContext({
                [`${ORIGIN}/series/${SERIES_ID}`]: `<meta property="og:title" content="${ogTitle}" />`
            })
            const result = await adapter.resolveManga({ url: new URL(SERIES_URL) }, ctx as never)
            expect(result.manga.title).toBe("Hiding Out")
        }
    )
})

describe("weebCentralAdapter.listChapters", () => {
    it("extracts and sorts chapters ascending by number", async () => {
        const ctx = makeContext({ [`${ORIGIN}/series/${SERIES_ID}/full-chapter-list`]: seriesHtml })
        const stubManga = {
            manga: {
                id: `weebcentral:manga:${SERIES_ID}`,
                title: "Solo Leveling",
                normalizedTitle: "solo leveling",
                authors: [] as string[],
                status: "unknown" as const,
                addedAt: 0,
                updatedAt: 0
            },
            sourceId: "weebcentral",
            sourceMangaId: SERIES_ID,
            url: SERIES_URL
        }
        const chapters = await adapter.listChapters({ manga: stubManga }, ctx as never)
        expect(chapters.length).toBe(3)
        expect(chapters[0]!.sortKey).toBeLessThanOrEqual(chapters[1]!.sortKey)
        expect(chapters[1]!.sortKey).toBeLessThanOrEqual(chapters[2]!.sortKey)
        expect(chapters[0]!.sourceChapterId).toBe(CHAPTER_ID)
    })

    // The old regex required a relative href ("/chapters/{ULID}") - weebcentral now emits
    // absolute hrefs, so the old regex matched zero anchors. seriesHtml uses absolute hrefs
    // throughout, so a non-empty result here already exercises the fix; this test just makes
    // the expectation explicit and future-proofs against a regression back to relative-only.
    it("matches chapter anchors with absolute hrefs", async () => {
        const ctx = makeContext({ [`${ORIGIN}/series/${SERIES_ID}/full-chapter-list`]: seriesHtml })
        const stubManga = {
            manga: {
                id: `weebcentral:manga:${SERIES_ID}`,
                title: "Solo Leveling",
                normalizedTitle: "solo leveling",
                authors: [] as string[],
                status: "unknown" as const,
                addedAt: 0,
                updatedAt: 0
            },
            sourceId: "weebcentral",
            sourceMangaId: SERIES_ID,
            url: SERIES_URL
        }
        const chapters = await adapter.listChapters({ manga: stubManga }, ctx as never)
        expect(chapters.map(c => c.sourceChapterId).sort()).toEqual(
            ["01HV3K9MXNP2Q4R6S8T0V2W4Z9", "01HV3K9MXNP2Q4R6S8T1V2W4Y6", "01HV3K9MXNP2Q4R6S8T2V2W4Y6"].sort()
        )
    })

    // The CHAPTER_ID_2 anchor in seriesHtml reproduces the real per-row markup verbatim: a
    // hidden "Last Read" span, an inline SVG with an embedded <style> block, and a trailing
    // <time> element whose text content is a raw ISO timestamp, all inside the same <a>. None of
    // that is a chapter tag, so plain tag-stripping alone would leak it straight into the title
    // (e.g. "Chapter 2 Last Read .st0 { fill: #d3d629; } 2024-09-07T17:04:15.717343Z").
    it("strips embedded style/time/last-read noise from a chapter anchor, keeping only the label", async () => {
        const ctx = makeContext({ [`${ORIGIN}/series/${SERIES_ID}/full-chapter-list`]: seriesHtml })
        const stubManga = {
            manga: {
                id: `weebcentral:manga:${SERIES_ID}`,
                title: "Solo Leveling",
                normalizedTitle: "solo leveling",
                authors: [] as string[],
                status: "unknown" as const,
                addedAt: 0,
                updatedAt: 0
            },
            sourceId: "weebcentral",
            sourceMangaId: SERIES_ID,
            url: SERIES_URL
        }
        const chapters = await adapter.listChapters({ manga: stubManga }, ctx as never)
        const chapterTwo = chapters.find(c => c.sourceChapterId === "01HV3K9MXNP2Q4R6S8T1V2W4Y6")!
        expect(chapterTwo.title).toBe("Chapter 2")
    })

    // seriesHtml lists chapters newest-first (descending) - live-verified against a real
    // weebcentral series page. bonusSeriesHtml adds a non-numeric "Extra" chapter between
    // Chapter 3 and Chapter 4 in that same descending listing. The old code returned sortKey 0
    // for "Extra", which would sort it before Chapter 1 in the final ascending list - the bonus
    // chapter should instead land strictly between Chapter 3 and Chapter 4.
    it("interpolates a non-numeric bonus chapter's sortKey between its real neighbors, even in a descending document", async () => {
        const ctx = makeContext({ [`${ORIGIN}/series/${bonusSeriesId}/full-chapter-list`]: bonusSeriesHtml })
        const stubManga = {
            manga: {
                id: `weebcentral:manga:${bonusSeriesId}`,
                title: "Bonus Test Manga",
                normalizedTitle: "bonus test manga",
                authors: [] as string[],
                status: "unknown" as const,
                addedAt: 0,
                updatedAt: 0
            },
            sourceId: "weebcentral",
            sourceMangaId: bonusSeriesId,
            url: `${ORIGIN}/series/${bonusSeriesId}`
        }
        const chapters = await adapter.listChapters({ manga: stubManga }, ctx as never)
        expect(chapters.length).toBe(5)

        // Ascending sort should exactly reproduce chronological reading order: 1, 2, 3, Extra, 4.
        expect(chapters.map(c => bonusChapterTitlesById[c.sourceChapterId])).toEqual([
            "Chapter 1",
            "Chapter 2",
            "Chapter 3",
            "Extra",
            "Chapter 4"
        ])

        const chapter3 = chapters.find(c => bonusChapterTitlesById[c.sourceChapterId] === "Chapter 3")!
        const chapter4 = chapters.find(c => bonusChapterTitlesById[c.sourceChapterId] === "Chapter 4")!
        const extra = chapters.find(c => bonusChapterTitlesById[c.sourceChapterId] === "Extra")!
        expect(extra.sortKey).toBeGreaterThan(chapter3.sortKey)
        expect(extra.sortKey).toBeLessThan(chapter4.sortKey)
    })
})

// WeebCentral labels webtoon series "Episode N" (live-verified: The Beginning After The End).
// chapterNumberFromText only recognised a chapter/ch marker, so every "Episode N" parsed to
// undefined and assignListSortKeys assigned position/1000 sortKeys - Episode 17 -> 0.017,
// Episode 269 -> 0.269 - for ALL episode-labeled series. A mangled latest of 0.269 then sorts
// below a real lastRead of 1, so a caught-up series was wrongly treated as read.
describe("weebCentralAdapter.listChapters - Episode-labeled webtoon series (0.NNN sortKey regression)", () => {
    const stubManga = {
        manga: {
            id: `weebcentral:manga:${episodeSeriesId}`,
            title: "The Beginning After The End",
            normalizedTitle: "the beginning after the end",
            authors: [] as string[],
            status: "unknown" as const,
            addedAt: 0,
            updatedAt: 0
        },
        sourceId: "weebcentral",
        sourceMangaId: episodeSeriesId,
        url: `${ORIGIN}/series/${episodeSeriesId}`
    }
    const runListChapters = () => {
        const ctx = makeContext({ [`${ORIGIN}/series/${episodeSeriesId}/full-chapter-list`]: episodeSeriesHtml })
        return adapter.listChapters({ manga: stubManga }, ctx as never)
    }

    it("reads the real 'Episode N' label as the chapter number", async () => {
        const chapters = await runListChapters()
        for (const chapter of chapters) {
            expect(chapter.sortKey).toBe(episodeChapterNumberById[chapter.sourceChapterId])
        }
    })

    it("never collapses a numbered episode to a fractional 0.0NN sortKey", async () => {
        const chapters = await runListChapters()
        // Pre-fix every episode parsed to undefined and assignListSortKeys assigned
        // position/1000 (0.001..0.007) - all below 1. A real numbered episode must be >= 1.
        expect(chapters.every(c => Number.isFinite(c.sortKey) && c.sortKey >= 1)).toBe(true)
    })

    it("keeps 17 -> 17, 269 -> 269, and a decimal 269.5 -> 269.5", async () => {
        const chapters = await runListChapters()
        const sortKeyFor = (num: number) =>
            chapters.find(c => episodeChapterNumberById[c.sourceChapterId] === num)?.sortKey
        expect(sortKeyFor(17)).toBe(17)
        expect(sortKeyFor(269)).toBe(269)
        expect(sortKeyFor(269.5)).toBe(269.5)
    })
})

// The keyword-less bare-number fallback used to fire on ANY label, so a label like
// "New Year 2024 Special" yielded 2024 (a year embedded in prose), poisoning the sortKey.
// The fallback must only fire when the whole trimmed label IS a standalone number.
describe("weebCentralAdapter.listChapters - bare-number fallback must not grab an embedded year", () => {
    const bareFallbackSeriesId = "01J76XYE23859ZWDP7BJ520BARE"
    const ulid = (c: string) => c.repeat(26)
    const SPECIAL = ulid("A")
    const BARE = ulid("B")
    const EPISODE = ulid("C")
    const row = (id: string, label: string) =>
        `<a href="/chapters/${id}" class="flex-1"><span class="grow flex"><span class="">${label}</span></span></a>`
    // Newest-first document order (as the live site lists it).
    const bareFallbackHtml = [row(BARE, "246"), row(SPECIAL, "New Year 2024 Special"), row(EPISODE, "Episode 17")].join(
        "\n"
    )

    const stubManga = {
        manga: {
            id: `weebcentral:manga:${bareFallbackSeriesId}`,
            title: "Fallback Test",
            normalizedTitle: "fallback test",
            authors: [] as string[],
            status: "unknown" as const,
            addedAt: 0,
            updatedAt: 0
        },
        sourceId: "weebcentral",
        sourceMangaId: bareFallbackSeriesId,
        url: `${ORIGIN}/series/${bareFallbackSeriesId}`
    }
    const run = () => {
        const ctx = makeContext({
            [`${ORIGIN}/series/${bareFallbackSeriesId}/full-chapter-list`]: bareFallbackHtml
        })
        return adapter.listChapters({ manga: stubManga }, ctx as never)
    }

    it("does not parse the embedded year from 'New Year 2024 Special'", async () => {
        const chapters = await run()
        const special = chapters.find(c => c.sourceChapterId === SPECIAL)!
        // Unnumbered -> interpolated between its real neighbours (Episode 17 and Chapter 246),
        // never the year 2024.
        expect(special.sortKey).not.toBe(2024)
        expect(special.sortKey).toBeLessThan(246)
    })

    it("still resolves a standalone bare number (246 -> 246) and keyword labels", async () => {
        const chapters = await run()
        expect(chapters.find(c => c.sourceChapterId === BARE)!.sortKey).toBe(246)
        expect(chapters.find(c => c.sourceChapterId === EPISODE)!.sortKey).toBe(17)
    })
})

describe("weebCentralAdapter.resolveChapter", () => {
    it("returns pages from the images endpoint", async () => {
        const ctx = makeContext({
            [`${ORIGIN}/chapters/${CHAPTER_ID}/`]: chapterPageHtml,
            [`${ORIGIN}/chapters/${CHAPTER_ID}/images`]: imagesHtml,
            [`${ORIGIN}/series/${SERIES_ID}`]: seriesHtml
        })
        const result = await adapter.resolveChapter({ url: new URL(CHAPTER_URL) }, ctx as never)
        expect(result.pages.length).toBe(3)
        expect(result.pages[0]!.url).toContain("001.jpg")
        expect(result.chapter.sourceChapterId).toBe(CHAPTER_ID)
        expect(result.manga.manga.title).toBe("Solo Leveling")
    })

    it("resolves with empty pages when no images found, preserving series metadata for panel nav", async () => {
        const ctx = makeContext({
            [`${ORIGIN}/chapters/${CHAPTER_ID}/`]: chapterPageHtml,
            [`${ORIGIN}/chapters/${CHAPTER_ID}/images`]: "<html><body>Loading…</body></html>",
            [`${ORIGIN}/series/${SERIES_ID}`]: seriesHtml
        })
        const result = await adapter.resolveChapter({ url: new URL(CHAPTER_URL) }, ctx as never)
        expect(result.pages).toEqual([])
        expect(result.manga.manga.title).toBe("Solo Leveling")
    })

    // A chapter titled "Extra" has no parseable chapter number. Resolved in isolation (no
    // surrounding chapter list to interpolate a position from), it must fall back to
    // +Infinity rather than 0 - otherwise it would sort before every real chapter.
    it("falls back to +Infinity sortKey for an unparseable chapter title", async () => {
        const ctx = makeContext({
            [`${ORIGIN}/chapters/${CHAPTER_ID}/`]: chapterPageHtmlUnparseableTitle,
            [`${ORIGIN}/chapters/${CHAPTER_ID}/images`]: imagesHtml,
            [`${ORIGIN}/series/${SERIES_ID}`]: seriesHtml
        })
        const result = await adapter.resolveChapter({ url: new URL(CHAPTER_URL) }, ctx as never)
        expect(result.chapter.sortKey).toBe(Number.POSITIVE_INFINITY)
        expect(result.chapter.title).toBe("Extra")
    })
})

describe("weebCentralAdapter.search", () => {
    // The old endpoint (/search?order_by=title&asc_or_desc=asc) only renders the static
    // advanced-search FORM page - live-verified to contain zero real result links. The real
    // results come from the htmx endpoint /search/data.
    it("queries the /search/data endpoint, not the static /search form page", async () => {
        const ctx = makeContext({ [`${ORIGIN}/search/data`]: searchHtml })
        const results = await adapter.search!("solo leveling", ctx as never)
        expect(results.length).toBe(2)
        expect(results[0]!.title).toBe("Solo Leveling")
        expect(results[0]!.sourceId).toBe("weebcentral")
        expect(results[1]!.title).toBe("Solo Leveling 2")
    })

    it("sends the HX-Request header and the live-verified param names", async () => {
        const getText = vi.fn(async (url: URL, _options?: { headers?: Record<string, string> }) => {
            expect(url.pathname).toBe("/search/data")
            expect(url.searchParams.get("text")).toBe("solo leveling")
            expect(url.searchParams.get("sort")).toBe("Best Match")
            expect(url.searchParams.get("order")).toBe("Ascending")
            expect(url.searchParams.get("display_mode")).toBe("Full Display")
            return searchHtml
        })
        const ctx = {
            request: { getText },
            now: () => 1_000_000,
            logger: { debug: vi.fn(), warn: vi.fn() }
        }
        await adapter.search!("solo leveling", ctx as never)
        expect(getText).toHaveBeenCalledTimes(1)
        const [, options] = getText.mock.calls[0]!
        expect(options?.headers?.["HX-Request"]).toBe("true")
    })

    // extractSearchResults must also accept absolute hrefs (see the chapter-list fix above) -
    // searchHtml uses absolute hrefs throughout for both anchors of each result.
    it("dedupes to a single result per series", async () => {
        const ctx = makeContext({ [`${ORIGIN}/search/data`]: searchHtml })
        const results = await adapter.search!("solo leveling", ctx as never)
        expect(results.map(r => r.sourceMangaId)).toEqual([...new Set(results.map(r => r.sourceMangaId))])
    })

    // Each result card renders a mobile-only badge anchor (no class attribute, text can be
    // prefixed with an "Official" ribbon) BEFORE the desktop-only clean-title anchor
    // (class="line-clamp-1 link link-hover") - live-verified, see searchHtml's fixture comment.
    // The old dedup logic kept whichever anchor was encountered first, so on the real site it
    // kept the badge-prefixed title ("Official Solo Leveling") instead of the clean one. This
    // must resolve to the clean title regardless of anchor order in the document.
    it("prefers the clean desktop title over the badge-prefixed mobile title for the same series", async () => {
        const ctx = makeContext({ [`${ORIGIN}/search/data`]: searchHtml })
        const results = await adapter.search!("solo leveling", ctx as never)
        const solo = results.find(r => r.sourceMangaId === SERIES_ID)
        expect(solo?.title).toBe("Solo Leveling")
        expect(solo?.title).not.toContain("Official")
    })
})
