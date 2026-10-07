import { describe, expect, it } from "vitest"
import { draftProfileFromSignals, type CaptureSignals } from "./draft"
import { parseProfile } from "./profile-schema"

describe("draftProfileFromSignals", () => {
    const signals: CaptureSignals = {
        url: "https://www.webtoons.com/en/fantasy/tower-of-god/list?title_no=95",
        ogTitle: "Tower of God | WEBTOON",
        ogImage: "https://swebtoon-phinf.pstatic.net/cover.jpg",
        links: [
            {
                href: "https://www.webtoons.com/en/fantasy/tower-of-god/ep-1/viewer?title_no=95&episode_no=1",
                text: "Ep 1"
            },
            {
                href: "https://www.webtoons.com/en/fantasy/tower-of-god/ep-2/viewer?title_no=95&episode_no=2",
                text: "Ep 2"
            },
            { href: "/about", text: "About" }
        ],
        images: [
            "https://webtoon-phinf.pstatic.net/a/001.jpg",
            "https://webtoon-phinf.pstatic.net/a/002.jpg",
            "https://ad.example.com/banner.png"
        ]
    }

    it("fills the reliable fields from the page", () => {
        const draft = draftProfileFromSignals(signals) as Record<string, unknown>
        expect(draft.origin).toBe("https://www.webtoons.com")
        expect(draft.domains).toEqual(["www.webtoons.com"])
        expect(draft.name).toBe("Tower of God")
        expect((draft.series as { titlePattern: string }).titlePattern).toContain("og:title")
        expect((draft.series as { coverPattern?: string }).coverPattern).toContain("og:image")
    })

    it("guesses a list pattern with a chapter-number capture", () => {
        const draft = draftProfileFromSignals(signals) as Record<string, unknown>
        const list = draft.list as { itemPattern: string }
        expect(list.itemPattern).toContain("(?<chapterNumber>")
    })

    it("drafts a format-2 profile with no image extraction (reading is on-site)", () => {
        const draft = draftProfileFromSignals(signals) as Record<string, unknown>
        expect(draft.profileFormat).toBe(2)
        expect(draft.numberingKind).toBe("chapter")
        expect(draft.pages).toBeUndefined()
        expect(draft.capabilities).toEqual(["chapters", "manga"])
    })

    it("produces JSON that parses as a valid profile once the chapter pattern is fixed", () => {
        const draft = draftProfileFromSignals(signals) as Record<string, unknown>
        // The chapter match is a placeholder; replace it with a real one and the draft validates.
        ;(draft.match as { chapter: string }).chapter = "^/en/[^/]+/([^/]+)/[^/]+/viewer/?$"
        const parsed = parseProfile(draft)
        expect(parsed.ok).toBe(true)
    })
})

describe("draft hardening against hostile captured links", () => {
    const longDigits = "1".repeat(20_000)

    it("handles a 20KB digit-run href quickly (was cubic in the last-number lookahead)", () => {
        const started = Date.now()
        const draft = draftProfileFromSignals({
            url: "https://reader.example/manga/demo",
            links: [{ href: `/manga/demo/chapter-${longDigits}`, text: "x" }],
            images: []
        })
        expect(Date.now() - started).toBeLessThan(500)
        expect((draft["list"] as { itemPattern: string }).itemPattern).toContain("REPLACE")
    })

    it("still guesses from a normal-length numeric href", () => {
        const draft = draftProfileFromSignals({
            url: "https://reader.example/manga/demo",
            links: [{ href: "/manga/demo/chapter-12", text: "x" }],
            images: []
        })
        expect((draft["list"] as { itemPattern: string }).itemPattern).toContain("chapterNumber")
    })

    it("a long digit run just under the cap is linear", () => {
        const started = Date.now()
        draftProfileFromSignals({
            url: "https://reader.example/manga/demo",
            links: [{ href: `/c/${"9".repeat(2000)}`, text: "x" }],
            images: []
        })
        expect(Date.now() - started).toBeLessThan(500)
    })
})
