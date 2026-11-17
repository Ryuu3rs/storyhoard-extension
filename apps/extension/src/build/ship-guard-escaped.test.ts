import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { OFFICIAL_SOURCE_IDS } from "@amr/sources"
import { describe, expect, it } from "vitest"
import { forbiddenPackageHosts, hostsIn } from "./ship-guard"

// The shipped-build guard (wxt.config.ts generateBundle) fails the build when an output file names a
// non-official site. Minification keeps a host written inside a regex or an escaped string verbatim, so
// the guard has to read those forms too.

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCES_PKG = join(HERE, "../../../../packages/sources")

describe("ship guard host matching", () => {
    it("catches a forbidden host written as an escaped regex literal", () => {
        const minified = "(function(){if(!/(^|\\.)seed-host\\.to$/i.test(location.hostname))return})()"
        expect(hostsIn(minified, ["seed-host.to"])).toEqual(["seed-host.to"])
    })

    it("catches the other escaped forms minified code keeps", () => {
        for (const text of [
            'new RegExp("seed-host\\\\.to")',
            "/seed-host[.]to/",
            "/seed-host[\\.]to/",
            '"seed-host\\x2eto"',
            '"seed-host\\u002eto"',
            "/seed\\-host\\.to/"
        ]) {
            expect(hostsIn(text, ["seed-host.to"]), text).toEqual(["seed-host.to"])
        }
    })

    it("still matches only a whole host", () => {
        expect(hostsIn("/seed-host\\.tools/", ["seed-host.to"])).toEqual([])
        expect(hostsIn("/myseed-host\\.to/", ["seed-host.to"])).toEqual([])
    })

    it("the panel source names no seed host in any form", () => {
        const forbidden = forbiddenPackageHosts(SOURCES_PKG, OFFICIAL_SOURCE_IDS)
        expect(forbidden.length).toBeGreaterThan(0)
        const shipped = readFileSync(join(HERE, "../background/inject-chapter-prompt.ts"), "utf8")
        expect(hostsIn(shipped, forbidden)).toEqual([])
    })
})
