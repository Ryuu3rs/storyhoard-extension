import type { ZodType } from "zod"
import { SourceError, SourceRequestError } from "./errors"
import { isPublicHttpsUrl } from "./public-host"
import type { SourceRequestClient, SourceRequestOptions } from "./types"

export type FetchResponse = {
    ok: boolean
    status: number
    // Final URL after redirects. When present, the bounded client validates it
    // against allowedOrigins so redirects to ad networks are caught and thrown
    // as SourceError("invalid-input") rather than surfacing as CORS failures.
    url?: string
    // Optional response headers (lowercased keys). When a Content-Length is present the
    // bounded client rejects an already-over-cap response before reading a single byte.
    headers?: Readonly<Record<string, string>>
    // Optional raw body stream. When present the client reads it incrementally and aborts
    // once maxResponseBytes is exceeded, so a hostile/oversized response from an allowed
    // (or MITM'd http) origin can't be buffered whole into memory. Environments and test
    // fakes that only implement text() fall back to a post-read size check.
    body?: ReadableStream<Uint8Array> | null
    text(): Promise<string>
}

export type FetchFunction = (
    url: string,
    init: {
        headers?: Readonly<Record<string, string>>
        method: "GET" | "POST"
        body?: string
        signal: AbortSignal
        credentials?: "include" | "same-origin" | "omit"
    }
) => Promise<FetchResponse>

