import { readFileSync } from "node:fs"
import path from "node:path"

export const neutralHosts = [
    "*://*.mangadex.network/*",
    "*://*.pstatic.net/*",
    "https://api.github.com/*",
    "https://api.mangadex.org/*",
    "https://cdn.myanimelist.net/*",
    "https://graphql.anilist.co/*",
    "https://mangadex.org/*",
    "https://s4.anilist.co/*",
    "https://uploads.mangadex.org/*",
    "https://webtoons.com/*",
    "https://weeb.ltd/*",
    "https://www.mangadex.org/*",
    "https://www.webtoons.com/*"
]

export const neutralSkipReason = "needs a bundled site adapter, absent from this no-bundled-sites build"

// A build is neutral when its required hosts are only first-party and official ones. AMR_EXPECT_BUILD
// (neutral or shipped) lets CI state the intent so a mis-built artifact fails instead of passing as the other kind.
export function isNeutralManifest(manifest, extraAllowedHosts = []) {
    const allowed = new Set([...neutralHosts, ...extraAllowedHosts])
    return (manifest.host_permissions ?? []).every(host => allowed.has(host))
}

export function isNeutralBuild(extensionDirectory) {
    const manifest = JSON.parse(readFileSync(path.join(extensionDirectory, "manifest.json"), "utf8"))
    const detected = isNeutralManifest(
        manifest,
        [
            process.env.VITE_COMMUNITY_API_ORIGIN,
            process.env.VITE_METADATA_API_ORIGIN,
            process.env.VITE_WEEB_SITE_ORIGIN
        ].filter(Boolean)
    )
    const expected = process.env.AMR_EXPECT_BUILD
    if (expected && expected !== "neutral" && expected !== "shipped") {
        throw new Error(`AMR_EXPECT_BUILD must be neutral or shipped, got ${expected}`)
    }
    if (expected && (expected === "neutral") !== detected) {
        throw new Error(
            `AMR_EXPECT_BUILD=${expected} but ${extensionDirectory} is a ${detected ? "neutral" : "shipped"} build`
        )
    }
    return detected
}
