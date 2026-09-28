import assert from "node:assert/strict"
import { access, readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
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

const allowedPermissions = [
    "alarms",
    "declarativeNetRequest",
    "downloads",
    "notifications",
    "scripting",
    "storage",
    "tabs"
]

// All source origins + GitHub API are required (granted at install, no per-source grant step).
// VITE_COMMUNITY_API_ORIGIN and VITE_METADATA_API_ORIGIN are intentionally excluded - they come
// from a local .env and must not be part of the policy check (CI has no .env, local builds may
// have them set).
const allowedRequiredHosts = [
    "*://*.asurascans.com/*",
    "*://*.compsci88.com/*",
    "*://*.meowing.org/*",
    "https://nyanukafe.com/*",
    "https://www.nyanukafe.com/*",
    "*://*.flamecomics.xyz/*",
    "*://*.images.mangafreak.me/*",
    "*://*.imgsrv4.com/*",
    "*://*.mangadex.network/*",
    "*://*.mangafreak.me/*",
    "*://*.mangahere.com/*",
    "*://*.mangakatana.com/*",
    "*://*.mangaread.org/*",
    "*://*.manhwatop.com/*",
    "*://*.mfcdn.net/*",
    "*://*.mghcdn.com/*",
    "*://*.mhcdn.net/*",
    "*://*.pstatic.net/*",
    "*://*.static.comix.to/*",
    "*://*.weebcentral.com/*",
    "https://api.github.com/*",
    "https://api.mangadex.org/*",
    "https://asurascans.com/*",
    "https://brainrotcomics.com/*",
    "https://cdn.myanimelist.net/*",
    "https://comix.to/*",
    "https://dragontea.ink/*",
    "https://dynasty-scans.com/*",
    "https://en-thunderscans.com/*",
    "https://fanfox.net/*",
    "https://flamecomics.xyz/*",
    "https://gdscans.com/*",
    "https://graphql.anilist.co/*",
    "https://hentairead.com/*",
    "https://kagane.to/*",
    "https://kappabeast.com/*",
    "https://kstatic.to/*",
    "https://lhtranslation.net/*",
    "https://mangadex.org/*",
    "https://mangadistrict.com/*",
    "https://mangahere.cc/*",
    "https://mangahub.io/*",
    "https://mangak.io/*",
    "https://mangakatana.com/*",
    "https://mangasushi.org/*",
    "https://manhuatop.org/*",
    "https://manhuaus.com/*",
    "https://manhwatop.com/*",
    "https://mgeko.cc/*",
    "https://mgread.io/*",
    "https://natomanga.com/*",
    "https://olympustaff.com/*",
    "https://s4.anilist.co/*",
    "https://spiderscans.xyz/*",
    "https://tritinia.com/*",
    "https://tritinia.org/*",
    "https://uploads.mangadex.org/*",
    "https://webtoons.com/*",
    "https://weeb.ltd/*",
    "https://weebcentral.com/*",
    "https://www.comix.to/*",
    "https://www.dynasty-scans.com/*",
    "https://www.fanfox.net/*",
    "https://www.mangadex.org/*",
    "https://www.mangahere.cc/*",
    "https://www.mangahub.io/*",
    "https://www.mangakatana.com/*",
    "https://www.mgeko.cc/*",
    "https://www.natomanga.com/*",
    "https://www.olympustaff.com/*",
    "https://www.webtoons.com/*",
    "https://www.weebcentral.com/*",
    "https://yuzuki.kagane.to/*",
    "https://z-fanfox.net/*"
]

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
        assert.deepEqual([...manifest.permissions].sort(), allowedPermissions)
        const actualHosts = [...manifest.host_permissions]
            .filter(h => h !== communityApiOrigin && h !== metadataApiOrigin && h !== weebSiteOrigin)
            .sort()
        assert.deepEqual(actualHosts, [...allowedRequiredHosts].sort())
        assert.equal(manifest.optional_host_permissions, undefined)
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

test("browser-specific manifest policy is preserved", async () => {
    const chromium = await readManifest(chromiumExtension)
    const firefox = await readManifest(firefoxExtension)

    assert.equal(chromium.browser_specific_settings, undefined)
    assert.equal(chromium.key, EXPECTED_CHROMIUM_KEY)
    assert.equal(firefox.key, undefined)
    assert.equal(firefox.browser_specific_settings?.gecko?.id, "amr-next@ryuu3rs.dev")
    // Nothing collected by default; opt-in community data is declared as optional.
    assert.deepEqual(firefox.browser_specific_settings?.gecko?.data_collection_permissions, {
        required: ["none"],
        optional: ["technicalAndInteraction", "personallyIdentifyingInfo"]
    })
    // No Firefox-for-Android opt-in: the extension is desktop-only (source-site host
    // permissions don't grant on Android; the mobile app is the phone client). Guard that
    // gecko_android never sneaks back in. Chromium has no browser_specific_settings at all.
    assert.equal(firefox.browser_specific_settings?.gecko_android, undefined)
    assert.equal(chromium.background?.service_worker, "background.js")
    assert.deepEqual(firefox.background?.scripts, ["background.js"])
})
