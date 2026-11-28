import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
    diffPermissions,
    formatReport,
    hostSummary,
    originCovers,
    promptSummary,
    specFromAmoVersion,
    specFromManifest
} from "./permission-diff.js"

// Trimmed from AMO's API for 0.32.2 and the 0.33.2 manifest: the real update that stranded users.
const amo0322 = {
    version: "0.32.2",
    file: {
        permissions: [
            "alarms",
            "declarativeNetRequest",
            "downloads",
            "notifications",
            "scripting",
            "storage",
            "tabs",
            "https://weeb.ltd/*"
        ],
        optional_permissions: [],
        host_permissions: [
            "https://weeb.ltd/*",
            "https://mangadex.org/*",
            "*://*.mangadex.network/*",
            "*://*.pstatic.net/*"
        ],
        data_collection_permissions: ["none"],
        optional_data_collection_permissions: ["technicalAndInteraction", "personallyIdentifyingInfo"]
    }
}

const manifest0332 = {
    version: "0.33.2",
    permissions: [
        "alarms",
        "declarativeNetRequest",
        "notifications",
        "scripting",
        "storage",
        "tabs",
        "https://weeb.ltd/*"
    ],
    optional_permissions: ["search"],
    host_permissions: [
        "https://weeb.ltd/*",
        "https://mangadex.org/*",
        "https://*.mangadex.network/*",
        "https://*.pstatic.net/*"
    ],
    browser_specific_settings: {
        gecko: {
            id: "amr-next@ryuu3rs.dev",
            data_collection_permissions: {
                required: ["websiteContent", "searchTerms"],
                optional: ["technicalAndInteraction", "browsingActivity", "personallyIdentifyingInfo"]
            }
        }
    }
}

function manifestLike(overrides = {}) {
    return { ...manifest0332, version: "9.9.9", ...overrides }
}

test("0.32.2 -> 0.33.2 prompts for the new required data types only", () => {
    const diff = diffPermissions(specFromAmoVersion(amo0322), specFromManifest(manifest0332))
    assert.equal(diff.prompts, true)
    assert.deepEqual(diff.prompting, { permissions: [], dataRequired: ["searchTerms", "websiteContent"] })
    assert.deepEqual(diff.removedPermissions, ["downloads"])
    assert.deepEqual(diff.addedOptional, ["search"])
    assert.deepEqual(diff.addedDataOptional, ["browsingActivity"])
    assert.match(formatReport(diff), /will ask every Firefox user to approve it/)
    assert.match(formatReport(diff), /Removed host access: 2 patterns/)
    assert.doesNotMatch(formatReport(diff), /pstatic/)
    assert.equal(
        promptSummary(diff),
        "0.32.2 -> 0.33.2 adds required data types: searchTerms, websiteContent. Users must approve the update; say so in the release notes."
    )
})

test("optional host access is not reported as new against AMO, which does not list it", () => {
    const next = specFromManifest({ ...manifest0332, optional_host_permissions: ["https://*/*"] })
    const diff = diffPermissions(specFromAmoVersion(amo0322), next)
    assert.deepEqual(diff.addedOptional, ["search"])

    const againstManifest = diffPermissions(specFromManifest(manifest0332), next)
    assert.deepEqual(againstManifest.addedOptional, ["https://*/*"])
})

test("an identical manifest applies silently", () => {
    const spec = specFromManifest(manifest0332)
    const diff = diffPermissions(spec, specFromManifest(manifestLike()))
    assert.equal(diff.prompts, false)
    assert.match(formatReport(diff), /applies without a prompt/)
})

test("removals and optional additions never prompt", () => {
    const previous = specFromManifest(manifest0332)
    const next = specFromManifest(
        manifestLike({
            permissions: ["alarms", "storage"],
            host_permissions: ["https://weeb.ltd/*"],
            optional_permissions: ["search", "bookmarks"],
            optional_host_permissions: ["https://example.org/*"]
        })
    )
    const diff = diffPermissions(previous, next)
    assert.equal(diff.prompts, false)
    assert.deepEqual(diff.addedOptional, ["bookmarks", "https://example.org/*"])
})

test("a new permission with no Firefox message is silent, an unknown one prompts", () => {
    const previous = specFromManifest(manifest0332)
    const silent = diffPermissions(
        previous,
        specFromManifest(manifestLike({ permissions: [...manifest0332.permissions, "unlimitedStorage"] }))
    )
    assert.equal(silent.prompts, false)
    assert.deepEqual(silent.silentPermissions, ["unlimitedStorage"])

    const loud = diffPermissions(
        previous,
        specFromManifest(
            manifestLike({ permissions: [...manifest0332.permissions, "downloads", "someFuturePermission"] })
        )
    )
    assert.equal(loud.prompts, true)
    assert.deepEqual(loud.prompting.permissions, ["downloads", "someFuturePermission"])
})

