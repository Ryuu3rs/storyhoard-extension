import { describe, expect, it, vi } from "vitest"
import {
    COLD_START_LIBRARY_SIZE,
    DISCOVER_CACHE_BUDGET,
    DISCOVER_RETRY_MS,
    DISCOVER_TTL_MS,
    createWeebDiscoverSource,
    discoverItemAsTitle,
    fetchDiscoverRail,
    isColdStartLibrary,
    loadWeebDiscover,
    parseDiscoverItem,
    parseDiscoverRail,
    parsePicks,
    planToReadRequest,
    visibleRails,
    withoutOwned,
    type WeebDiscoverRail
} from "./weeb-discover"
import { runtimeRequestSchema } from "./runtime"

const SITE = "https://weeb.example"

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

const item = {
    anilistId: 105398,
    workId: "w_solo",
    title: "Solo Leveling",
    altTitles: ["Na Honjaman Level Up", "Solo Leveling", "나 혼자만 레벨업"],
    cover: "https://s4.anilist.co/file/cover.jpg",
    mediaType: "manhwa",
    genres: ["Action", "Fantasy"],
    isAdult: false,
    metric: "1.2k readers this week"
}

const railBody = (rail: string, items: unknown[], extra: Record<string, unknown> = {}) => ({
    rail,
    label: rail === "seasonal" ? "Fall 2026" : rail,
    note: null,
    genre: null,
    items,
    ...extra
})

// A fetch that answers each rail from a table and records every request it was given.
function railFetch(answers: Record<string, () => Response>) {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        calls.push({ url: url.href, init })
        const key = url.pathname === "/api/public/picks" ? "picks" : (url.searchParams.get("rail") ?? "")
        const answer = answers[key]
        return answer ? answer() : new Response("<html>not found</html>", { status: 404 })
    })
    return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

describe("parseDiscoverItem", () => {
    it("keeps a well-formed item, minus its own title from the other names", () => {
        expect(parseDiscoverItem(item)).toEqual({
            anilistId: 105398,
            workId: "w_solo",
            title: "Solo Leveling",
            altTitles: ["Na Honjaman Level Up", "나 혼자만 레벨업"],
            cover: "https://s4.anilist.co/file/cover.jpg",
            mediaType: "manhwa",
            genres: ["Action", "Fantasy"],
            metric: "1.2k readers this week"
        })
    })

    it("drops adult titles, titles with no id, and titles with no usable name", () => {
        expect(parseDiscoverItem({ ...item, isAdult: true })).toBeNull()
        expect(parseDiscoverItem({ ...item, isAdult: "false" })).toBeNull()
        expect(parseDiscoverItem({ ...item, anilistId: null, workId: null })).toBeNull()
        expect(parseDiscoverItem({ ...item, anilistId: -4 })).toBeNull()
        expect(parseDiscoverItem({ ...item, anilistId: 1.5 })).toBeNull()
        expect(parseDiscoverItem({ ...item, workId: "../../etc" })).toBeNull()
        expect(parseDiscoverItem({ ...item, title: " ​\u0007 " })).toBeNull()
        expect(parseDiscoverItem("Solo Leveling")).toBeNull()
        expect(parseDiscoverItem([item])).toBeNull()
    })

    it("refuses a cover that is not a public https address, and an unknown media type", () => {
        for (const cover of [
            "http://s4.anilist.co/c.jpg",
            "https://127.0.0.1/c.jpg",
            "https://localhost/c.jpg",
            "javascript:alert(1)",
            42
        ]) {
            expect(parseDiscoverItem({ ...item, cover })?.cover).toBeNull()
        }
        expect(parseDiscoverItem({ ...item, cover: "https://weeb.ltd/api/cover?u=x&sig=y" })?.cover).toBe(
            "https://weeb.ltd/api/cover?u=x&sig=y"
        )
        expect(parseDiscoverItem({ ...item, mediaType: "comic" })?.mediaType).toBeNull()
    })

    it("cleans page text out of names and caps the lists", () => {
        const parsed = parseDiscoverItem({
            ...item,
            title: "Solo‮ Leveling\u0000",
            altTitles: Array.from({ length: 20 }, (_, i) => `Name ${i}`),
            genres: ["Action", 7, "action", "  "]
        })
        expect(parsed?.title).toBe("Solo Leveling")
        expect(parsed?.altTitles).toHaveLength(8)
        expect(parsed?.genres).toEqual(["Action"])
    })
})

