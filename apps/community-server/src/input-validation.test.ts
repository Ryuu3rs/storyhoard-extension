import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "amr-community-input-"))

const { app } = await import("./index.js")

async function newUser(username: string): Promise<string> {
    const res = await app.request("/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, consentVersion: 1 })
    })
    const { userId } = (await res.json()) as { userId: string }
    return userId
}

test("/rate rejects an over-long mangaTitle instead of storing it", async () => {
    const userId = await newUser("lentest")
    const res = await app.request("/rate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, mangaTitle: "z".repeat(100000), rating: 5 })
    })
    assert.equal(res.status, 400)
})

test("/rate rejects a non-string mangaTitle without a 500", async () => {
    const userId = await newUser("typetest-rate")
    const res = await app.request("/rate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, mangaTitle: 5, rating: 5 })
    })
    assert.equal(res.status, 400)
})

test("/events drops a non-string sourceId row instead of 500ing on the DB bind", async () => {
    const userId = await newUser("typetest-events")
    const res = await app.request("/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            userId,
            events: [{ type: "chapter_read", sourceId: {}, mangaTitle: "x", date: "2020-01-01" }]
        })
    })
    assert.notEqual(res.status, 500)
})

test("/events drops an over-long mangaTitle row", async () => {
    const reg = await app.request("/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "longtitle-events", consentVersion: 1 })
    })
    const { userId, secret } = (await reg.json()) as { userId: string; secret: string }
    const res = await app.request("/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify({
            userId,
            events: [{ type: "chapter_read", sourceId: "mangadex", mangaTitle: "y".repeat(50000), date: "2020-01-01" }]
        })
    })
    // Accepted request, but the oversized row is filtered out (not stored).
    assert.equal(res.status, 200)
})

test("/manga rejects an over-long title", async () => {
    const res = await app.request(`/manga?title=${"a".repeat(5000)}`)
    assert.equal(res.status, 400)
})

test("/events does not 500 on a malformed events field or element (bughunt)", async () => {
    const userId = await newUser("shape-events")
    const post = (events: unknown) =>
        app.request("/events", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId, events })
        })
    for (const events of ["not-an-array", 123, [null], [42]]) {
        const res = await post(events)
        assert.ok(res.status < 500, `events=${JSON.stringify(events)} -> ${res.status}`)
    }
})
