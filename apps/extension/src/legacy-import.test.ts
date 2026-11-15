import { describe, expect, it } from "vitest"
import { isLegacyExport, migrateLegacyImport } from "./legacy-import"

// ---------------------------------------------------------------------------
// isLegacyExport
// ---------------------------------------------------------------------------
describe("isLegacyExport", () => {
    it("detects a well-formed legacy export", () => {
        expect(isLegacyExport({ mangas: [] })).toBe(true)
        expect(isLegacyExport({ mangas: [{ n: "X", u: "https://example.com/" }] })).toBe(true)
    })

    it("rejects new-format envelopes (have format field)", () => {
        expect(isLegacyExport({ format: "all-mangas-reader", version: 1, mangas: [] })).toBe(false)
    })

    it("rejects non-objects", () => {
        expect(isLegacyExport(null)).toBe(false)
        expect(isLegacyExport("string")).toBe(false)
        expect(isLegacyExport(42)).toBe(false)
    })

    it("rejects objects without mangas array", () => {
        expect(isLegacyExport({ bookmarks: [] })).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// migrateLegacyImport - general behaviour
// ---------------------------------------------------------------------------
describe("migrateLegacyImport - passthrough for non-legacy input", () => {
    it("returns migrated: false when given new-format envelope", () => {
        const newFmt = { format: "all-mangas-reader", version: 1, exportedAt: 0, data: {} }
        const result = migrateLegacyImport(newFmt)
        expect(result.migrated).toBe(false)
        expect(result.envelope).toBe(newFmt)
    })
})

describe("migrateLegacyImport - skips invalid entries", () => {
    it("skips entries with no title", () => {
        const raw = { mangas: [{ u: "https://mangadex.org/title/abc" }] }
        const result = migrateLegacyImport(raw)
        expect(result.migrated).toBe(true)
        expect(result.converted).toBe(0)
        expect(result.skipped).toBe(1)
    })

    it("skips entries with no URL at all", () => {
        const raw = { mangas: [{ n: "Some Manga" }] }
        const result = migrateLegacyImport(raw)
        expect(result.skipped).toBe(1)
    })
})

// ---------------------------------------------------------------------------
// migrateLegacyImport - known sources resolve correctly
// ---------------------------------------------------------------------------
describe("migrateLegacyImport - known source URLs resolve to adapter ID", () => {
    it("resolves MangaDex URLs to mangadex adapter", () => {
        const raw = {
            mangas: [
                {
                    n: "Test Manga",
                    u: "https://mangadex.org/title/afa40bc8-34fa-4b03-a1e1-50f4eb79f9da"
                }
            ]
        }
        const result = migrateLegacyImport(raw)
        expect(result.converted).toBe(1)
        const manga = (result.envelope as any).data.manga[0]
        expect(manga.sourceId).toBe("mangadex")
        expect(manga.manualTracking).toBeUndefined()
        expect(result.needsAttention).toHaveLength(0)
    })

    it("extracts MangaDex UUID as sourceMangaId", () => {
        const uuid = "afa40bc8-34fa-4b03-a1e1-50f4eb79f9da"
        const raw = {
            mangas: [{ n: "Test", u: `https://mangadex.org/title/${uuid}` }]
        }
        const result = migrateLegacyImport(raw)
        const manga = (result.envelope as any).data.manga[0]
        expect(manga.sourceMangaId).toBe(uuid)
    })

    it("resolves asuratoon.com URLs to asurascans adapter via a legacy alias", () => {
        const raw = {
            mangas: [{ n: "My Hero Academia", u: "https://asuratoon.com/manga/my-hero-academia" }]
        }
        const result = migrateLegacyImport(raw)
        const manga = (result.envelope as any).data.manga[0]
        expect(manga.sourceId).toBe("asurascans")
        expect(manga.manualTracking).toBeUndefined()
    })
})

// ---------------------------------------------------------------------------
// migrateLegacyImport - LEGACY DOMAIN ALIAS MAP (the U1 bug fix)
// ---------------------------------------------------------------------------
describe("migrateLegacyImport - legacy domain aliases (U1 bug)", () => {
    it("maps asura.gg → asurascans", () => {
        const raw = {
            mangas: [
                {
                    n: "The S-Classes That I Raised",
                    u: "https://asura.gg/manga/the-s-classes-that-i-raised/"
                }
            ]
        }
        const result = migrateLegacyImport(raw)
        expect(result.needsAttention).toHaveLength(0)
        expect((result.envelope as any).data.manga[0].sourceId).toBe("asurascans")
    })

    it("maps www.asurascans.com → asurascans", () => {
        const raw = {
            mangas: [
                {
                    n: "Return of the Disaster-Class Hero",
                    u: "https://www.asurascans.com/manga/8239705535-return-of-the-disaster-class-hero/"
                }
            ]
        }
        const result = migrateLegacyImport(raw)
        expect(result.needsAttention).toHaveLength(0)
        expect((result.envelope as any).data.manga[0].sourceId).toBe("asurascans")
    })

    it("maps mangasushi.net → mangasushi", () => {
        const raw = {
            mangas: [{ n: "Sousou no Frieren", u: "https://mangasushi.net/manga/sousou-no-frieren/" }]
        }
        const result = migrateLegacyImport(raw)
        expect(result.needsAttention).toHaveLength(0)
        expect((result.envelope as any).data.manga[0].sourceId).toBe("mangasushi")
    })
})

// ---------------------------------------------------------------------------
// migrateLegacyImport - aliases removed for retired adapters (Bug 3 fix)
// ---------------------------------------------------------------------------
// These domains used to alias to manganato/mangapark/manhuaplus/mangabuddy/flamecomics/
// aquascans/s2manga/manhwahentai, but every one of those adapter ids is retired from the
// current registry. Keeping the alias produced a real-looking sourceId with no dot, which
// App.svelte's reconcile-needed check (`m.sourceId.includes(".")`) never caught - a silently
// stuck import with no reconcile UI ever offered. Removing the alias lets these domains fall
// through to the hostname-based unknown-source path instead, which IS reconcile-flagged.
describe("migrateLegacyImport - retired adapter aliases fall through to manualTracking (Bug 3 fix)", () => {
    it.each([
        ["chapmanganato.to (manganato)", "https://chapmanganato.to/manga-az963656"],
        ["chap.manganato.com (manganato)", "https://chap.manganato.com/manga-aa951409"],
        ["mangapark.com (mangapark)", "https://mangapark.com/title/17-en-berserk"],
        ["manhuaplus.com (manhuaplus)", "https://manhuaplus.com/manga/spirit-sword-sovereign/"],
        ["mangabuddy.com (mangabuddy)", "https://mangabuddy.com/manga/some-title"],
        ["flamecomics.com (flamecomics)", "https://flamecomics.com/series/some-title"],
        ["aquascans.com (aquascans)", "https://aquascans.com/manga/some-title/"],
        ["s2manga.com (s2manga)", "https://s2manga.com/manga/some-title/"],
        ["manhwahentai.me (manhwahentai)", "https://manhwahentai.me/webtoon/some-title/"]
    ])("%s is no longer aliased and gets manualTracking + a reconcile-flagged hostname sourceId", (_label, url) => {
        const raw = { mangas: [{ n: "Some Manga", u: url }] }
        const result = migrateLegacyImport(raw)
        const manga = (result.envelope as any).data.manga[0]
        expect(manga.manualTracking).toBe(true)
        expect(manga.sourceId).toBe(new URL(url).hostname)
        expect(manga.sourceId.includes(".")).toBe(true)
        expect(result.needsAttention).toContain(manga.id)
    })
})

// ---------------------------------------------------------------------------
// migrateLegacyImport - truly unknown sources still get manualTracking: true
// ---------------------------------------------------------------------------
describe("migrateLegacyImport - truly unknown source falls back to manualTracking", () => {
    it("flags a completely unrecognised domain as needing attention", () => {
        const raw = {
            mangas: [{ n: "Some Manga", u: "https://totally-unknown-old-site.xyz/manga/some-manga/" }]
        }
        const result = migrateLegacyImport(raw)
        expect(result.needsAttention).toHaveLength(1)
        const manga = (result.envelope as any).data.manga[0]
        expect(manga.manualTracking).toBe(true)
        // sourceId should be the hostname, not a clean adapter id
        expect(manga.sourceId).toBe("totally-unknown-old-site.xyz")
    })
})

// ---------------------------------------------------------------------------
// migrateLegacyImport - output shape
// ---------------------------------------------------------------------------
describe("migrateLegacyImport - output shape", () => {
    it("produces a valid v1 envelope with all required tables", () => {
        const raw = {
            mangas: [{ n: "Test", u: "https://mangadex.org/title/afa40bc8-34fa-4b03-a1e1-50f4eb79f9da" }]
        }
        const result = migrateLegacyImport(raw)
        const env = result.envelope as any
        expect(env.format).toBe("all-mangas-reader")
        expect(env.version).toBe(1)
        expect(Array.isArray(env.data.manga)).toBe(true)
        expect(Array.isArray(env.data.sourceLinks)).toBe(true)
        expect(Array.isArray(env.data.chapters)).toBe(true)
        expect(Array.isArray(env.data.historyEvents)).toBe(true)
    })

    it("deduplicates entries with the same computed id", () => {
        const raw = {
            mangas: [
                { n: "Dupe", u: "https://mangadex.org/title/afa40bc8-34fa-4b03-a1e1-50f4eb79f9da" },
                { n: "Dupe", u: "https://mangadex.org/title/afa40bc8-34fa-4b03-a1e1-50f4eb79f9da" }
            ]
        }
        const result = migrateLegacyImport(raw)
        expect(result.converted).toBe(1)
    })

    it("creates a sourceLink for known sources with a manga URL", () => {
        const raw = {
            mangas: [{ n: "Sousou no Frieren", u: "https://mangasushi.net/manga/sousou-no-frieren/" }]
        }
        const result = migrateLegacyImport(raw)
        expect((result.envelope as any).data.sourceLinks).toHaveLength(1)
    })

    it("synthesises a chapter record when last-chapter URL + chapter number are present", () => {
        const raw = {
            mangas: [
                {
                    n: "Sousou no Frieren",
                    u: "https://mangasushi.net/manga/sousou-no-frieren/",
                    l: "https://mangasushi.net/manga/sousou-no-frieren/chapter-428"
                }
            ]
        }
        const result = migrateLegacyImport(raw)
        const chapters = (result.envelope as any).data.chapters
        expect(chapters).toHaveLength(1)
        expect(chapters[0].sortKey).toBe(428)
    })
})

// ---------------------------------------------------------------------------
// migrateLegacyImport - read-progress derivation (cn label + broadened URLs)
// Entry shapes below mirror real old-AMR exports (AMR_2026-06-20 / 06-16).
// ---------------------------------------------------------------------------
describe("migrateLegacyImport - read-progress derivation", () => {
    const readNumberOf = (raw: unknown) =>
        (migrateLegacyImport(raw).envelope as any).data.manga[0].lastReadChapterNumber

    it("reads the number from cn.name for a MangaDex uuid chapter URL", () => {
        const raw = {
            mangas: [
                {
                    n: "Some MangaDex Title",
                    u: "https://mangadex.org/title/01e360bc-22da-4e86-bbb7-3ae1091a223b",
                    l: "https://mangadex.org/chapter/d6b0f743-0993-43ff-82a3-f85b6bf0b470",
                    cn: {
                        name: "85 - Message",
                        url: "https://mangadex.org/chapter/d6b0f743-0993-43ff-82a3-f85b6bf0b470"
                    }
                }
            ]
        }
        expect(readNumberOf(raw)).toBe(85)
    })

    it("reads the number from cn.name for a Weeb Central ulid chapter URL", () => {
        const raw = {
            mangas: [
                {
                    n: "Death Is the Only Ending for the Villainess",
                    u: "https://weebcentral.com/series/01J76XYDMZ059WG12B0QQWRYXS/x",
                    l: "https://weebcentral.com/chapters/01K4BM51JDZBYKK5QGDN7XF7WD",
                    cn: { name: "Episode 185", url: "https://weebcentral.com/chapters/01K4BM51JDZBYKK5QGDN7XF7WD" }
                }
            ]
        }
        expect(readNumberOf(raw)).toBe(185)
    })

    it("parses the fanfox /cNNN/ chapter URL when no cn is present (older export)", () => {
        const raw = {
            mangas: [
                {
                    n: "I'm Being Raised by Villains",
                    u: "https://fanfox.net/manga/i_m_being_raised_by_villains/",
                    l: "https://fanfox.net/manga/i_m_being_raised_by_villains/c112/"
                }
            ]
        }
        expect(readNumberOf(raw)).toBe(112)
    })

    it("parses the mangahere /cNNN/ chapter URL with a leading zero", () => {
        const raw = {
            mangas: [{ n: "X", u: "https://www.mangahere.cc/manga/x/", l: "https://www.mangahere.cc/manga/x/c045/" }]
        }
        expect(readNumberOf(raw)).toBe(45)
    })

    it("treats the chapter-N-M dash convention as the decimal N.M", () => {
        const raw = {
            mangas: [
                {
                    n: "Y",
                    u: "https://lhtranslation.net/manga/y/",
                    l: "https://lhtranslation.net/manga/y/chapter-23-7?style=list"
                }
            ]
        }
        expect(readNumberOf(raw)).toBe(23.7)
    })

    it("uses the cn.name chapter title on the synthesised chapter record", () => {
        const raw = {
            mangas: [
                {
                    n: "Z",
                    u: "https://mangadex.org/title/01e360bc-22da-4e86-bbb7-3ae1091a223b",
                    l: "https://mangadex.org/chapter/d6b0f743-0993-43ff-82a3-f85b6bf0b470",
                    cn: { name: "85 - Message" }
                }
            ]
        }
        const chapters = (migrateLegacyImport(raw).envelope as any).data.chapters
        expect(chapters[0].title).toBe("85 - Message")
        expect(chapters[0].sortKey).toBe(85)
    })

    it("preserves the last-read URL when the number is unrecoverable (ulid, no cn)", () => {
        const raw = {
            mangas: [
                {
                    n: "Rental Hero",
                    u: "https://weebcentral.com/series/01J76XYGVA5WQW846803Q1J9DJ/Rental-Hero",
                    l: "https://weebcentral.com/chapters/01J76XZ7N4Y3C0X29Y0TZ4QC3Y"
                }
            ]
        }
        const env = migrateLegacyImport(raw).envelope as any
        const manga = env.data.manga[0]
        const chapters = env.data.chapters
        // No number could be derived...
        expect(manga.lastReadChapterNumber).toBeUndefined()
        // ...but the last-read chapter is preserved so the title reads as "Read" (not
        // "Unread"), resume works, and a later relink can recover the number by URL.
        expect(chapters).toHaveLength(1)
        expect(chapters[0].url).toBe("https://weebcentral.com/chapters/01J76XZ7N4Y3C0X29Y0TZ4QC3Y")
        expect(Number.isFinite(chapters[0].sortKey)).toBe(false)
        expect(manga.lastReadChapterId).toBe(chapters[0].id)
    })
})

// ---------------------------------------------------------------------------
// migrateLegacyImport - bookmarks (real shape from user's export)
// ---------------------------------------------------------------------------
describe("migrateLegacyImport - bookmarks", () => {
    const sampleBookmark = {
        m: "MangaDex V5",
        n: "Wolf-chan wa Sumashitai",
        u: "https://mangadex.org/title/b24d2c22-5b28-44d4-a77f-0e920cd960a6",
        c: "https://mangadex.org/chapter/304d2896-9895-4d0a-b654-b3e5db7ddc27",
        h: "47 - Costume and Extinction",
        o: "",
        t: "scan",
        s: "https://cmdxd98sb0x3yprd.mangadex.network/data/97d9/3-abc.jpg",
        a: "3"
    }

    it("converts a legacy page bookmark into a pageBookmark", () => {
        const result = migrateLegacyImport({ mangas: [], bookmarks: [sampleBookmark] })
        const bookmarks = (result.envelope as any).data.pageBookmarks
        expect(bookmarks).toHaveLength(1)
        const bm = bookmarks[0]
        expect(bm.mangaId).toBe("mangadex:manga:b24d2c22-5b28-44d4-a77f-0e920cd960a6")
        expect(bm.chapterUrl).toBe("https://mangadex.org/chapter/304d2896-9895-4d0a-b654-b3e5db7ddc27")
        expect(bm.mangaTitle).toBe("Wolf-chan wa Sumashitai")
        expect(bm.chapterTitle).toBe("47 - Costume and Extinction")
        // a="3" is 1-based; reader pageIndex is 0-based.
        expect(bm.pageIndex).toBe(2)
        expect(bm.id).toBe(`${bm.chapterId}:2`)
    })

    it("attaches the bookmark to the same manga id the entry import creates", () => {
        const result = migrateLegacyImport({
            mangas: [{ n: "Wolf-chan wa Sumashitai", u: sampleBookmark.u }],
            bookmarks: [sampleBookmark]
        })
        const data = (result.envelope as any).data
        expect(data.pageBookmarks[0].mangaId).toBe(data.manga[0].id)
    })

    it("clamps a missing or first-page number to index 0", () => {
        const result = migrateLegacyImport({
            mangas: [],
            bookmarks: [
                { ...sampleBookmark, a: "1" },
                {
                    ...sampleBookmark,
                    c: "https://mangadex.org/chapter/aaaa1111-2222-3333-4444-555566667777",
                    a: undefined
                }
            ]
        })
        const bookmarks = (result.envelope as any).data.pageBookmarks
        expect(bookmarks.every((b: { pageIndex: number }) => b.pageIndex === 0)).toBe(true)
    })

    it("emits an empty pageBookmarks array when the export has none", () => {
        const result = migrateLegacyImport({ mangas: [], bookmarks: [] })
        expect((result.envelope as any).data.pageBookmarks).toEqual([])
    })

    // Regression: Webtoons chapter URLs all end in the path segment "viewer" (the
    // episode is in ?episode_no=N), so keying the bookmark id off the last path segment
    // collapsed every episode to one id and the dedup dropped all but one.
    it("keeps bookmarks in different Webtoons episodes distinct", () => {
        const base = "https://www.webtoons.com/en/action/slug"
        const result = migrateLegacyImport({
            mangas: [],
            bookmarks: [
                { n: "T", u: `${base}/list?title_no=95`, c: `${base}/ep-1/viewer?title_no=95&episode_no=1`, a: "3" },
                { n: "T", u: `${base}/list?title_no=95`, c: `${base}/ep-2/viewer?title_no=95&episode_no=2`, a: "3" }
            ]
        })
        const bookmarks = (result.envelope as any).data.pageBookmarks
        expect(bookmarks).toHaveLength(2)
        expect(new Set(bookmarks.map((b: { id: string }) => b.id)).size).toBe(2)
        expect(new Set(bookmarks.map((b: { chapterId: string }) => b.chapterId)).size).toBe(2)
    })
})

describe("migrateLegacyImport tolerates malformed entries", () => {
    it("skips and counts bad manga entries instead of aborting", () => {
        const result = migrateLegacyImport({
            mangas: [null, { n: 123 }, "junk", { n: "Good", u: "https://example.com/manga/good" }]
        })
        expect(result.migrated).toBe(true)
        expect(result.converted).toBe(1)
        expect(result.skipped).toBe(3)
    })

    it("ignores bookmarks that are not an array and bad bookmark entries", () => {
        const asObject = migrateLegacyImport({
            mangas: [{ n: "Good", u: "https://example.com/manga/good" }],
            bookmarks: { a: 1 }
        })
        expect(asObject.converted).toBe(1)
        const badEntries = migrateLegacyImport({
            mangas: [{ n: "Good", u: "https://example.com/manga/good" }],
            bookmarks: [null, { u: 5, c: {} }]
        })
        expect(badEntries.converted).toBe(1)
    })
})
