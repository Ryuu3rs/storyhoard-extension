import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
    SourceError,
    SourceRegistry,
    createBoundedRequestClient,
    createOriginAllowlist,
    decodeHtmlEntities,
    isNonPublicHost,
    isPublicHttpsUrl,
    matchesSourceDomain,
    type SourceAdapter
} from "./index"

describe("decodeHtmlEntities", () => {
    it("decodes the common named entities every adapter used to hand-roll", () => {
        expect(decodeHtmlEntities("Rock &amp; Roll")).toBe("Rock & Roll")
        expect(decodeHtmlEntities("&quot;quoted&quot;")).toBe('"quoted"')
        expect(decodeHtmlEntities("Tom&#39;s")).toBe("Tom's")
        expect(decodeHtmlEntities("Tom&apos;s")).toBe("Tom's")
        expect(decodeHtmlEntities("a &lt; b &gt; c")).toBe("a < b > c")
        expect(decodeHtmlEntities("one&nbsp;two")).toBe("one two")
    })

    it("decodes accented Latin-1 named entities (the bug: titles like Fianc&eacute;e)", () => {
        expect(decodeHtmlEntities("Daisy: How to Become the Duke&#39;s Fianc&eacute;e")).toBe(
            "Daisy: How to Become the Duke's Fiancée"
        )
        expect(decodeHtmlEntities("Na&iuml;ve Caf&eacute; owner Fr&auml;ulein M&uuml;ller")).toBe(
            "Naïve Café owner Fräulein Müller"
        )
    })

    it("decodes numeric decimal and hex entities", () => {
        expect(decodeHtmlEntities("&#233;&#233;")).toBe("éé")
        expect(decodeHtmlEntities("&#x27;&#x27;")).toBe("''")
        expect(decodeHtmlEntities("&#x00e9;")).toBe("é")
    })

    it("leaves unknown entity-like text alone instead of throwing", () => {
        expect(decodeHtmlEntities("A &notarealentity; B")).toBe("A &notarealentity; B")
    })

    it("trims the result", () => {
        expect(decodeHtmlEntities("  padded  ")).toBe("padded")
    })
})

describe("matchesSourceDomain", () => {
    it("matches exact domains without matching lookalikes", () => {
        expect(matchesSourceDomain("mangadex.org", ["mangadex.org"])).toBe(true)
        expect(matchesSourceDomain("fake-mangadex.org", ["mangadex.org"])).toBe(false)
    })

    it("matches wildcard subdomains but not the apex domain", () => {
        expect(matchesSourceDomain("uploads.mangadex.org", ["*.mangadex.org"])).toBe(true)
        expect(matchesSourceDomain("mangadex.org", ["*.mangadex.org"])).toBe(false)
    })

    it("normalizes case and a trailing dot", () => {
        expect(matchesSourceDomain("API.MANGADEX.ORG.", ["api.mangadex.org"])).toBe(true)
    })
})

