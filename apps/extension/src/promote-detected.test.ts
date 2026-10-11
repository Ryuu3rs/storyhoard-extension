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
