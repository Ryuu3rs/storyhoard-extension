import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createOriginAllowlist, type SourceManifest, type SourceSearchResult } from "@amr/source-sdk"

const manifest = (id: string): SourceManifest => ({
    id,
    name: id,
    domains: [`${id}.example`],
    languages: ["en"],
    capabilities: ["manga", "chapters"],
    requestRateLimit: { requests: 3, intervalMs: 1000 },
    fixtureVersion: 1
})

function makeAdapter(id: string, results: SourceSearchResult[]) {
    return {
        manifest: manifest(id),
        match: () => "none" as const,
        resolveManga: vi.fn(),
        resolveChapter: vi.fn(),
        listChapters: vi.fn(),
        search: vi.fn().mockResolvedValue(results)
    }
}

const result = (title: string, sourceId = "test-source", altTitles?: string[]): SourceSearchResult => ({
    sourceId,
    sourceMangaId: title.toLowerCase().replace(/\s+/g, "-"),
    title,
    url: `https://example.com/${title}`,
    ...(altTitles ? { altTitles } : {})
})

vi.mock("@amr/sources", async importOriginal => {
    const actual = await importOriginal<typeof import("@amr/sources")>()
    return {
        ...actual,
        sourceRegistry: {
            list: () => listMock(),
            match: vi.fn(),
            get: vi.fn()
        }
    }
})

let listMock: () => ReturnType<typeof makeAdapter>[]

describe("matchesQuery", () => {
    it("requires every whitespace-separated query token to appear in the normalized title", async () => {
        const { matchesQuery } = await import("./sources")
        expect(matchesQuery("The Best Manga Ever", "best")).toBe(true)
        expect(matchesQuery("One Piece", "best")).toBe(false)
        expect(matchesQuery("Attack on Titan", "attack titan")).toBe(true)
        expect(matchesQuery("Attack on Titan", "titan attack")).toBe(true)
        expect(matchesQuery("Attack on Titan", "attack zzz")).toBe(false)
    })

    it("normalizes case and punctuation like entrypoints/app/App.svelte's normTitle", async () => {
        const { matchesQuery } = await import("./sources")
        expect(matchesQuery("Jujutsu Kaisen: Part 2", "jujutsu-kaisen part 2")).toBe(true)
        expect(matchesQuery("Re:Zero", "re zero")).toBe(true)
    })

    it("treats an empty/whitespace query as matching everything", async () => {
        const { matchesQuery } = await import("./sources")
        expect(matchesQuery("Anything", "   ")).toBe(true)
    })

    it("filters non-latin queries instead of matching every title", async () => {
        const { matchesQuery } = await import("./sources")
        // A CJK query must survive normalization and actually filter - it used to
        // collapse to "" under [^a-z0-9], leaving zero tokens and admitting all.
        expect(matchesQuery("Naruto", "ワンピース")).toBe(false)
        expect(matchesQuery("ワンピース", "ワンピース")).toBe(true)
        // Cyrillic behaves the same way.
        expect(matchesQuery("Наруто", "наруто")).toBe(true)
        expect(matchesQuery("One Piece", "наруто")).toBe(false)
    })
})

describe("chaptersForLanguage", () => {
    const ch = (id: string, language?: string) => (language === undefined ? { id } : { id, language })

    it("keeps only the preferred language when the source tags languages", async () => {
        const { chaptersForLanguage } = await import("./sources")
        const list = [ch("a", "en"), ch("b", "pt"), ch("c", "en"), ch("d", "id")]
        expect(chaptersForLanguage(list, "en").map(c => c.id)).toEqual(["a", "c"])
    })

    it("always keeps untagged chapters (single-language scrape sources)", async () => {
        const { chaptersForLanguage } = await import("./sources")
        const list = [ch("a"), ch("b"), ch("c")]
        expect(chaptersForLanguage(list, "fr").map(c => c.id)).toEqual(["a", "b", "c"])
    })

    it("falls back to the full list when nothing matches the preferred language", async () => {
        const { chaptersForLanguage } = await import("./sources")
        const list = [ch("a", "en"), ch("b", "en")]
        expect(chaptersForLanguage(list, "fr").map(c => c.id)).toEqual(["a", "b"])
    })

    it("returns the list unchanged when no language is set", async () => {
        const { chaptersForLanguage } = await import("./sources")
        const list = [ch("a", "en"), ch("b", "pt")]
        expect(chaptersForLanguage(list, "").map(c => c.id)).toEqual(["a", "b"])
    })
})

