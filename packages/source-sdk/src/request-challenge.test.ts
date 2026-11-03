import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { SourceChallengeError, SourceRequestError } from "./errors"
import { createBoundedRequestClient, type FetchFunction, type FetchResponse } from "./request"

const SITE = "https://reader.example"
const OTHER = "https://other.example"

function respond(overrides: Partial<FetchResponse> & { body?: never } = {}, text = "ok"): FetchResponse {
    return { ok: true, status: 200, text: async () => text, ...overrides }
}

function client(fetch: FetchFunction, extra: Partial<Parameters<typeof createBoundedRequestClient>[0]> = {}) {
    return createBoundedRequestClient({
        fetch,
        allowedOrigins: [`${SITE}/*`, `${OTHER}/*`, "https://api.reader.example/*"],
        maxRequests: 10,
        maxResponseBytes: 1024 * 1024,
        timeoutMs: 1000,
        sleep: async () => undefined,
        ...extra
    })
}

describe("bounded client: challenge detection", () => {
    it("throws a challenge carrying the request origin when redirected onto a challenge path", async () => {
        const fetch = vi.fn<FetchFunction>(async () => respond({ url: `${SITE}/edge/challenge` }))
        const error = await client(fetch)
            .getText(new URL("https://api.reader.example/list"))
            .catch(e => e)
        expect(error).toBeInstanceOf(SourceChallengeError)
        expect((error as SourceChallengeError).origin).toBe("https://api.reader.example")
    })

    it("throws a challenge for HTML where JSON was expected, but parses HTML when text was asked for", async () => {
        const html = "<!doctype html><html><body>Hello</body></html>"
        const fetch = vi.fn<FetchFunction>(async () => respond({}, html))
        await expect(client(fetch).getJson(new URL(`${SITE}/api`), z.any())).rejects.toBeInstanceOf(
            SourceChallengeError
        )
        await expect(client(fetch).getText(new URL(`${SITE}/page`))).resolves.toBe(html)
    })

    it("does not retry a challenge, even a 503", async () => {
        const fetch = vi.fn<FetchFunction>(async () =>
            respond({ ok: false, status: 503 }, "<title>Just a moment...</title>")
        )
        await expect(client(fetch).getText(new URL(`${SITE}/page`))).rejects.toBeInstanceOf(SourceChallengeError)
        expect(fetch).toHaveBeenCalledTimes(1)
    })

    it("keeps retrying a plain 503 and reporting a plain 403 as before", async () => {
        const unavailable = vi.fn<FetchFunction>(async () => respond({ ok: false, status: 503 }, "busy"))
        const error = await client(unavailable)
            .getText(new URL(`${SITE}/page`))
            .catch(e => e)
        expect(error).toBeInstanceOf(SourceRequestError)
        expect(error).not.toBeInstanceOf(SourceChallengeError)
        expect(unavailable).toHaveBeenCalledTimes(3)

        const forbidden = vi.fn<FetchFunction>(async () => respond({ ok: false, status: 403 }, "Forbidden"))
        const refused = await client(forbidden)
            .getText(new URL(`${SITE}/page`))
            .catch(e => e)
        expect(refused).not.toBeInstanceOf(SourceChallengeError)
        expect((refused as SourceRequestError).status).toBe(403)
    })

    it("still refuses a redirect to an origin outside the allowlist, challenge path or not", async () => {
        const fetch = vi.fn<FetchFunction>(async () => respond({ url: "https://ads.example/challenge" }))
        const error = await client(fetch)
            .getText(new URL(`${SITE}/page`))
            .catch(e => e)
        expect(error).not.toBeInstanceOf(SourceChallengeError)
        expect(String(error)).toContain("disallowed origin")
    })

    it("tells onChallenge even when the caller goes on to swallow the error", async () => {
        const onChallenge = vi.fn()
        const fetch = vi.fn<FetchFunction>(async () => respond({ headers: { "cf-mitigated": "challenge" } }))
        await client(fetch, { onChallenge })
            .getText(new URL(`${SITE}/page`))
            .catch(() => undefined)
        expect(onChallenge).toHaveBeenCalledTimes(1)
        expect(onChallenge.mock.calls[0]?.[0]).toBeInstanceOf(SourceChallengeError)
    })

    it("never caches a challenge", async () => {
        const responses = [
            respond({ ok: false, status: 403 }, "Bot challenge not passed"),
            respond({}, "<html>real page</html>")
        ]
        const fetch = vi.fn<FetchFunction>(async () => responses.shift()!)
        const c = client(fetch, { cacheTtlMs: 60_000 })
        await expect(c.getText(new URL(`${SITE}/page`))).rejects.toBeInstanceOf(SourceChallengeError)
        await expect(c.getText(new URL(`${SITE}/page`))).resolves.toBe("<html>real page</html>")
    })
})

