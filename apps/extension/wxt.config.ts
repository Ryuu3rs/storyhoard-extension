import { execSync } from "node:child_process"
import { defineConfig } from "wxt"
import { ALL_OPTIONAL_ORIGINS, ANILIST_API_ORIGIN, GITHUB_API_ORIGIN, METADATA_COVER_ORIGINS } from "./src/permissions"

// Build marker shown in the UI next to the (release-please-owned) version, so a local dev build
// is identifiable while testing without hand-bumping the version. Short commit + a "+" when the
// working tree is dirty; "dev" if git is unavailable. Injected as a compile-time constant.
function gitBuildId(): string {
    try {
        const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim()
        // The "+" flags a LOCAL dev build with uncommitted changes. A release is built in CI from a
        // tagged commit, where the tree can pick up incidental changes during install/build - so never
        // stamp "+" on a tagged commit or in CI, or a clean release footer reads as a dirty dev one.
        let onTag = false
        try {
            execSync("git describe --exact-match --tags HEAD", { stdio: "ignore" })
            onTag = true
        } catch {
            // not on a tag
        }
        let dirty = ""
        if (!onTag && !process.env.CI) {
            try {
                execSync("git diff --quiet")
            } catch {
                dirty = "+"
            }
        }
        return sha ? sha + dirty : "dev"
    } catch {
        return "dev"
    }
}
const BUILD_ID = gitBuildId()

export default defineConfig({
    manifestVersion: 3,
    modules: ["@wxt-dev/module-svelte"],
    // Release-asset filename prefix. Overrides WXT's default {{name}} (which sanitizes the
    // @amr/extension package name to "amrextension") so built zips are storyhoard-<version>-chrome.zip
    // / -firefox.zip / -sources.zip. The -chrome.zip / -firefox.zip SUFFIX must stay: the in-app
    // self-updater and amo-submit.yml match on it. The @amr npm scope is unchanged.
    zip: {
        name: "storyhoard"
    },
    // Fully disable Vite's modulepreload - extensions use self.importScripts, not link preload,
    // and the preload helper injects Function() + innerHTML which violate MV3 CSP and AMO policy.
    vite: () => ({
        define: {
            __BUILD_ID__: JSON.stringify(BUILD_ID)
        },
        build: {
            modulePreload: false
        }
    }),
    manifest: ({ browser }) => ({
        name: "StoryHoard",
        description: "Track and read your manga and comics library across many sources.",
        // Fixed public key so "Load unpacked" always computes the SAME extension ID
        // regardless of which folder the zip is extracted to. Without this, Chrome
        // derives the id from the unpacked folder's path - since release zips are
        // named per-version (amrextension-0.9.X-chrome), each update unpacked to a
        // new folder got a brand-new id, and IndexedDB (the whole library) is scoped
        // to chrome-extension://<id>, so every manual update looked like data loss.
        // Corresponding private key: apps/extension/chrome-signing-key.pem (gitignored,
        // not required for unpacked loading - only needed if we ever pack/sign a .crx).
        ...(browser !== "firefox"
            ? {
                  // FROZEN: never change - Chrome extension id + IndexedDB origin (renaming empties every library)
                  key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuFs/Zy3z054Tl4XnWmlr+CBQ8vsvnzIUNJBJ/o/ltpGW3vsNypznLvMDeDlZ3yMhNCA0ZkEuy0o2cfyQ6BtBE+wEZu/teb0AKyRzVEOVo3gy//lcPhVaewqfAVF4woFG5lWnEoOS5Fg+88NBdZp6/rY+OyjFgLv6oX1PWnCfX7WRYnAwi90KJK9c27MtgNRJfMaQGHAK4vieUdLcyObKoHxZlVQXqMQOFtUR3WJIQI3AVKg3wheXF8IvBHKHxueyR2f3C5EAWfBI7mm/F051ivpnQT9foV9ED6R9rF3mqfflHZLjqcfoq64qMCYsHkR/9J8BpWTFNfcYmSR21sCE+wIDAQAB"
              }
            : {}),
        permissions: ["alarms", "declarativeNetRequest", "downloads", "notifications", "scripting", "storage", "tabs"],
        declarative_net_request: {
            rule_resources: [
                { id: "pstatic-referer", enabled: true, path: "rules/pstatic-referer.json" },
                // Injects the isAdult=1 cookie on fanfox.net / mangahere.cc requests so
                // Mature-tagged titles return a real chapter list. Cookie is a forbidden
                // fetch header (silently dropped), so it must be set below fetch via DNR.
                { id: "fanfox-adult", enabled: true, path: "rules/fanfox-adult.json" }
            ]
        },
        // All source origins are required so reading works immediately after install
        // without any manual "Grant access" step. GitHub API also required for
        // update checks and Gist sync.
        // VITE_COMMUNITY_API_ORIGIN and VITE_METADATA_API_ORIGIN are loaded from
        // apps/extension/.env (gitignored); each is added only when set.
        host_permissions: [
            GITHUB_API_ORIGIN,
            ANILIST_API_ORIGIN,
            ...METADATA_COVER_ORIGINS,
            ...(process.env.VITE_COMMUNITY_API_ORIGIN ? [process.env.VITE_COMMUNITY_API_ORIGIN] : []),
            ...(process.env.VITE_METADATA_API_ORIGIN ? [process.env.VITE_METADATA_API_ORIGIN] : []),
            // weeb.ltd account sync. The production origin is public; VITE_WEEB_SITE_ORIGIN adds a
            // dev server origin on top when set.
            "https://weeb.ltd/*",
            ...(process.env.VITE_WEEB_SITE_ORIGIN ? [process.env.VITE_WEEB_SITE_ORIGIN] : []),
            ...ALL_OPTIONAL_ORIGINS
        ],
        icons: {
            32: "/icons/icon_32.png",
            48: "/icons/icon_48.png",
            96: "/icons/icon_96.png",
            128: "/icons/icon_128.png"
        },
        browser_specific_settings:
            browser === "firefox"
                ? {
                      gecko: {
                          // FROZEN: never change - AMO auto-update + IndexedDB origin
                          id: "amr-next@ryuu3rs.dev",
                          strict_min_version: "142.0",
                          // Nothing is collected by default (required: none). Community
                          // features are strictly opt-in behind an in-app consent card, so the
                          // data they send is declared as OPTIONAL: technicalAndInteraction
                          // (anonymous install id, version, feature usage) and
                          // personallyIdentifyingInfo (the username the user chooses). See the
                          // in-app privacy policy (src/privacy-policy.ts).
                          data_collection_permissions: {
                              required: ["none"],
                              optional: ["technicalAndInteraction", "personallyIdentifyingInfo"]
                          }
                      },
                      // Opt in to Firefox for Android (Fenix): an empty object marks the
                      // add-on Android-compatible so it installs + is searchable from the
                      // AMO listing on mobile Firefox. The desktop gecko block (frozen id)
                      // is unchanged.
                      gecko_android: {}
                  }
                : undefined
    })
})