describe("searchManga result filtering", () => {
    it("drops results whose title doesn't contain every query token", async () => {
        listMock = () => [
            makeAdapter("fuzzy-source", [result("The Best Manga"), result("One Piece"), result("Best Friends")])
        ]
        const { searchManga } = await import("./sources")

        const results = await searchManga("best")

        expect(results.map(r => r.title).sort()).toEqual(["Best Friends", "The Best Manga"])
    })

    it("filters uniformly across multiple adapters", async () => {
        listMock = () => [
            makeAdapter("source-a", [result("Best Manga", "source-a"), result("Unrelated Title", "source-a")]),
            makeAdapter("source-b", [result("The Best Story", "source-b")])
        ]
        const { searchManga } = await import("./sources")

        const results = await searchManga("best")

        expect(results.map(r => r.title).sort()).toEqual(["Best Manga", "The Best Story"])
    })

    it("passes a result whose main title doesn't match but an altTitle does", async () => {
        listMock = () => [
            makeAdapter("mangadex", [
                result("Attack on Titan", "mangadex", ["Shingeki no Kyojin"]),
                result("One Piece", "mangadex", ["Wan Pisu"])
            ])
        ]
        const { searchManga } = await import("./sources")

        const results = await searchManga("shingeki")

        expect(results.map(r => r.title)).toEqual(["Attack on Titan"])
    })

    it("still filters out results with no title or altTitle match", async () => {
        listMock = () => [makeAdapter("mangadex", [result("One Piece", "mangadex", ["Wan Pisu"])])]
        const { searchManga } = await import("./sources")

        const results = await searchManga("naruto")

        expect(results).toEqual([])
    })

    it("keeps title-only matching behavior unchanged for results without altTitles", async () => {
        listMock = () => [
            makeAdapter("test-source", [result("The Best Manga"), result("One Piece"), result("Best Friends")])
        ]
        const { searchManga } = await import("./sources")

        const results = await searchManga("best")

        expect(results.map(r => r.title).sort()).toEqual(["Best Friends", "The Best Manga"])
    })
})

