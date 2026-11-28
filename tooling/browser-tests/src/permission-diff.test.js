import assert from "node:assert/strict"
import test from "node:test"
import {
    diffPermissions,
    formatReport,
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
    assert.deepEqual(diff.prompting, { permissions: [], origins: [], dataRequired: ["searchTerms", "websiteContent"] })
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
    assert.match(formatReport(diff), /applies silently/)
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

test("new host access outside the old patterns prompts", () => {
    const next = specFromManifest(
        manifestLike({ host_permissions: [...manifest0332.host_permissions, "https://example.org/*"] })
    )
    const diff = diffPermissions(specFromManifest(manifest0332), next)
    assert.deepEqual(diff.prompting.origins, ["https://example.org/*"])
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
