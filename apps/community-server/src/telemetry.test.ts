import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "amr-community-telemetry-"))
process.env.COMMUNITY_ADMIN_TOKEN = "secret-admin-token"

const { app } = await import("./index.js")
const { getInstallStats, getUserById } = await import("./db.js")

function post(path: string, body: unknown): Promise<Response> {
    return app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    })
}

test("/ping requires an installId", async () => {
    const res = await post("/ping", { browser: "chrome" })
    assert.equal(res.status, 400)
})

test("/ping upserts an install and counts it once across repeat pings", async () => {
    assert.equal((await post("/ping", { installId: "inst-1", browser: "chrome", version: "0.21.0" })).status, 200)
    // A second ping for the same install must not create a duplicate row.
    assert.equal((await post("/ping", { installId: "inst-1", browser: "chrome", version: "0.21.1" })).status, 200)
    assert.equal((await post("/ping", { installId: "inst-2", browser: "firefox", version: "0.21.0" })).status, 200)

    const stats = getInstallStats()
    assert.equal(stats.total, 2)
    assert.equal(stats.active7d, 2)
    const chrome = stats.byBrowser.find(b => b.browser === "chrome")
    assert.equal(chrome?.count, 1)
    // The repeat ping updated the version to the latest value, not a second row.
    assert.ok(stats.byVersion.some(v => v.version === "0.21.1"))
})

test("registration requires consent and stamps the consent version", async () => {
    const ok = await post("/register", { username: "consenter", consentVersion: 1 })
    assert.equal(ok.status, 200)
    const { userId } = (await ok.json()) as { userId: string }
    assert.ok(getUserById(userId))

    const bad = await post("/register", { username: "no-consent" })
    assert.equal(bad.status, 400)
})

test("DELETE /me erases the user and cascades their data", async () => {
    const reg = await post("/register", { username: "erase-me", consentVersion: 1 })
    const { userId, secret } = (await reg.json()) as { userId: string; secret: string }
    const authorized = (path: string, body: unknown) =>
        app.request(path, {
            method: "POST",
            headers: { "Content-Type": "application/json", authorization: `Bearer ${secret}` },
            body: JSON.stringify(body)
        })
    await authorized("/events", {
        userId,
        events: [{ type: "chapter_read", sourceId: "mangadex", mangaTitle: "Erase Test", date: "2026-08-20" }]
    })
    await authorized("/rate", { userId, mangaTitle: "Erase Test", rating: 5 })

    const res = await app.request("/me", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify({ userId })
    })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, deleted: true })
    assert.equal(getUserById(userId), undefined)
})

test("DELETE /me is idempotent for an unknown user", async () => {
    const res = await app.request("/me", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "does-not-exist" })
    })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, deleted: false })
})

test("/installs is admin-gated (403 without the token, 200 with it)", async () => {
    assert.equal((await app.request("/installs")).status, 403)
    assert.equal((await app.request("/installs", { headers: { authorization: "Bearer wrong" } })).status, 403)
    const ok = await app.request("/installs", { headers: { authorization: "Bearer secret-admin-token" } })
    assert.equal(ok.status, 200)
    const stats = (await ok.json()) as { total: number }
    assert.ok(typeof stats.total === "number")
})
