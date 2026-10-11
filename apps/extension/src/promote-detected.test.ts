import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { db, promoteDetectedManga } from "./database"
import type { LibraryManga } from "./database"

const DETECTED = "detected:reader.example"
const FOLLOWED = "reader.example"
const SLUG = "demo-title"
const FROM_ID = `${DETECTED}:manga:${SLUG}`
const TO_ID = `${FOLLOWED}:manga:${SLUG}`

function manga(id: string, sourceId: string, extra: Partial<LibraryManga> = {}): LibraryManga {
    return {
        id,
        title: "Demo Title",
        normalizedTitle: "demo title",
        authors: [],
        status: "unknown",
        addedAt: 1,
        updatedAt: 1,
        sourceId,
        sourceUrl: `https://reader.example/manga/${SLUG}/chapter-1`,
        mangaUrl: `https://reader.example/manga/${SLUG}`,
        sourceMangaId: SLUG,
        ...extra
    }
}

async function chapter(mangaId: string, sourceId: string, id: string, n: number) {
    await db.chapters.put({
        id,
        mangaId,
        sourceId,
        title: `Chapter ${n}`,
        url: `https://reader.example/manga/${SLUG}/chapter-${n}`,
        sortKey: n
    })
}

async function read(mangaId: string, chapterId: string, completed = true) {
    await db.progress.put({ mangaId, chapterId, pageIndex: 0, pageCount: 1, completed, updatedAt: 5 })
}

beforeEach(async () => {
    vi.restoreAllMocks()
    await Promise.all([
        db.manga.clear(),
        db.chapters.clear(),
        db.progress.clear(),
        db.historyEvents.clear(),
        db.sourceLinks.clear()
    ])
})

describe("promoteDetectedManga while the library changes underneath it", () => {
    it("does not bring back a title that was removed after the sweep listed it", async () => {
        await db.manga.put(manga(FROM_ID, DETECTED))
        const original = db.manga.get.bind(db.manga) as (key: string) => Promise<LibraryManga | undefined>
        let removed = false
        vi.spyOn(db.manga, "get").mockImplementation((async (key: string) => {
            if (!removed) {
                removed = true
                await db.manga.delete(FROM_ID)
            }
            return original(key)
        }) as unknown as typeof db.manga.get)

        await promoteDetectedManga(DETECTED, FOLLOWED)

        vi.restoreAllMocks()
        expect(removed).toBe(true)
        expect(await db.manga.get(TO_ID)).toBeUndefined()
        expect(await db.manga.get(FROM_ID)).toBeUndefined()
        expect(await db.sourceLinks.get(TO_ID)).toBeUndefined()
    })

    it("moves a title that a visit wrote after the sweep started", async () => {
        await db.manga.put(manga(FROM_ID, DETECTED))
        await chapter(FROM_ID, DETECTED, `${FROM_ID}:ext:ch-2`, 2)
        await read(FROM_ID, `${FROM_ID}:ext:ch-2`)

        expect(await promoteDetectedManga(DETECTED, FOLLOWED)).toBe(1)

        expect(await db.manga.get(TO_ID)).toMatchObject({ sourceId: FOLLOWED })
        expect((await db.progress.toArray()).map(p => p.mangaId)).toEqual([TO_ID])
    })
})

async function dangling(): Promise<string[]> {
    const lost: string[] = []
    for (const progress of await db.progress.toArray()) {
        if (!(await db.chapters.get(progress.chapterId))) lost.push(progress.chapterId)
    }
    for (const row of await db.manga.toArray()) {
        if (row.lastReadChapterId && !(await db.chapters.get(row.lastReadChapterId))) lost.push(row.lastReadChapterId)
    }
    return lost
}

const canonical = (n: number) => `${FOLLOWED}:chapter:${SLUG}:${n}`

