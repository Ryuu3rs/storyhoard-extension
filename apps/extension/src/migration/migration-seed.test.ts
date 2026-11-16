import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createAdapterFromProfile, parseProfile, PROFILE_FORMAT_2 } from "@amr/source-engine"
import { describe, expect, it } from "vitest"
import { OFFICIAL_SITES_DEFAULT, isOfficialHost } from "../official-sources"

// The seed is generated in the private site lab, which also checks it against the adapters it came
// from. These checks hold for the committed file on its own.

const here = dirname(fileURLToPath(import.meta.url))
const seedPath = join(here, "..", "..", "..", "..", "packages", "sources", "migration-seed.json")
const committed = JSON.parse(readFileSync(seedPath, "utf8")) as { seedVersion: number; profiles: unknown[] }

describe("committed migration-seed.json", () => {
    it("holds format-2 profiles with unique ids", () => {
        const ids = committed.profiles.map(p => (p as { id: string }).id)
        expect(ids.length).toBeGreaterThan(0)
        expect(new Set(ids).size).toBe(ids.length)
        for (const profile of committed.profiles) {
            expect((profile as { profileFormat: number }).profileFormat).toBe(PROFILE_FORMAT_2)
        }
    })

    it("every profile parses through the real schema AND createAdapterFromProfile accepts it", () => {
        for (const raw of committed.profiles) {
            const parsed = parseProfile(raw)
            expect(parsed.ok, JSON.stringify(parsed)).toBe(true)
            if (!parsed.ok) continue
            const adapter = createAdapterFromProfile(parsed.profile)
            expect(adapter.manifest.id).toBe(parsed.profile.id)
            expect(adapter.manifest.domains).toEqual(parsed.profile.domains)
        }
    })

    it("carries no circumvention surface: no token/nonce/signature/header/cookie fields anywhere", () => {
        const forbidden = /token|nonce|signature|secret|cookie|header|authorization|drm|challenge/i
        const walk = (value: unknown, path: string): void => {
            if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`))
            else if (value && typeof value === "object") {
                for (const [key, v] of Object.entries(value)) {
                    expect(forbidden.test(key), `forbidden key "${path}.${key}"`).toBe(false)
                    walk(v, `${path}.${key}`)
                }
            }
        }
        walk(committed, "seed")
        for (const raw of committed.profiles) {
            expect((raw as { pages?: unknown }).pages, "format-2 seed never extracts page images").toBeUndefined()
        }
    })
})

describe("Tier-1 official sources", () => {
    it("are identifiable from the seed's own domains (the register routine skips these)", () => {
        const tier1 = committed.profiles
            .map(p => p as { id: string; domains: string[] })
            .filter(p => p.domains.some(d => isOfficialHost(d, OFFICIAL_SITES_DEFAULT)))
            .map(p => p.id)
            .sort()
        expect(tier1).toEqual(["mangadex", "webtoons"])
    })
})
