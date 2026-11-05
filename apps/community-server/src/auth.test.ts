import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "amr-community-auth-"))
process.env.COMMUNITY_ADMIN_TOKEN = "admin-secret"

const { app } = await import("./index.js")
const { createUser, getUserById, getUserSecretHash } = await import("./db.js")

let serial = 0
function legacyUser(): string {
    serial += 1
    const id = `legacy-${serial}`
    createUser(id, `legacy${serial}`)
    return id
}

async function send(path: string, method: string, body: unknown, secret?: string): Promise<Response> {
    return await app.request(path, {
        method,
        headers: { "Content-Type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
        body: JSON.stringify(body)
    })
}

const rate = (userId: string, secret?: string) =>
    send("/rate", "POST", { userId, mangaTitle: "A Title", rating: 4 }, secret)
const events = (userId: string, secret?: string) => send("/events", "POST", { userId, events: [] }, secret)
const recommendations = (userId: string, secret?: string) =>
    app.request(`/recommendations?userId=${userId}`, { headers: secret ? { authorization: `Bearer ${secret}` } : {} })

async function claim(userId: string): Promise<string> {
    const res = await send("/claim", "POST", { userId })
    assert.equal(res.status, 200)
    return ((await res.json()) as { secret: string }).secret
}

test("a new registration gets a secret, and its bare id no longer works", async () => {
    const res = await send("/register", "POST", { username: "newreader", consentVersion: 1 })
    assert.equal(res.status, 200)
    const { userId, secret } = (await res.json()) as { userId: string; secret: string }
    assert.ok(secret.length >= 32)

    assert.equal((await rate(userId)).status, 401)
    assert.equal((await rate(userId, "wrong")).status, 401)
    assert.equal((await rate(userId, secret)).status, 200)
})

test("an existing user with no secret still works by bare id, so installed versions keep working", async () => {
    const id = legacyUser()
    assert.equal((await rate(id)).status, 200)
    assert.equal((await events(id)).status, 200)
    assert.equal((await recommendations(id)).status, 200)
})

test("claiming once locks the bare id on every route", async () => {
    const id = legacyUser()
    const secret = await claim(id)

    for (const res of [
        await rate(id),
        await events(id),
        await recommendations(id),
        await send("/me", "DELETE", { userId: id })
    ]) {
        assert.equal(res.status, 401)
    }
    assert.ok(getUserById(id), "a refused delete must not delete")

    assert.equal((await rate(id, secret)).status, 200)
    assert.equal((await events(id, secret)).status, 200)
    assert.equal((await recommendations(id, secret)).status, 200)
})

test("a user can only be claimed once, and unknown users cannot be claimed", async () => {
    const id = legacyUser()
    await claim(id)
    assert.equal((await send("/claim", "POST", { userId: id })).status, 409)
    assert.equal((await send("/claim", "POST", { userId: "nobody" })).status, 404)
    assert.equal((await send("/claim", "POST", {})).status, 400)
})

test("one user's secret does not open another user", async () => {
    const a = legacyUser()
    const b = legacyUser()
    const secretA = await claim(a)
    await claim(b)
    assert.equal((await rate(b, secretA)).status, 401)
})

test("delete with the secret works and is still idempotent", async () => {
    const id = legacyUser()
    const secret = await claim(id)
    assert.equal((await send("/me", "DELETE", { userId: id }, secret)).status, 200)
    assert.equal(getUserById(id), undefined)
    assert.equal((await send("/me", "DELETE", { userId: id })).status, 200)
})

test("after the sunset, bare ids and new claims stop, and secrets keep working", async () => {
    const claimed = legacyUser()
    const secret = await claim(claimed)
    const late = legacyUser()

    process.env.COMMUNITY_BARE_ID_SUNSET = String(Date.now() - 1000)
    try {
        assert.equal((await rate(late)).status, 401)
        assert.equal((await send("/claim", "POST", { userId: late })).status, 410)
        assert.equal((await rate(claimed, secret)).status, 200)
    } finally {
        delete process.env.COMMUNITY_BARE_ID_SUNSET
    }
})

test("the admin dashboard shows how many users have no secret yet", async () => {
    const before = (await (
        await app.request("/admin/stats", { headers: { authorization: "Bearer admin-secret" } })
    ).json()) as { usersWithoutSecret: number }
    legacyUser()
    const after = (await (
        await app.request("/admin/stats", { headers: { authorization: "Bearer admin-secret" } })
    ).json()) as { usersWithoutSecret: number }
    assert.equal(after.usersWithoutSecret, before.usersWithoutSecret + 1)
})

test("a stored secret is hashed, not kept as sent", async () => {
    const id = legacyUser()
    const secret = await claim(id)
    const stored = getUserSecretHash(id)
    assert.ok(stored)
    assert.notEqual(stored, secret)
    assert.ok(!stored.includes(secret))
})
