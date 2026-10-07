import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchCoverBlob } from "./covers"

function okResponse(url: string, type = "image/jpeg") {
    return { ok: true, url, blob: async () => new Blob(["cover"], { type }) }
}

afterEach(() => {
    vi.unstubAllGlobals()
})

describe("fetchCoverBlob", () => {
    it("fetches a public https cover", async () => {
        const fetchMock = vi.fn(async (url: string) => okResponse(url))
        vi.stubGlobal("fetch", fetchMock)
        const blob = await fetchCoverBlob("https://cdn.reader.example/c.jpg")
        expect(blob?.type).toBe("image/jpeg")
        expect(fetchMock).toHaveBeenCalledWith("https://cdn.reader.example/c.jpg", {
            credentials: "omit",
            signal: expect.any(AbortSignal)
        })
    })

    it.each([
        "http://cdn.reader.example/c.jpg",
        "https://127.0.0.1/c.jpg",
        "https://localhost/c.jpg",
        "https://192.168.0.10/c.jpg",
        "https://[::1]/c.jpg",
        "https://nas.local/c.jpg",
        "https://cdn.reader.example:8443/c.jpg",
        "https://user:pw@cdn.reader.example/c.jpg",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "not a url"
    ])("never fetches %s", async raw => {
        const fetchMock = vi.fn()
        vi.stubGlobal("fetch", fetchMock)
        expect(await fetchCoverBlob(raw)).toBeUndefined()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("discards a cover that redirected to a loopback address", async () => {
        const blobSpy = vi.fn(async () => new Blob(["secret"], { type: "image/png" }))
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({ ok: true, url: "https://127.0.0.1/admin.png", blob: blobSpy }))
        )
        expect(await fetchCoverBlob("https://cdn.reader.example/c.jpg")).toBeUndefined()
        expect(blobSpy).not.toHaveBeenCalled()
    })

    it("discards a cover that redirected to plain http", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => okResponse("http://cdn.reader.example/c.jpg"))
        )
        expect(await fetchCoverBlob("https://cdn.reader.example/c.jpg")).toBeUndefined()
    })

    it("still rejects non-image and failed responses", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => okResponse(url, "text/html"))
        )
        expect(await fetchCoverBlob("https://cdn.reader.example/c.jpg")).toBeUndefined()
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({ ok: false, url: "https://cdn.reader.example/c.jpg" }))
        )
        expect(await fetchCoverBlob("https://cdn.reader.example/c.jpg")).toBeUndefined()
    })

    it("refuses an over-cap declared Content-Length without reading the body", async () => {
        const blobSpy = vi.fn(async () => new Blob(["x"], { type: "image/png" }))
        const cancel = vi.fn(async () => undefined)
        const getReader = vi.fn()
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                ok: true,
                url: "https://cdn.reader.example/c.jpg",
                headers: new Headers({ "content-length": String(50 * 1024 * 1024), "content-type": "image/jpeg" }),
                body: { getReader, cancel },
                blob: blobSpy
            }))
        )
        expect(await fetchCoverBlob("https://cdn.reader.example/c.jpg")).toBeUndefined()
        expect(blobSpy).not.toHaveBeenCalled()
        expect(getReader).not.toHaveBeenCalled()
        expect(cancel).toHaveBeenCalled()
    })

    it("stops reading a streamed body that grows past the cap even when it declares no length", async () => {
        let reads = 0
        const cancel = vi.fn(async () => undefined)
        const reader = {
            read: vi.fn(async () => {
                reads++
                return reads > 1000
                    ? { done: true, value: undefined }
                    : { done: false, value: new Uint8Array(1024 * 1024) }
            }),
            cancel
        }
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                ok: true,
                url: "https://cdn.reader.example/c.jpg",
                headers: new Headers({ "content-type": "image/jpeg" }),
                body: { getReader: () => reader },
                blob: vi.fn()
            }))
        )
        expect(await fetchCoverBlob("https://cdn.reader.example/c.jpg")).toBeUndefined()
        expect(reads).toBeLessThanOrEqual(3)
        expect(cancel).toHaveBeenCalled()
    })

    it("reads a small streamed cover into a typed blob", async () => {
        const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]
        const reader = {
            read: vi.fn(async () => {
                const value = chunks.shift()
                return value ? { done: false, value } : { done: true, value: undefined }
            }),
            cancel: vi.fn()
        }
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                ok: true,
                url: "https://cdn.reader.example/c.jpg",
                headers: new Headers({ "content-type": "image/webp; charset=binary", "content-length": "5" }),
                body: { getReader: () => reader }
            }))
        )
        const blob = await fetchCoverBlob("https://cdn.reader.example/c.jpg")
        expect(blob?.type).toBe("image/webp")
        expect(blob?.size).toBe(5)
    })

    it("aborts a fetch that never answers", async () => {
        vi.useFakeTimers()
        try {
            let aborted = false
            vi.stubGlobal(
                "fetch",
                vi.fn(
                    (_url: string, init: { signal: AbortSignal }) =>
                        new Promise((_resolve, reject) => {
                            init.signal.addEventListener("abort", () => {
                                aborted = true
                                reject(new Error("aborted"))
                            })
                        })
                )
            )
            const pending = fetchCoverBlob("https://cdn.reader.example/c.jpg")
            await vi.advanceTimersByTimeAsync(20_000)
            expect(await pending).toBeUndefined()
            expect(aborted).toBe(true)
        } finally {
            vi.useRealTimers()
        }
    })
})
