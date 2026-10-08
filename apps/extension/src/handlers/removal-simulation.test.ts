import "fake-indexeddb/auto"
import type { SourceLinkRecord } from "@amr/contracts"
import { madaraSiteConfigs, mangaStreamSiteConfigs, sourceRegistry } from "@amr/sources"
import { createBoundedRequestClient, type FetchFunction, type SourceContext } from "@amr/source-sdk"
import { fakeBrowser } from "wxt/testing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LibraryManga } from "../database"

// END-TO-END "adapters off" simulation = the P6/P7 removal release, exercised NOW without actually
// deleting any adapter. For a sample of sources we: seed a library, run the one-time migration seed,
// UNREGISTER the bundled adapters (what the removal release does), re-register from the seed, then
// prove the library rows still resolve, their chapter lists still come back through the generic
// engine (list-capable families), and the un-listable bespoke ones degrade to tracking-only - with
// read progress intact.

vi.stubGlobal("browser", fakeBrowser)

const { db } = await import("../database")
const { getSourceById } = await import("../sources")
const { runSourceMigrationSeed, registerSeededSources } = await import("../migration/seed-register")

// A Madara row (list-capable seed) and a bespoke recognition-only row (kagane - CF/DRM, no list).
const MADARA = madaraSiteConfigs[0]!
const MANGASTREAM = mangaStreamSiteConfigs[0]!
const BESPOKE_NO_LIST = "kagane"

function manga(id: string, sourceId: string, extra: Partial<LibraryManga> = {}): LibraryManga {
    return {
        id,
        title: `Title ${id}`,
        normalizedTitle: `title ${id}`,
        authors: [],
        status: "ongoing",
        addedAt: 1_600_000_000_000,
        updatedAt: 1_600_000_000_000,
        sourceId,
        sourceUrl: `${originOf(sourceId)}/manga/${id}/`,
        mangaUrl: `${originOf(sourceId)}/manga/${id}/`,
        sourceMangaId: id,
        ...extra
    }
}

function link(mangaId: string, sourceId: string): SourceLinkRecord {
    return {
        mangaId,
        sourceId,
        sourceMangaId: mangaId,
        url: `${originOf(sourceId)}/manga/${mangaId}/`,
        addedAt: 1_600_000_000_000,
        updatedAt: 1_600_000_000_000
    }
}

function originOf(sourceId: string): string {
    if (sourceId === MADARA.id) return MADARA.origin
    if (sourceId === MANGASTREAM.id) return MANGASTREAM.origin
    return "https://kagane.to"
}

function ctxReturning(html: string, origin: string): SourceContext {
    const fetch: FetchFunction = async () => ({ ok: true, status: 200, text: async () => html })
    return {
        request: createBoundedRequestClient({
            fetch,
            allowedOrigins: [`${origin}/*`, origin],
            maxRequests: 10,
            maxResponseBytes: 1_000_000,
            timeoutMs: 1000
        }),
        now: () => 1_700_000_000_000,
        logger: { debug: () => undefined, warn: () => undefined }
    }
}

// The bundled adapters this test unregisters, so afterEach can put them back and never leak the
// "removed" state into another test file's view of the shared registry.
const removed: ReturnType<typeof sourceRegistry.get>[] = []

beforeEach(async () => {
    fakeBrowser.reset()
    await db.manga.clear()
    await db.sourceLinks.clear()
    await db.archProfiles.clear()
    await db.chapters.clear()
    removed.length = 0
})

afterEach(() => {
    for (const adapter of removed) if (adapter) sourceRegistry.upsert(adapter)
})

async function seedAndRemove(ids: string[]): Promise<void> {
    await runSourceMigrationSeed() // writes archProfiles rows for the used, non-Tier-1 ids
    for (const id of ids) {
        const adapter = sourceRegistry.get(id)
        if (adapter) {
            removed.push(adapter)
            sourceRegistry.unregister(id) // the removal release drops the bundled adapter
        }
    }
    await registerSeededSources() // re-register from the seed for the now-unresolved ids
}