describe("searchManga timeout-skip memo", () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it("excludes a source from search after 3 sequential race-timeouts, then re-probes once after the retry window", async () => {
        const { searchManga } = await import("./sources")
        const id = "flaky-seq-timeout"
        const hangingAdapter = makeAdapter(id, [])
        hangingAdapter.search = vi.fn(() => new Promise(() => {}))
        listMock = () => [hangingAdapter]

        // 3 genuinely sequential timeouts (each call fully awaited before the next
        // starts) build the streak to the skip threshold. The trailing 1ms advance
        // after each is a fake-timer-only precaution: without any elapsed time
        // between one call's settle and the next call's dispatch, both would read
        // the exact same Date.now() tick, tying searchStartedAt with the previous
        // lastIncrementAt and spuriously blocking the sequential-guard's own
        // increment (which requires a STRICT >) - real sequential calls always have
        // some real time pass between them, so this isn't the behavior under test.
        for (let i = 0; i < 3; i++) {
            const pending = searchManga("anything")
            await vi.advanceTimersByTimeAsync(10000)
            await pending
            await vi.advanceTimersByTimeAsync(1)
        }
        expect(hangingAdapter.search).toHaveBeenCalledTimes(3)

        // The streak just crossed the skip threshold, and lastProbeAt hasn't been
        // stamped yet (it defaults to 0, and real elapsed-since-epoch is always well
        // past SEARCH_RETRY_PROBE_MS) - so the very next call is dispatched as an
        // eager first probe, which is what actually stamps lastProbeAt. It times out
        // again too.
        const eagerProbe = searchManga("anything")
        await vi.advanceTimersByTimeAsync(10000)
        await eagerProbe
        expect(hangingAdapter.search).toHaveBeenCalledTimes(4)

        // Genuinely within SEARCH_RETRY_PROBE_MS of that stamped probe now - skipped
        // entirely, no dispatch.
        const skipped = searchManga("anything")
        await vi.advanceTimersByTimeAsync(10000)
        await skipped
        expect(hangingAdapter.search).toHaveBeenCalledTimes(4)

        // Past the retry window since the last probe - included exactly once. Make
        // it succeed to also exercise the streak-reset-on-success path.
        await vi.advanceTimersByTimeAsync(60_001)
        hangingAdapter.search.mockResolvedValueOnce([result("Found It", id)])
        const probeResults = await searchManga("found")
        expect(hangingAdapter.search).toHaveBeenCalledTimes(5)
        expect(probeResults.map(r => r.title)).toEqual(["Found It"])

        // Streak was reset (deleted) by the successful probe - immediately dispatches
        // again rather than staying skipped.
        const afterSuccess = searchManga("anything")
        await vi.advanceTimersByTimeAsync(10000)
        await afterSuccess
        expect(hangingAdapter.search).toHaveBeenCalledTimes(6)
    })

    it("does not double-count a source timing out for two overlapping (concurrent) searchManga calls", async () => {
        const { searchManga } = await import("./sources")
        const id = "flaky-concurrent-timeout"
        const hangingAdapter = makeAdapter(id, [])
        hangingAdapter.search = vi.fn(() => new Promise(() => {}))
        listMock = () => [hangingAdapter]

        // Two calls started close together, both racing the same adapter, both
        // observing its timeout in the same window - the searchStartedAt >
        // lastIncrementAt guard should only let ONE of them register a streak tick.
        const p1 = searchManga("anything")
        const p2 = searchManga("anything")
        await vi.advanceTimersByTimeAsync(10000)
        await Promise.all([p1, p2])
        expect(hangingAdapter.search).toHaveBeenCalledTimes(2)
        // See the sequential test above for why this small gap is needed - it keeps
        // each following call's searchStartedAt strictly after the previous one's
        // settle, matching real-world timing instead of a fake-timer exact tie.
        await vi.advanceTimersByTimeAsync(1)

        // If the concurrent pair had counted as 2 streak ticks, streak would already
        // be 3 (skip threshold) entering p4, and p4 itself would be skipped (call
        // count would stay at 3, not reach 4). Since the guard collapses the
        // concurrent pair to 1 tick, two MORE sequential timeouts (p3, p4) are
        // needed to reach the threshold, so both still dispatch.
        const p3 = searchManga("anything")
        await vi.advanceTimersByTimeAsync(10000)
        await p3
        await vi.advanceTimersByTimeAsync(1)
        expect(hangingAdapter.search).toHaveBeenCalledTimes(3)

        const p4 = searchManga("anything")
        await vi.advanceTimersByTimeAsync(10000)
        await p4
        expect(hangingAdapter.search).toHaveBeenCalledTimes(4)

        // Streak just crossed the threshold - the immediate next call is dispatched
        // as an eager first probe (lastProbeAt not yet stamped - see the sequential
        // test above for the same quirk), and times out again too.
        const p5 = searchManga("anything")
        await vi.advanceTimersByTimeAsync(10000)
        await p5
        expect(hangingAdapter.search).toHaveBeenCalledTimes(5)

        // Now genuinely within the retry window of that stamped probe - skipped.
        const p6 = searchManga("anything")
        await vi.advanceTimersByTimeAsync(10000)
        await p6
        expect(hangingAdapter.search).toHaveBeenCalledTimes(5)
    })

    it("does not apply the searchManga skip memo to searchMangaStreaming", async () => {
        const { searchManga, searchMangaStreaming } = await import("./sources")
        const id = "flaky-streaming-unaffected"
        const hangingAdapter = makeAdapter(id, [])
        hangingAdapter.search = vi.fn(() => new Promise(() => {}))
        listMock = () => [hangingAdapter]

        for (let i = 0; i < 3; i++) {
            const pending = searchManga("anything")
            await vi.advanceTimersByTimeAsync(10000)
            await pending
        }
        expect(hangingAdapter.search).toHaveBeenCalledTimes(3)

        // Benched for searchManga now, but searchMangaStreaming must still dispatch.
        hangingAdapter.search.mockResolvedValueOnce([result("Streaming Found", id)])
        const partials: Array<{ sourceId: string; titles: string[] }> = []
        await new Promise<void>(resolveDone => {
            searchMangaStreaming(
                "streaming",
                (results, sourceId) => partials.push({ sourceId, titles: results.map(r => r.title) }),
                () => resolveDone()
            )
        })
        expect(hangingAdapter.search).toHaveBeenCalledTimes(4)
        expect(partials).toEqual([{ sourceId: id, titles: ["Streaming Found"] }])
    })

    it("applies a 12s race timeout for mangahub search while other adapters use the 10s default", async () => {
        const { searchManga } = await import("./sources")
        const mangahubAdapter = makeAdapter("mangahub", [])
        mangahubAdapter.search = vi.fn(
            () =>
                new Promise(resolve => {
                    setTimeout(() => resolve([result("Searchable Title", "mangahub")]), 11000)
                })
        )
        const otherAdapter = makeAdapter("other-source", [])
        otherAdapter.search = vi.fn(
            () =>
                new Promise(resolve => {
                    setTimeout(() => resolve([result("Searchable Title", "other-source")]), 11000)
                })
        )
        listMock = () => [mangahubAdapter, otherAdapter]

        const pending = searchManga("searchable")
        await vi.advanceTimersByTimeAsync(11000)
        const results = await pending

        // other-source's 10s cap fires before its 11s response lands - only mangahub
        // (12s cap) survives to return a result.
        expect(results.map(r => r.sourceId)).toEqual(["mangahub"])
    })
})

