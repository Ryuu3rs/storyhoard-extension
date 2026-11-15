import { describe, expect, it } from "vitest"
import type { RuntimeRequest } from "../runtime"
import { assertSenderMayRequest, fromExtensionOrigin } from "./sender-gate"

const BASE = "chrome-extension://ext/"
const appPage = { url: `${BASE}app.html`, tab: { id: 1 } }
const popup = { url: `${BASE}popup.html` }
const readerTab = { url: "https://reader.example/series/x/chapter-2", tab: { id: 9, url: "https://reader.example/" } }
const weebTab = { url: "https://weeb.ltd/welcome", tab: { id: 4 } }

const req = (r: unknown) => r as RuntimeRequest
const check = (request: unknown, sender: unknown) => () =>
    assertSenderMayRequest(req(request), sender as Parameters<typeof assertSenderMayRequest>[1], BASE)

describe("fromExtensionOrigin", () => {
    it("is true only for a url under the extension's own base", () => {
        expect(fromExtensionOrigin(appPage, BASE)).toBe(true)
        expect(fromExtensionOrigin(popup, BASE)).toBe(true)
        expect(fromExtensionOrigin(readerTab, BASE)).toBe(false)
        expect(fromExtensionOrigin({ url: "chrome-extension://other/app.html" }, BASE)).toBe(false)
        expect(fromExtensionOrigin({}, BASE)).toBe(false)
        expect(fromExtensionOrigin(undefined, BASE)).toBe(false)
    })
})

describe("assertSenderMayRequest", () => {
    it("lets the extension's own pages send anything", () => {
        expect(check({ type: "library:clear" }, appPage)).not.toThrow()
        expect(check({ type: "data:export" }, popup)).not.toThrow()
        expect(check({ type: "settings:update", settings: { usageAnalytics: false } }, appPage)).not.toThrow()
    })

    it("lets a content script send the panel's and the bridge's own messages", () => {
        for (const type of [
            "analytics:record",
            "chapter:siblings",
            "chapter:track",
            "library:get",
            "library:reading-prefs",
            "panel:resolve-mode",
            "source:add-from-tab",
            "work:best-for-url",
            "work:chapter-list",
            "work:record-chapter-list",
            "work:track-detected"
        ]) {
            expect(check({ type }, readerTab), type).not.toThrow()
        }
        for (const type of ["account:status", "site:open", "handoff:hello", "handoff:code"]) {
            expect(check({ type }, weebTab), type).not.toThrow()
        }
    })

    it("refuses every other message from a content script", () => {
        for (const type of [
            "data:export",
            "library:clear",
            "library:remove",
            "sync:config",
            "account:link",
            "account:unlink",
            "handoff:confirm",
            "import:reader"
        ]) {
            expect(check({ type }, readerTab), type).toThrow(/not allowed/)
            expect(check({ type }, weebTab), type).toThrow(/not allowed/)
        }
    })

    it("treats a sender with no extension url as a content script", () => {
        expect(check({ type: "library:clear" }, {})).toThrow(/not allowed/)
        expect(check({ type: "library:clear" }, undefined)).toThrow(/not allowed/)
    })

    it("lets the panel save only its reading-view defaults through settings:update", () => {
        expect(
            check(
                {
                    type: "settings:update",
                    settings: {
                        readerContinuousScroll: true,
                        readerFitWidth: false,
                        readerNoGap: true,
                        readerTheme: "dark"
                    }
                },
                readerTab
            )
        ).not.toThrow()
        expect(check({ type: "settings:update", settings: { usageAnalytics: false } }, readerTab)).toThrow(
            /not allowed/
        )
        expect(check({ type: "settings:update", settings: { readerNoGap: true, autoAdd: true } }, readerTab)).toThrow(
            /not allowed/
        )
    })
})
