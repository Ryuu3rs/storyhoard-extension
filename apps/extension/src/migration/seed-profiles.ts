// The committed migration seed, parsed once through the real profile schema. Shared by the seed
// routine (which writes rows from it) and the registry (which only trusts a stored `origin: "seed"`
// row when its profile is still byte-equal to the committed one).

import seedJson from "@amr/sources/migration-seed.json"
import { parseProfile, type SiteProfile } from "@amr/source-engine"

let seedProfiles: Map<string, SiteProfile> | undefined

// A profile the schema rejects is dropped (never written), so a bad seed entry degrades to "not
// seeded", not to a corrupt archProfiles row.
export function loadSeedProfiles(): Map<string, SiteProfile> {
    if (seedProfiles) return seedProfiles
    const map = new Map<string, SiteProfile>()
    for (const raw of (seedJson as { profiles: unknown[] }).profiles) {
        const parsed = parseProfile(raw)
        if (parsed.ok) map.set(parsed.profile.id, parsed.profile)
    }
    seedProfiles = map
    return map
}

export function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
    if (value && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
    }
    return JSON.stringify(value)
}

// True when `profile` is exactly the committed seed profile for its own id. A row claiming to be a
// seed row but failing this is a tampered or stale row and must not be registered as trusted.
export function isCommittedSeedProfile(profile: unknown): boolean {
    const parsed = parseProfile(profile)
    if (!parsed.ok) return false
    const expected = loadSeedProfiles().get(parsed.profile.id)
    return !!expected && canonical(parsed.profile) === canonical(expected)
}
