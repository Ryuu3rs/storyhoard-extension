import { describe, expect, it } from "vitest"
import {
    detectChallengeBeforeBody,
    detectChallengeInBody,
    hasChallengeMarker,
    isChallengePage,
    isChallengePath
} from "./challenge"

const url = (s: string) => new URL(s)
const CF_PAGE = `<!doctype html><html><head><title>Just a moment...</title></head><body><div id="challenge-running"></div></body></html>`
const JSD_SCRIPT = `<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>`
const NORMAL_PAGE = `<!doctype html><html><head><title>Demo Series - Chapter 3</title></head><body><h1>Demo</h1><a href="/manga/demo/chapter-3">Chapter 3</a>${JSD_SCRIPT}</body></html>`

describe("detectChallengeBeforeBody", () => {
    it("recognises a redirect onto a challenge path, across subdomains of the site", () => {
        expect(
            detectChallengeBeforeBody({
                requestUrl: url("https://api.reader.example/manga/1"),
                finalUrl: url("https://reader.example/edge/challenge")
            })
        ).toBe("path")
        expect(
            detectChallengeBeforeBody({
                requestUrl: url("https://reader.example/manga/1"),
                finalUrl: url("https://reader.example/cdn-cgi/challenge-platform/h/b/flow")
            })
        ).toBe("path")
    })

    it("recognises a challenge response header at any status", () => {
        const requestUrl = url("https://reader.example/manga/1")
        expect(detectChallengeBeforeBody({ requestUrl, headers: { "cf-mitigated": "challenge" } })).toBe("header")
        expect(detectChallengeBeforeBody({ requestUrl, headers: { "x-amzn-waf-action": "captcha" } })).toBe("header")
    })

    it("does not mistake an ordinary response for one", () => {
        const requestUrl = url("https://reader.example/manga/1")
        expect(detectChallengeBeforeBody({ requestUrl })).toBeUndefined()
        expect(detectChallengeBeforeBody({ requestUrl, finalUrl: requestUrl })).toBeUndefined()
        expect(detectChallengeBeforeBody({ requestUrl, headers: { "cf-mitigated": "other" } })).toBeUndefined()
        expect(
            detectChallengeBeforeBody({ requestUrl, finalUrl: url("https://www.reader.example/manga/1") })
        ).toBeUndefined()
    })

    it("does not treat a title that uses the word as an interstitial", () => {
        for (const [from, to] of [
            ["https://reader.example/manga/challenge", "https://reader.example/manga/challenge/"],
            ["https://reader.example/series/old-slug", "https://reader.example/series/challenge"],
            ["https://reader.example/the-challenge", "https://reader.example/the-challenge/chapter-1"],
            ["https://reader.example/challenge", "https://reader.example/challenge/"]
        ] as const) {
            expect(detectChallengeBeforeBody({ requestUrl: url(from), finalUrl: url(to) })).toBeUndefined()
        }
    })
})

describe("isChallengePath", () => {
    it("matches a whole segment near the root only", () => {
        expect(isChallengePath("/challenge")).toBe(true)
        expect(isChallengePath("/edge/challenge")).toBe(true)
        expect(isChallengePath("/captcha/abc")).toBe(true)
        expect(isChallengePath("/challenges-weekly")).toBe(false)
        expect(isChallengePath("/a/b/challenge")).toBe(false)
        expect(isChallengePath("/manga/challenge/chapter-1")).toBe(false)
        expect(isChallengePath("/")).toBe(false)
    })
})

describe("detectChallengeInBody", () => {
    const body = (status: number, text: string, type = "text/html", expectJson = false) =>
        detectChallengeInBody({ status, body: text, expectJson, headers: { "content-type": type } })

    it("recognises HTML where JSON was expected", () => {
        expect(body(200, "<!doctype html><html><body>hello</body></html>", "text/html", true)).toBe("html-for-json")
        expect(detectChallengeInBody({ status: 200, body: "<html><body>hello</body></html>", expectJson: true })).toBe(
            "html-for-json"
        )
    })

    it("recognises a 403 or 503 carrying a marker", () => {
        expect(body(403, "Bot challenge not passed", "text/plain")).toBe("marker")
        expect(body(403, CF_PAGE)).toBe("marker")
        expect(body(503, CF_PAGE)).toBe("marker")
        expect(body(503, "Just a moment...", "text/plain")).toBe("marker")
        expect(body(403, `<html><body><div class="cf-turnstile"></div></body></html>`)).toBe("marker")
    })

    it("recognises a challenge page served with a 200", () => {
        expect(body(200, CF_PAGE)).toBe("marker")
    })

    it("leaves a normal 403 alone", () => {
        expect(body(403, "<html><head><title>403 Forbidden</title></head><body>nginx</body></html>")).toBeUndefined()
        expect(body(403, "Forbidden", "text/plain")).toBeUndefined()
        expect(body(403, `<html><body>Access denied${JSD_SCRIPT}</body></html>`)).toBeUndefined()
        expect(body(403, "")).toBeUndefined()
    })

    it("leaves a normal HTML page alone, even with the script Cloudflare injects into every page", () => {
        expect(body(200, NORMAL_PAGE)).toBeUndefined()
        expect(
            body(200, `<html><head><title>The Challenge</title></head><body>Just a moment later...</body></html>`)
        ).toBe(undefined)
    })

    it("leaves JSON alone even when it mentions the word, whatever the status", () => {
        const json = JSON.stringify({ title: "Just a moment...", tag: "challenge", note: "Bot challenge not passed" })
        for (const status of [200, 403, 503]) {
            expect(body(status, json, "application/json", true)).toBeUndefined()
            expect(body(status, json, "text/html", true)).toBeUndefined()
        }
        expect(body(200, `[{"chapter":"Chapter 1: The Challenge"}]`, "application/json", true)).toBeUndefined()
    })

    it("does not read other error statuses as a challenge", () => {
        expect(body(404, CF_PAGE)).toBeUndefined()
        expect(body(500, CF_PAGE)).toBeUndefined()
        expect(body(404, "<html>not found</html>", "text/html", true)).toBeUndefined()
    })
})

describe("marker helpers", () => {
    it("isChallengePage only trusts strong markers, hasChallengeMarker also takes hints", () => {
        const hint = `<html><body><div class="cf-turnstile"></div></body></html>`
        expect(isChallengePage(hint)).toBe(false)
        expect(hasChallengeMarker(hint)).toBe(true)
        expect(isChallengePage(CF_PAGE)).toBe(true)
        expect(hasChallengeMarker(NORMAL_PAGE)).toBe(false)
    })

    it("does not scan past the head of a huge page", () => {
        expect(isChallengePage(`<html>${"x".repeat(200 * 1024)}<title>Just a moment</title></html>`)).toBe(false)
    })
})