describe("parseDiscoverRail", () => {
    it("needs the rail that was asked for, and drops duplicate and bad items", () => {
        const body = railBody("trending", [item, item, { ...item, isAdult: true, anilistId: 2 }, { title: "x" }])
        expect(parseDiscoverRail(body, "seasonal")).toBeNull()
        expect(parseDiscoverRail({ ...body, items: "nope" }, "trending")).toBeNull()
        expect(parseDiscoverRail(body, "trending")?.items).toHaveLength(1)
    })

    it("falls back to a default label and keeps the community note", () => {
        const rail = parseDiscoverRail(
            railBody("community", [item], { label: "", note: "This week's vote" }),
            "community"
        )
        expect(rail).toMatchObject({ label: "Community picks", note: "This week's vote" })
    })
})

describe("fetchDiscoverRail", () => {
    it("asks without cookies, for non-adult titles only", async () => {
        const { fetch, calls } = railFetch({ trending: () => json(railBody("trending", [item])) })
        const result = await fetchDiscoverRail({ siteBase: SITE, fetch }, "trending")
        expect(result.ok).toBe(true)
        expect(calls[0]!.init?.credentials).toBe("omit")
        const url = new URL(calls[0]!.url)
        expect(url.searchParams.get("adult")).toBe("0")
        expect(url.searchParams.get("rail")).toBe("trending")
    })

    it("tells an unknown genre (with the genre list) from an endpoint that is not there", async () => {
        const { fetch } = railFetch({
            genre: () => json({ error: "genre must be one of the Discover genres", genres: ["Action", "Romance"] }, 404)
        })
        expect(await fetchDiscoverRail({ siteBase: SITE, fetch }, "genre", { genre: "Nope" })).toEqual({
            ok: false,
            status: "unknown-genre",
            genres: ["Action", "Romance"]
        })
        expect(await fetchDiscoverRail({ siteBase: SITE, fetch }, "trending")).toEqual({
            ok: false,
            status: "missing"
        })
    })

    it("answers 400, 429, 503, bad JSON and network failures quietly", async () => {
        const cases: [() => Response | Promise<Response>, string][] = [
            [() => json({ error: "bad" }, 400), "bad-request"],
            [() => json({ error: "slow down" }, 429), "rate-limited"],
            [() => json({ error: "down" }, 503), "unavailable"],
            [() => new Response("not json", { status: 200 }), "unavailable"],
            [() => Promise.reject(new TypeError("offline")), "unavailable"]
        ]
        for (const [answer, status] of cases) {
            const fetch = vi.fn(async () => answer()) as unknown as typeof globalThis.fetch
            expect(await fetchDiscoverRail({ siteBase: SITE, fetch }, "staff")).toEqual({ ok: false, status })
        }
    })
})

