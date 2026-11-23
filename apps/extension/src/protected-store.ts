// Secrets and user-only choices, kept in an IndexedDB database of the extension's own origin.
//
// storage.local is readable and writable from every content-script world (the weeb.ltd bridge, the
// on-page panel). Chromium can lock it to trusted contexts, Firefox cannot, so the tokens and the
// stores no page may set live here in both browsers: a content script runs with the page's origin and
// cannot open this database. Not part of the library database, so no backup, export or sync reads it.
//
// Older builds kept these keys in storage.local. They are moved here once; after that a value that
// shows up in storage.local again was planted, is never read, and is removed.

import Dexie, { type Table } from "dexie"

export const PROTECTED_KEYS = [
    "account",
    "anilistConfig",
    "syncConfig",
    "handoffPendingLink",
    "community",
    "approvedSiteOrigins",
    "siteSessions"
] as const

export type ProtectedKey = (typeof PROTECTED_KEYS)[number]

const MOVED_FLAG = "movedFromStorageLocal"

type Row = { key: string; value: unknown }

class ProtectedDatabase extends Dexie {
    kv!: Table<Row, string>

    constructor() {
        super("storyhoard-protected")
        this.version(1).stores({ kv: "key" })
    }
}

const store = new ProtectedDatabase()
let ready: Promise<void> | undefined

async function moveFromStorageLocal(): Promise<void> {
    const legacy = await browser.storage.local.get([...PROTECTED_KEYS])
    await store.transaction("rw", store.kv, async () => {
        if (await store.kv.get(MOVED_FLAG)) return
        for (const key of PROTECTED_KEYS) {
            if (legacy[key] !== undefined && (await store.kv.get(key)) === undefined) {
                await store.kv.put({ key, value: legacy[key] })
            }
        }
        await store.kv.put({ key: MOVED_FLAG, value: Date.now() })
    })
    const left = PROTECTED_KEYS.filter(key => legacy[key] !== undefined)
    if (left.length > 0) await browser.storage.local.remove(left)
}

export function protectedStoreReady(): Promise<void> {
    ready ??= moveFromStorageLocal().catch(error => {
        ready = undefined
        throw error
    })
    return ready
}

export async function getProtected<T>(key: ProtectedKey): Promise<T | undefined> {
    await protectedStoreReady()
    return (await store.kv.get(key))?.value as T | undefined
}

export async function setProtected(key: ProtectedKey, value: unknown): Promise<void> {
    await protectedStoreReady()
    await store.kv.put({ key, value })
}

export async function removeProtected(key: ProtectedKey): Promise<void> {
    await protectedStoreReady()
    await store.kv.delete(key)
}

export async function _resetProtectedStoreForTests(): Promise<void> {
    ready = undefined
    await store.kv.clear()
}
