import { describe, expect, it } from "vitest"
import { coverCrossOrigin } from "./cover-crossorigin"

const permitted = ["https://s4.anilist.co/*", "https://*.pstatic.net/*", "https://weeb.ltd/*"]

describe("coverCrossOrigin", () => {
    it("leaves a cover on a permitted host to the cookie rule", () => {
        expect(coverCrossOrigin("https://s4.anilist.co/file/c.jpg", permitted)).toBeUndefined()
        expect(coverCrossOrigin("https://phinf.pstatic.net/c.jpg", permitted)).toBeUndefined()
        expect(coverCrossOrigin("https://pstatic.net/c.jpg", permitted)).toBeUndefined()
    })

    it("loads a cover on any other host without credentials", () => {
        expect(coverCrossOrigin("https://img.example.net/c.png", permitted)).toBe("anonymous")
        expect(coverCrossOrigin("https://s4.anilist.co.example.net/c.png", permitted)).toBe("anonymous")
        expect(coverCrossOrigin("https://evilpstatic.net/c.png", permitted)).toBe("anonymous")
        expect(coverCrossOrigin("http://s4.anilist.co/c.png", permitted)).toBe("anonymous")
    })

    it("treats the all-sites grant as permitted", () => {
        expect(coverCrossOrigin("https://img.example.net/c.png", ["https://*/*"])).toBeUndefined()
        expect(coverCrossOrigin("https://img.example.net/c.png", ["<all_urls>"])).toBeUndefined()
    })

    it("leaves local and data covers alone", () => {
        expect(coverCrossOrigin("/sample-covers/a.png", permitted)).toBeUndefined()
        expect(coverCrossOrigin("data:image/png;base64,AA", permitted)).toBeUndefined()
        expect(coverCrossOrigin("blob:chrome-extension://abc/1", permitted)).toBeUndefined()
    })
})
