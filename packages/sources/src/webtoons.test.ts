import { createBoundedRequestClient, type FetchFunction, type SourceContext } from "@amr/source-sdk"
import { describe, expect, it } from "vitest"
import {
    COVER_URL,
    FRESH_COVER_URL,
    freshListHtml,
    LEGACY_LIST_URL,
    listHtml,
    noCoverHtml,
    ORIGIN,
    SERIES_LIST_PATH,
    SERIES_PREFIX_URL,
    TITLE_NO,
    UNKNOWN_LIST_PATH
} from "./__fixtures__/webtoons"
import { webtoonsAdapter } from "./webtoons"

function createContext(fixtures: Readonly<Record<string, string>>, requests: string[] = []): SourceContext {
    const fetch: FetchFunction = async (url, init) => {
        requests.push(`${init.method} ${url}`)
        const body = fixtures[new URL(url).pathname]
        return {
            ok: body !== undefined,
            status: body === undefined ? 404 : 200,
            text: async () => body ?? ""
        }
    }
    return {
        request: createBoundedRequestClient({
            fetch,
            allowedOrigins: [ORIGIN],
            maxRequests: 10,
            maxResponseBytes: 1_000_000,
            timeoutMs: 1000
        }),
        now: () => 1_700_000_000_000,
        logger: { debug: () => undefined, warn: () => undefined }
    }
}

describe("webtoonsAdapter.resolveManga", () => {
    it("reads the title from the list page when given the stored series-prefix mangaUrl", async () => {
        const requests: string[] = []
        const context = createContext({ [SERIES_LIST_PATH]: listHtml }, requests)

        const result = await webtoonsAdapter.resolveManga(
            { sourceMangaId: TITLE_NO, url: new URL(SERIES_PREFIX_URL) },
            context
        )

        expect(result.manga.title).toBe("Daisy: How to Become the Duke's Fiancée")
        expect(requests).toEqual([`GET ${ORIGIN}${SERIES_LIST_PATH}?title_no=${TITLE_NO}`])
    })

    it("falls back to the /en/fantasy/unknown/ list when only sourceMangaId is known", async () => {
        const context = createContext({ [UNKNOWN_LIST_PATH]: listHtml })

        const result = await webtoonsAdapter.resolveManga({ sourceMangaId: TITLE_NO }, context)

        expect(result.manga.title).toBe("Daisy: How to Become the Duke's Fiancée")
    })
})

describe("webtoonsAdapter.resolveCover", () => {
    it("resolves the cover from a stored series-prefix mangaUrl", async () => {
        const requests: string[] = []
        const context = createContext({ [SERIES_LIST_PATH]: listHtml }, requests)

        const result = await webtoonsAdapter.resolveCover!(
            { sourceMangaId: TITLE_NO, url: new URL(SERIES_PREFIX_URL) },
            context
        )

        expect(result).toBe(COVER_URL)
        expect(requests.some(r => r.includes(SERIES_LIST_PATH))).toBe(true)
    })

    it("resolves the cover from a legacy list mangaUrl", async () => {
        const context = createContext({ [SERIES_LIST_PATH]: listHtml })

        const result = await webtoonsAdapter.resolveCover!(
            { sourceMangaId: TITLE_NO, url: new URL(LEGACY_LIST_URL) },
            context
        )

        expect(result).toBe(COVER_URL)
    })

    it("falls back to the /en/fantasy/unknown/ trick when only sourceMangaId is known", async () => {
        const requests: string[] = []
        const context = createContext({ [UNKNOWN_LIST_PATH]: listHtml }, requests)

        const result = await webtoonsAdapter.resolveCover!({ sourceMangaId: TITLE_NO }, context)

        expect(result).toBe(COVER_URL)
        expect(requests.some(r => r.includes(UNKNOWN_LIST_PATH))).toBe(true)
    })

    it("re-resolves a fresh cover URL on demand (stale-cover retry scenario)", async () => {
        const context = createContext({ [SERIES_LIST_PATH]: freshListHtml })

        const result = await webtoonsAdapter.resolveCover!(
            { sourceMangaId: TITLE_NO, url: new URL(SERIES_PREFIX_URL) },
            context
        )

        expect(result).toBe(FRESH_COVER_URL)
    })

    it("returns undefined when the page has no og:image", async () => {
        const context = createContext({ [SERIES_LIST_PATH]: noCoverHtml })

        const result = await webtoonsAdapter.resolveCover!(
            { sourceMangaId: TITLE_NO, url: new URL(SERIES_PREFIX_URL) },
            context
        )

        expect(result).toBeUndefined()
    })

    it("returns undefined when neither sourceMangaId nor a title_no-bearing url is provided", async () => {
        const context = createContext({})

        const result = await webtoonsAdapter.resolveCover!({}, context)

        expect(result).toBeUndefined()
    })

    it("returns undefined instead of throwing when the fetch fails", async () => {
        const context = createContext({})

        const result = await webtoonsAdapter.resolveCover!({ sourceMangaId: TITLE_NO }, context)

        expect(result).toBeUndefined()
    })
})

describe("webtoonsAdapter.listChapters hasNext scoping", () => {
    it("does not fetch page 2 when 'page=2' only appears incidentally (e.g. a listpage=2 beacon)", async () => {
        const page1 = `<html><body>
<a href="/en/romance/slug/ep-1/viewer?title_no=${TITLE_NO}&amp;episode_no=1">Episode 1</a>
<img src="https://stats.example.com/b?listpage=2&uid=9" />
</body></html>`
        const requests: string[] = []
        const context = createContext({ [SERIES_LIST_PATH]: page1 }, requests)
        await webtoonsAdapter.listChapters(
            {
                manga: {
                    manga: { id: `webtoons:manga:${TITLE_NO}` },
                    sourceId: "webtoons",
                    sourceMangaId: TITLE_NO,
                    url: SERIES_PREFIX_URL
                }
            } as never,
            context
        )
        const listReqs = requests.filter(r => r.includes(SERIES_LIST_PATH))
        expect(listReqs.length).toBe(1) // no wasted page=2 fetch from the incidental substring
    })
})

describe("webtoonsAdapter.resolveChapter numeric guard", () => {
    it("rejects a non-numeric episode_no instead of producing a NaN sortKey", async () => {
        const context = createContext({})
        const url = new URL(`${ORIGIN}/en/romance/slug/ep-1/viewer?title_no=${TITLE_NO}&episode_no=abc`)
        await expect(webtoonsAdapter.resolveChapter({ url }, context)).rejects.toThrow(/numeric/)
    })
})