describe("createSourceContext response cache reuse", () => {
    it("shares the response cache across two separately-created contexts for the same sourceId", async () => {
        // Mirrors the real-world scenario this fix targets: resolveCover and
        // resolveGenres each call createSourceContext independently (one context
        // per operation, so their requestCount budgets stay separate - see
        // request.ts), but both fetch the identical manga-page URL for the same
        // sourceId seconds apart. The response cache should be shared so the
        // second operation is served from cache instead of hitting the network again.
        const mangaPageUrl = "https://mangadex.org/title/shared-cache-test"
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            url: mangaPageUrl,
            text: async () => "<html>manga page</html>"
        }))
        vi.stubGlobal("fetch", fetchMock)

        const adapter = {
            manifest: manifest("mangadex"),
            match: () => "none" as const,
            resolveManga: vi.fn(),
            resolveChapter: vi.fn(),
            listChapters: vi.fn(),
            resolveCover: vi.fn(async (_input: unknown, ctx: { request: { getText: (u: URL) => Promise<string> } }) => {
                const body = await ctx.request.getText(new URL(mangaPageUrl))
                return `cover-from:${body}`
            }),
            resolveGenres: vi.fn(
                async (_input: unknown, ctx: { request: { getText: (u: URL) => Promise<string> } }) => {
                    const body = await ctx.request.getText(new URL(mangaPageUrl))
                    return [body]
                }
            )
        }
        const getMock = vi.fn(() => adapter)
        const { sourceRegistry } = await import("@amr/sources")
        vi.mocked(sourceRegistry.get).mockImplementation(getMock as never)

        const { resolveCoverFor, resolveGenresFor } = await import("./sources")

        const cover = await resolveCoverFor({ sourceId: "mangadex", sourceMangaId: "shared-cache-test" })
        const genres = await resolveGenresFor({ sourceId: "mangadex", sourceMangaId: "shared-cache-test" })

        expect(cover).toBe("cover-from:<html>manga page</html>")
        expect(genres).toEqual(["<html>manga page</html>"])
        // Two operations, two independently-constructed contexts/clients - but only
        // one underlying network fetch because the response cache Map is shared per
        // sourceId across createSourceContext calls.
        expect(fetchMock).toHaveBeenCalledTimes(1)

        vi.unstubAllGlobals()
    })
})