describe("loadWeebDiscover", () => {
    it("loads the four main rails and hides an empty one", async () => {
        const { fetch } = railFetch({
            trending: () => json(railBody("trending", [item])),
            seasonal: () => json(railBody("seasonal", [{ ...item, anilistId: 2, workId: null, title: "Season One" }])),
            staff: () => json(railBody("staff", [])),
            community: () => json(railBody("community", [{ ...item, anilistId: 3, workId: null, title: "Voted" }]))
        })
        const loaded = await loadWeebDiscover({ siteBase: SITE, fetch }, 1000)
        expect(loaded.source).toBe("discover")
        expect(loaded.rails.map(r => r.rail)).toEqual(["trending", "seasonal", "community"])
        expect(loaded.rails[1]!.label).toBe("Fall 2026")
    })

    it("falls back to the picks list while the discover endpoint is not deployed", async () => {
        const { fetch, calls } = railFetch({
            picks: () =>
                json({
                    community: {
                        source: "week",
                        label: "This week's vote",
                        items: [{ anilistId: 30013, title: "One Piece", coverUrl: null, metric: "41 votes" }]
                    },
                    trending: [
                        {
                            anilistId: 105398,
                            title: "Solo Leveling",
                            coverUrl: "https://s4.anilist.co/c.jpg",
                            metric: "hot"
                        },
                        { anilistId: "x", title: "Bad id", coverUrl: null, metric: "" }
                    ]
                })
        })
        const loaded = await loadWeebDiscover({ siteBase: SITE, fetch }, 1000)
        expect(loaded.source).toBe("picks")
        expect(loaded.rails.map(r => [r.rail, r.items.length, r.note])).toEqual([
            ["trending", 1, null],
            ["community", 1, "This week's vote"]
        ])
        expect(calls.every(call => call.init?.credentials === "omit")).toBe(true)
    })

    it("does not fall back while rate limited, and reports nothing when both are down", async () => {
        const limited = railFetch({ trending: () => json({}, 429), picks: () => json({ trending: [] }) })
        expect((await loadWeebDiscover({ siteBase: SITE, fetch: limited.fetch }, 1)).source).toBe("none")
        expect(limited.calls.some(call => call.url.includes("/picks"))).toBe(false)

        const down = railFetch({})
        expect(await loadWeebDiscover({ siteBase: SITE, fetch: down.fetch }, 1)).toEqual({
            rails: [],
            source: "none",
            fetchedAt: 1
        })
    })

    it("leaves out the picks community list while it is only trending again", () => {
        const rails = parsePicks({
            community: {
                source: "trending",
                label: "Trending, until the votes come in",
                items: [{ anilistId: 1, title: "A" }]
            },
            trending: [{ anilistId: 1, title: "A" }]
        })
        expect(rails?.map(r => r.rail)).toEqual(["trending"])
    })
})

describe("visibleRails", () => {
    it("hides a community rail that only repeats trending", () => {
        const a = parseDiscoverItem({ ...item, anilistId: 1 })!
        const b = parseDiscoverItem({ ...item, anilistId: 2 })!
        const rail = (r: WeebDiscoverRail["rail"], items = [a, b]): WeebDiscoverRail => ({
            rail: r,
            label: r,
            note: null,
            genre: null,
            items
        })
        expect(visibleRails([rail("trending"), rail("community")]).map(r => r.rail)).toEqual(["trending"])
        expect(visibleRails([rail("trending", [a]), rail("community")]).map(r => r.rail)).toEqual([
            "trending",
            "community"
        ])
    })
})

describe("createWeebDiscoverSource", () => {
    function setup(answers: Record<string, () => Response>, stored: unknown = undefined) {
        let now = 1_000_000
        let saved = stored
        const { fetch, calls } = railFetch(answers)
        const source = createWeebDiscoverSource({
            siteBase: SITE,
            fetch,
            now: () => now,
            store: {
                read: async () => saved,
                write: async entry => {
                    saved = JSON.parse(JSON.stringify(entry))
                }
            }
        })
        return {
            source,
            calls,
            advance: (ms: number) => (now += ms),
            saved: () => saved
        }
    }
    const answers = { trending: () => json(railBody("trending", [item])) }

    it("asks weeb.ltd once per ten minutes and shares one load between callers", async () => {
        const { source, calls, advance } = setup(answers)
        const [a, b] = await Promise.all([source.get(), source.get()])
        expect(a).toBe(b)
        const first = calls.length
        expect(first).toBe(4)
        advance(DISCOVER_TTL_MS - 1)
        await source.get()
        expect(calls.length).toBe(first)
        advance(2)
        await source.get()
        expect(calls.length).toBe(first * 2)
    })

    it("reuses a fresh stored copy after the background restarts", async () => {
        const first = setup(answers)
        await first.source.get()
        const second = setup(answers, first.saved())
        const loaded = await second.source.get()
        expect(second.calls).toHaveLength(0)
        expect(loaded.rails[0]!.items[0]!.title).toBe("Solo Leveling")
    })

    it("keeps the last rails while weeb.ltd is down, and retries after a minute", async () => {
        let up = true
        const { source, calls, advance } = setup({
            trending: () => (up ? json(railBody("trending", [item])) : json({}, 503))
        })
        await source.get()
        up = false
        advance(DISCOVER_TTL_MS + 1)
        const stale = await source.get()
        expect(stale.rails).toHaveLength(1)
        const asked = calls.length
        await source.get()
        expect(calls.length).toBe(asked)
        advance(DISCOVER_RETRY_MS + 1)
        await source.get()
        expect(calls.length).toBeGreaterThan(asked)
    })

    it("ignores a stored copy of the wrong shape", async () => {
        const { source, calls } = setup(answers, { value: { rails: "x" }, checkedAt: 1_000_000 })
        await source.get()
        expect(calls.length).toBe(4)
    })
})

