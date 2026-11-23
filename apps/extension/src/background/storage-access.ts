// Chromium: content scripts (the weeb.ltd bridge, the on-page panel) lose all access to storage.local, so a
// compromised page can neither read nor rewrite settings and stores. No content script uses extension
// storage. Firefox has no access level for storage.local; the secrets live in the protected store there.
export async function lockStorageToExtension(): Promise<void> {
    const local = browser.storage.local
    if (typeof local.setAccessLevel !== "function") return
    try {
        await local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    } catch (error) {
        console.error("[AMR] Could not limit storage to the extension", error)
    }
}
