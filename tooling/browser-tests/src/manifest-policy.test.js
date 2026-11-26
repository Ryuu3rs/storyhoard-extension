import assert from "node:assert/strict"
import { access, readdir, readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { isNeutralBuild, neutralHosts } from "./build-kind.js"
import { chromiumExtension, firefoxExtension, repositoryRoot } from "./paths.js"

// Reads a build-time origin env var that may be baked in by the release pipeline
// (no .env file - see .github/workflows/release-please.yml) or set locally via
// apps/extension/.env. Both community and metadata origins are optional and must be
// excluded from the policy check whichever way the manifest was built.
async function readEnvOrigin(name) {
    if (process.env[name]) return process.env[name].trim()
    try {
        const content = await readFile(path.join(repositoryRoot, "apps", "extension", ".env"), "utf8")
        const match = new RegExp(`^${name}=(.+)$`, "m").exec(content)
        return match?.[1]?.trim()
    } catch {
        return undefined
    }
}

const communityApiOrigin = await readEnvOrigin("VITE_COMMUNITY_API_ORIGIN")
const metadataApiOrigin = await readEnvOrigin("VITE_METADATA_API_ORIGIN")
// Optional dev-server origin for weeb.ltd account sync; the production origin is required.
const weebSiteOrigin = await readEnvOrigin("VITE_WEEB_SITE_ORIGIN")

const allowedPermissions = ["alarms", "declarativeNetRequest", "notifications", "scripting", "storage", "tabs"]

async function readManifest(extensionDirectory) {
    const manifestPath = path.join(extensionDirectory, "manifest.json")
    return JSON.parse(await readFile(manifestPath, "utf8"))
}

// Must match the "key" literal in apps/extension/wxt.config.ts exactly. This pins the
// Chromium extension id (bbhdbcfjedbbgaeafdfffcadbgafjgai) so it never again depends on
// the unpacked folder's path - a data-loss bug (every manual update reset IndexedDB,
// since a new path meant a new id) was fixed by adding this key. Losing it in a future
// edit would silently reintroduce that bug.
const EXPECTED_CHROMIUM_KEY =
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuFs/Zy3z054Tl4XnWmlr+CBQ8vsvnzIUNJBJ/o/ltpGW3vsNypznLvMDeDlZ3yMhNCA0ZkEuy0o2cfyQ6BtBE+wEZu/teb0AKyRzVEOVo3gy//lcPhVaewqfAVF4woFG5lWnEoOS5Fg+88NBdZp6/rY+OyjFgLv6oX1PWnCfX7WRYnAwi90KJK9c27MtgNRJfMaQGHAK4vieUdLcyObKoHxZlVQXqMQOFtUR3WJIQI3AVKg3wheXF8IvBHKHxueyR2f3C5EAWfBI7mm/F051ivpnQT9foV9ED6R9rF3mqfflHZLjqcfoq64qMCYsHkR/9J8BpWTFNfcYmSR21sCE+wIDAQAB"

function packagedPaths(manifest) {
    return [
        manifest.action?.default_popup,
        manifest.background?.service_worker,
        ...(manifest.background?.scripts ?? []),
        ...Object.values(manifest.icons ?? {})
    ].filter(Boolean)
}

for (const [browserName, extensionDirectory] of [
    ["Chromium", chromiumExtension],
    ["Firefox", firefoxExtension]
]) {
    test(`${browserName} manifest follows extension policy`, async () => {
        const manifest = await readManifest(extensionDirectory)

        assert.equal(manifest.manifest_version, 3)
        // The listing matches the build: a tracker with no reader, official sources plus the sites you add.
        assert.match(manifest.description, /^Track your manga and comics library\. No built-in reader: /)
        assert.deepEqual([...manifest.permissions].sort(), allowedPermissions)
        // downloads only serves the GitHub update of a sideloaded Chromium copy, asked for in the click.
        // Firefox is updated by AMO and never asks for it. search is asked for by the "Search the web" click.
        assert.deepEqual(
            manifest.optional_permissions,
            browserName === "Firefox" ? ["search"] : ["downloads", "search"]
        )
        const actualHosts = [...manifest.host_permissions]
            .filter(h => h !== communityApiOrigin && h !== metadataApiOrigin && h !== weebSiteOrigin)
            .sort()
        const neutral = isNeutralBuild(extensionDirectory)
        // Only the local testing build may bundle site adapters; anything else that is not neutral is a
        // shipped build that names reader sites, which the store listing must never carry.
        if (process.env.AMR_EXPECT_BUILD !== "bundled") {
            assert.ok(neutral, `${browserName}: the shipped build must request host access for official sites only`)
        }
        if (neutral) {
            assert.deepEqual(actualHosts, [...neutralHosts].sort())
        } else {
            // The local testing build adds the private site lab's hosts on top of the shipped ones.
            for (const host of neutralHosts) assert.ok(actualHosts.includes(host), `bundled build is missing ${host}`)
        }
        // The "Add site" flow requests exactly one `https://<host>/*` per click, which the browser only
        // allows for a pattern declared optional. The declaration is exactly https-only (never
        // `*://*/*`, never a bare `<all_urls>`), and nothing REQUIRED may use that wildcard.
        assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"])
        for (const required of manifest.host_permissions) {
            assert.notEqual(required, "https://*/*", "required host_permissions must not hold the wildcard")
            assert.notEqual(required, "*://*/*")
            assert.notEqual(required, "<all_urls>")
            assert.ok(!/^[^/]*:\/\/\*\//.test(required), `required host ${required} must not be a bare wildcard host`)
        }
        // The ONLY content script allowed is the weeb.ltd site bridge (presence signal +
        // same-origin-gated "open a title" relay). Locked to exactly this shape so an
        // unreviewed content script on any other site can never slip into the manifest.
        // The dev-server origin is added only when the build baked VITE_WEEB_SITE_ORIGIN in.
        assert.equal(manifest.content_scripts?.length, 1)
        const bridge = manifest.content_scripts[0]
        const expectedBridgeMatches = ["https://weeb.ltd/*", ...(weebSiteOrigin ? [weebSiteOrigin] : [])]
        assert.deepEqual([...bridge.matches].sort(), [...expectedBridgeMatches].sort())
        assert.deepEqual(bridge.js, ["content-scripts/weeb-bridge.js"])
        assert.equal(bridge.run_at, "document_start")
        // Still no externally_connectable: the bridge content script is the only web-page
        // path into the extension, so arbitrary sites can never message it directly.
        assert.equal(manifest.externally_connectable, undefined)

        for (const packagedPath of packagedPaths(manifest)) {
            assert.ok(!packagedPath.includes("://"), `${packagedPath} must be packaged locally`)
            await access(path.join(extensionDirectory, packagedPath.replace(/^[/\\]/, "")))
        }
    })
}

// ARCH TRACK A: the in-app reader is retired from the shipped build - reading happens on the
// source's own page. A normal (non-arch) build must emit no reader.html; the entrypoint is dropped
// in wxt.config's entrypoints:found hook unless VITE_ARCH_TRACK=A.
for (const [browserName, extensionDirectory] of [
    ["Chromium", chromiumExtension],
    ["Firefox", firefoxExtension]
]) {
    test(`${browserName} store build emits no in-app reader`, async () => {
        if (process.env.VITE_ARCH_TRACK === "A") return // arch dev build keeps a Classic reader
        let present = false
        try {
            await access(path.join(extensionDirectory, "reader.html"))
            present = true
        } catch {
            present = false
        }
        assert.equal(present, false, "reader.html must not ship in a normal build")
    })
}

// A rule file the manifest does not load serves a site the build left out, so it must not ship either.
for (const [browserName, extensionDirectory] of [
    ["Chromium", chromiumExtension],
    ["Firefox", firefoxExtension]
]) {
    test(`${browserName} packages only the network rules it loads`, async () => {
        const manifest = await readManifest(extensionDirectory)
        const loaded = (manifest.declarative_net_request?.rule_resources ?? []).map(rule => rule.path).sort()
        const packaged = (await readdir(path.join(extensionDirectory, "rules"))).map(file => `rules/${file}`).sort()
        assert.deepEqual(packaged, loaded)
    })
}

test("browser-specific manifest policy is preserved", async () => {
    const chromium = await readManifest(chromiumExtension)
    const firefox = await readManifest(firefoxExtension)

    assert.equal(chromium.browser_specific_settings, undefined)
    assert.equal(chromium.key, EXPECTED_CHROMIUM_KEY)
    assert.equal(firefox.key, undefined)
    assert.equal(firefox.browser_specific_settings?.gecko?.id, "amr-next@ryuu3rs.dev")
    // Library titles go to AniList automatically and typed searches to weeb.ltd. Usage analytics and the
    // opt-in community data (reading activity, install id, username) are declared as optional.
    assert.deepEqual(firefox.browser_specific_settings?.gecko?.data_collection_permissions, {
        required: ["websiteContent", "searchTerms"],
        optional: ["technicalAndInteraction", "browsingActivity", "personallyIdentifyingInfo"]
    })
    // Listed for Firefox for Android, so copies there update from the store. Chromium has no
    // browser_specific_settings at all.
    assert.deepEqual(firefox.browser_specific_settings?.gecko_android, { strict_min_version: "142.0" })
    assert.equal(chromium.background?.service_worker, "background.js")
    assert.deepEqual(firefox.background?.scripts, ["background.js"])
})
