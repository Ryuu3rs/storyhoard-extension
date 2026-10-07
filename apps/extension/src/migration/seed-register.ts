// One-time, per-user registration of the bundled-source migration seed.
//
// WHY: a later release will remove bundled scraper adapters. A library row whose sourceId no
// longer resolves (getSourceById === undefined) would go dead. This routine, run while the
// adapters still ship, copies the committed seed profile for each source the user ACTUALLY has in
// their library into the existing `archProfiles` store, so that when the adapter is removed the
// row keeps resolving through the generic engine (tracking-only when the seed carries no list).
//
// SAFETY CONTRACT (each point has a test in migration-seed-safety.test.ts):
//   * Additive only. Writes touch `archProfiles` rows and one storage.local flag - never db.manga,
//     db.sourceLinks, chapters, progress or any other store. No new Dexie version or store, and it
//     deliberately does NOT run inside a Dexie `.upgrade()` callback: database.ts documents that
//     Firefox auto-commits a versionchange transaction when non-IDB async work drains the
//     microtask queue, which would abort the upgrade. This is plain runtime code on an open db.
//   * The user's own captured/imported profile always wins: an id that already has an archProfiles
//     row is never touched. The existence check and the write share one transaction.
//   * Strictly per-user: only ids present in THIS library (db.manga / db.sourceLinks) are seeded.
//   * Tier-1 legit sources (the official-sites allowlist: MangaDex, WEBTOON, ...) are never
//     seeded; they stay bundled permanently.
//   * Idempotent: the `migratedSourcesV1` flag makes a re-run a no-op for data, and the
//     per-id "no existing row" guard makes even a flag-less retry (a crash mid-run) safe.
//   * Registration never displaces a bundled adapter: only a profile whose id does NOT resolve
//     (getSourceById === undefined) is upserted into the live registry. Today every seeded id
//     resolves through its bundled adapter, so this release changes no runtime behaviour.
//   * Reversible: rollbackSourceMigrationSeed() deletes exactly the rows this routine wrote
//     (recorded in the flag) that the user has not since replaced, and clears the flag.
//   * An unresolved row is never deleted or rewritten; it stays in the library, tracking-only.

import seedJson from "@amr/sources/migration-seed.json"
import { parseProfile, type SiteProfile } from "@amr/source-engine"
import { registerStoredArchProfiles } from "../arch-sources"
import { db, putArchProfile } from "../database"
import { OFFICIAL_SITES_DEFAULT, isOfficialHost } from "../official-sources"

export const MIGRATED_SOURCES_FLAG = "migratedSourcesV1"

type MigrationFlag = { version: 1; at: number; seeded: string[] }

export type SeedRunResult = {
    // Ids whose seed profile was written to archProfiles by THIS run.
    seeded: string[]
    // True when the flag was already set (or nothing needed seeding yet) and no seeding was attempted.
    alreadyDone: boolean
}

let seedProfiles: Map<string, SiteProfile> | undefined

// The committed seed, parsed through the real schema once. A profile the schema rejects is dropped
// (never written), so a bad seed entry degrades to "not seeded", not to a corrupt archProfiles row.
function loadSeedProfiles(): Map<string, SiteProfile> {
    if (seedProfiles) return seedProfiles
    const map = new Map<string, SiteProfile>()
    for (const raw of (seedJson as { profiles: unknown[] }).profiles) {
        const parsed = parseProfile(raw)
        if (parsed.ok) map.set(parsed.profile.id, parsed.profile)
    }
    seedProfiles = map
    return map
}

export function isTier1Profile(profile: SiteProfile): boolean {
    return profile.domains.some(domain => isOfficialHost(domain.replace(/^\*\./, ""), OFFICIAL_SITES_DEFAULT))
}

async function readFlag(): Promise<MigrationFlag | undefined> {
    const stored = await browser.storage.local.get(MIGRATED_SOURCES_FLAG)
    const value = stored[MIGRATED_SOURCES_FLAG] as MigrationFlag | undefined
    return value && typeof value === "object" ? value : undefined
}

