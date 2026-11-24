import "fake-indexeddb/auto"
import Dexie, { type Table } from "dexie"
import { fakeBrowser } from "wxt/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("browser", fakeBrowser)

const { _resetProtectedStoreForTests, getProtected, PROTECTED_KEYS, protectedStoreReady, setProtected } =
    await import("./protected-store")
const { getAccountProfile, updateAccountProfile } = await import("./account")
const { getAniListConfig, setAniListConfig } = await import("./anilist")
const { getSyncConfig, setSyncConfig } = await import("./sync")
const { getCommunityProfile, updateCommunityProfile } = await import("./community")
const { approveSiteOrigins, holdsChosenAccess } = await import("./site-approvals")

beforeEach(async () => {
    fakeBrowser.reset()
    await _resetProtectedStoreForTests()
})

const olderBuild = {
    account: { token: "weeb_device_token_1234567890", userId: "u1", lastPushAt: 5, lastSyncAt: 0, invalid: false },
    anilistConfig: { token: "anilist-token", autoSync: true, syncMembership: false },
    syncConfig: { token: "gh-token", gistId: "g1", autoSync: false },
    handoffPendingLink: { deviceToken: "staged-token", handle: "reader", stagedAt: 1 },
    community: { enabled: true, userId: "c1", secret: "community-secret", consentVersion: 1 },
    approvedSiteOrigins: ["https://site.example/*"],
    siteSessions: { seen: { "https://site.example": { seenAt: 1 } }, enabled: { "https://site.example": 1 } }
}

describe("moving the secrets out of storage.local", () => {
    it("moves what an older build stored, once, and strips it from storage.local", async () => {
        await fakeBrowser.storage.local.set({ ...olderBuild, settings: { language: "en" } })

        expect((await getAccountProfile()).token).toBe("weeb_device_token_1234567890")
        expect((await getAniListConfig()).token).toBe("anilist-token")
        expect((await getSyncConfig()).token).toBe("gh-token")
        expect((await getCommunityProfile()).secret).toBe("community-secret")
        for (const key of PROTECTED_KEYS) expect(await getProtected(key)).toEqual(olderBuild[key])

        const left = await fakeBrowser.storage.local.get(null)
        expect(Object.keys(left)).toEqual(["settings"])
        expect(JSON.stringify(left)).not.toMatch(/token|secret/i)
    })

    it("never reads a token planted in storage.local after the move", async () => {
        await protectedStoreReady()
        await fakeBrowser.storage.local.set({
            account: { token: "ATTACKER-TOKEN", invalid: false },
            syncConfig: { token: "attacker-gh", gistId: "attacker-gist" },
            approvedSiteOrigins: ["https://attacker.example/*"]
        })

        expect((await getAccountProfile()).token).toBeUndefined()
        expect((await getSyncConfig()).gistId).toBeUndefined()
        expect(await getProtected("approvedSiteOrigins")).toBeUndefined()
    })

    it("does not let a planted value replace the user's own after a worker restart", async () => {
        await updateAccountProfile({ token: "weeb_device_token_1234567890" })
        await fakeBrowser.storage.local.set({ account: { token: "ATTACKER-TOKEN" } })

        const restarted = await freshWorker()
        expect((await restarted.getAccountProfile()).token).toBe("weeb_device_token_1234567890")
        expect(await fakeBrowser.storage.local.get("account")).toEqual({})
    })

    it("keeps the value the protected store holds when a second page races the move with an older copy", async () => {
        await setProtected("syncConfig", { token: "current", autoSync: true })
        await withRawStore(kv => kv.delete("movedFromStorageLocal"))
        await fakeBrowser.storage.local.set({ syncConfig: { token: "stale", autoSync: false } })

        const page = await freshWorker()
        expect((await page.getSyncConfig()).token).toBe("current")
        expect(await fakeBrowser.storage.local.get("syncConfig")).toEqual({})
    })
})

describe("the secrets stay out of storage.local, where content scripts can reach them", () => {
    it("writes every token and user-only store to the protected store only", async () => {
        vi.stubEnv("BROWSER", "firefox")
        try {
            await updateAccountProfile({ token: "weeb_device_token_1234567890", userId: "u1" })
            await setAniListConfig({ token: "anilist-token" })
            await setSyncConfig({ token: "gh-token", gistId: "g1" })
            await updateCommunityProfile({ userId: "c1", secret: "community-secret" })
            await approveSiteOrigins(["https://site.example/*"])

            const local = await fakeBrowser.storage.local.get(null)
            for (const key of PROTECTED_KEYS) expect(local[key]).toBeUndefined()
            expect(JSON.stringify(local)).not.toMatch(/weeb_device_token|anilist-token|gh-token|community-secret/)
            expect(await getProtected("approvedSiteOrigins")).toEqual(["https://site.example/*"])
        } finally {
            vi.unstubAllEnvs()
        }
    })

    it("ignores a site approval planted in storage.local", async () => {
        vi.spyOn(fakeBrowser.permissions, "contains").mockResolvedValue(true)
        vi.spyOn(fakeBrowser.permissions, "getAll").mockResolvedValue({ origins: ["https://*/*"] })
        await protectedStoreReady()
        await fakeBrowser.storage.local.set({ approvedSiteOrigins: ["https://planted.example/*"] })

        expect(await holdsChosenAccess(["https://planted.example/*"])).toBe(false)
    })
})

// A new worker or page: same database, fresh modules that have not checked storage.local yet.
async function freshWorker() {
    vi.resetModules()
    return { ...(await import("./account")), ...(await import("./sync")) }
}

async function withRawStore(change: (kv: Table<{ key: string; value: unknown }, string>) => Promise<unknown>) {
    const raw = new Dexie("storyhoard-protected")
    raw.version(1).stores({ kv: "key" })
    await change(raw.table("kv"))
    raw.close()
}