describe("bounded client: session origins", () => {
    const credentialsOf = (fetch: ReturnType<typeof vi.fn<FetchFunction>>, call = 0) =>
        fetch.mock.calls[call]?.[1]?.credentials

    it("is cookieless with no session origins, which is the default", async () => {
        const fetch = vi.fn<FetchFunction>(async () => respond())
        await client(fetch).getText(new URL(`${SITE}/page`))
        expect(credentialsOf(fetch)).toBe("omit")
        expect(fetch.mock.calls[0]?.[1]?.redirect).toBeUndefined()
    })

    it("sends the session on a GET to that exact origin, without following redirects", async () => {
        const fetch = vi.fn<FetchFunction>(async () => respond())
        await client(fetch, { sessionOrigins: [SITE] }).getText(new URL(`${SITE}/page`))
        expect(credentialsOf(fetch)).toBe("include")
        expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("manual")
    })

    it("keeps every other origin cookieless, including a subdomain of the chosen one", async () => {
        const fetch = vi.fn<FetchFunction>(async () => respond())
        const c = client(fetch, { sessionOrigins: [SITE] })
        await c.getText(new URL(`${OTHER}/page`))
        await c.getText(new URL("https://api.reader.example/page"))
        expect(credentialsOf(fetch, 0)).toBe("omit")
        expect(credentialsOf(fetch, 1)).toBe("omit")
    })

    it("never sends the session on a POST", async () => {
        const fetch = vi.fn<FetchFunction>(async () => respond({}, "{}"))
        const c = client(fetch, { sessionOrigins: [SITE] })
        await c.postForm(new URL(`${SITE}/form`), { a: "1" })
        await c.postJson(new URL(`${SITE}/json`), { a: 1 }, z.any())
        expect(credentialsOf(fetch, 0)).toBe("omit")
        expect(credentialsOf(fetch, 1)).toBe("omit")
    })

    it("follows a redirect only after dropping the session", async () => {
        const fetch = vi.fn<FetchFunction>(async (_url, init) =>
            init.redirect === "manual"
                ? respond({ ok: false, status: 0, type: "opaqueredirect", url: "" })
                : respond({ url: `${SITE}/moved` }, "moved")
        )
        await expect(client(fetch, { sessionOrigins: [SITE] }).getText(new URL(`${SITE}/page`))).resolves.toBe("moved")
        expect(fetch).toHaveBeenCalledTimes(2)
        expect(credentialsOf(fetch, 0)).toBe("include")
        expect(credentialsOf(fetch, 1)).toBe("omit")
        expect(fetch.mock.calls[1]?.[1]?.redirect).toBeUndefined()
    })

    it("recognises a challenge reached through that cookieless retry", async () => {
        const fetch = vi.fn<FetchFunction>(async (_url, init) =>
            init.redirect === "manual"
                ? respond({ ok: false, status: 0, type: "opaqueredirect", url: "" })
                : respond({ url: `${SITE}/edge/challenge` }, "<html></html>")
        )
        await expect(client(fetch, { sessionOrigins: [SITE] }).getText(new URL(`${SITE}/page`))).rejects.toBeInstanceOf(
            SourceChallengeError
        )
    })
})
