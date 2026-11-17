import { describe, expect, it } from "vitest"
import { isCatalogCoverUrl, isPlaceholderCoverUrl, placeholderBlobIds, placeholderCoverIds } from "./placeholder-covers"

describe("isPlaceholderCoverUrl", () => {
    it("flags loader and spacer files and inline SVG", () => {
        expect(isPlaceholderCoverUrl("https://site.example/static/img/loading.gif")).toBe(true)
        expect(isPlaceholderCoverUrl("https://site.example/img/spinner.svg?v=2")).toBe(true)
        expect(isPlaceholderCoverUrl("https://site.example/1x1.png")).toBe(true)
        expect(isPlaceholderCoverUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBe(true)
    })

    it("keeps ordinary cover addresses", () => {
        expect(isPlaceholderCoverUrl("https://cdn.example/covers/solo-leveling.jpg")).toBe(false)
        expect(isPlaceholderCoverUrl("https://cdn.example/covers/loading-the-hero/cover.jpg")).toBe(false)
        expect(isPlaceholderCoverUrl(undefined)).toBe(false)
    })
})

describe("placeholderCoverIds", () => {
    it("flags one image shared by titles with different names", () => {
        const ids = placeholderCoverIds([
            { id: "a", title: "Title A", coverUrl: "https://site.example/x.png" },
            { id: "b", title: "Title B", coverUrl: "https://site.example/x.png" },
            { id: "c", title: "Title C", coverUrl: "https://site.example/c.jpg" }
        ])
        expect([...ids].sort()).toEqual(["a", "b"])
    })

    it("keeps art shared by one title tracked on two sources", () => {
        const ids = placeholderCoverIds([
            { id: "one:a", title: "Solo Leveling", coverUrl: "https://cdn.example/sl.jpg" },
            { id: "two:a", title: "solo  leveling", coverUrl: "https://cdn.example/sl.jpg" }
        ])
        expect(ids.size).toBe(0)
    })

    it("keeps art shared by one work tracked under two names", () => {
        const art = "https://cdn.example/sl.jpg"
        const byAniList = placeholderCoverIds([
            { id: "one:a", title: "Solo Leveling", anilistId: 105398, coverUrl: art },
            { id: "two:a", title: "Na Honjaman Level Up", anilistId: 105398, coverUrl: art }
        ])
        const byWork = placeholderCoverIds([
            { id: "one:a", title: "Solo Leveling", workId: "w1", coverUrl: art },
            { id: "two:a", title: "Na Honjaman Level Up", workId: "w1", coverUrl: art }
        ])
        expect(byAniList.size).toBe(0)
        expect(byWork.size).toBe(0)
    })

    it("still flags an image shared by two works even when one of them has two names", () => {
        const ids = placeholderCoverIds([
            { id: "a1", title: "Solo Leveling", anilistId: 1, coverUrl: "https://site.example/x.png" },
            { id: "a2", title: "Na Honjaman Level Up", anilistId: 1, coverUrl: "https://site.example/x.png" },
            { id: "b", title: "Other Work", anilistId: 2, coverUrl: "https://site.example/x.png" }
        ])
        expect([...ids].sort()).toEqual(["a1", "a2", "b"])
    })

    it("flags one site image shared by two works that only share a title but carry different AniList ids", () => {
        const url = "https://site.example/img/cover.jpg"
        const ids = placeholderCoverIds([
            { id: "a", title: "Monster", anilistId: 30001, coverUrl: url },
            { id: "b", title: "Monster", anilistId: 99999, coverUrl: url },
            { id: "c", title: "Monster", workId: "w1", coverUrl: "https://site.example/img/other.jpg" },
            { id: "d", title: "Monster", workId: "w2", coverUrl: "https://site.example/img/other.jpg" }
        ])
        expect([...ids].sort()).toEqual(["a", "b", "c", "d"])
    })

    it("flags titles still named after their site's hostname that share the site's stand-in image", () => {
        const url = "https://site.example/img/cover.jpg"
        expect(
            [
                ...placeholderCoverIds([
                    { id: "a", title: "site.example", coverUrl: url, anilistId: 1 },
                    { id: "b", title: "site.example", coverUrl: url, anilistId: 2 }
                ])
            ].sort()
        ).toEqual(["a", "b"])
        expect(
            [
                ...placeholderCoverIds([
                    { id: "a", title: "site.example", coverUrl: url },
                    { id: "b", title: "site.example", coverUrl: url }
                ])
            ].sort()
        ).toEqual(["a", "b"])
    })

    it("still joins a shared title when only one side carries an id", () => {
        const art = "https://cdn.example/monster.jpg"
        const ids = placeholderCoverIds([
            { id: "a", title: "Monster", anilistId: 30001, coverUrl: art },
            { id: "b", title: "Monster", coverUrl: art }
        ])
        expect(ids.size).toBe(0)
    })

    it("flags the MAL no-image icon even on a single entry", () => {
        const url = "https://cdn.myanimelist.net/img/sp/icon/apple-touch-icon-256.png"
        expect(isPlaceholderCoverUrl(url)).toBe(true)
        const ids = placeholderCoverIds([
            { id: "a", title: "Work One", coverUrl: url },
            { id: "b", title: "Work Two", coverUrl: url }
        ])
        expect([...ids].sort()).toEqual(["a", "b"])
    })

    it("never treats a catalog or weeb.ltd cover as a shared site placeholder", () => {
        const ids = placeholderCoverIds([
            { id: "a", title: "Title A", coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/a.jpg" },
            { id: "b", title: "Title B", coverUrl: "https://s4.anilist.co/file/anilistcdn/media/manga/cover/a.jpg" },
            { id: "c", title: "Title C", coverUrl: "https://weeb.ltd/covers/c.webp" },
            { id: "d", title: "Title D", coverUrl: "https://weeb.ltd/covers/c.webp" }
        ])
        expect(ids.size).toBe(0)
        expect(isCatalogCoverUrl("https://cdn.myanimelist.net/images/manga/1.jpg")).toBe(true)
        expect(isCatalogCoverUrl("https://notanilist.co.example/a.jpg")).toBe(false)
    })
})

describe("placeholderBlobIds", () => {
    it("keeps an identical cached image shared by one work under two names", async () => {
        const art = () => new Blob(["same-art"], { type: "image/jpeg" })
        const ids = await placeholderBlobIds([
            { id: "a", title: "Solo Leveling", anilistId: 105398, blob: art() },
            { id: "b", title: "Na Honjaman Level Up", anilistId: 105398, blob: art() }
        ])
        expect(ids.size).toBe(0)
    })

    it("flags identical cached images across different titles only", async () => {
        const loader = () => new Blob(["same-frame"], { type: "image/png" })
        const ids = await placeholderBlobIds([
            { id: "a", title: "Title A", blob: loader() },
            { id: "b", title: "Title B", blob: loader() },
            { id: "c", title: "Title C", blob: new Blob(["diff-frame"], { type: "image/png" }) }
        ])
        expect([...ids].sort()).toEqual(["a", "b"])
    })

    it("flags an animated cover even when only one title has it", async () => {
        const head = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]
        const frame = [0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0]
        const animated = new Blob([new Uint8Array([...head, ...frame, ...frame, 0x3b])], { type: "image/gif" })
        const still = new Blob([new Uint8Array([...head, ...frame, 0x3b])], { type: "image/gif" })
        const ids = await placeholderBlobIds([
            { id: "loader", title: "Title A", blob: animated },
            { id: "art", title: "Title B", blob: still }
        ])
        expect([...ids]).toEqual(["loader"])
    })
})
