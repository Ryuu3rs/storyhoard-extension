import { describe, expect, it } from "vitest"
import { isPlaceholderCoverUrl, placeholderBlobIds, placeholderCoverIds } from "./placeholder-covers"

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
})

describe("placeholderBlobIds", () => {
    it("flags identical cached images across different titles only", async () => {
        const loader = () => new Blob(["same-frame"], { type: "image/png" })
        const ids = await placeholderBlobIds([
            { id: "a", title: "Title A", blob: loader() },
            { id: "b", title: "Title B", blob: loader() },
            { id: "c", title: "Title C", blob: new Blob(["diff-frame"], { type: "image/png" }) }
        ])
        expect([...ids].sort()).toEqual(["a", "b"])
    })
})
