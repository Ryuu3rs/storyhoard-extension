import { describe, expect, it } from "vitest"
import { coverCrossOrigin, isCatalogCoverUrl, libraryCoverMode, proxiedCoverUrl } from "./cover-crossorigin"

const SITE = "https://weeb.ltd"
const permitted = [
    "https://s4.anilist.co/*",
    "https://*.pstatic.net/*",
    "https://weeb.ltd/*",
    "https://reader.example/*"
]
const mode = (src: string, origins = permitted) => coverCrossOrigin(src, origins, SITE)

describe("isCatalogCoverUrl", () => {
    it("is the catalog cover hosts and weeb.ltd's cover route only", () => {
        expect(isCatalogCoverUrl(new URL("https://s4.anilist.co/file/c.jpg"), SITE)).toBe(true)
        expect(isCatalogCoverUrl(new URL("https://cdn.myanimelist.net/images/c.jpg"), SITE)).toBe(true)
        expect(isCatalogCoverUrl(new URL("https://uploads.mangadex.org/covers/c.jpg"), SITE)).toBe(true)
        expect(isCatalogCoverUrl(new URL("https://weeb.ltd/api/cover?u=a&s=b"), SITE)).toBe(true)
        expect(isCatalogCoverUrl(new URL("https://weeb.ltd/legal/privacy"), SITE)).toBe(false)
        expect(isCatalogCoverUrl(new URL("https://reader.example/c.jpg"), SITE)).toBe(false)
        expect(isCatalogCoverUrl(new URL("https://s4.anilist.co.example.net/c.jpg"), SITE)).toBe(false)
        expect(isCatalogCoverUrl(new URL("http://s4.anilist.co/c.jpg"), SITE)).toBe(false)
    })
})

describe("proxiedCoverUrl", () => {
    const official = "https://uploads.mangadex.org/covers/77bee52c/6079dd31.jpg.512.jpg"
    const proxied = `${SITE}/api/cover?u=${encodeURIComponent(official)}`

    it("routes an official-source cover through the site's cover route", () => {
        expect(proxiedCoverUrl(official, SITE)).toBe(proxied)
        expect(new URL(proxiedCoverUrl(official, SITE)).searchParams.get("u")).toBe(official)
    })

    it("is idempotent", () => {
        expect(proxiedCoverUrl(proxied, SITE)).toBe(proxied)
        expect(proxiedCoverUrl(proxiedCoverUrl(official, SITE), SITE)).toBe(proxied)
    })

    it("passes a cover the site already proxied and signed through unchanged", () => {
        const signed = `${proxied}&s=3f9a1c0b7e`
        expect(proxiedCoverUrl(signed, SITE)).toBe(signed)
        expect(mode(signed)).toBeUndefined()
    })

    it("passes no cover through as none", () => {
        expect(proxiedCoverUrl(undefined, SITE)).toBeUndefined()
    })

    it("leaves every other host untouched", () => {
        for (const src of [
            "https://s4.anilist.co/file/c.jpg",
            "https://cdn.myanimelist.net/images/c.jpg",
            "https://reader.example/c.jpg",
            "https://uploads.mangadex.org.example.net/covers/c.jpg",
            "https://evil.example/uploads.mangadex.org/covers/c.jpg",
            "https://mangadex.org/covers/c.jpg",
            "https://weeb.ltd/api/cover?u=a&s=b"
        ]) {
            expect(proxiedCoverUrl(src, SITE)).toBe(src)
        }
    })

    it("leaves http, odd ports, credentials, local and bad input untouched", () => {
        for (const src of [
            "http://uploads.mangadex.org/covers/c.jpg",
            "https://uploads.mangadex.org:8443/covers/c.jpg",
            "https://user:pw@uploads.mangadex.org/covers/c.jpg",
            "blob:chrome-extension://abc/1",
            "data:image/png;base64,AA",
            "/sample-covers/a.png",
            "not a url",
            ""
        ]) {
            expect(proxiedCoverUrl(src, SITE)).toBe(src)
        }
    })

    it("lands on a catalog cover the cookie rule covers, so it loads without a crossorigin mode", () => {
        expect(isCatalogCoverUrl(new URL(proxiedCoverUrl(official, SITE)), SITE)).toBe(true)
        expect(mode(proxiedCoverUrl(official, SITE))).toBeUndefined()
    })
})

describe("libraryCoverMode", () => {
    const lib = (src: string | undefined, origins = permitted) => libraryCoverMode(src, origins, SITE)

    it("leaves a permitted catalog cover, proxied or direct, to the cookie rule", () => {
        expect(lib(proxiedCoverUrl("https://uploads.mangadex.org/covers/a/b.jpg", SITE))).toBeUndefined()
        expect(lib("https://s4.anilist.co/file/c.jpg")).toBeUndefined()
    })

    it("loads a catalog cover without credentials when its host is not permitted", () => {
        expect(lib("https://cdn.myanimelist.net/c.jpg")).toBe("anonymous")
        expect(lib("https://weeb.ltd/api/cover?u=a&s=b", [])).toBe("anonymous")
    })

    it("leaves a followed site's cover and cached blobs as they were", () => {
        expect(lib("https://reader.example/c.png")).toBeUndefined()
        expect(lib("https://img.example.net/c.png")).toBeUndefined()
        expect(lib("blob:chrome-extension://abc/1")).toBeUndefined()
        expect(lib(undefined)).toBeUndefined()
    })
})

describe("coverCrossOrigin", () => {
    it("leaves a permitted catalog cover to the cookie rule", () => {
        expect(mode("https://s4.anilist.co/file/c.jpg")).toBeUndefined()
        expect(mode("https://weeb.ltd/api/cover?u=a&s=b")).toBeUndefined()
    })

    it("loads any other cover without credentials, permitted or not", () => {
        expect(mode("https://img.example.net/c.png")).toBe("anonymous")
        expect(mode("https://reader.example/c.png")).toBe("anonymous")
        expect(mode("https://phinf.pstatic.net/c.jpg")).toBe("anonymous")
        expect(mode("https://img.example.net/c.png", ["https://*/*"])).toBe("anonymous")
        expect(mode("https://cdn.myanimelist.net/c.jpg")).toBe("anonymous")
    })

    it("leaves local and data covers alone", () => {
        expect(mode("/sample-covers/a.png")).toBeUndefined()
        expect(mode("data:image/png;base64,AA")).toBeUndefined()
        expect(mode("blob:chrome-extension://abc/1")).toBeUndefined()
    })
})
