import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "amr-community-internal-"))
process.env.COMMUNITY_INTERNAL_TOKEN = "internal-secret"
process.env.COMMUNITY_ADMIN_TOKEN = "admin-secret"

const { app, rlBuckets } = await import("./index.js")

const INTERNAL = { authorization: "Bearer internal-secret" }
const today = new Date().toISOString().slice(0, 10)

async function register(username: string, installId: string): Promise<{ userId: string; secret: string }> {
    // This file registers more users than the per-IP sign-up limit allows in an hour.
    rlBuckets.clear()
    const res = await app.request("/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, consentVersion: 1, installId })
    })
    assert.equal(res.status, 200)
    return (await res.json()) as { userId: string; secret: string }
}

async function readChapters(user: { userId: string; secret: string }, title: string, count: number): Promise<void> {
    const events = Array.from({ length: count }, (_, i) => ({
        type: "chapter_read",
        sourceId: "example",
        mangaTitle: title,
        genres: ["Action"],
        date: today,
        chapter: String(i + 1)
    }))
    const res = await app.request("/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: `Bearer ${user.secret}` },
        body: JSON.stringify({ userId: user.userId, events })
    })
    assert.equal(res.status, 200)
}

async function leaderboardNames(): Promise<string[]> {
    const body = (await (await app.request("/community")).json()) as { leaderboard: Array<{ username: string }> }
    return body.leaderboard.map(row => row.username)
}

test("every internal route needs the internal token, and the admin token is not enough", async () => {
    const paths: Array<[string, string]> = [
        ["DELETE", "/internal/users/x"],
        ["GET", "/internal/users/x/export"],
        ["PUT", "/internal/users/x/flags"]
    ]
    for (const [method, path] of paths) {
        assert.equal((await app.request(path, { method })).status, 403)
        assert.equal(
            (await app.request(path, { method, headers: { authorization: "Bearer admin-secret" } })).status,
            403
        )
    }
})

test("export returns everything held for the user, and 404 for an unknown id", async () => {
    const user = await register("ExportReader", "install-export")
    await readChapters(user, "Export Title", 2)
    await app.request("/rate", {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: `Bearer ${user.secret}` },
        body: JSON.stringify({ userId: user.userId, mangaTitle: "Export Title", rating: 4 })
    })

    const res = await app.request(`/internal/users/${user.userId}/export`, { headers: INTERNAL })
    assert.equal(res.status, 200)
    const data = (await res.json()) as {
        user: { username: string }
        events: Array<{ title: string; genres: string[]; chapter: string }>
        ratings: Array<{ title: string; rating: number; updatedAt: number }>
        installs: Array<{ installId: string }>
    }
    assert.equal(data.user.username, "ExportReader")
    assert.deepEqual(
        data.events.map(e => [e.title, e.chapter, e.genres]),
        [
            ["Export Title", "1", ["Action"]],
            ["Export Title", "2", ["Action"]]
        ]
    )
    assert.deepEqual(data.ratings, [{ title: "Export Title", rating: 4, updatedAt: data.ratings[0]!.updatedAt }])
    assert.deepEqual(
        data.installs.map(i => i.installId),
        ["install-export"]
    )

    assert.equal((await app.request("/internal/users/nobody/export", { headers: INTERNAL })).status, 404)
})

test("a known minor never appears on the leaderboard, and clearing the flag brings them back", async () => {
    const minor = await register("YoungReader", "install-minor")
    const adult = await register("GrownReader", "install-adult")
    await readChapters(minor, "Busy Title", 5)
    await readChapters(adult, "Busy Title", 3)
    assert.ok((await leaderboardNames()).includes("YoungReader"))

    const flag = (minorValue: unknown) =>
        app.request(`/internal/users/${minor.userId}/flags`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", ...INTERNAL },
            body: JSON.stringify({ minor: minorValue })
        })

    assert.equal((await flag("yes")).status, 400)
    assert.equal((await flag(true)).status, 200)
    const hidden = await leaderboardNames()
    assert.ok(!hidden.includes("YoungReader"))
    assert.ok(hidden.includes("GrownReader"))

    assert.equal((await flag(false)).status, 200)
    assert.ok((await leaderboardNames()).includes("YoungReader"))

    const unknown = await app.request("/internal/users/nobody/flags", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...INTERNAL },
        body: JSON.stringify({ minor: true })
    })
    assert.equal(unknown.status, 404)
})

test("a JSON body that is not an object is a 400, not a server error", async () => {
    for (const body of ["null", "7", "[]", '"text"']) {
        const flags = await app.request("/internal/users/x/flags", {
            method: "PUT",
            headers: { "Content-Type": "application/json", ...INTERNAL },
            body
        })
        assert.equal(flags.status, 400, `flags with ${body}`)
        const register = await app.request("/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body
        })
        assert.equal(register.status, 400, `register with ${body}`)
    }
})

test("a known minor is not ranked, and adults' ranks do not count them", async () => {
    const minor = await register("RankMinor", "install-rank-minor")
    const adult = await register("RankAdult", "install-rank-adult")
    await readChapters(minor, "Rank Title", 30)
    await app.request(`/internal/users/${minor.userId}/flags`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...INTERNAL },
        body: JSON.stringify({ minor: true })
    })
    const res = await app.request("/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: `Bearer ${adult.secret}` },
        body: JSON.stringify({
            userId: adult.userId,
            events: Array.from({ length: 25 }, (_, i) => ({
                type: "chapter_read",
                sourceId: "example",
                mangaTitle: "Rank Title",
                genres: [],
                date: today,
                chapter: String(i + 1)
            }))
        })
    })
    const body = (await res.json()) as { rank: number | null }
    const leaderboard = await leaderboardNames()
    assert.equal(body.rank, leaderboard.indexOf("RankAdult") + 1)
    assert.ok(!leaderboard.includes("RankMinor"))

    const minorRes = await app.request("/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: `Bearer ${minor.secret}` },
        body: JSON.stringify({ userId: minor.userId, events: [] })
    })
    assert.equal(((await minorRes.json()) as { rank: number | null }).rank, null)
})

test("the export includes the minor flag", async () => {
    const user = await register("ExportMinor", "install-export-minor")
    const read = async () =>
        (
            (await (await app.request(`/internal/users/${user.userId}/export`, { headers: INTERNAL })).json()) as {
                user: { minor: boolean }
            }
        ).user.minor
    assert.equal(await read(), false)
    await app.request(`/internal/users/${user.userId}/flags`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...INTERNAL },
        body: JSON.stringify({ minor: true })
    })
    assert.equal(await read(), true)
})

test("erase removes the user and their data, and is idempotent", async () => {
    const user = await register("LeavingReader", "install-leaving")
    await readChapters(user, "Leaving Title", 1)

    const first = await app.request(`/internal/users/${user.userId}`, { method: "DELETE", headers: INTERNAL })
    assert.deepEqual(await first.json(), { ok: true, deleted: true })
    assert.equal((await app.request(`/internal/users/${user.userId}/export`, { headers: INTERNAL })).status, 404)

    const again = await app.request(`/internal/users/${user.userId}`, { method: "DELETE", headers: INTERNAL })
    assert.deepEqual(await again.json(), { ok: true, deleted: false })
})
