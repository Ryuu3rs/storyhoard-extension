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
        expect(fetchMock).toHaveBeenCalledWith("https://cdn.reader.example/c.jpg", { credentials: "omit" })
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
})
