import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("browser", fakeBrowser)
const fetchMock = vi.fn<typeof fetch>()
vi.stubGlobal("fetch", fetchMock)

const { pullFromGist } = await import("./sync")

const GIST_ID = "abc123"
const RAW_URL = `https://gist.githubusercontent.com/someone/${GIST_ID}/raw/0f1e2d3c/amr-library.json`

const envelope = { format: "storyhoard", manga: [{ id: "x", title: "Long Library" }], note: "y".repeat(2000) }
const fullText = JSON.stringify(envelope, null, 2)
const cutText = fullText.slice(0, 120)

const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })

function gistResponse(file: Record<string, unknown>) {
    return json({ id: GIST_ID, files: { "amr-library.json": { filename: "amr-library.json", ...file } } })
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
    return typeof input === "string" ? input : input instanceof URL ? input.href : input.url
}

beforeEach(async () => {
    fakeBrowser.reset()
    fetchMock.mockReset()
    await fakeBrowser.storage.local.set({ syncConfig: { token: "gh-token", gistId: GIST_ID, autoSync: false } })
})

describe("pullFromGist with a backup GitHub truncates in the API response", () => {
    it("reads the whole file from raw_url, without the token", async () => {
        fetchMock.mockImplementation(async input => {
            const url = requestUrl(input)
            if (url.startsWith("https://api.github.com/gists/")) {
                return gistResponse({ content: cutText, truncated: true, raw_url: RAW_URL, size: fullText.length })
            }
            if (url === RAW_URL) return new Response(fullText, { status: 200 })
            return new Response("", { status: 404 })
        })

        await expect(pullFromGist()).resolves.toEqual(envelope)

        const rawCall = fetchMock.mock.calls.find(([input]) => requestUrl(input) === RAW_URL)
        expect(rawCall).toBeDefined()
        const init = rawCall?.[1]
        expect(init?.credentials).toBe("omit")
        expect(JSON.stringify(init?.headers ?? {})).not.toContain("gh-token")
    })

    it("refuses a raw_url outside GitHub's gist host", async () => {
        fetchMock.mockImplementation(async input => {
            const url = requestUrl(input)
            if (url.startsWith("https://api.github.com/gists/")) {
                return gistResponse({
                    content: cutText,
                    truncated: true,
                    raw_url: "https://evil.example/amr-library.json",
                    size: fullText.length
                })
            }
            return new Response(fullText, { status: 200 })
        })

        await expect(pullFromGist()).rejects.toThrow()
        expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).not.toContain(
            "https://evil.example/amr-library.json"
        )
    })

    it("says the backup is too big when the raw file is also cut short", async () => {
        fetchMock.mockImplementation(async input => {
            const url = requestUrl(input)
            if (url.startsWith("https://api.github.com/gists/")) {
                return gistResponse({ content: cutText, truncated: true, raw_url: RAW_URL, size: fullText.length })
            }
            return new Response(fullText.slice(0, 600), { status: 200 })
        })

        await expect(pullFromGist()).rejects.toThrow(/too large/i)
        const stored = await fakeBrowser.storage.local.get("syncConfig")
        expect((stored.syncConfig as { lastPulledAt?: number }).lastPulledAt).toBeUndefined()
    })

    it("still reads a small backup straight from the API response", async () => {
        fetchMock.mockImplementation(async () => gistResponse({ content: fullText, truncated: false }))

        await expect(pullFromGist()).resolves.toEqual(envelope)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })
})
