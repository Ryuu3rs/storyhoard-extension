import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it } from "vitest"
import { db, promoteDetectedManga } from "./database"
import type { LibraryManga } from "./database"

// Repro: a site that was followed, then removed (so passive "detected" tracking took over),
// then followed again. On the re-follow, promoteDetectedManga merges the detected copy into the
// still-present followed row via its same-site branch (remapExternalChapterProgress). The detected
// copy read a chapter all the way to the end; the followed row still holds an older, shorter
// progress row for that same chapter number. The fold must keep the FURTHEST page reached
// (mergeVisitRows does exactly this), but remapExternalChapterProgress takes whichever row has the
// newer updatedAt wholesale, so the resume position is thrown back to the stale, shorter one.

const DETECTED = "detected:reader.example"
const FOLLOWED = "reader.example"
const SLUG = "demo-title"
const FROM_ID = `${DETECTED}:manga:${SLUG}`
const TO_ID = `${FOLLOWED}:manga:${SLUG}`
const canonical = (n: number) => `${FOLLOWED}:chapter:${SLUG}:${n}`

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

async function chap(mangaId: string, sourceId: string, id: string, n: number) {
    await db.chapters.put({
        id,
        mangaId,
        sourceId,
        title: `Chapter ${n}`,
        url: `https://reader.example/manga/${SLUG}/chapter-${n}`,
        sortKey: n
    })
}

async function prog(
    mangaId: string,
    chapterId: string,
    pageIndex: number,
    pageCount: number,
    completed: boolean,
    updatedAt: number
) {
    await db.progress.put({ mangaId, chapterId, pageIndex, pageCount, completed, updatedAt })
}

beforeEach(async () => {
    await Promise.all([
        db.manga.clear(),
        db.chapters.clear(),
        db.progress.clear(),
        db.historyEvents.clear(),
        db.sourceLinks.clear()
    ])
})

describe("promote same-site fold keeps the furthest page of a shared chapter", () => {
    it("does not throw the resume position back to a stale, shorter progress row", async () => {
        // Followed row survives a source removal, holding an older, page-2 read of chapter 5.
        await db.manga.put(
            manga(TO_ID, FOLLOWED, {
                lastReadChapterNumber: 5,
                lastReadChapterId: canonical(5),
                latestChapterNumber: 5,
                latestChapterId: canonical(5)
            })
        )
        await chap(TO_ID, FOLLOWED, canonical(5), 5)
        // The stale followed progress is NEWER by timestamp but only reached page 2 of 40.
        await prog(TO_ID, canonical(5), 2, 40, false, 200)

        // While unregistered, the detected copy read chapter 5 to the very end (older timestamp).
        await db.manga.put(
            manga(FROM_ID, DETECTED, {
                lastReadChapterNumber: 5,
                lastReadChapterId: `${FROM_ID}:ext:ch-5`
            })
        )
        await chap(FROM_ID, DETECTED, `${FROM_ID}:ext:ch-5`, 5)
        await prog(FROM_ID, `${FROM_ID}:ext:ch-5`, 39, 40, true, 100)

        await promoteDetectedManga(DETECTED, FOLLOWED)

        const folded = await db.progress.get(canonical(5))
        // The furthest page reached (39) must survive the fold - the chapter was read to the end.
        expect(folded?.pageIndex).toBe(39)
        expect(folded?.completed).toBe(true)
    })
})