describe("createBoundedRequestClient", () => {
    it("validates JSON and enforces the request limit", async () => {
        const client = createBoundedRequestClient({
            fetch: async () => ({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ value: 7 })
            }),
            allowedOrigins: ["https://api.example.test"],
            maxRequests: 1,
            maxResponseBytes: 100,
            timeoutMs: 100
        })

        await expect(
            client.getJson(new URL("https://api.example.test/value"), z.object({ value: z.number() }))
        ).resolves.toEqual({ value: 7 })
        await expect(
            client.getJson(new URL("https://api.example.test/value"), z.object({ value: z.number() }))
        ).rejects.toMatchObject({ code: "request-limit" })
    })

    it("rejects unexpected origins and invalid payloads", async () => {
        const client = createBoundedRequestClient({
            fetch: async () => ({ ok: true, status: 200, text: async () => "{}" }),
            allowedOrigins: ["https://api.example.test"],
            maxRequests: 2,
            maxResponseBytes: 100,
            timeoutMs: 100
        })

        await expect(
            client.getJson(new URL("https://other.test/value"), z.object({ value: z.number() }))
        ).rejects.toBeInstanceOf(SourceError)
        await expect(
            client.getJson(new URL("https://api.example.test/value"), z.object({ value: z.number() }))
        ).rejects.toMatchObject({ code: "invalid-response" })
    })

    it("rejects a declared Content-Length over the cap before reading the body", async () => {
        let read = false
        const client = createBoundedRequestClient({
            fetch: async () => ({
                ok: true,
                status: 200,
                url: "https://api.example.test/big",
                headers: { "content-length": "999999" },
                text: async () => {
                    read = true
                    return "x"
                }
            }),
            allowedOrigins: ["https://api.example.test"],
            maxRequests: 5,
            maxResponseBytes: 100,
            timeoutMs: 100
        })
        await expect(client.getText(new URL("https://api.example.test/big"))).rejects.toMatchObject({
            code: "request-limit"
        })
        expect(read).toBe(false)
    })

    it("aborts an oversized body stream instead of buffering it whole", async () => {
        let pulls = 0
        const chunk = () => new Uint8Array(60)
        const stream = () => {
            let i = 0
            return new ReadableStream<Uint8Array>({
                pull(controller) {
                    pulls += 1
                    if (i < 4) {
                        i += 1
                        controller.enqueue(chunk())
                    } else {
                        controller.close()
                    }
                }
            })
        }
        const client = createBoundedRequestClient({
            fetch: async () => ({
                ok: true,
                status: 200,
                url: "https://api.example.test/big",
                body: stream(),
                text: async () => {
                    throw new Error("must not fall back to text() when a stream is present")
                }
            }),
            allowedOrigins: ["https://api.example.test"],
            maxRequests: 5,
            maxResponseBytes: 100,
            timeoutMs: 100
        })
        await expect(client.getText(new URL("https://api.example.test/big"))).rejects.toMatchObject({
            code: "request-limit"
        })
        // 60 + 60 = 120 > 100, so it aborts after 2 chunks - never reads all 4.
        expect(pulls).toBeLessThan(4)
    })

    it("fails closed when the final response URL cannot be verified (SSRF guard)", async () => {
        const client = createBoundedRequestClient({
            fetch: async () => ({ ok: true, status: 200, url: "", text: async () => "unverifiable" }),
            allowedOrigins: ["https://api.example.test"],
            maxRequests: 5,
            maxResponseBytes: 1000,
            timeoutMs: 100
        })
        await expect(client.getText(new URL("https://api.example.test/x"))).rejects.toMatchObject({
            code: "invalid-input"
        })
    })
})

describe("createBoundedRequestClient wildcard host origins (mangaread/mangafreak fix)", () => {
    // Regression test for the bug where mangaread/mangafreak's ONLY SOURCE_ORIGINS
    // entries are wildcard host patterns ("*://*.mangafreak.me/*") - the old exact-
    // origin Set built via `new URL(origin).origin` couldn't parse those at all, so
    // every fetch for those sources threw invalid-input before any network I/O.
    it("allows a subdomain mirror and the bare domain, rejects a lookalike and a non-http(s) scheme", async () => {
        const client = createBoundedRequestClient({
            fetch: async () => ({ ok: true, status: 200, text: async () => "mirror-body" }),
            allowedOrigins: ["*://*.mangafreak.me/*"],
            maxRequests: 10,
            maxResponseBytes: 100,
            timeoutMs: 100
        })

        await expect(client.getText(new URL("https://ww2.mangafreak.me/Manga/One-Piece"))).resolves.toBe("mirror-body")
        await expect(client.getText(new URL("https://mangafreak.me/Manga/One-Piece"))).resolves.toBe("mirror-body")
        await expect(client.getText(new URL("https://evilmangafreak.me/Manga/One-Piece"))).rejects.toMatchObject({
            code: "invalid-input"
        })
        await expect(client.getText(new URL("file://mangafreak.me/x"))).rejects.toMatchObject({
            code: "invalid-input"
        })
    })
})

