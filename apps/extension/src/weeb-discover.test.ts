import { describe, expect, it, vi } from "vitest"
import {
    COLD_START_LIBRARY_SIZE,
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
    visibleRails,
    withoutOwned,
    type WeebDiscoverRail
} from "./weeb-discover"

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