describe("removal simulation: bundled adapters off, seed + generic engine keep the library working", () => {
    it("a Madara row still resolves and lists its chapters through the seed profile after the adapter is removed", async () => {
        const prefix = MADARA.chapterPrefix ?? "chapter"
        const mangaPath = MADARA.mangaPath ?? "manga"
        await db.manga.put(
            manga("m1", MADARA.id, { lastReadChapterNumber: 7, lastReadChapterId: "keep-me", workId: "w1" })
        )
        await db.sourceLinks.put(link("m1", MADARA.id))

        // Capture how the bundled adapter resolves BEFORE removal, to compare after.
        const beforeDefined = getSourceById(MADARA.id) !== undefined
        await seedAndRemove([MADARA.id])

        // After removal the id STILL resolves - now via the generic engine built from the seed profile.
        const adapter = getSourceById(MADARA.id)
        expect(beforeDefined).toBe(true)
        expect(adapter, `${MADARA.id} must still resolve after removal`).toBeDefined()

        // And it still lists chapters from the same server HTML the bundled adapter read.
        const row = (n: number) =>
            `<li class="wp-manga-chapter"><a href="${MADARA.origin}/${mangaPath}/m1/${prefix}-${n}/">Chapter ${n}</a></li>`
        const html = `<ul class="main version-chap">${[3, 2, 1].map(row).join("\n")}</ul>`
        const m = (await db.manga.get("m1"))!
        const chapters = await adapter!.listChapters!(
            { manga: { manga: m as never, sourceId: MADARA.id, sourceMangaId: "m1", url: m.mangaUrl! } },
            ctxReturning(html, MADARA.origin)
        )
        expect(chapters.map(c => c.sortKey).sort((a, b) => a - b)).toEqual([1, 2, 3])

        // Read progress survived the migration untouched.
        expect(m.lastReadChapterNumber).toBe(7)
        expect(m.lastReadChapterId).toBe("keep-me")
        expect(m.workId).toBe("w1")
    })

    it("a MangaStream row still lists its chapters through the seed profile after removal", async () => {
        const mangaPath = MANGASTREAM.mangaPath ?? "manga"
        const hierarchical = MANGASTREAM.chapterFormat === "hierarchical"
        await db.manga.put(manga("m2", MANGASTREAM.id))
        await db.sourceLinks.put(link("m2", MANGASTREAM.id))
        await seedAndRemove([MANGASTREAM.id])

        const adapter = getSourceById(MANGASTREAM.id)
        expect(adapter, `${MANGASTREAM.id} must still resolve`).toBeDefined()
        const href = (n: number) =>
            hierarchical ? `${MANGASTREAM.origin}/${mangaPath}/m2/${n}/` : `${MANGASTREAM.origin}/m2-chapter-${n}/`
        const rows = [3, 2, 1].map(n => `<li data-num="${n}"><a href="${href(n)}"><span>Chapter ${n}</span></a></li>`)
        const html = `<div id="chapterlist"><ul>${rows.join("\n")}</ul></div>`
        const m = (await db.manga.get("m2"))!
        const chapters = await adapter!.listChapters!(
            { manga: { manga: m as never, sourceId: MANGASTREAM.id, sourceMangaId: "m2", url: m.mangaUrl! } },
            ctxReturning(html, MANGASTREAM.origin)
        )
        expect(chapters.length).toBe(3)
    })

    it("a bespoke un-listable source (kagane) resolves but is tracking-only after removal, never dead", async () => {
        await db.manga.put(manga("k1", BESPOKE_NO_LIST, { lastReadChapterNumber: 42, workId: "w-kagane" }))
        await db.sourceLinks.put(link("k1", BESPOKE_NO_LIST))
        await seedAndRemove([BESPOKE_NO_LIST])

        const adapter = getSourceById(BESPOKE_NO_LIST)
        // It still resolves (recognition-only seed), so the row is never orphaned...
        expect(adapter, "kagane must still resolve for recognition").toBeDefined()
        // ...but it carries no list, so background updates are tracking-only (listChapters is empty).
        const m = (await db.manga.get("k1"))!
        const chapters = await adapter!.listChapters!(
            { manga: { manga: m as never, sourceId: BESPOKE_NO_LIST, sourceMangaId: "k1", url: m.mangaUrl! } },
            ctxReturning("<html>shell</html>", "https://kagane.to")
        ).catch(() => [])
        expect(chapters).toEqual([])
        // Read progress (number-based, domain-independent) is intact.
        expect(m.lastReadChapterNumber).toBe(42)
        expect(m.workId).toBe("w-kagane")
    })

    it("every removed id still resolves, so no library row goes dead", async () => {
        const ids = [MADARA.id, MANGASTREAM.id, BESPOKE_NO_LIST]
        for (const [i, id] of ids.entries()) {
            await db.manga.put(manga(`row-${i}`, id))
            await db.sourceLinks.put(link(`row-${i}`, id))
        }
        await seedAndRemove(ids)
        for (const id of ids) expect(getSourceById(id), `${id} resolved after removal`).toBeDefined()
    })
})