describe("createOriginAllowlist", () => {
    it("accepts exact origins for entries that are plain URL prefixes", () => {
        const isAllowed = createOriginAllowlist(["https://mangadex.org/*"])
        expect(isAllowed("https://mangadex.org")).toBe(true)
        expect(isAllowed("https://evil.test")).toBe(false)
    })

    it("matches a wildcard host pattern against the bare domain and any subdomain, http/https only", () => {
        const isAllowed = createOriginAllowlist(["*://*.mangafreak.me/*"])
        expect(isAllowed("https://mangafreak.me")).toBe(true)
        expect(isAllowed("https://ww1.mangafreak.me")).toBe(true)
        expect(isAllowed("http://ww9.mangafreak.me")).toBe(true)
    })

    it("does not let a lookalike domain or a non-http(s) scheme pass the wildcard check", () => {
        const isAllowed = createOriginAllowlist(["*://*.mangafreak.me/*"])
        // "evilmangafreak.me" ends with "mangafreak.me" as a raw string, but not with
        // the required ".mangafreak.me" dot-boundary, so it must NOT match.
        expect(isAllowed("https://evilmangafreak.me")).toBe(false)
        expect(isAllowed("file://mangafreak.me")).toBe(false)
        expect(isAllowed("chrome-extension://mangafreak.me")).toBe(false)
    })

    it("covers mangaread.org via its wildcard-only SOURCE_ORIGINS entry (the bug this fix targets)", () => {
        const isAllowed = createOriginAllowlist(["*://*.mangaread.org/*"])
        expect(isAllowed("https://mangaread.org")).toBe(true)
        expect(isAllowed("https://cdn.mangaread.org")).toBe(true)
    })
})

describe("createBoundedRequestClient retry + rate limit", () => {
    it("retries transient failures then succeeds", async () => {
        let calls = 0
        const client = createBoundedRequestClient({
            fetch: async () => {
                calls += 1
                if (calls < 3) return { ok: false, status: 503, text: async () => "busy" }
                return { ok: true, status: 200, text: async () => "ok-body" }
            },
            allowedOrigins: ["https://api.example.test"],
            maxRequests: 5,
            maxResponseBytes: 100,
            timeoutMs: 100,
            maxRetries: 2,
            sleep: async () => undefined,
            random: () => 0
        })

        await expect(client.getText(new URL("https://api.example.test/x"))).resolves.toBe("ok-body")
        expect(calls).toBe(3)
    })

    it("does not retry deterministic 4xx responses", async () => {
        let calls = 0
        const client = createBoundedRequestClient({
            fetch: async () => {
                calls += 1
                return { ok: false, status: 404, text: async () => "nope" }
            },
            allowedOrigins: ["https://api.example.test"],
            maxRequests: 5,
            maxResponseBytes: 100,
            timeoutMs: 100,
            sleep: async () => undefined
        })

        await expect(client.getText(new URL("https://api.example.test/x"))).rejects.toMatchObject({
            code: "not-found"
        })
        expect(calls).toBe(1)
    })

    it("gives up after maxRetries on persistent transient failure", async () => {
        let calls = 0
        const client = createBoundedRequestClient({
            fetch: async () => {
                calls += 1
                return { ok: false, status: 500, text: async () => "err" }
            },
            allowedOrigins: ["https://api.example.test"],
            maxRequests: 10,
            maxResponseBytes: 100,
            timeoutMs: 100,
            maxRetries: 2,
            sleep: async () => undefined,
            random: () => 0
        })

        await expect(client.getText(new URL("https://api.example.test/x"))).rejects.toMatchObject({
            code: "request-failed"
        })
        expect(calls).toBe(3)
    })

    it("spaces requests according to the rate limit", async () => {
        const waits: number[] = []
        const client = createBoundedRequestClient({
            fetch: async () => ({ ok: true, status: 200, text: async () => "x" }),
            allowedOrigins: ["https://api.example.test"],
            maxRequests: 10,
            maxResponseBytes: 100,
            timeoutMs: 100,
            rateLimit: { requests: 1, intervalMs: 1000 },
            sleep: async ms => {
                waits.push(ms)
            }
        })

        await client.getText(new URL("https://api.example.test/a"))
        await client.getText(new URL("https://api.example.test/b"))
        await client.getText(new URL("https://api.example.test/c"))

        expect(waits.filter(w => w > 0).length).toBeGreaterThanOrEqual(2)
    })
})