describe("listChaptersForSource overrides threading", () => {
    it("threads a timeoutMs/maxRetries override into the real request client instead of the default budget", async () => {
        const hangingFetch = vi.fn(
            (_url: string, init: { signal: AbortSignal }) =>
                new Promise<never>((_resolve, reject) => {
                    init.signal.addEventListener("abort", () => reject(new Error("aborted")))
                })
        )
        vi.stubGlobal("fetch", hangingFetch)

        const adapter = {
            manifest: manifest("hang-source"),
            match: () => "none" as const,
            resolveManga: vi.fn(),
            resolveChapter: vi.fn(),
            listChapters: vi.fn(async (_input: unknown, ctx: { request: { getText: (u: URL) => Promise<string> } }) => {
                // Must be an origin actually present in the real (unmocked)
                // SOURCE_ORIGINS allowlist - createBoundedRequestClient rejects any
                // other origin before ever calling fetch, which would make this test
                // pass for the wrong reason (an origin-check throw, not a timeout).
                await ctx.request.getText(new URL("https://mangadex.org/manga/x"))
                return []
            }),
            search: vi.fn()
        }
        const getMock = vi.fn(() => adapter)
        const { sourceRegistry } = await import("@amr/sources")
        vi.mocked(sourceRegistry.get).mockImplementation(getMock as never)

        const { listChaptersForSource } = await import("./sources")
        const manga = {
            id: "hang-source:manga:x",
            title: "X",
            normalizedTitle: "x",
            authors: [],
            status: "ongoing",
            addedAt: 0,
            updatedAt: 0
        } as never

        // A tiny override (50ms timeout, 0 retries) should make this fail fast. If
        // the override were silently dropped (falling back to the real default of a
        // 15s timeout / 2 retries, ~46s worst case), this call would still be
        // pending when vitest's own test timeout hits - a genuine regression signal,
        // not just an assertion mismatch.
        await expect(
            listChaptersForSource(manga, "hang-source", "x", "https://mangadex.org/manga/x", {
                timeoutMs: 50,
                maxRetries: 0
            })
        ).rejects.toThrow()

        // maxRetries: 0 means exactly one attempt, no retry.
        expect(hangingFetch).toHaveBeenCalledTimes(1)

        vi.unstubAllGlobals()
    })
})

