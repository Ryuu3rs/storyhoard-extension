// GitHub Gist sync for the library/progress/settings backup. Stores a personal
// access token (gist scope) + gist id in storage.local. Snapshot-based:
// push uploads the full human-readable JSON export; pull imports it (bulkPut
// merge). Last push wins at the gist level - per-record LWW merge is future work.

import { SyncDataPermissionError, syncDataAllowed } from "./sync-data-permission"

const SYNC_KEY = "syncConfig"
const GIST_FILENAME = "amr-library.json"
const API = "https://api.github.com"
const RAW_GIST_ORIGIN = "https://gist.githubusercontent.com"

export type SyncConfig = {
    token?: string
    gistId?: string
    autoSync: boolean
    lastPushedAt?: number
    lastPulledAt?: number
    // "<gistId>:<content hash>" of the last successful push, so the hourly auto-push can skip
    // re-uploading an unchanged library. Tied to the gist id so pointing at a new gist re-pushes.
    lastPushedSig?: string
}

// exportedAt changes on every export, so it is left out: the signature tracks library content only.
export async function exportContentSignature(envelope: unknown): Promise<string> {
    const { exportedAt: _exportedAt, ...rest } = (envelope ?? {}) as Record<string, unknown>
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(rest)))
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("")
}

const defaultSyncConfig: SyncConfig = { autoSync: false }

export async function getSyncConfig(): Promise<SyncConfig> {
    const stored = await browser.storage.local.get(SYNC_KEY)
    return { ...defaultSyncConfig, ...(stored[SYNC_KEY] as Partial<SyncConfig> | undefined) }
}

export async function setSyncConfig(patch: Partial<SyncConfig>): Promise<SyncConfig> {
    const next = { ...(await getSyncConfig()), ...patch }
    await browser.storage.local.set({ [SYNC_KEY]: next })
    return next
}

// Token-free view for the UI - never ship the token back to the page.
export async function getSyncStatus(): Promise<{
    hasToken: boolean
    gistId?: string
    autoSync: boolean
    lastPushedAt?: number
    lastPulledAt?: number
}> {
    const c = await getSyncConfig()
    return {
        hasToken: Boolean(c.token),
        ...(c.gistId ? { gistId: c.gistId } : {}),
        autoSync: c.autoSync,
        ...(c.lastPushedAt ? { lastPushedAt: c.lastPushedAt } : {}),
        ...(c.lastPulledAt ? { lastPulledAt: c.lastPulledAt } : {})
    }
}

async function githubFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${API}${path}`, {
        ...init,
        credentials: "omit",
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(init?.headers ?? {})
        }
    })
    if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 200)
        throw new Error(`GitHub API ${res.status}${detail ? `: ${detail}` : ""}`)
    }
    return res
}

export async function pushToGist(envelope: unknown): Promise<{ gistId: string }> {
    const config = await getSyncConfig()
    if (!config.token) throw new Error("No GitHub token configured")
    if (!(await syncDataAllowed())) throw new SyncDataPermissionError()
    const content = JSON.stringify(envelope, null, 2)
    const files = { [GIST_FILENAME]: { content } }
    const signature = await exportContentSignature(envelope)

    if (config.gistId) {
        await githubFetch(`/gists/${config.gistId}`, config.token, {
            method: "PATCH",
            body: JSON.stringify({ description: "StoryHoard library backup", files })
        })
        await setSyncConfig({ lastPushedAt: Date.now(), lastPushedSig: `${config.gistId}:${signature}` })
        return { gistId: config.gistId }
    }

    const res = await githubFetch(`/gists`, config.token, {
        method: "POST",
        body: JSON.stringify({ description: "StoryHoard library backup", public: false, files })
    })
    const json = (await res.json()) as { id: string }
    await setSyncConfig({ gistId: json.id, lastPushedAt: Date.now(), lastPushedSig: `${json.id}:${signature}` })
    return { gistId: json.id }
}

type GistFile = { content?: string; truncated?: boolean; raw_url?: string; size?: number }

const TOO_LARGE =
    "The backup in your gist is too large for GitHub to send in full. Open the gist on github.com, " +
    "use Download ZIP, unzip it, and import amr-library.json under Import & Export > Restore backup."

// The gist API returns at most 1 MB of each file and marks the rest truncated; the full file is at
// raw_url (up to 10 MB). Secret gists' raw URLs need no token, so none is sent.
async function gistFileText(file: GistFile): Promise<string> {
    if (!file.truncated) return file.content ?? ""
    let raw: URL
    try {
        raw = new URL(file.raw_url ?? "")
    } catch {
        throw new Error(TOO_LARGE)
    }
    if (raw.origin !== RAW_GIST_ORIGIN) throw new Error(TOO_LARGE)
    const res = await fetch(raw.href, { credentials: "omit" })
    if (!res.ok) throw new Error(`GitHub ${res.status} while reading the backup file`)
    const text = await res.text()
    if (typeof file.size === "number" && new TextEncoder().encode(text).length < file.size) {
        throw new Error(TOO_LARGE)
    }
    return text
}

export async function pullFromGist(): Promise<unknown> {
    const config = await getSyncConfig()
    if (!config.token || !config.gistId) throw new Error("Sync is not configured")
    const res = await githubFetch(`/gists/${config.gistId}`, config.token, { method: "GET" })
    const json = (await res.json()) as { files?: Record<string, GistFile | undefined> }
    const file = json.files?.[GIST_FILENAME]
    if (!file?.content && !file?.truncated) throw new Error("Backup file not found in the gist")
    const text = await gistFileText(file)
    // Parse before updating the timestamp - a corrupted/truncated backup would
    // otherwise mark the pull as successful even though import never runs.
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        throw new Error(file.truncated ? TOO_LARGE : "The backup in your gist is not valid JSON")
    }
    await setSyncConfig({ lastPulledAt: Date.now() })
    return parsed
}
