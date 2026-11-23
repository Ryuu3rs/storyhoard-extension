import { createBoundedRequestClient, type FetchFunction, type SourceContext } from "@amr/source-sdk"
import { describe, expect, it } from "vitest"
import { createAdapterFromProfile } from "./create-adapter-from-profile"
import { parseProfile } from "./profile-schema"

const parsed = parseProfile({
    profileFormat: 1,
    id: "example-scans",
    name: "Example Scans",
    engine: "generic",
    origin: "https://example-scans.test",
    domains: ["example-scans.test"],
    languages: ["en"],
    capabilities: ["pages", "chapters"],
    requestRateLimit: { requests: 3, intervalMs: 1000 },
    origins: ["https://example-scans.test/*"],
    match: { manga: "^/manga/([a-z0-9-]+)/?$", chapter: "^/manga/([a-z0-9-]+)/ch-([0-9.]+)/?$" },
    series: { urlTemplate: "/manga/{slug}", titlePattern: "<h1>(?<title>[^<]+)</h1>" },
    list: { itemPattern: '<a href="(?<chapterUrl>/manga/[a-z0-9-]+/ch-(?<chapterNumber>[0-9.]+))">' },
    pages: { imagePatterns: ['<img class="page" src="(?<url>[^"]+)"'] },
    search: {
        urlTemplate: "/search?q={query}",
        itemPattern: '<a class="result" href="(?<url>[^"]+)">(?<title>[^<]+)</a>'
    }
})
if (!parsed.ok) throw new Error(parsed.error)
const profile = parsed.profile

// The site's own search page, hostile or compromised: one honest result, then results that point at
// another host, at a javascript: url and at a data: url whose path still matches the series pattern.
const searchHtml = `<html><body>
<a class="result" href="/manga/real-title">Real Title</a>
<a class="result" href="https://phish.example/manga/real-title">Real Title (mirror)</a>
<a class="result" href="javascript:/manga/x/%0Aalert(document.domain)">Script Title</a>
<a class="result" href="data:/manga/y,hello">Data Title</a>
</body></html>`

function context(): SourceContext {
    const fetch: FetchFunction = async url => {
        const body = new URL(url).pathname === "/search" ? searchHtml : undefined
        return { ok: body !== undefined, status: body ? 200 : 404, text: async () => body ?? "" }
    }
    return {
        request: createBoundedRequestClient({
            fetch,
            allowedOrigins: ["https://example-scans.test/*"],
            maxRequests: 5,
            maxRetries: 0,
            timeoutMs: 1000,
            maxResponseBytes: 1_000_000
        }),
        now: () => 0,
        logger: { debug: () => undefined, warn: () => undefined }
    }
}

describe("profile search results stay on the site's own origin", () => {
    it("keeps only results on the profile's own https origin, like chapter and cover urls", async () => {
        const results = await createAdapterFromProfile(profile).search!("real", context())
        const urls = results.map(r => r.url)
        expect(urls).toEqual(["https://example-scans.test/manga/real-title"])
    })
})