describe("searchMangaStreaming result filtering", () => {
    // The title search never shows adult titles (the catalog step asks weeb.ltd with adult=0), so a title a
    // source itself marks adult does not reach the results under it either.
    it("drops results the source marks adult", async () => {
        listMock = () => [
            makeAdapter("source-a", [
                result("Best Manga", "source-a"),
                { ...result("Best Manga Uncut", "source-a"), isAdult: true }
            ])
        ]
        const { searchMangaStreaming } = await import("./sources")

        const titles: string[] = []
        await new Promise<void>(resolveDone => {
            searchMangaStreaming(
                "best",
                results => titles.push(...results.map(r => r.title)),
                () => resolveDone()
            )
        })

        expect(titles).toEqual(["Best Manga"])
    })

    it("only emits onPartial for adapters with matches after filtering", async () => {
        listMock = () => [
            makeAdapter("source-a", [result("Best Manga", "source-a")]),
            makeAdapter("source-b", [result("Unrelated Title", "source-b")])
        ]
        const { searchMangaStreaming } = await import("./sources")

        const partials: Array<{ sourceId: string; titles: string[] }> = []
        await new Promise<void>(resolveDone => {
            searchMangaStreaming(
                "best",
                (results, sourceId) => {
                    partials.push({ sourceId, titles: results.map(r => r.title) })
                },
                () => resolveDone()
            )
        })

        expect(partials).toEqual([{ sourceId: "source-a", titles: ["Best Manga"] }])
    })

    it("delivers no partials and suppresses onDone once the abort signal fires (closed search UI / superseded query)", async () => {
        let resolveSearch!: (r: SourceSearchResult[]) => void
        const adapter = makeAdapter("slow-source", [])
        adapter.search = vi.fn(
            () =>
                new Promise<SourceSearchResult[]>(resolve => {
                    resolveSearch = resolve
                })
        )
        listMock = () => [adapter]
        const { searchMangaStreaming } = await import("./sources")

        const controller = new AbortController()
        const partials: string[] = []
        let doneCalled = false
        searchMangaStreaming(
            "best",
            (_results, sourceId) => partials.push(sourceId),
            () => {
                doneCalled = true
            },
            controller.signal
        )

        // The UI closes (or a new query starts) before the adapter settles.
        controller.abort()
        resolveSearch([result("Best Manga", "slow-source")])
        await Promise.resolve()
        await Promise.resolve()

        expect(partials).toEqual([])
        expect(doneCalled).toBe(false)
    })

    it("emits results matched only via altTitles", async () => {
        listMock = () => [
            makeAdapter("mangadex", [result("Attack on Titan", "mangadex", ["Shingeki no Kyojin"])]),
            makeAdapter("source-b", [result("Unrelated Title", "source-b")])
        ]
        const { searchMangaStreaming } = await import("./sources")

        const partials: Array<{ sourceId: string; titles: string[] }> = []
        await new Promise<void>(resolveDone => {
            searchMangaStreaming(
                "shingeki",
                (results, sourceId) => {
                    partials.push({ sourceId, titles: results.map(r => r.title) })
                },
                () => resolveDone()
            )
        })

        expect(partials).toEqual([{ sourceId: "mangadex", titles: ["Attack on Titan"] }])
    })
})

describe("searchMangaStreaming race timeout", () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it("applies the 12s mangahub cap in streaming, matching searchManga (an ~11s response survives)", async () => {
        const { searchMangaStreaming } = await import("./sources")
        const mangahubAdapter = makeAdapter("mangahub", [])
        mangahubAdapter.search = vi.fn(
            () =>
                new Promise<SourceSearchResult[]>(resolve => {
                    setTimeout(() => resolve([result("Searchable Title", "mangahub")]), 11000)
                })
        )
        const otherAdapter = makeAdapter("other-source", [])
        otherAdapter.search = vi.fn(
            () =>
                new Promise<SourceSearchResult[]>(resolve => {
                    setTimeout(() => resolve([result("Searchable Title", "other-source")]), 11000)
                })
        )
        listMock = () => [mangahubAdapter, otherAdapter]

        const partials: Array<{ sourceId: string; titles: string[] }> = []
        let doneCalled = false
        searchMangaStreaming(
            "searchable",
            (results, sourceId) => partials.push({ sourceId, titles: results.map(r => r.title) }),
            () => {
                doneCalled = true
            }
        )

        await vi.advanceTimersByTimeAsync(11000)
        await vi.runAllTimersAsync()

        // other-source's 10s cap fires before its 11s response lands; mangahub's 12s cap
        // lets the ~11s response through - same outcome as searchManga.
        expect(partials).toEqual([{ sourceId: "mangahub", titles: ["Searchable Title"] }])
        expect(doneCalled).toBe(true)
    })
})

