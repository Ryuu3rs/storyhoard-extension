import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { PRIVACY_POLICY } from "./privacy-policy"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const policyText = (heading: string) =>
    PRIVACY_POLICY.filter(section => section.heading.startsWith(heading))
        .flatMap(section => section.body)
        .join(" ")

function shippedSources(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) return shippedSources(path)
        return /\.(ts|svelte)$/.test(name) && !name.endsWith(".test.ts") ? [path] : []
    })
}

describe("privacy policy: usage analytics", () => {
    it("says Chrome is on by default with no prompt, and Firefox follows its data permission", () => {
        const text = policyText("Usage analytics")
        expect(text).toContain("there is no prompt for it")
        expect(text).toContain("On Chrome it is on by default from install")
        expect(text).toContain("On Firefox it runs only while Firefox's data-collection permission allows it")
        expect(text).not.toContain("first-run")
    })

    it("no shipped code keeps a first-run analytics choice that nothing ever records", () => {
        const offenders = [...shippedSources(join(ROOT, "src")), ...shippedSources(join(ROOT, "entrypoints"))].filter(
            file => readFileSync(file, "utf8").includes("usageAnalyticsChoice")
        )
        expect(offenders).toEqual([])
    })
})
