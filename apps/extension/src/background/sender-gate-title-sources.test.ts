import { describe, expect, it } from "vitest"
import type { RuntimeRequest } from "../runtime"
import { assertSenderMayRequest } from "./sender-gate"

const BASE = "chrome-extension://ext/"
const appPage = { url: `${BASE}app.html`, tab: { id: 1 } }
const readerTab = { url: "https://reader.example/series/x/chapter-2", tab: { id: 9, url: "https://reader.example/" } }
const weebTab = { url: "https://weeb.ltd/welcome", tab: { id: 4 } }

const check = (request: unknown, sender: unknown) => () =>
    assertSenderMayRequest(request as RuntimeRequest, sender as Parameters<typeof assertSenderMayRequest>[1], BASE)

const titleMessages = [
    { type: "title:sources", mangaId: "m1" },
    { type: "title:unresolved" },
    { type: "title:source-prefer", mangaId: "m1", sourceId: "alpha" },
    { type: "title:source-remove", mangaId: "m1", versionId: "alpha:1" },
    { type: "title:source-link", mangaId: "m1", url: "https://site.example/series/x" },
    { type: "title:source-preview", mangaId: "m1", url: "https://site.example/series/x" },
    {
        type: "title:source-change",
        mangaId: "m1",
        sourceId: "alpha",
        sourceMangaId: "1",
        mangaUrl: "https://site.example/series/x"
    },
    { type: "title:source-undo", mangaId: "m1", backupId: 1 }
]

describe("title source messages and the sender gate", () => {
    it("rejects every one of them from a web page", () => {
        for (const message of titleMessages) {
            expect(check(message, readerTab)).toThrow("not allowed from a web page")
            expect(check(message, weebTab)).toThrow("not allowed from a web page")
        }
    })

    it("accepts them from the extension's own pages", () => {
        for (const message of titleMessages) expect(check(message, appPage)).not.toThrow()
    })
})