describe("createBoundedRequestClient GET coalescing", () => {
    it("coalesces concurrent identical GETs into one fetch", async () => {
        let calls = 0
        const client = createBoundedRequestClient({
            fetch: async () => {
                calls += 1
                await Promise.resolve()
                return { ok: true, status: 200, text: async () => "shared-body" }
            },
            allowedOrigins: ["https://api.example.test"],
            maxRequests: 10,
            maxResponseBytes: 100,
            timeoutMs: 100
        })

        const url = new URL("https://api.example.test/same")
        const [a, b] = await Promise.all([client.getText(url), client.getText(url)])

        expect(a).toBe("shared-body")
        expect(b).toBe("shared-body")
        expect(calls).toBe(1)
    })

    it("does not coalesce different URLs", async () => {
        let calls = 0
        const client = createBoundedRequestClient({
            fetch: async () => {
                calls += 1
                await Promise.resolve()
                return { ok: true, status: 200, text: async () => "body" }
            },
            allowedOrigins: ["https://api.example.test"],
            maxRequests: 10,
            maxResponseBytes: 100,
            timeoutMs: 100
        })

        await Promise.all([
            client.getText(new URL("https://api.example.test/one")),
            client.getText(new URL("https://api.example.test/two"))
        ])

        expect(calls).toBe(2)
    })

    it("sequential GETs after settle are not shared", async () => {
        let calls = 0
        const client = createBoundedRequestClient({
            fetch: async () => {
                calls += 1
                await Promise.resolve()
                return { ok: true, status: 200, text: async () => "body" }
            },
            allowedOrigins: ["https://api.example.test"],
            maxRequests: 10,
            maxResponseBytes: 100,
            timeoutMs: 100
        })

        const url = new URL("https://api.example.test/same")
        await client.getText(url)
        await client.getText(url)

        expect(calls).toBe(2)
    })
})

describe("createBoundedRequestClient TTL cache", () => {
    it("serves second GET from cache without fetching", async () => {
        let calls = 0
        const fakeNow = 1000
        const client = createBoundedRequestClient({
            fetch: async () => {
                calls += 1
                return { ok: true, status: 200, text: async () => "cached-body" }
            },
            allowedOrigins: ["https://api.example.test"],
            maxRequests: 10,
            maxResponseBytes: 100,
            timeoutMs: 100,
            cacheTtlMs: 5000,
            now: () => fakeNow
        })
        const url = new URL("https://api.example.test/item")
        const a = await client.getText(url)
        const b = await client.getText(url)
        expect(a).toBe("cached-body")
        expect(b).toBe("cached-body")
        expect(calls).toBe(1)
    })

    it("refetches after TTL expires", async () => {
        let calls = 0
        let fakeNow = 1000
        const client = createBoundedRequestClient({
            fetch: async () => {
                calls += 1
                return { ok: true, status: 200, text: async () => `body-${calls}` }
            },
            allowedOrigins: ["https://api.example.test"],
            maxRequests: 10,
            maxResponseBytes: 100,
            timeoutMs: 100,
            cacheTtlMs: 5000,
            now: () => fakeNow
        })
        const url = new URL("https://api.example.test/item")
        await client.getText(url)
        fakeNow += 6000
        const second = await client.getText(url)
        expect(second).toBe("body-2")
        expect(calls).toBe(2)
    })

    // Regression test: expired entries used to be skipped on read but never deleted,
    // so they (each up to maxResponseBytes) accumulated in the shared response-cache
    // Map for as long as the service worker lived. The fix deletes an expired entry
    // on read, and sweeps other expired entries on every successful write.
    it("evicts an expired entry from the shared cache Map instead of leaving it to accumulate", async () => {
        let fakeNow = 1000
        const sharedCache = new Map<string, { body: string; expiresAt: number }>()
        const client = createBoundedRequestClient({
            fetch: async () => ({ ok: true, status: 200, text: async () => "body" }),
            allowedOrigins: ["https://api.example.test"],
            maxRequests: 10,
            maxResponseBytes: 100,
            timeoutMs: 100,
            cacheTtlMs: 5000,
            now: () => fakeNow,
            cache: sharedCache
        })

        const firstUrl = new URL("https://api.example.test/first")
        await client.getText(firstUrl)
        expect(sharedCache.has(firstUrl.toString())).toBe(true)

        // Advance the clock past the first entry's TTL, then trigger a second
        // request (a different URL, exercising the write-time sweep as well as the
        // read-time delete-on-expiry path for the first key).
        fakeNow += 6000
        const secondUrl = new URL("https://api.example.test/second")
        await client.getText(secondUrl)

        expect(sharedCache.has(firstUrl.toString())).toBe(false)
        expect(sharedCache.has(secondUrl.toString())).toBe(true)
    })

    it("does not cache POST responses", async () => {
        let calls = 0
        const client = createBoundedRequestClient({
            fetch: async () => {
                calls += 1
                return { ok: true, status: 200, text: async () => "post-body" }
            },
            allowedOrigins: ["https://api.example.test"],
            maxRequests: 10,
            maxResponseBytes: 100,
            timeoutMs: 100,
            cacheTtlMs: 5000
        })
        const url = new URL("https://api.example.test/form")
        await client.postForm(url, { q: "a" })
        await client.postForm(url, { q: "a" })
        expect(calls).toBe(2)
    })
})

