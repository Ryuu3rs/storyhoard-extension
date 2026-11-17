import { describe, expect, it } from "vitest"
import { groupUpdateProblems, hasFixItWork, isHostnameTitle } from "./fix-it-groups"

describe("groupUpdateProblems", () => {
    it("sorts problems by the action that fixes them", () => {
        const groups = groupUpdateProblems({
            relinkTitles: [
                { mangaId: "a", title: "A", sourceId: "gone", reason: "site-off" },
                { mangaId: "b", title: "B", sourceId: "gone", reason: "site-off" },
                { mangaId: "c", title: "C", sourceId: "other", reason: "site-off" },
                { mangaId: "d", title: "D", sourceId: "s1", reason: "no-link" }
            ],
            errors: [
                {
                    mangaId: "e",
                    title: "E",
                    message: "Request failed with status 404",
                    sourceId: "s1",
                    cause: "http-404"
                },
                { mangaId: "f", title: "F", message: "Request failed", sourceId: "s2", cause: "network" },
                {
                    mangaId: "g",
                    title: "G",
                    message: "Request failed with status 503",
                    sourceId: "s2",
                    cause: "http-503"
                },
                { mangaId: "h", title: "H", message: "Something odd", sourceId: "s3", cause: "other" }
            ],
            needsVerify: [
                {
                    origin: "https://x.example",
                    sourceId: "x",
                    count: 2,
                    openUrl: "https://x.example/t",
                    sampleTitle: "X"
                }
            ]
        })

        expect(groups.sites.map(site => [site.sourceId, site.titles.length])).toEqual([
            ["gone", 2],
            ["other", 1]
        ])
        expect(groups.lost.map(t => [t.mangaId, t.detail])).toEqual([
            ["d", "No link saved"],
            ["e", "Page gone"]
        ])
        expect(groups.retry.map(t => t.mangaId)).toEqual(["f", "g"])
        expect(groups.other.map(t => [t.mangaId, t.detail])).toEqual([["h", "Something odd"]])
        expect(groups.visit).toHaveLength(1)
    })

    it("reads the cause from the message on an older stored status", () => {
        const groups = groupUpdateProblems({
            errors: [
                { mangaId: "a", title: "A", message: "Request failed with status 404" },
                { mangaId: "b", title: "B", message: "Request failed" },
                { mangaId: "c", title: "C", message: "Request limit of 20 exceeded" }
            ],
            relinkTitles: [{ mangaId: "d", title: "D", sourceId: "s" }]
        })
        expect(groups.lost.map(t => t.mangaId)).toEqual(["d", "a"])
        expect(groups.retry.map(t => t.mangaId)).toEqual(["b", "c"])
    })

    it("lists a title once even when it shows up twice", () => {
        const groups = groupUpdateProblems({
            relinkTitles: [{ mangaId: "a", title: "A", sourceId: "s", reason: "no-link" }],
            errors: [{ mangaId: "a", title: "A", message: "x", cause: "http-404" }]
        })
        expect(groups.lost).toHaveLength(1)
    })

    it("returns empty groups for no status", () => {
        expect(groupUpdateProblems(null)).toEqual({ sites: [], visit: [], lost: [], retry: [], other: [] })
    })
})

describe("isHostnameTitle", () => {
    it("flags a bare site name and keeps real titles", () => {
        expect(isHostnameTitle("mangadex.org")).toBe(true)
        expect(isHostnameTitle("www.example.co.uk")).toBe(true)
        expect(isHostnameTitle("Dr. Stone")).toBe(false)
        expect(isHostnameTitle("Solo Leveling")).toBe(false)
        expect(isHostnameTitle("Vol.2")).toBe(false)
    })

    it("does not take a dotted real title for a hostname", () => {
        expect(isHostnameTitle("Dr.STONE")).toBe(false)
        expect(isHostnameTitle("Dr.Slump")).toBe(false)
    })
})

describe("hasFixItWork", () => {
    it("is false only when the last check left nothing to fix", () => {
        expect(hasFixItWork(groupUpdateProblems(null))).toBe(false)
        expect(hasFixItWork(groupUpdateProblems({ errors: [], relinkTitles: [], needsVerify: [] }))).toBe(false)
    })

    it("is true for titles on a site that is not connected, even with no errors", () => {
        const status = { relinkTitles: [{ mangaId: "a", title: "A", sourceId: "gone", reason: "site-off" as const }] }
        expect(hasFixItWork(groupUpdateProblems(status))).toBe(true)
    })

    it("is true for a lost link, a retry, another error or a site asking for a visit", () => {
        const one = (status: Parameters<typeof groupUpdateProblems>[0]) => hasFixItWork(groupUpdateProblems(status))
        expect(one({ relinkTitles: [{ mangaId: "a", title: "A", sourceId: "s", reason: "no-link" }] })).toBe(true)
        expect(one({ errors: [{ mangaId: "a", title: "A", message: "Request failed", cause: "network" }] })).toBe(true)
        expect(one({ errors: [{ mangaId: "a", title: "A", message: "odd", cause: "other" }] })).toBe(true)
        expect(
            one({ needsVerify: [{ origin: "https://a.test", sourceId: "s", count: 1, openUrl: "", sampleTitle: "A" }] })
        ).toBe(true)
    })
})