describe("promoting into a followed title that already exists", () => {
    async function followedAt(read: number) {
        await db.manga.put(
            manga(TO_ID, FOLLOWED, {
                lastReadChapterNumber: read,
                lastReadChapterId: canonical(read),
                lastReadAt: 100,
                latestChapterNumber: 5,
                latestChapterId: canonical(5)
            })
        )
        for (const n of [1, 2, 3, 4, 5]) await chapter(TO_ID, FOLLOWED, canonical(n), n)
        await read_(TO_ID, canonical(read))
    }
    const read_ = read

    it("takes the position the detected copy read further, and keeps its progress resolvable", async () => {
        await followedAt(3)
        await db.manga.put(
            manga(FROM_ID, DETECTED, {
                lastReadChapterNumber: 8,
                lastReadChapterId: `${FROM_ID}:ext:ch-8`,
                lastReadAt: 200
            })
        )
        await chapter(FROM_ID, DETECTED, `${FROM_ID}:ext:ch-8`, 8)
        await read(FROM_ID, `${FROM_ID}:ext:ch-8`)

        await promoteDetectedManga(DETECTED, FOLLOWED)

        const merged = await db.manga.get(TO_ID)
        expect(merged?.lastReadChapterNumber).toBe(8)
        expect(merged?.lastReadAt).toBe(200)
        expect(await db.chapters.get(merged!.lastReadChapterId!)).toMatchObject({ sortKey: 8, mangaId: TO_ID })
        expect(await dangling()).toEqual([])
        expect(await db.manga.get(FROM_ID)).toBeUndefined()
    })

    it("never moves the followed position back when the detected copy read less", async () => {
        await followedAt(5)
        await db.manga.put(
            manga(FROM_ID, DETECTED, {
                lastReadChapterNumber: 2,
                lastReadChapterId: `${FROM_ID}:ext:ch-2`,
                lastReadAt: 50
            })
        )
        await chapter(FROM_ID, DETECTED, `${FROM_ID}:ext:ch-2`, 2)
        await read(FROM_ID, `${FROM_ID}:ext:ch-2`)

        await promoteDetectedManga(DETECTED, FOLLOWED)

        const merged = await db.manga.get(TO_ID)
        expect(merged).toMatchObject({ lastReadChapterNumber: 5, lastReadChapterId: canonical(5) })
        const progress = await db.progress.toArray()
        expect(progress.map(p => p.chapterId).sort()).toEqual([canonical(2), canonical(5)])
        expect(progress.every(p => p.mangaId === TO_ID)).toBe(true)
        expect(await dangling()).toEqual([])
    })
})

describe("promoting files a title under the followed source's own identity", () => {
    it("uses the id the followed source resolves from a chapter address, not the detected slug", async () => {
        await db.manga.put(manga(FROM_ID, DETECTED))
        await chapter(FROM_ID, DETECTED, `${FROM_ID}:ext:ch-2`, 2)
        await read(FROM_ID, `${FROM_ID}:ext:ch-2`)
        const asked: string[] = []

        await promoteDetectedManga(DETECTED, FOLLOWED, url => {
            asked.push(url)
            return { sourceMangaId: "demo-title.x1", mangaUrl: "https://reader.example/series/demo-title.x1" }
        })

        const nextId = `${FOLLOWED}:manga:demo-title.x1`
        expect(asked.length).toBeGreaterThan(0)
        expect(await db.manga.get(TO_ID)).toBeUndefined()
        expect(await db.manga.get(nextId)).toMatchObject({
            sourceId: FOLLOWED,
            sourceMangaId: "demo-title.x1",
            mangaUrl: "https://reader.example/series/demo-title.x1"
        })
        expect(await db.sourceLinks.get(nextId)).toMatchObject({
            sourceMangaId: "demo-title.x1",
            url: "https://reader.example/series/demo-title.x1"
        })
        expect((await db.progress.toArray()).map(p => p.mangaId)).toEqual([nextId])
    })

    it("keeps the detected slug when the followed source cannot name the title", async () => {
        await db.manga.put(manga(FROM_ID, DETECTED))

        await promoteDetectedManga(DETECTED, FOLLOWED, () => undefined)

        expect(await db.manga.get(TO_ID)).toMatchObject({ sourceMangaId: SLUG })
    })
})
