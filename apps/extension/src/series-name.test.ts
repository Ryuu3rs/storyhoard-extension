import { describe, expect, it } from "vitest"
import { seriesNameFromPage, seriesNameFromTitle } from "./series-name"

const HOST = "reader-demo.net"
const SLUG = "lantern-keeper-3f9c2b71"
const at = { slug: SLUG, host: HOST }

describe("seriesNameFromTitle", () => {
    it("takes the chapter label off", () => {
        expect(seriesNameFromTitle("Lantern Keeper Chapter 3", at)).toBe("Lantern Keeper")
        expect(seriesNameFromTitle("Lantern Keeper Ch. 3", at)).toBe("Lantern Keeper")
        expect(seriesNameFromTitle("Lantern Keeper, Episode 12", at)).toBe("Lantern Keeper")
        expect(seriesNameFromTitle("Lantern Keeper #12", at)).toBe("Lantern Keeper")
        expect(seriesNameFromTitle("Chapter 3 - Lantern Keeper", at)).toBe("Lantern Keeper")
        expect(seriesNameFromTitle("Read Lantern Keeper Chapter 3 Online", at)).toBe("Lantern Keeper")
    })

    it("takes the site's name off, from og:site_name or the host", () => {
        expect(seriesNameFromTitle("Lantern Keeper Chapter 3 - Reader Demo", at)).toBe("Lantern Keeper")
        expect(seriesNameFromTitle("Lantern Keeper Chapter 3 | reader-demo.net", at)).toBe("Lantern Keeper")
        expect(seriesNameFromTitle("Reader Demo | Lantern Keeper - Chapter 3", at)).toBe("Lantern Keeper")
        expect(
            seriesNameFromTitle(`Paper Lamp Comics ${String.fromCharCode(0x2013)} Lantern Keeper Chapter 3`, {
                ...at,
                siteName: "Paper Lamp Comics"
            })
        ).toBe("Lantern Keeper")
    })

    it("keeps punctuation that is part of the name", () => {
        expect(seriesNameFromTitle("The Lantern Keeper's Oath: Rekindled Chapter 3 - Reader Demo", at)).toBe(
            "The Lantern Keeper's Oath: Rekindled"
        )
        expect(seriesNameFromTitle("Re:Lantern Keeper Chapter 3", at)).toBe("Re:Lantern Keeper")
        expect(seriesNameFromTitle("Lantern-Keeper No. 8 Chapter 3", at)).toBe("Lantern-Keeper No. 8")
    })

    it("refuses a title that does not name this series", () => {
        expect(seriesNameFromTitle("Just a moment...", at)).toBeUndefined()
        expect(seriesNameFromTitle("Reader Demo - Read comics online", at)).toBeUndefined()
        expect(seriesNameFromTitle("Harbor Lights Chapter 3 - Reader Demo", at)).toBeUndefined()
        expect(seriesNameFromTitle("Chapter 3", at)).toBeUndefined()
        expect(seriesNameFromTitle("", at)).toBeUndefined()
        expect(seriesNameFromTitle(undefined, at)).toBeUndefined()
    })

    it("does not take a weak shared word or the hash as proof", () => {
        const slug = "the-lantern-keeper-3f9c2b71"
        expect(seriesNameFromTitle("The Best Comics Chapter 3", { slug, host: HOST })).toBeUndefined()
        expect(seriesNameFromTitle("3f9c2b71 Chapter 3", { slug, host: HOST })).toBeUndefined()
    })

    it("accepts the page's name for a slug that is only an id", () => {
        expect(seriesNameFromTitle("Lantern Keeper Chapter 3 - Reader Demo", { slug: "48213", host: HOST })).toBe(
            "Lantern Keeper"
        )
    })

    it("strips invisible and direction characters and caps the length", () => {
        const hidden = `Lantern${String.fromCharCode(0x200b)} Keeper${String.fromCharCode(0x202e)} Chapter 3`
        expect(seriesNameFromTitle(hidden, at)).toBe("Lantern Keeper")
        const long = `Lantern Keeper ${"and more ".repeat(40)}Chapter 3`
        expect(seriesNameFromTitle(long, at)!.length).toBeLessThanOrEqual(120)
    })
})

describe("seriesNameFromPage", () => {
    it("prefers og:title, then the document title, then the heading", () => {
        expect(
            seriesNameFromPage(
                {
                    ogTitle: "Lantern Keeper: Embers Chapter 3",
                    docTitle: "Lantern Keeper Chapter 3 - Reader Demo",
                    heading: "Lantern Keeper"
                },
                at
            )
        ).toBe("Lantern Keeper: Embers")
        expect(
            seriesNameFromPage(
                { ogTitle: "Reader Demo", docTitle: "Lantern Keeper Chapter 3 - Reader Demo", heading: "x" },
                at
            )
        ).toBe("Lantern Keeper")
        expect(seriesNameFromPage({ docTitle: "Just a moment...", heading: "Lantern Keeper Chapter 3" }, at)).toBe(
            "Lantern Keeper"
        )
    })

    it("uses og:site_name to drop the site's own part", () => {
        expect(
            seriesNameFromPage({ ogTitle: "Night Lamp Scans | Lantern Keeper", siteName: "Night Lamp Scans" }, at)
        ).toBe("Lantern Keeper")
    })

    it("gives nothing when no text names the series", () => {
        expect(seriesNameFromPage({ ogTitle: "Reader Demo", docTitle: "Just a moment..." }, at)).toBeUndefined()
        expect(seriesNameFromPage({}, at)).toBeUndefined()
    })
})
