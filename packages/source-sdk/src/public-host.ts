const NON_PUBLIC_SUFFIXES = [
    ".local",
    ".localhost",
    ".internal",
    ".lan",
    ".test",
    ".home.arpa",
    ".localdomain",
    ".corp",
    ".intranet",
    ".private",
    ".onion",
    ".i2p",
    ".invalid",
    ".arpa",
    ".nip.io",
    ".sslip.io",
    ".xip.io",
    ".localtest.me",
    ".lvh.me"
]

// True for a hostname that can never be a public website: loopback, private-network, IP literal,
// single-label, trailing-dot or an intranet-style suffix. Used to keep user-added sources (and the
// requests they make, including after a redirect) off the user's own network.
export function isNonPublicHost(hostname: string): boolean {
    const host = hostname.toLowerCase()
    if (host === "" || host.endsWith(".")) return true
    if (host.startsWith("[") || host.includes(":")) return true
    if (!host.includes(".")) return true
    if (/^\d+(\.\d+){3}$/.test(host) || /\.\d+$/.test(host)) return true
    return host === "localhost" || NON_PUBLIC_SUFFIXES.some(suffix => host.endsWith(suffix) || host === suffix.slice(1))
}

// https, no explicit port, no embedded credentials, and a public hostname.
export function isPublicHttpsUrl(url: URL): boolean {
    if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return false
    return !isNonPublicHost(url.hostname)
}
