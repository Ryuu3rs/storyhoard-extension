// Regenerates packages/sources/migration-seed.json from src/migration/seed-spec.ts.
//
//   npm run seed:generate -w @amr/extension
//
// Build-time only; never bundled into the extension. The output is validated through the real
// profile schema before it is written, so a seed that the runtime would reject cannot be
// committed. migration-seed.test.ts fails if the committed JSON drifts from this generator.

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { format, resolveConfig } from "prettier"
import { parseProfile } from "@amr/source-engine"
import { buildSeed } from "../src/migration/seed-spec"

const here = dirname(fileURLToPath(import.meta.url))
const outPath = join(here, "..", "..", "..", "packages", "sources", "migration-seed.json")

const seed = buildSeed()
for (const profile of seed.profiles) {
    const parsed = parseProfile(profile)
    if (!parsed.ok) throw new Error(`seed profile "${profile.id}" is invalid: ${parsed.error}`)
}

const config = await resolveConfig(outPath)
const text = await format(JSON.stringify(seed), { ...config, filepath: outPath })
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, text)
console.log(`wrote ${seed.profiles.length} profiles to ${outPath}`)