test("the none data type is not a data type", () => {
    const withNone = manifestLike({
        browser_specific_settings: { gecko: { id: "x@y", data_collection_permissions: { required: ["none"] } } }
    })
    const diff = diffPermissions(specFromAmoVersion(amo0322), specFromManifest(withNone))
    assert.deepEqual(diff.prompting.dataRequired, [])
})

test("new host access does not hold an MV3 update but is reported as not granted", () => {
    const next = specFromManifest(
        manifestLike({ host_permissions: [...manifest0332.host_permissions, "https://example.org/*"] })
    )
    const diff = diffPermissions(specFromManifest(manifest0332), next)
    assert.equal(diff.prompts, false)
    assert.deepEqual(diff.hostsNotGranted, ["https://example.org/*"])
    assert.match(formatReport(diff), /NOT granted/)
    assert.match(hostSummary(diff), /does not grant it/)
})

test("origin coverage follows match-pattern rules", () => {
    assert.equal(originCovers("*://*.mangadex.network/*", "https://*.mangadex.network/*"), true)
    assert.equal(originCovers("*://*.mangadex.network/*", "https://uploads.mangadex.network/*"), true)
    assert.equal(originCovers("https://*.mangadex.org/*", "https://mangadex.org/*"), true)
    assert.equal(originCovers("<all_urls>", "https://anything.example/*"), true)
    assert.equal(originCovers("https://weeb.ltd/*", "https://weeb.ltd/api/*"), true)

    assert.equal(originCovers("https://*.mangadex.org/*", "https://mangadex.org.example.com/*"), false)
    assert.equal(originCovers("https://*.mangadex.org/*", "https://evilmangadex.org/*"), false)
    assert.equal(originCovers("https://mangadex.org/*", "https://*.mangadex.org/*"), false)
    assert.equal(originCovers("https://weeb.ltd/*", "*://weeb.ltd/*"), false)
    assert.equal(originCovers("https://weeb.ltd/api/*", "https://weeb.ltd/*"), false)
    assert.equal(originCovers("http://weeb.ltd/*", "https://weeb.ltd/*"), false)
    assert.equal(originCovers("*://weeb.ltd/*", "ftp://weeb.ltd/*"), false)
})

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "amo-permission-diff.js")

function runCli(args, env = {}) {
    const result = spawnSync(process.execPath, [cli, ...args], {
        encoding: "utf8",
        env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: "", AMR_RELEASE_ORIGINS: "", ...env }
    })
    return { code: result.status, out: result.stdout + result.stderr }
}

function writeManifests(previous, next) {
    const dir = mkdtempSync(path.join(tmpdir(), "perm-diff-"))
    const before = path.join(dir, "before.json")
    const after = path.join(dir, "after.json")
    writeFileSync(before, JSON.stringify(previous))
    writeFileSync(after, JSON.stringify(next))
    return { before, after }
}

test("CLI: a missing manifest warns and exits 0, or 1 with --strict", () => {
    const missing = path.join(tmpdir(), "no-such-dir-perm-diff", "manifest.json")
    const loose = runCli(["--manifest", missing, "--baseline", missing])
    assert.equal(loose.code, 0)
    assert.match(loose.out, /::warning title=AMO permission check skipped::/)
    assert.equal(runCli(["--manifest", missing, "--baseline", missing, "--strict"]).code, 1)
})

test("CLI: a prompting update warns on one escaped line; --strict exits 1", () => {
    const { before, after } = writeManifests(
        { ...manifest0332, version: "1.0.0", browser_specific_settings: { gecko: { id: "x@y" } } },
        { ...manifest0332, version: "1.1.0" }
    )
    const loose = runCli(["--baseline", before, "--manifest", after])
    assert.equal(loose.code, 0)
    const warning = loose.out
        .split(/\r?\n/)
        .find(line => line.startsWith("::warning title=Firefox update needs user approval::"))
    assert.ok(warning, loose.out)
    assert.match(warning, /adds required data types: searchTerms, websiteContent\./)
    assert.equal(runCli(["--baseline", before, "--manifest", after, "--strict"]).code, 1)
})

test("CLI: AMR_RELEASE_ORIGINS stands in for hosts only the release build adds", () => {
    const releaseOnly = "https://api.example.org/*"
    const { before, after } = writeManifests(
        { ...manifest0332, host_permissions: [...manifest0332.host_permissions, releaseOnly] },
        { ...manifest0332, version: "9.9.9" }
    )
    const without = runCli(["--baseline", before, "--manifest", after])
    assert.match(without.out, /Removed host access: 1 patterns/)
    const withOrigin = runCli(["--baseline", before, "--manifest", after], { AMR_RELEASE_ORIGINS: releaseOnly })
    assert.doesNotMatch(withOrigin.out, /Removed host access/)
    assert.equal(withOrigin.code, 0)
})
