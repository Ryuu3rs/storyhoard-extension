import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { OFFICIAL_SOURCE_IDS } from "@amr/sources"
import { describe, expect, it } from "vitest"
import { sampleEntries } from "../lab/sample-library"
import {
    emptiedProfileFile,
    forbiddenPackageHosts,
    hostsIn,
    isShippableProfile,
    packageFiles,
    profilesIn,
    unshippableProfileHosts,
    unshippableProfileIds
} from "./ship-guard"

const SOURCES_PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "packages", "sources")
const profileFiles = packageFiles(SOURCES_PKG)
    .filter(file => file.endsWith(".json"))
    .map(file => ({ file, text: readFileSync(join(SOURCES_PKG, file), "utf8") }))
    .filter(({ text }) => profilesIn(text) !== undefined)

describe("the shipped build carries no site profiles", () => {
    it("finds the migration seed among the profile files of the sources package", () => {
        expect(profileFiles.map(({ file }) => file)).toContain("migration-seed.json")
    })

    it("needs the strip: the committed seed holds profiles for non-official sites", () => {
        const seed = profilesIn(profileFiles.find(({ file }) => file === "migration-seed.json")!.text)!
        expect(unshippableProfileIds(seed, OFFICIAL_SOURCE_IDS).length).toBeGreaterThan(0)
    })

    it("loads every profile file of the sources package with no profiles and its other fields kept", () => {
        for (const { file, text } of profileFiles) {
            const emptied = emptiedProfileFile(text)!
            expect(profilesIn(emptied), file).toEqual([])
            const { profiles: _dropped, ...rest } = JSON.parse(text) as Record<string, unknown>
            expect(JSON.parse(emptied), file).toMatchObject(rest)
        }
    })

    it("leaves any other JSON alone", () => {
        expect(emptiedProfileFile('{"name":"@amr/sources"}')).toBeUndefined()
        expect(emptiedProfileFile("not json")).toBeUndefined()
    })

    it("accepts only an official profile with no chapter-list rule", () => {
        expect(isShippableProfile({ id: "mangadex", domains: ["mangadex.org"] }, OFFICIAL_SOURCE_IDS)).toBe(true)
        expect(isShippableProfile({ id: "mangadex", list: {} }, OFFICIAL_SOURCE_IDS)).toBe(false)
        expect(isShippableProfile({ id: "some-site", domains: ["some-site.example"] }, OFFICIAL_SOURCE_IDS)).toBe(false)
        expect(isShippableProfile(null, OFFICIAL_SOURCE_IDS)).toBe(false)
    })
})

describe("hostnames the shipped bundle must not contain", () => {
    const forbidden = forbiddenPackageHosts(SOURCES_PKG, OFFICIAL_SOURCE_IDS)

    it("covers every domain of every non-official profile and none of the official ones", () => {
        for (const { text } of profileFiles) {
            for (const host of unshippableProfileHosts(profilesIn(text)!, OFFICIAL_SOURCE_IDS)) {
                expect(forbidden).toContain(host)
            }
        }
        expect(forbidden).not.toContain("mangadex.org")
        expect(forbidden).not.toContain("webtoons.com")
    })

    it("strips the wildcard and www prefixes", () => {
        const hosts = unshippableProfileHosts(
            [{ id: "a", domains: ["*.alpha.example", "www.beta.example", "beta.example"] }],
            OFFICIAL_SOURCE_IDS
        )
        expect(hosts).toEqual(["alpha.example", "beta.example"])
    })

    it("matches whole hostnames only", () => {
        expect(hostsIn('fetch("https://ww2.alpha.example/x")', ["alpha.example"])).toEqual(["alpha.example"])
        expect(hostsIn("ALPHA.EXAMPLE", ["alpha.example"])).toEqual(["alpha.example"])
        expect(hostsIn("alpha.examples.org notalpha.example", ["alpha.example"])).toEqual([])
    })

    it("the sample library links non-official sites, so it must stay out of the shipped build", () => {
        const unofficial = sampleEntries(0).filter(entry => !OFFICIAL_SOURCE_IDS.includes(entry.sourceId))
        expect(unofficial.length).toBeGreaterThan(0)
    })
})
