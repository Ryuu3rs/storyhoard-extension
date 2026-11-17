import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { OFFICIAL_SOURCE_IDS, buildScope, isSourceInScope } from "@amr/sources"
import type { Plugin } from "vite"
import { defineConfig } from "wxt"
import {
    bareHost,
    emptiedProfileFile,
    forbiddenPackageHosts,
    hostsIn,
    labMarkersIn,
    profilesIn,
    unshippableProfileIds
} from "./src/build/ship-guard"
import { sampleEntries } from "./src/lab/sample-library"
import {
    ALL_OPTIONAL_ORIGINS,
    ALL_SITES_ORIGIN,
    ANILIST_API_ORIGIN,
    GITHUB_API_ORIGIN,
    METADATA_COVER_ORIGINS,
    sourceOriginsFor,
    type SiteSet
} from "./src/permissions"

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

const SOURCES_PKG = fileURLToPath(new URL("../../packages/sources/", import.meta.url)).replace(/\\/g, "/")
const SOURCES_SRC = `${SOURCES_PKG}src/`
const BUILD_FLAVOR = fileURLToPath(new URL("./src/build-flavor.ts", import.meta.url)).replace(/\\/g, "/")
const cleanId = (id: string) => id.replace(/\\/g, "/").split("?")[0]!
const isUnder = (dir: string) => (id: string) => cleanId(id).toLowerCase().startsWith(dir.toLowerCase())
const inSourcesPkg = isUnder(SOURCES_PKG)
const inSourcesSrc = isUnder(SOURCES_SRC)
const isBuildFlavor = (id: string) => cleanId(id).toLowerCase() === BUILD_FLAVOR.toLowerCase()
const LAB_UI = fileURLToPath(new URL("./src/lab-ui.ts", import.meta.url)).replace(/\\/g, "/")
const LAB_SAMPLE_ROW = fileURLToPath(new URL("./src/lab/LabSampleRow.svelte", import.meta.url)).replace(/\\/g, "/")
const isLabUi = (id: string) => cleanId(id).toLowerCase() === LAB_UI.toLowerCase()
// The only code modules of the sources package a shipped build may contain. A profile file (JSON with a
// `profiles` array) may also be loaded, but only emptied by stripSiteProfiles.
const SHIPPED_SOURCE_MODULES = [
    "src/index.ts",
    "src/build-scope.ts",
    "src/mangadex.ts",
    "src/webtoons.ts",
    "src/sites.ts"
]

// Hostnames no shipped file may contain: every non-official site in a profile file of the sources
// package, and every non-official site the lab-only sample library links to.
function forbiddenShippedHosts(): string[] {
    const sampleHosts = sampleEntries(0)
        .filter(entry => !OFFICIAL_SOURCE_IDS.includes(entry.sourceId))
        .flatMap(entry => [entry.chapterUrl, entry.manga.mangaUrl ?? entry.manga.sourceUrl])
        .map(url => bareHost(new URL(url).hostname))
    return [...new Set([...forbiddenPackageHosts(SOURCES_PKG, OFFICIAL_SOURCE_IDS), ...sampleHosts])]
}

// Lab-only text no shipped file may contain: the Load samples row and the sample cover file names.
function labOnlyMarkers(): string[] {
    const covers = sampleEntries(0).flatMap(entry => {
        const name = entry.manga.coverUrl?.split("/").pop()
        return name ? [name] : []
    })
    return ["Load samples", ...new Set(covers)]
}

// The site adapters live in the private site lab, a separate repository checked out as .site-lab in the
// main checkout (worktrees share it). AMR_SITE_LAB points somewhere else. Only VITE_BUNDLED=1 reads it.
function siteLabDir(): string {
    if (process.env.AMR_SITE_LAB) return process.env.AMR_SITE_LAB
    const gitDir = execSync("git rev-parse --path-format=absolute --git-common-dir", { encoding: "utf8" }).trim()
    return join(dirname(gitDir), ".site-lab")
}

function labSitesPath(): string {
    const path = join(siteLabDir(), "sources", "src", "sites.ts").replace(/\\/g, "/")
    if (!existsSync(path)) {
        throw new Error(`VITE_BUNDLED=1 needs the private site lab, and ${path} is missing (set AMR_SITE_LAB)`)
    }
    return path
}

async function labSites(): Promise<SiteSet> {
    return (await import(pathToFileURL(labSitesPath()).href)) as SiteSet
}