// Distinct sourceIds actually referenced by this user's library. Index key scans only: no row is
// read into memory, no row is written.
async function usedSourceIds(): Promise<Set<string>> {
    const [fromManga, fromLinks] = await Promise.all([
        db.manga.orderBy("sourceId").uniqueKeys(),
        db.sourceLinks.orderBy("sourceId").uniqueKeys()
    ])
    const ids = new Set<string>()
    for (const key of [...fromManga, ...fromLinks]) if (typeof key === "string" && key) ids.add(key)
    return ids
}

// Write the seed profile for `id` only if no archProfiles row exists for it. Check + write are one
// rw transaction, so a user import landing between them cannot be overwritten.
async function seedOne(id: string, profile: SiteProfile): Promise<boolean> {
    return db.transaction("rw", db.archProfiles, async () => {
        if (await db.archProfiles.get(id)) return false
        await putArchProfile(id, profile)
        return true
    })
}

// Re-apply stored profiles for ids with no bundled adapter. The in-memory registry is rebuilt on
// every service-worker start (which, unlike onStartup, also happens after an idle suspend), so the
// background calls this at top level each time. Never displaces a bundled adapter.
export function registerSeededSources(): Promise<void> {
    return registerStoredArchProfiles({ onlyUnresolved: true })
}

let inFlight: Promise<SeedRunResult> | undefined

// Entry point for background onInstalled/onStartup. Safe to call any number of times.
export function runSourceMigrationSeed(): Promise<SeedRunResult> {
    inFlight ??= run().finally(() => {
        inFlight = undefined
    })
    return inFlight
}

async function run(): Promise<SeedRunResult> {
    const flag = await readFlag()
    const result: SeedRunResult = { seeded: [], alreadyDone: flag !== undefined }

    if (!flag) {
        const used = await usedSourceIds()
        // An empty library has nothing to migrate YET (fresh install, or a restore/import still to
        // come). Leave the flag unset so a later run - once rows exist - still seeds them. The
        // per-id guards make that retry cheap and safe.
        if (used.size === 0) {
            result.alreadyDone = true
        } else {
            const seed = loadSeedProfiles()
            const written: string[] = []
            for (const id of used) {
                const profile = seed.get(id)
                if (!profile || isTier1Profile(profile)) continue
                if (await seedOne(id, profile)) written.push(id)
            }
            // Flag AFTER the writes: a crash before this point just retries (writes are guarded).
            const record: MigrationFlag = { version: 1, at: Date.now(), seeded: written }
            await browser.storage.local.set({ [MIGRATED_SOURCES_FLAG]: record })
            result.seeded = written
        }
    }

    // In-memory registry is rebuilt every service-worker start, so registration runs every time,
    // but only for ids with no bundled adapter - a bundled adapter is never displaced.
    await registerSeededSources()
    return result
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
    if (value && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
    }
    return JSON.stringify(value)
}

// Undo: delete the archProfiles rows this routine wrote, but only those still byte-equal to the
// seed (a row the user has since replaced is theirs and is kept), then clear the flag so the
// routine may run again. Library rows are never touched.
export async function rollbackSourceMigrationSeed(): Promise<{ removed: string[]; kept: string[] }> {
    const flag = await readFlag()
    const removed: string[] = []
    const kept: string[] = []
    if (!flag) return { removed, kept }
    const seed = loadSeedProfiles()
    for (const id of flag.seeded) {
        const expected = seed.get(id)
        const deleted = await db.transaction("rw", db.archProfiles, async () => {
            const row = await db.archProfiles.get(id)
            if (!row || !expected || canonical(row.profile) !== canonical(expected)) return false
            await db.archProfiles.delete(id)
            return true
        })
        ;(deleted ? removed : kept).push(id)
    }
    await browser.storage.local.remove(MIGRATED_SOURCES_FLAG)
    return { removed, kept }
}