export type BoundedRequestClientOptions = {
    fetch: FetchFunction
    allowedOrigins: readonly string[]
    maxRequests: number
    maxResponseBytes: number
    timeoutMs: number
    // Optional per-client rate limit. Spacing = intervalMs / requests between
    // consecutive requests. Omit to disable (default).
    rateLimit?: { requests: number; intervalMs: number }
    // Transient-failure retries (timeouts, network errors, 429, 5xx). Default 2.
    maxRetries?: number
    // Base backoff in ms; grows exponentially per attempt with jitter. Default 300.
    retryBaseDelayMs?: number
    // Injectable for tests so backoff/rate-limit waits are instant.
    sleep?: (ms: number) => Promise<void>
    random?: () => number
    // Short-TTL success cache for coalescable GETs. 0 or omit to disable.
    cacheTtlMs?: number
    // Injectable clock for tests.
    now?: () => number
    // Optional response cache to use instead of a fresh internal Map. Lets callers
    // share the cache ACROSS separate client instances (e.g. one per operation) so
    // back-to-back operations against the same source benefit from cacheTtlMs even
    // though each gets its own client. Deliberately does NOT extend to requestCount/
    // maxRequests - that budget must stay per-instance (see attemptOnce) or a shared
    // client would let one operation's request count block a later, unrelated one.
    cache?: Map<string, { body: string; expiresAt: number }>
    // Defence in depth on top of allowedOrigins, for user-supplied sources: every request URL and
    // every post-redirect URL must also be https on a public hostname (no loopback, private-network
    // or IP-literal destination), even if an allowlist entry were ever to name one. The browser
    // fetch API cannot expose redirect hops to script, so the final URL is the strongest check
    // available: a response from a disallowed destination is discarded and never read.
    requirePublicHttps?: boolean
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function isRetryable(error: unknown): boolean {
    if (error instanceof SourceRequestError) {
        const status = error.status
        return status === undefined || status === 429 || (status >= 500 && status <= 599)
    }
    return false
}

// allowedOrigins entries are either exact origins/URL prefixes ("https://mangadex.org/*")
// or Chrome-match-pattern-style wildcard hosts ("*://*.mangafreak.me/*"). Wildcards match
// the bare domain AND any subdomain, http/https only - same semantics as the manifest
// host_permissions grant they mirror. Exported (in addition to being used internally by
// createBoundedRequestClient) so tests can exercise the real allow/deny logic directly
// against the production SOURCE_ORIGINS list without constructing a full client.
export function createOriginAllowlist(allowedOrigins: readonly string[]): (origin: string) => boolean {
    const exactOrigins = new Set<string>()
    const wildcardHostSuffixes: string[] = []
    for (const entry of allowedOrigins) {
        const wildcard = entry.match(/^\*:\/\/\*\.([^/*]+)(?:\/.*)?$/)
        if (wildcard?.[1]) {
            wildcardHostSuffixes.push(wildcard[1])
            continue
        }
        exactOrigins.add(new URL(entry).origin)
    }
    return function isOriginAllowed(origin: string): boolean {
        if (exactOrigins.has(origin)) return true
        let parsed: URL
        try {
            parsed = new URL(origin)
        } catch {
            return false
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
        const host = parsed.hostname
        return wildcardHostSuffixes.some(suffix => host === suffix || host.endsWith(`.${suffix}`))
    }
}

// Read a response body without ever buffering more than maxResponseBytes. Rejects early on a
// declared Content-Length over the cap, then streams the body counting bytes and aborts the read
// the moment it exceeds the cap - so a hostile/oversized response can't OOM the worker before a
// post-hoc size check fires. A response that exposes no stream (test fakes, exotic environments)
// falls back to text() + a post-read cap.
async function readBoundedBody(response: FetchResponse, maxResponseBytes: number, urlStr: string): Promise<string> {
    const declared = Number(response.headers?.["content-length"])
    if (Number.isFinite(declared) && declared > maxResponseBytes) {
        throw new SourceError("request-limit", `Response exceeded ${maxResponseBytes} bytes`, {
            url: urlStr,
            bodySize: declared
        })
    }
    const stream = response.body
    if (stream && typeof stream.getReader === "function") {
        const reader = stream.getReader()
        const chunks: Uint8Array[] = []
        let total = 0
        try {
            for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                if (!value) continue
                total += value.byteLength
                if (total > maxResponseBytes) {
                    await reader.cancel().catch(() => undefined)
                    throw new SourceError("request-limit", `Response exceeded ${maxResponseBytes} bytes`, {
                        url: urlStr,
                        bodySize: total
                    })
                }
                chunks.push(value)
            }
        } finally {
            reader.releaseLock?.()
        }
        const merged = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
            merged.set(chunk, offset)
            offset += chunk.byteLength
        }
        return new TextDecoder().decode(merged)
    }
    const body = await response.text()
    if (new TextEncoder().encode(body).byteLength > maxResponseBytes) {
        throw new SourceError("request-limit", `Response exceeded ${maxResponseBytes} bytes`, { url: urlStr })
    }
    return body
}

export function createBoundedRequestClient(options: BoundedRequestClientOptions): SourceRequestClient {
    const isOriginAllowed = createOriginAllowlist(options.allowedOrigins)
    const maxRetries = options.maxRetries ?? 2
    const retryBaseDelayMs = options.retryBaseDelayMs ?? 300
    const sleep = options.sleep ?? defaultSleep
    const random = options.random ?? Math.random
    const now = options.now ?? (() => Date.now())
    const cacheTtlMs = options.cacheTtlMs ?? 0
    const minIntervalMs =
        options.rateLimit && options.rateLimit.requests > 0
            ? options.rateLimit.intervalMs / options.rateLimit.requests
            : 0

    let requestCount = 0
    let nextAllowedAt = 0

    // Dedupe concurrent identical GETs. Keyed by URL string; the entry lives only
    // while the underlying fetch is in flight (no time-based caching).
    const inFlight = new Map<string, Promise<string>>()
    // Short-TTL success cache for coalescable GETs. Entries expire after cacheTtlMs.
    // Uses the caller-supplied shared cache when provided (options.cache), otherwise
    // a fresh instance-local Map - identical to the pre-existing behavior. Note this
    // is the ONLY thing that can be shared across client instances; requestCount and
    // maxRequests below remain local to `options` per call to this factory.
    const responseCache = options.cache ?? new Map<string, { body: string; expiresAt: number }>()

    async function waitForRateSlot(): Promise<void> {
        if (minIntervalMs <= 0) return
        const ts = now()
        const wait = Math.max(0, nextAllowedAt - ts)
        nextAllowedAt = Math.max(ts, nextAllowedAt) + minIntervalMs
        if (wait > 0) await sleep(wait)
    }

    async function attemptOnce(
        url: URL,
        init: { method: "GET" | "POST"; headers?: Readonly<Record<string, string>>; body?: string }
    ): Promise<string> {
        if (requestCount >= options.maxRequests) {
            throw new SourceError("request-limit", `Request limit of ${options.maxRequests} exceeded`)
        }
        requestCount += 1
        await waitForRateSlot()

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), options.timeoutMs)
        try {
            const response = await options.fetch(url.toString(), {
                method: init.method,
                signal: controller.signal,
                credentials: "omit",
                ...(init.body === undefined ? {} : { body: init.body }),
                ...(init.headers === undefined ? {} : { headers: init.headers })
            })
            if (response.url !== undefined) {
                try {
                    const finalUrl = new URL(response.url)
                    const finalOrigin = finalUrl.origin
                    if (!isOriginAllowed(finalOrigin) || (options.requirePublicHttps && !isPublicHttpsUrl(finalUrl))) {
                        throw new SourceError(
                            "invalid-input",
                            `Request was redirected to a disallowed origin: ${finalOrigin}`
                        )
                    }
                } catch (e) {
                    if (e instanceof SourceError) throw e
                    // new URL(response.url) failed - the final origin is unverifiable. Fail
                    // CLOSED: an SSRF/redirect guard must not treat "I don't know where this
                    // came from" as allowed.
                    throw new SourceError("invalid-input", "Could not verify the final response origin")
                }
            }

            const body = await readBoundedBody(response, options.maxResponseBytes, url.toString())
            if (!response.ok) {
                throw new SourceRequestError(`Request failed with status ${response.status}`, response.status, {
                    url: url.toString()
                })
            }
            return body
        } catch (error) {
            if (error instanceof SourceError) throw error
            if (controller.signal.aborted) {
                throw new SourceRequestError(`Request timed out after ${options.timeoutMs}ms`, undefined, {
                    url: url.toString()
                })
            }
            throw new SourceRequestError("Request failed", undefined, {
                url: url.toString(),
                cause: String(error)
            })
        } finally {
            clearTimeout(timeout)
        }
    }

    async function attemptWithRetries(
        url: URL,
        init: { method: "GET" | "POST"; headers?: Readonly<Record<string, string>>; body?: string }
    ): Promise<string> {
        let attempt = 0
        for (;;) {
            try {
                return await attemptOnce(url, init)
            } catch (error) {
                if (attempt >= maxRetries || !isRetryable(error)) throw error
                const backoff = retryBaseDelayMs * 2 ** attempt + Math.floor(random() * retryBaseDelayMs)
                attempt += 1
                await sleep(backoff)
            }
        }
    }

    async function requestText(
        url: URL,
        init: { method: "GET" | "POST"; headers?: Readonly<Record<string, string>>; body?: string },
        coalescable: boolean
    ): Promise<string> {
        if (!isOriginAllowed(url.origin)) {
            throw new SourceError("invalid-input", `Request origin is not allowed: ${url.origin}`)
        }
        if (options.requirePublicHttps && !isPublicHttpsUrl(url)) {
            throw new SourceError("invalid-input", `Request destination is not a public https site: ${url.origin}`)
        }
        if (!coalescable) {
            return attemptWithRetries(url, init)
        }
        const key = url.toString()
        if (cacheTtlMs > 0) {
            const cached = responseCache.get(key)
            if (cached !== undefined) {
                if (now() < cached.expiresAt) return cached.body
                responseCache.delete(key)
            }
        }
        const existing = inFlight.get(key)
        if (existing !== undefined) {
            return existing
        }
        const pending = attemptWithRetries(url, init)
            .then(body => {
                if (cacheTtlMs > 0) {
                    const ts = now()
                    for (const [k, v] of responseCache) {
                        if (ts >= v.expiresAt) responseCache.delete(k)
                    }
                    responseCache.set(key, { body, expiresAt: ts + cacheTtlMs })
                }
                return body
            })
            .finally(() => {
                inFlight.delete(key)
            })
        inFlight.set(key, pending)
        return pending
    }

    return {
        async getJson<T>(url: URL, schema: ZodType<T>, requestOptions?: SourceRequestOptions): Promise<T> {
            const body = await requestText(
                url,
                {
                    method: "GET",
                    ...(requestOptions?.headers === undefined ? {} : { headers: requestOptions.headers })
                },
                true
            )
            let json: unknown
            try {
                json = JSON.parse(body)
            } catch (error) {
                throw new SourceError("invalid-response", "Response was not valid JSON", {
                    url: url.toString(),
                    cause: String(error)
                })
            }
            const result = schema.safeParse(json)
            if (!result.success) {
                throw new SourceError("invalid-response", "Response did not match the expected schema", {
                    url: url.toString(),
                    issues: result.error.issues
                })
            }
            return result.data
        },

        async getText(url: URL, requestOptions?: SourceRequestOptions): Promise<string> {
            return requestText(
                url,
                {
                    method: "GET",
                    ...(requestOptions?.headers === undefined ? {} : { headers: requestOptions.headers })
                },
                true
            )
        },

        async postForm(
            url: URL,
            params: Record<string, string>,
            requestOptions?: SourceRequestOptions
        ): Promise<string> {
            return requestText(
                url,
                {
                    method: "POST",
                    body: new URLSearchParams(params).toString(),
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        ...(requestOptions?.headers ?? {})
                    }
                },
                false
            )
        },

        async postJson<T>(
            url: URL,
            body: unknown,
            schema: ZodType<T>,
            requestOptions?: SourceRequestOptions
        ): Promise<T> {
            const raw = await requestText(
                url,
                {
                    method: "POST",
                    body: JSON.stringify(body),
                    headers: {
                        "Content-Type": "application/json",
                        ...(requestOptions?.headers ?? {})
                    }
                },
                false
            )
            let json: unknown
            try {
                json = raw ? JSON.parse(raw) : {}
            } catch (error) {
                throw new SourceError("invalid-response", "Response was not valid JSON", {
                    url: url.toString(),
                    cause: String(error)
                })
            }
            const result = schema.safeParse(json)
            if (!result.success) {
                throw new SourceError("invalid-response", "Response did not match the expected schema", {
                    url: url.toString(),
                    issues: result.error.issues
                })
            }
            return result.data
        }
    }
}
