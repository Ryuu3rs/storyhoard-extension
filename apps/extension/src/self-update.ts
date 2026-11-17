// GitHub releases update sideloaded copies only. AMO updates every Firefox install, and a Chrome Web Store
// install carries the store's update_url, so neither ever asks GitHub or offers a download.
export function selfUpdateAllowed(
    browserName: string | undefined = import.meta.env.BROWSER,
    manifest: { update_url?: string | undefined } = browser.runtime.getManifest()
): boolean {
    return browserName !== "firefox" && !manifest.update_url
}
