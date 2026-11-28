// Compares the built Firefox manifest with the version AMO serves today and reports whether the
// update will need each user's approval, or adds host access Firefox will not grant on update.
// It warns rather than fails, because some releases need a new permission on purpose; the point
// is that the release notes say so. Read it on the Release PR's CI run: by the time the release
// job runs, the release is already published.
//
//   node tooling/browser-tests/src/amo-permission-diff.js [--manifest <path>] [--baseline <manifest.json>] [--strict]
//
// --baseline compares against a local manifest instead of AMO. --strict exits 1 when the update
// prompts, adds ungranted host access or the check cannot run. AMR_RELEASE_ORIGINS (comma list)
// names host patterns the release build adds from env vars that this build may lack.
import { appendFile, readFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import {
    diffPermissions,
    formatReport,
    hostSummary,
    promptSummary,
    specFromAmoVersion,
    specFromManifest
} from "./permission-diff.js"
import { firefoxExtension } from "./paths.js"

const inActions = process.env.GITHUB_ACTIONS === "true"

// Workflow-command data must escape %, CR and LF or the annotation is cut short.
function escapeCommand(value) {
    return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")
}

function warn(title, message) {
    if (inActions) console.log(`::warning title=${escapeCommand(title)}::${escapeCommand(message)}`)
    else console.warn(`${title}: ${message}`)
}

function describe(error) {
    const cause = error?.cause?.message ?? error?.cause?.code
    return cause ? `${error.message} (${cause})` : String(error?.message ?? error)
}

async function summary(text) {
    if (!process.env.GITHUB_STEP_SUMMARY) return
    try {
        await appendFile(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
    } catch (error) {
        warn("AMO permission check", `Could not write the step summary: ${describe(error)}`)
    }
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

function releaseOrigins() {
    return (process.env.AMR_RELEASE_ORIGINS ?? "")
        .split(",")
        .map(value => value.trim())
        .filter(Boolean)
}

async function run() {
    const { values } = parseArgs({
        options: {
            manifest: { type: "string", default: path.join(firefoxExtension, "manifest.json") },
            baseline: { type: "string" },
            strict: { type: "boolean", default: false }
        }
    })
    const strict = values.strict
    let diff
    try {
        const manifest = await readJson(values.manifest)
        const next = specFromManifest(manifest)
        for (const origin of releaseOrigins()) if (!next.origins.includes(origin)) next.origins.push(origin)
        const addonId = manifest.browser_specific_settings?.gecko?.id
        if (!values.baseline && !addonId)
            throw new Error(`${values.manifest} has no browser_specific_settings.gecko.id`)
        const previous = values.baseline
            ? specFromManifest(await readJson(values.baseline))
            : await amoBaseline(addonId)
        diff = diffPermissions(previous, next)
    } catch (error) {
        warn("AMO permission check skipped", describe(error))
        return strict ? 1 : 0
    }

    const report = formatReport(diff)
    console.log(report)
    await summary(`### Firefox update permissions\n\n${report}`)
    if (diff.prompts) warn("Firefox update needs user approval", promptSummary(diff))
    if (diff.hostsNotGranted.length > 0) warn("Firefox will not grant new host access", hostSummary(diff))
    return strict && (diff.prompts || diff.hostsNotGranted.length > 0) ? 1 : 0
}

let code
try {
    code = await run()
} catch (error) {
    warn("AMO permission check skipped", describe(error))
    code = process.argv.includes("--strict") ? 1 : 0
}
process.exitCode = code
