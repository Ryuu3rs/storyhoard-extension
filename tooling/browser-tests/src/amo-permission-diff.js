// Compares the built Firefox manifest with the version AMO serves today and reports whether the
// update will need each user's approval. It warns rather than fails, because some releases need
// a new permission on purpose; the point is that the release notes say so.
//
//   node tooling/browser-tests/src/amo-permission-diff.js [--manifest <path>] [--baseline <manifest.json>] [--strict]
//
// --baseline compares against a local manifest instead of AMO. --strict exits 1 when the update
// prompts or AMO cannot be read.
import { appendFile, readFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import {
    diffPermissions,
    formatReport,
    promptSummary,
    specFromAmoVersion,
    specFromManifest
} from "./permission-diff.js"
import { firefoxExtension } from "./paths.js"

const { values } = parseArgs({
    options: {
        manifest: { type: "string", default: path.join(firefoxExtension, "manifest.json") },
        baseline: { type: "string" },
        strict: { type: "boolean", default: false }
    }
})

const inActions = process.env.GITHUB_ACTIONS === "true"

async function summary(text) {
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
}

function warn(title, message) {
    if (inActions) console.log(`::warning title=${title}::${message}`)
    else console.warn(`${title}: ${message}`)
}

async function readJson(file) {
    return JSON.parse(await readFile(file, "utf8"))
}

async function amoBaseline(addonId) {
    const url = `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(addonId)}/`
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(`AMO answered HTTP ${response.status} for ${url}`)
    const addon = await response.json()
    if (!addon.current_version) throw new Error(`AMO has no public version of ${addonId}`)
    return specFromAmoVersion(addon.current_version)
}

const manifest = await readJson(values.manifest)
const next = specFromManifest(manifest)
const addonId = manifest.browser_specific_settings?.gecko?.id
if (!addonId && !values.baseline) throw new Error(`${values.manifest} has no browser_specific_settings.gecko.id`)

let previous
try {
    previous = values.baseline ? specFromManifest(await readJson(values.baseline)) : await amoBaseline(addonId)
} catch (error) {
    warn("AMO permission check skipped", `Could not read the live AMO version: ${error.message}`)
    process.exit(values.strict ? 1 : 0)
}

const diff = diffPermissions(previous, next)
const report = formatReport(diff)
console.log(report)
await summary(`### Firefox update permissions\n\n${report}`)
if (diff.prompts) warn("Firefox update needs user approval", promptSummary(diff))
if (diff.prompts && values.strict) process.exit(1)