// The local testing build: the empty packages/sources/src/sites.ts is swapped for the lab's,
// src/build-flavor.ts says it is the lab build, and src/lab-ui.ts exports the lab's components.
function useLabSites(): Plugin {
    const lab = labSitesPath()
    return {
        name: "amr-use-lab-sites",
        enforce: "pre",
        resolveId(source, importer) {
            return source === "./sites" && !!importer && inSourcesSrc(importer) ? lab : null
        },
        load(id) {
            if (isBuildFlavor(id)) return "export const LAB_BUILD = true\n"
            if (isLabUi(id)) return `export { default as LabSampleRow } from ${JSON.stringify(LAB_SAMPLE_ROW)}\n`
            return null
        }
    }
}

// A shipped build loads every profile file of the sources package (the migration seed) with no profiles.
// Users who already have stored profiles keep them; see registerStoredRows in src/arch-sources.ts.
function stripSiteProfiles(): Plugin {
    return {
        name: "amr-strip-site-profiles",
        enforce: "pre",
        load(id) {
            const file = cleanId(id)
            if (!inSourcesPkg(file) || !file.endsWith(".json")) return null
            return emptiedProfileFile(readFileSync(file, "utf8")) ?? null
        }
    }
}

// A shipped build carries the official sources only. It fails if any other module of the sources
// package, a non-official or chapter-list profile from any of its files, anything from the site lab,
// or the hostname of any non-official profile or sample site made it into the output.
function shipOfficialSourcesOnly(): Plugin {
    const hosts = forbiddenShippedHosts()
    const markers = labOnlyMarkers()
    const leaked = new Set<string>()
    return {
        name: "amr-ship-official-sources-only",
        enforce: "pre",
        transform(code, id) {
            const file = cleanId(id)
            if (!inSourcesPkg(file) || !file.endsWith(".json")) return null
            const profiles = profilesIn(code)
            if (!profiles) return null
            for (const profileId of unshippableProfileIds(profiles, OFFICIAL_SOURCE_IDS)) {
                leaked.add(`${file.slice(SOURCES_PKG.length)} profile ${profileId}`)
            }
            return null
        },
        buildEnd(error) {
            if (error) return
            for (const file of [...this.getModuleIds()].map(cleanId)) {
                if (file.includes("/.site-lab/")) leaked.add(file)
                if (!inSourcesPkg(file)) continue
                const path = file.slice(SOURCES_PKG.length)
                const isProfileFile = path.endsWith(".json") && !!profilesIn(readFileSync(file, "utf8"))
                if (!SHIPPED_SOURCE_MODULES.includes(path) && !isProfileFile) leaked.add(path)
            }
            if (leaked.size > 0) this.error(`site code or profiles in a shipped build: ${[...leaked].join(", ")}`)
        },
        generateBundle(_options, bundle) {
            for (const output of Object.values(bundle)) {
                const text =
                    output.type === "chunk"
                        ? output.code
                        : typeof output.source === "string"
                          ? output.source
                          : new TextDecoder().decode(output.source)
                const found = hostsIn(text, hosts)
                if (found.length > 0) this.error(`${output.fileName} names non-official sites: ${found.join(", ")}`)
                const lab = labMarkersIn(text, markers)
                if (lab.length > 0) this.error(`${output.fileName} carries lab-only content: ${lab.join(", ")}`)
            }
        }
    }
}
export default defineConfig({
    manifestVersion: 3,
    modules: ["@wxt-dev/module-svelte"],
    // ARCH TRACK A: the in-app reader is retired from the shipped build. Reading happens on the
    // source's own page (see work:open-best and the on-site opens), so the store/release build
    // emits no reader.html. The reader entrypoint is kept in the tree and still built under the
    // arch flag (a sideload "Classic reader" for development), but dropped from a normal build.
    hooks: {
        "entrypoints:found": (_wxt, infos) => {
            if (process.env.VITE_ARCH_TRACK === "A") return
            const idx = infos.findIndex(e => e.name === "reader")
            if (idx !== -1) infos.splice(idx, 1)
        },
        // The fanfox-adult rule only serves those two sites, so a build without them leaves it out. The
        // sample covers belong to the lab-only sample library.
        "build:publicAssets": (_wxt, files) => {
            const dropped = (dest: string) =>
                (dest === "rules/fanfox-adult.json" && !isSourceInScope("fanfox") && !isSourceInScope("mangahere")) ||
                (dest.startsWith("sample-covers/") && !buildScope.bundled)
            for (let i = files.length - 1; i >= 0; i--) {
                if (dropped(files[i]!.relativeDest.replace(/\\/g, "/"))) files.splice(i, 1)
            }
        }
    },
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
        plugins: buildScope.bundled ? [useLabSites()] : [stripSiteProfiles(), shipOfficialSourcesOnly()],
        resolve: { dedupe: ["@amr/source-sdk", "zod"] },
        define: {
            __BUILD_ID__: JSON.stringify(BUILD_ID)
        },
        build: {
            modulePreload: false
        }
    }),
    manifest: async ({ browser }) => ({
        name: "StoryHoard",
        // Store listing text, at most 132 characters. The shipped build is a tracker with no reader, carrying
        // the official sources only; every other site is one the user adds. It also names the built-in
        // pop-under ad block (rules/popup-block.json) so the store sees it as part of the one purpose.
        description: buildScope.bundled
            ? "Track your manga and comics library. No built-in reader: official sources and sites you add. Local testing build."
            : "Track your manga and comics library. No built-in reader: follow official sources and sites you add. Blocks pop-under ads.",
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
        // downloads only serves the GitHub update download of a sideloaded Chromium copy (src/self-update.ts),
        // so it is optional and asked for in that click, and Firefox, which AMO updates, never has it. The
        // development reader build saves pages with it, so there it stays required.
        permissions: [
            "alarms",
            "declarativeNetRequest",
            ...(process.env.VITE_ARCH_TRACK === "A" ? ["downloads"] : []),
            "notifications",
            "scripting",
            "storage",
            "tabs"
        ],
        // search serves "Search the web" on a title's page, asked for in that click; it hands the title's
        // name to the browser's own default search engine.
        optional_permissions: [
            ...(browser !== "firefox" && process.env.VITE_ARCH_TRACK !== "A" ? ["downloads"] : []),
            "search"
        ],
        declarative_net_request: {
            rule_resources: [
                // Injects the isAdult=1 cookie on fanfox.net / mangahere.cc requests so
                // Mature-tagged titles return a real chapter list. Cookie is a forbidden
                // fetch header (silently dropped), so it must be set below fetch via DNR.
                ...(isSourceInScope("fanfox") || isSourceInScope("mangahere")
                    ? [{ id: "fanfox-adult", enabled: true, path: "rules/fanfox-adult.json" }]
                    : []),
                // Blocks known pop-under / redirect ad destinations (the ad/18+ sites abusive
                // scraper hosts bounce users to) at the network layer - the only thing that stops
                // a top-frame location redirect or iframe-originated open the in-page guard can't
                // reach. Seed list; extend as new destinations surface.
                { id: "popup-block", enabled: true, path: "rules/popup-block.json" }
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
            ...(buildScope.bundled ? sourceOriginsFor(await labSites(), buildScope) : ALL_OPTIONAL_ORIGINS)
        ],
        // The "Add site" flow asks the user, per click, for access to exactly one site
        // (`https://<host>/*`), and the opt-in "Detect on all sites" setting asks for the whole
        // pattern once. Chrome and Firefox only honour a runtime permissions.request for a pattern
        // the manifest declares as optional, so the declaration is https-only; it grants nothing by
        // itself. Never `*://*/*`, and no required host permission uses this wildcard.
        optional_host_permissions: [ALL_SITES_ORIGIN],
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
                          // Required: websiteContent, because library titles (text taken from
                          // the sites the user reads) are looked up on AniList automatically to
                          // fill covers, genres and status; searchTerms, because what the user
                          // types in the search popover goes to weeb.ltd's title search (and
                          // AniList when weeb.ltd can't answer). OPTIONAL: technicalAndInteraction
                          // for usage analytics and the community install ping (install id,
                          // version, feature counts); browsingActivity for the reading activity
                          // community features, weeb.ltd account sync, the GitHub gist backup and
                          // AniList list sync send (which titles and chapters were read, and when);
                          // personallyIdentifyingInfo for the community username. The community
                          // opt-in asks Firefox for its three and sends nothing without them
                          // (src/community.ts); linking an account, adding a gist token or turning on
                          // AniList list sync asks for browsingActivity, and those send nothing
                          // without it (src/sync-data-permission.ts). See src/privacy-policy.ts.
                          data_collection_permissions: {
                              required: ["websiteContent", "searchTerms"],
                              optional: ["technicalAndInteraction", "browsingActivity", "personallyIdentifyingInfo"]
                          }
                      }
                      // No gecko_android: the extension is desktop-only. Firefox for Android
                      // is deliberately NOT a target - its source-site host permissions do not
                      // grant cleanly on a fresh install, so search/read can't reach sources.
                      // The StoryHoard mobile app is the phone client (see ECO_HANDOVER §1b).
                  }
                : undefined
    })
})
