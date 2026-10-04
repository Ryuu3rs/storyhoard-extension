import {
    createBackup,
    db,
    exportDatabase,
    importDatabase,
    libraryChangeSignature,
    listBackups,
    previewImport,
    restoreBackup,
    seedDatabase
} from "../database"
import { getSettings, updateSettings } from "../settings"
import { getSyncConfig, getSyncStatus, pullFromGist, pushToGist, setSyncConfig } from "../sync"
import { configureBackupAlarm, configureSyncAlarm, configureUpdateAlarm } from "../background/alarms"
import { ARCH_ENABLED, registerStoredArchProfiles } from "../arch-sources"
import type { HandlerMap } from "../background/handler-types"

const autoBackupSigKey = "autoBackupSig"

export const dataSyncSettingsHandlers: HandlerMap = {
    "data:export": async () => {
        return await exportDatabase()
    },
    "data:import:preview": async request => {
        return await previewImport(request.envelope)
    },
    "data:import": async request => {
        // Pre-import safety net: snapshot the current library before applying any
        // mutation, so a bad import/merge can always be undone via data:backup:restore.
        await createBackup("pre-import")
        const result = await importDatabase(request.envelope, request.resolutions)
        // ARCH TRACK A: re-register any imported source profiles the restore just wrote.
        if (ARCH_ENABLED) await registerStoredArchProfiles()
        return result
    },
    "data:seed": async () => {
        return await seedDatabase()
    },
    // Response: BackupSummary[] = { id, createdAt, reason }[] - small and safe to
    // render directly in a list; call data:backup:restore with the chosen `id` to
    // apply it. See database.ts's BackupSummary/listBackups for the full contract.
    "data:backup:list": async () => {
        return await listBackups()
    },
    "data:backup:restore": async request => {
        const result = await restoreBackup(request.id)
        if (ARCH_ENABLED) await registerStoredArchProfiles()
        return result
    },
    "sync:status": async () => {
        return await getSyncStatus()
    },
    "sync:config": async request => {
        const patch = Object.fromEntries(Object.entries(request.config).filter(([, v]) => v !== undefined))
        const next = await setSyncConfig(patch)
        await configureSyncAlarm()
        return {
            hasToken: Boolean(next.token),
            ...(next.gistId ? { gistId: next.gistId } : {}),
            autoSync: next.autoSync
        }
    },
    "sync:push": async () => {
        const envelope = await exportDatabase()
        return await pushToGist(envelope)
    },
    "sync:pull": async () => {
        const envelope = await pullFromGist()
        // Same pre-mutation safety net as data:import - a pull overwrites/merges local
        // data too, so it deserves the same undo-via-backup guarantee.
        await createBackup("pre-sync-pull")
        const result = await importDatabase(envelope)
        if (ARCH_ENABLED) await registerStoredArchProfiles()
        return result
    },
    "settings:get": async () => {
        return await getSettings()
    },
    "settings:update": async request => {
        const settings = await updateSettings(
            Object.fromEntries(Object.entries(request.settings).filter(([, value]) => value !== undefined)) as Partial<
                Awaited<ReturnType<typeof getSettings>>
            >
        )
        await configureUpdateAlarm()
        await configureBackupAlarm(settings.autoBackup)
        return settings
    }
}

export async function autoPush() {
    const config = await getSyncConfig()
    if (!config.autoSync || !config.token) return
    try {
        await pushToGist(await exportDatabase())
    } catch (error) {
        console.warn("[AMR] Auto sync push failed", error)
    }
}

// Daily automatic library restore-point. Driven by the backup alarm. Skips when the
// setting is off, the library is empty, or nothing has changed since the last auto
// snapshot (so idle days add no churn to the bounded backups table). Never throws -
// an alarm listener has no caller to catch a rejection.
export async function runAutoBackup() {
    try {
        const settings = await getSettings()
        if (!settings.autoBackup) return
        if ((await db.manga.count()) === 0) return
        const signature = await libraryChangeSignature()
        const stored = (await browser.storage.local.get(autoBackupSigKey))[autoBackupSigKey] as string | undefined
        if (stored === signature) return
        await createBackup("auto")
        await browser.storage.local.set({ [autoBackupSigKey]: signature })
    } catch (error) {
        console.warn("[AMR] Auto backup failed", error)
    }
}
