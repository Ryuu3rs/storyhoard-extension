import { describe, expect, it } from "vitest"
import { chaptersFromObservedList } from "./observed-chapter-list"
import { detectedPageFor } from "./detected-site"

const u = (s: string) => new URL(s)

function page(url: string) {
    const found = detectedPageFor(url)
    if (!found) throw new Error(`expected ${url} to be detected`)
    return found
}

// A url-numbered detected site whose SERIES SLUG happens to contain a chapter keyword
// immediately followed by digits ("catch-22", "deep-6-dive", "witch-5-sisters"). The
// chapter number has to come from the URL only when the link's visible text names none
// (a title line, a date, an icon), which is exactly the numberFromUrl fallback path.
describe("a detected slug that contains a chapter keyword and digits", () => {
    const run = (pageUrl: string, items: Array<{ url: string; text: string }>) => {
        const p = page(pageUrl)
        return chaptersFromObservedList({
            sourceId: p.sourceId,
            match: p.match,
            ownerOf: p.ownerOf,
            allowedOrigins: p.allowedOrigins,
            sourceMangaId: p.sourceMangaId,
            mangaId: `${p.sourceId}:manga:${p.sourceMangaId}`,
            numberFromUrl: p.numberFromUrl,
            items
        })
    }

    it("numbers each chapter from the chapter segment, never from a digit in the slug", () => {
        const PAGE = "https://reader.example/manga/catch-22/chapter-5"
        const p = page(PAGE)
        // The chapter shape derives cleanly: slug catch-22, chapter number 5.
        expect(p.sourceMangaId).toBe("catch-22")
        // What a visit records for this exact address.
        expect(p.numberOf(u(PAGE))).toBe(5)

        // The list the page shows, with link text that carries no number (chapter titles only),
        // so the URL fallback is used for the number - the same addresses, same site, same series.
        const rows = run(PAGE, [
            { url: "https://reader.example/manga/catch-22/chapter-5", text: "The Soldier in White" },
            { url: "https://reader.example/manga/catch-22/chapter-6", text: "Hungry Joe" },
            { url: "https://reader.example/manga/catch-22/chapter-7", text: "McWatt" }
        ])

        // Each distinct chapter must keep its own number; a visit (5) and the list must agree.
        expect(rows.map(r => r.sortKey).sort((a, b) => a - b)).toEqual([5, 6, 7])
    })

    it("agrees with the visit number on each such address", () => {
        for (const [address, expected] of [
            ["https://reader.example/manga/catch-22/chapter-5", 5],
            ["https://reader.example/webtoon/deep-6-dive/episode-11", 11],
            ["https://reader.example/series/witch-5-sisters/chapter-20", 20]
        ] as const) {
            const p = page(address)
            const visit = p.numberOf(u(address))
            const rows = chaptersFromObservedList({
                sourceId: p.sourceId,
                match: p.match,
                ownerOf: p.ownerOf,
                allowedOrigins: p.allowedOrigins,
                sourceMangaId: p.sourceMangaId,
                mangaId: "m",
                numberFromUrl: p.numberFromUrl,
                items: [{ url: address, text: "Read now" }]
            })
            expect(visit, address).toBe(expected)
            expect(
                rows.map(r => r.sortKey),
                address
            ).toEqual([visit])
        }
    })
})