describe("createBoundedRequestClient shared cache option", () => {
    it("serves a second client's GET from a cache Map shared via options.cache, without a second fetch", async () => {
        let calls = 0
        const fakeNow = 1000
        const sharedCache = new Map<string, { body: string; expiresAt: number }>()
        const fetch = async () => {
            calls += 1
            return { ok: true, status: 200, text: async () => "shared-cache-body" }
        }

        const clientA = createBoundedRequestClient({
            fetch,
            allowedOrigins: ["https://api.example.test"],
            maxRequests: 20,
            maxResponseBytes: 100,
            timeoutMs: 100,
            cacheTtlMs: 60_000,
            now: () => fakeNow,
            cache: sharedCache
        })
        const clientB = createBoundedRequestClient({
            fetch,
            allowedOrigins: ["https://api.example.test"],
            maxRequests: 20,
            maxResponseBytes: 100,
            timeoutMs: 100,
            cacheTtlMs: 60_000,
            now: () => fakeNow,
            cache: sharedCache
        })

        const url = new URL("https://api.example.test/item")
        const a = await clientA.getText(url)
        const b = await clientB.getText(url)

        expect(a).toBe("shared-cache-body")
        expect(b).toBe("shared-cache-body")
        // The underlying fetch was only invoked once - client B's call was served
        // from the cache Map shared with client A, even though B never made its
        // own network request for this URL.
        expect(calls).toBe(1)
    })

    it("keeps requestCount/maxRequests fully independent per client even when the cache Map is shared", async () => {
        const sharedCache = new Map<string, { body: string; expiresAt: number }>()
        const fetch = async () => ({ ok: true, status: 200, text: async () => "body" })

        const clientA = createBoundedRequestClient({
            fetch,
            allowedOrigins: ["https://api.example.test"],
            // Client A's budget is exhausted by one request.
            maxRequests: 1,
            maxResponseBytes: 100,
            timeoutMs: 100,
            cache: sharedCache
        })
        const clientB = createBoundedRequestClient({
            fetch,
            allowedOrigins: ["https://api.example.test"],
            maxRequests: 1,
            maxResponseBytes: 100,
            timeoutMs: 100,
            cache: sharedCache
        })

        // Exhaust client A's request-count budget on one URL, then hit its limit on
        // a second, different (uncached) URL - proving the limit is real and per-instance.
        await clientA.getText(new URL("https://api.example.test/a"))
        await expect(clientA.getText(new URL("https://api.example.test/a-2"))).rejects.toMatchObject({
            code: "request-limit"
        })

        // Client B, sharing the same cache Map, still has its own full budget: a
        // fresh (uncached) request on B succeeds even though A's counter is spent.
        await expect(clientB.getText(new URL("https://api.example.test/b"))).resolves.toBe("body")
    })
})

