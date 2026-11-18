import { describe, expect, it } from "vitest"
import { coverCrossOrigin, isCatalogCoverUrl } from "./cover-crossorigin"

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
