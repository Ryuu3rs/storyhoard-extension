// new URL() also accepts javascript:, data:, blob: and file: URLs. Source-controlled values (a site's
// page, a search result) flow to browser.tabs.create, so only http(s) is ever opened.
export function isValidUrl(value: string | undefined | null): value is string {
    if (!value) return false
    try {
        const protocol = new URL(value).protocol
        return protocol === "http:" || protocol === "https:"
    } catch {
        return false
    }
}

// Single funnel for opening a source-controlled URL in a tab. Returns false when the URL was rejected so
// callers can surface an error.
export function openExternal(url: string | undefined | null, active = true): boolean {
    if (!isValidUrl(url)) return false
    void browser.tabs.create({ url, active })
    return true
}
