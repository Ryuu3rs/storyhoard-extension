import { createAdapterFromProfile, PROFILE_FORMAT_2 } from "@amr/source-engine"
import type { SourceAdapter } from "@amr/source-sdk"
import { sourceRegistry } from "@amr/sources"

// Test-only stand-ins for site adapters. The extension bundles no site adapters (they live in the
// private site lab), so a test that needs "a bundled adapter for some site" registers one of these.

export function fakeSiteAdapter(id: string, domain = `${id}.example`): SourceAdapter {
    return createAdapterFromProfile({
        profileFormat: PROFILE_FORMAT_2,
        id,
        name: `Site ${id}`,
        engine: "generic",
        numberingKind: "chapter",
        origin: `https://${domain}`,
        domains: [domain],
        languages: ["en"],
        capabilities: ["manga", "chapters"],
        requestRateLimit: { requests: 50, intervalMs: 1000 },
        origins: [`https://${domain}/*`],
        match: { manga: "^/manga/([a-z0-9-]+)/?$", chapter: "^/manga/([a-z0-9-]+)/ch-([0-9.]+)/?$" },
        series: { urlTemplate: "/manga/{slug}", titlePattern: "<title>(?<title>[^<]+)</title>" }
    })
}

// Registers a fake adapter per id and returns the cleanup that unregisters them.
export function registerFakeSites(...ids: string[]): () => void {
    for (const id of ids) sourceRegistry.register(fakeSiteAdapter(id))
    return () => {
        for (const id of ids) sourceRegistry.unregister(id)
    }
}