// Regression: an external-tracked title (added while the chapter page was bot-blocked)
// used to get a source link with NO sourceMangaId, and listMangaChapters threw "The
// source link cannot be refreshed" on every background update forever. It now recovers
// the id from the link URL via the adapter's parseMangaUrl before giving up.
describe("listMangaChapters sourceMangaId heal", () => {
    it("derives sourceMangaId from the link URL via parseMangaUrl when the link lacks it", async () => {
        let seenSourceMangaId: string | undefined
        const adapter = {
            manifest: manifest("healme"),
            match: () => "none" as const,
            resolveManga: vi.fn(),
            resolveChapter: vi.fn(),
            parseMangaUrl: (url: URL) => ({
                sourceMangaId: url.pathname.split("/").filter(Boolean)[1] ?? "",
                mangaUrl: url.toString()
            }),
            listChapters: vi.fn(async (input: { manga: { sourceMangaId: string } }) => {
                seenSourceMangaId = input.manga.sourceMangaId
                return []
            })
        }
        const { sourceRegistry } = await import("@amr/sources")
        vi.mocked(sourceRegistry.get).mockReturnValue(adapter as never)

        const { listMangaChapters } = await import("./sources")
        await listMangaChapters(
            { id: "healme:manga:solo", title: "Solo", sourceId: "healme" } as never,
            {
                mangaId: "healme:manga:solo",
                sourceId: "healme",
                url: "https://healme.example/manga/solo",
                addedAt: 0,
                updatedAt: 0
            } as never
        )

        expect(seenSourceMangaId).toBe("solo")
        expect(adapter.listChapters).toHaveBeenCalledTimes(1)
    })

    it("still throws when the link lacks sourceMangaId and parseMangaUrl can't recover one", async () => {
        const adapter = {
            manifest: manifest("nope"),
            match: () => "none" as const,
            resolveManga: vi.fn(),
            resolveChapter: vi.fn(),
            listChapters: vi.fn()
        }
        const { sourceRegistry } = await import("@amr/sources")
        vi.mocked(sourceRegistry.get).mockReturnValue(adapter as never)

        const { listMangaChapters } = await import("./sources")
        await expect(
            listMangaChapters(
                { id: "nope:manga:x", title: "X", sourceId: "nope" } as never,
                {
                    mangaId: "nope:manga:x",
                    sourceId: "nope",
                    url: "https://nope.example/manga/x",
                    addedAt: 0,
                    updatedAt: 0
                } as never
            )
        ).rejects.toThrow("The source link cannot be refreshed")
        expect(adapter.listChapters).not.toHaveBeenCalled()
    })
})

// Regression test for the bug where createSourceContext stripped every wildcard-scheme
// SOURCE_ORIGINS entry before handing allowedOrigins to createBoundedRequestClient. A source
// whose ONLY origin entries were wildcards was left with an empty effective allowlist, and every
// fetch for it threw invalid-input before any network I/O. This sweep exercises the REAL SOURCE_ORIGINS array through the real origin-check
// logic (createOriginAllowlist, exported from @amr/source-sdk's request.ts) for every
// adapter actually registered in the source registry - the same check createSourceContext
// now performs unfiltered.
describe("SOURCE_ORIGINS + createOriginAllowlist covers every registered source adapter", () => {
    it("accepts a request origin for every adapter's manifest.domains entry", async () => {
        const { sourceAdapters } = await import("@amr/sources")
        const { SOURCE_ORIGINS } = await import("./permissions")
        const isOriginAllowed = createOriginAllowlist(SOURCE_ORIGINS)

        const missing: string[] = []
        for (const adapter of sourceAdapters) {
            for (const domain of adapter.manifest.domains) {
                // A manifest domain may itself be a wildcard subdomain entry - substitute a concrete
                // subdomain label so the constructed URL is valid and still exercises the
                // wildcard-matching branch of isOriginAllowed.
                const host = domain.startsWith("*.") ? `sub${domain.slice(1)}` : domain
                const origin = `https://${host}`
                if (!isOriginAllowed(origin)) {
                    missing.push(`${adapter.manifest.id}: origin "${origin}" (from domain "${domain}") was rejected`)
                }
            }
        }

        expect(missing).toEqual([])
        expect(isOriginAllowed("https://webtoon-phinf.pstatic.net")).toBe(true)
    })
})
