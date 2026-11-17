// Firefox asks before an add-on sends browsing activity off the device. Account sync, the GitHub backup and
// AniList list sync all send reading history (titles, chapter links, progress, when you last read), so on
// Firefox they send nothing until its optional browsingActivity data permission is granted. Chrome has no
// such permission, so there they are allowed as soon as the user turns them on.

// data_collection is newer than the browser typings this project uses.
export const SYNC_DATA_PERMISSION = { data_collection: ["browsingActivity"] } as never

const onFirefox = () => import.meta.env.BROWSER === "firefox"

export async function syncDataAllowed(): Promise<boolean> {
    if (!onFirefox()) return true
    try {
        return await browser.permissions.contains(SYNC_DATA_PERMISSION)
    } catch {
        return false
    }
}

// Must be the first await in a click handler: Firefox only shows the prompt while the click's user gesture
// is still live. `origins` folds a host grant the same click needs into the one prompt.
export function requestSyncData(origins?: string[]): Promise<boolean> {
    if (!onFirefox()) {
        return origins ? browser.permissions.request({ origins }).catch(() => false) : Promise.resolve(true)
    }
    const request = { data_collection: ["browsingActivity"], ...(origins ? { origins } : {}) } as never
    return browser.permissions.request(request).catch(() => false)
}

export class SyncDataPermissionError extends Error {
    constructor() {
        super("Firefox has not allowed StoryHoard to send your reading history yet. Allow it in Settings.")
    }
}