describe("library exclusion and the near-empty switch", () => {
    const rails: WeebDiscoverRail[] = [
        {
            rail: "trending",
            label: "Trending",
            note: null,
            genre: null,
            items: [
                parseDiscoverItem(item)!,
                parseDiscoverItem({ ...item, anilistId: 2, workId: "w_two", title: "Second Title", altTitles: [] })!,
                parseDiscoverItem({
                    ...item,
                    anilistId: 3,
                    workId: null,
                    title: "Third Title",
                    altTitles: ["Drittes"]
                })!
            ]
        },
        {
            rail: "staff",
            label: "Staff picks",
            note: null,
            genre: null,
            items: [parseDiscoverItem({ ...item, anilistId: 4, workId: null, title: "Only Pick", altTitles: [] })!]
        }
    ]

    it("never shows a title the library has, by AniList id, Work id, name or other name", () => {
        expect(withoutOwned(rails, [{ title: "Something else", anilistId: 105398 }])[0]!.items).toHaveLength(2)
        expect(withoutOwned(rails, [{ title: "Renamed by me", workId: "w_two" }])[0]!.items).toHaveLength(2)
        expect(withoutOwned(rails, [{ title: "na honjaman level-up" }])[0]!.items).toHaveLength(2)
        expect(withoutOwned(rails, [{ title: "Drittes" }])[0]!.items.map(i => i.title)).toEqual([
            "Solo Leveling",
            "Second Title"
        ])
    })

    it("drops a rail the library empties", () => {
        expect(withoutOwned(rails, [{ title: "Only Pick" }]).map(r => r.rail)).toEqual(["trending"])
    })

    it("leads with weeb.ltd rails below five titles", () => {
        expect(COLD_START_LIBRARY_SIZE).toBe(5)
        expect(isColdStartLibrary(0)).toBe(true)
        expect(isColdStartLibrary(4)).toBe(true)
        expect(isColdStartLibrary(5)).toBe(false)
    })

    it("opens as a catalog title with no adult flag and no facts it lacks", () => {
        expect(discoverItemAsTitle(parseDiscoverItem(item)!)).toMatchObject({
            title: "Solo Leveling",
            anilistId: 105398,
            workId: "w_solo",
            isAdult: false,
            status: null,
            year: null
        })
    })
})

describe("the live discover shape", () => {
    const live = {
        rail: "community",
        label: "Community picks",
        note: "Trending, until the votes come in",
        genre: null,
        items: [
            {
                anilistId: null,
                workId: "bf9e5edf-83df-42a8-b5b3-9bad3614acb6",
                title: "Catalog Only Title",
                altTitles: [
                    "Other One",
                    "Other Two",
                    "Other Three",
                    "Other Four",
                    "Other Five",
                    "Other Six",
                    "Other Seven",
                    "Other Eight"
                ],
                cover: "https://uploads.mangadex.org/covers/77bee52c/6079dd31.jpg.512.jpg",
                mediaType: "webtoon",
                genres: ["Drama"],
                isAdult: false,
                metric: "12 readers"
            },
            { ...item, workId: null }
        ]
    }

    it("keeps an item with only a Work id, its eight other names and its catalog cover", () => {
        const rail = parseDiscoverRail(live, "community", 24)!
        expect(rail.items).toHaveLength(2)
        expect(rail.items[0]).toMatchObject({
            anilistId: null,
            workId: "bf9e5edf-83df-42a8-b5b3-9bad3614acb6",
            mediaType: "webtoon",
            cover: "https://uploads.mangadex.org/covers/77bee52c/6079dd31.jpg.512.jpg"
        })
        expect(rail.items[0]!.altTitles).toHaveLength(8)
        expect(rail.note).toBe("Trending, until the votes come in")
    })

    it("asks for the picks list only when every discover rail failed", async () => {
        const { fetch, calls } = railFetch({
            trending: () => json(railBody("trending", [])),
            seasonal: () => json({}, 503),
            staff: () => json({}, 503),
            community: () => json({}, 503),
            picks: () => json({ trending: [{ anilistId: 1, title: "A" }] })
        })
        const loaded = await loadWeebDiscover({ siteBase: SITE, fetch }, 1)
        expect(loaded.source).toBe("discover")
        expect(calls.some(call => call.url.includes("/picks"))).toBe(false)
    })
})

