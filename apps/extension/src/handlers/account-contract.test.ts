import "fake-indexeddb/auto"
import { execSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LibraryManga } from "../database"

// The payloads this extension really sends to the shared sync route. The site's contract tests replay
// these files, so a failure here means the shape changed: update the rule book and tell the site before
// regenerating them with UPDATE_SYNC_FIXTURES=1.

vi.stubGlobal("browser", fakeBrowser)
const fetchMock = vi.fn<typeof fetch>()
vi.stubGlobal("fetch", fetchMock)

const { db } = await import("../database")
const { recordTombstone } = await import("../account")
const { runAccountSync } = await import("./account")

const FIXTURES = path.resolve(__dirname, "../../fixtures/sync/extension")
const CLIENT_ID = "asurascans:manga:the-breaker-3"
const AT = 1793793600000

const row: LibraryManga = {
    id: CLIENT_ID,
    title: "The Breaker 3",
    normalizedTitle: "the breaker 3",
    anilistId: 151234,
    sourceId: "asurascans",
    sourceMangaId: "the-breaker-3",
    sourceUrl: "https://asurascans.example/chapter/the-breaker-3-100",
    mangaUrl: "https://asurascans.example/series/the-breaker-3",
    coverUrl: "https://cdn.asurascans.example/the-breaker-3.jpg",
    genres: ["Action", "Martial Arts"],
    authors: [],
    status: "ongoing",
    lastReadChapterNumber: 100,
    latestChapterNumber: 120,
    lastReadAt: 1793790000000,
    addedAt: 1,
    updatedAt: AT
}

function json(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
}

// Runs the real sync against a stand-in server and returns exactly what it posted.
async function capturePush(): Promise<unknown> {
    await fakeBrowser.storage.local.set({
        account: {
            token: "weeb_test_token",
            userId: "u1",
            lastPushAt: 0,
            lastSyncAt: 0,
            invalid: false,
            autoSync: true
        }
    })
    let sent: unknown
    fetchMock.mockImplementation(async (input, init) => {
        const url = new URL(String(input))
        if (init?.method === "POST") {
            sent = JSON.parse(init.body as string)
            const ids = (sent as { items: Array<{ clientId: string }> }).items.map(i => i.clientId)
            return json({ accepted: ids, rejected: [], invalid: [], serverTime: AT })
        }
        if (url.pathname.endsWith("/status")) return json({ userId: "u1", name: null, image: null, itemCount: 0 })
        return json({ items: [], nextCursor: null, hasMore: false, serverTime: AT })
    })
    await runAccountSync()
    return sent
}

function checkAgainstFile(name: string, source: string, note: string, body: unknown): void {
    const file = path.join(FIXTURES, `${name}.json`)
    if (process.env.UPDATE_SYNC_FIXTURES) {
        mkdirSync(FIXTURES, { recursive: true })
        const version = (
            JSON.parse(readFileSync(path.resolve(__dirname, "../../package.json"), "utf8")) as { version: string }
        ).version
        const fixture = {
            client: "extension",
            build: version,
            origin: "exported",
            source,
            commit: execSync("git rev-parse --short=8 HEAD").toString().trim(),
            capturedOn: new Date().toISOString().slice(0, 10),
            note,
            body
        }
        writeFileSync(file, `${JSON.stringify(fixture, null, 4)}\n`)
    }
    const committed = JSON.parse(readFileSync(file, "utf8")) as { body: unknown }
    expect(body).toEqual(committed.body)
    expect(JSON.stringify(body)).toBe(JSON.stringify(committed.body))
}

describe("sync contract payloads", () => {
    beforeEach(async () => {
        fakeBrowser.reset()
        fetchMock.mockReset()
        await db.manga.clear()
    })

    it("a library row", async () => {
        await db.manga.put(row)
        checkAgainstFile(
            "full-row",
            "all-mangas-reader-2: apps/extension/src/handlers/account.ts runAccountSync, through toSyncItem",
            "One library row as runAccountSync posts it. Unset keys are null. There is no deleted key, and no progressPercent, owned, author or mediaType.",
            await capturePush()
        )
    })

    it("a removal", async () => {
        vi.useFakeTimers({ now: AT, toFake: ["Date"] })
        await fakeBrowser.storage.local.set({
            account: {
                token: "weeb_test_token",
                userId: "u1",
                lastPushAt: 0,
                lastSyncAt: 0,
                invalid: false,
                autoSync: true
            }
        })
        await recordTombstone(CLIENT_ID)
        const body = await capturePush()
        vi.useRealTimers()
        checkAgainstFile(
            "tombstone",
            "all-mangas-reader-2: apps/extension/src/handlers/account.ts runAccountSync, the parked removals",
            "A parked removal. The local row is already gone, so the clientId stands in for both title fields.",
            body
        )
    })
})