describe("SourceRegistry", () => {
    const adapter = {
        manifest: {
            id: "test",
            name: "Test",
            domains: ["example.test"],
            languages: ["en"],
            capabilities: ["manga", "chapters", "pages"],
            requestRateLimit: { requests: 1, intervalMs: 1000 },
            fixtureVersion: 1
        },
        match: (url: URL) => (url.hostname === "example.test" ? "manga" : "none")
    } as SourceAdapter

    it("registers and matches adapters deterministically", () => {
        const registry = new SourceRegistry([adapter])

        expect(registry.get("test")).toBe(adapter)
        expect(registry.match(new URL("https://example.test/title/1"))).toBe(adapter)
        expect(registry.list()).toEqual([adapter])
    })

    it("rejects duplicate source IDs", () => {
        expect(() => new SourceRegistry([adapter, adapter])).toThrow("Source is already registered")
    })
})

describe("isNonPublicHost / isPublicHttpsUrl", () => {
    it.each([
        "localhost",
        "127.0.0.1",
        "10.0.0.5",
        "192.168.1.1",
        "[::1]",
        "intranet",
        "printer.local",
        "nas.lan",
        "host.localdomain",
        "wiki.corp",
        "files.intranet",
        "secret.private",
        "example.com.",
        "a.b.123",
        "abcdef.onion",
        "site.i2p",
        "host.invalid",
        "1.0.0.10.in-addr.arpa",
        "10.0.0.1.nip.io",
        "192-168-1-1.sslip.io",
        "app.localtest.me"
    ])("treats %s as non-public", host => {
        expect(isNonPublicHost(host)).toBe(true)
    })

    it("accepts an ordinary public hostname", () => {
        expect(isNonPublicHost("reader.example")).toBe(false)
        expect(isPublicHttpsUrl(new URL("https://reader.example/a"))).toBe(true)
    })

    it.each([
        "http://reader.example/a",
        "https://reader.example:8443/a",
        "https://user:pw@reader.example/a",
        "https://127.0.0.1/a"
    ])("rejects %s", raw => {
        expect(isPublicHttpsUrl(new URL(raw))).toBe(false)
    })
})

describe("createBoundedRequestClient requirePublicHttps", () => {
    const base = { maxRequests: 5, maxResponseBytes: 1000, timeoutMs: 100 } as const

    it("discards a response that was redirected to a loopback destination", async () => {
        const client = createBoundedRequestClient({
            ...base,
            fetch: async () => ({ ok: true, status: 200, url: "https://127.0.0.1/admin", text: async () => "secret" }),
            allowedOrigins: ["https://reader.example/*", "https://127.0.0.1/*"],
            requirePublicHttps: true
        })
        await expect(client.getText(new URL("https://reader.example/a"))).rejects.toMatchObject({
            code: "invalid-input"
        })
    })

    it("blocks a redirect to an origin outside the allowlist", async () => {
        const client = createBoundedRequestClient({
            ...base,
            fetch: async () => ({ ok: true, status: 200, url: "http://localhost/x", text: async () => "secret" }),
            allowedOrigins: ["https://reader.example/*"],
            requirePublicHttps: true
        })
        await expect(client.getText(new URL("https://reader.example/a"))).rejects.toMatchObject({
            code: "invalid-input"
        })
    })

    it("refuses a non-public request URL before any fetch", async () => {
        let called = false
        const client = createBoundedRequestClient({
            ...base,
            fetch: async () => {
                called = true
                return { ok: true, status: 200, text: async () => "x" }
            },
            allowedOrigins: ["https://localhost/*"],
            requirePublicHttps: true
        })
        await expect(client.getText(new URL("https://localhost/a"))).rejects.toMatchObject({ code: "invalid-input" })
        expect(called).toBe(false)
    })

    it("still allows a normal public same-origin response", async () => {
        const client = createBoundedRequestClient({
            ...base,
            fetch: async () => ({ ok: true, status: 200, url: "https://reader.example/b", text: async () => "ok" }),
            allowedOrigins: ["https://reader.example/*"],
            requirePublicHttps: true
        })
        await expect(client.getText(new URL("https://reader.example/a"))).resolves.toBe("ok")
    })
})