describe("planToReadRequest", () => {
    it("is the existing quick-add as Plan to read, with names, type, genres and a public cover", () => {
        const title = discoverItemAsTitle(parseDiscoverItem(item)!)
        expect(planToReadRequest(title)).toEqual({
            type: "library:quick-add",
            anilistId: 105398,
            workId: "w_solo",
            title: "Solo Leveling",
            altTitles: ["Na Honjaman Level Up", "나 혼자만 레벨업"],
            coverUrl: "https://s4.anilist.co/file/cover.jpg",
            genres: ["Action", "Fantasy"],
            mediaType: "manhwa",
            mode: "planning"
        })
    })

    it("leaves out a cover that is not public", () => {
        const title = discoverItemAsTitle(parseDiscoverItem(item)!)
        expect(planToReadRequest({ ...title, cover: "https://127.0.0.1/c.jpg" })).not.toHaveProperty("coverUrl")
    })

    it("adds a title with only a Work id, keyed by that id", () => {
        const title = discoverItemAsTitle(parseDiscoverItem({ ...item, anilistId: null })!)
        const request = planToReadRequest(title)
        expect(request).toMatchObject({ type: "library:quick-add", workId: "w_solo", mode: "planning" })
        expect(request).not.toHaveProperty("anilistId")
        const checked = runtimeRequestSchema.safeParse(request)
        expect(checked.success).toBe(true)
    })

    it("needs an AniList id or a well-formed Work id", () => {
        const title = discoverItemAsTitle(parseDiscoverItem(item)!)
        expect(planToReadRequest({ ...title, anilistId: null, workId: null })).toBeNull()
        expect(planToReadRequest({ ...title, anilistId: null, workId: "../x" })).toBeNull()
        expect(planToReadRequest({ ...title, workId: "has space" })).not.toHaveProperty("workId")
    })

    it("an added title leaves the rails, under its other names too", () => {
        const rails: WeebDiscoverRail[] = [
            {
                rail: "trending",
                label: "Trending",
                note: null,
                genre: null,
                items: [parseDiscoverItem({ ...item, anilistId: 7, workId: null, title: "Drittes", altTitles: [] })!]
            }
        ]
        expect(withoutOwned(rails, [{ title: "Third Title", altTitles: ["Drittes"] }])).toEqual([])
    })
})

const rawItem = (anilistId: number, title: string, extra: Record<string, unknown> = {}) => ({
    anilistId,
    workId: null,
    title,
    altTitles: [],
    cover: `https://s4.anilist.co/file/${anilistId}.png`,
    mediaType: "manga",
    genres: ["Action"],
    isAdult: false,
    metric: "1 reader",
    ...extra
})

const oneRail = (items: WeebDiscoverRail["items"]): WeebDiscoverRail => ({
    rail: "trending",
    label: "Trending",
    note: null,
    genre: null,
    items
})

describe("owned titles leave the rails", () => {
    it("drops a short-named title the library already has under the same name", () => {
        const short = parseDiscoverItem(rawItem(116589, "86"))!
        expect(withoutOwned([oneRail([short])], [{ title: "86" }])).toEqual([])
        expect(withoutOwned([oneRail([short])], [{ title: "86 Eighty Six" }])).toHaveLength(1)
    })

    it("reads each library title once when filtering four rails against a 3000-title library", () => {
        const rails = (["trending", "seasonal", "staff", "community"] as const).map((_, k) =>
            oneRail(
                Array.from(
                    { length: 16 },
                    (_, i) =>
                        parseDiscoverItem(
                            rawItem(k * 100 + i + 1, `Some Rail Title ${k} ${i}`, {
                                altTitles: Array.from({ length: 8 }, (_, j) => `Alt name ${j} for ${k} ${i}`)
                            })
                        )!
                )
            )
        )
        let nameReads = 0
        const library = Array.from({ length: 3000 }, (_, i) => ({
            get title() {
                nameReads++
                return `Library Title Number ${i} with words`
            },
            anilistId: 100000 + i
        }))
        const itemCount = rails.reduce((sum, rail) => sum + rail.items.length, 0)

        const start = performance.now()
        const kept = withoutOwned(rails, library)
        const elapsed = performance.now() - start

        expect(kept.flatMap(rail => rail.items)).toHaveLength(itemCount)
        expect(nameReads).toBeLessThanOrEqual(library.length * 2)
        expect(elapsed).toBeLessThan(250)
    })
})

describe("Add to library from a rail item", () => {
    it("makes a valid quick-add message when an other name is long in code units", () => {
        // 200 letters with a combining accent each: 200 characters a reader sees, 400 code units.
        const longAlt = "e\u0301".repeat(200)
        const parsed = parseDiscoverItem(rawItem(5000, "Long Name Title", { altTitles: [longAlt, "Short Name"] }))!
        expect(parsed.altTitles).toHaveLength(2)
        const request = planToReadRequest(discoverItemAsTitle(parsed))!
        expect(request.altTitles).toEqual(["Short Name"])
        const checked = runtimeRequestSchema.safeParse(request)
        expect(checked.success, checked.success ? "" : checked.error.issues.map(i => i.message).join("; ")).toBe(true)
    })
})

describe("what the Discover cache stores", () => {
    it("refuses a cover link longer than the catalog's 2048 limit", () => {
        const long = parseDiscoverItem(
            rawItem(1, "Big Cover", { cover: `https://s4.anilist.co/file/a.png?x=${"a".repeat(100_000)}` })
        )
        expect(long?.cover).toBeNull()
        const fits = `https://s4.anilist.co/file/a.png?x=${"a".repeat(1900)}`
        expect(parseDiscoverItem(rawItem(2, "Fits", { cover: fits }))?.cover).toBe(fits)
    })

    it("one response cannot make the stored cache entry large", async () => {
        const huge = (id: number) =>
            rawItem(id, `Title ${id}`, { cover: `https://s4.anilist.co/file/${id}.png?pad=${"a".repeat(200_000)}` })
        const fetchFn = (async (input: string) => {
            const r = new URL(input).searchParams.get("rail")
            return json({
                rail: r,
                label: r,
                items: Array.from({ length: 16 }, (_, i) => huge((r?.length ?? 1) * 100 + i))
            })
        }) as unknown as typeof fetch
        let written = 0
        const source = createWeebDiscoverSource({
            siteBase: SITE,
            fetch: fetchFn,
            now: () => 1_000_000,
            store: {
                read: async () => undefined,
                write: async entry => {
                    written = JSON.stringify(entry).length
                }
            }
        })
        await source.get()
        expect(written).toBeLessThan(DISCOVER_CACHE_BUDGET)
    })

    it("keeps an entry over the size budget in memory only", async () => {
        const wordy = (id: number) =>
            rawItem(id, `Title ${id}`, {
                altTitles: Array.from({ length: 8 }, (_, j) => `${id} ${j} ${"e\u0301\u0302\u0303".repeat(290)}`)
            })
        const fetchFn = (async (input: string) => {
            const r = new URL(input).searchParams.get("rail")
            return json({
                rail: r,
                label: r,
                items: Array.from({ length: 16 }, (_, i) => wordy((r?.length ?? 1) * 100 + i))
            })
        }) as unknown as typeof fetch
        const write = vi.fn(async () => undefined)
        const source = createWeebDiscoverSource({
            siteBase: SITE,
            fetch: fetchFn,
            now: () => 1_000_000,
            store: { read: async () => undefined, write }
        })
        const loaded = await source.get()
        expect(loaded.rails.length).toBeGreaterThan(0)
        expect(write).not.toHaveBeenCalled()
    })
})
