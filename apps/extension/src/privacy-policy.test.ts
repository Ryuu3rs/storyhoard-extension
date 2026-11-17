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
    it("says it is on by default, sends nothing before its notice, and Firefox follows its data permission", () => {
        const text = policyText("Usage analytics")
        expect(text).toContain("on by default")
        expect(text).toContain("nothing is sent until the app has shown you a one-time notice")
        expect(text).toContain("Firefox's data-collection permission allows it")
        expect(text).not.toContain("there is no prompt")
    })

    it("names the analytics install id and says a linked account ties the counts to it", () => {
        const text = policyText("Usage analytics")
        expect(text).toContain("random analytics install id")
        expect(text).toContain("tied to your account")
        expect(text).not.toMatch(/anonymous usage/i)
    })

    it("does not promise the extension stops on the account opt-out, only that weeb.ltd discards it", () => {
        const text = policyText("Usage analytics")
        expect(text).toContain("weeb.ltd discards everything a linked browser sends")
        expect(text).toContain("never sent, even if you turn it back on later")
    })

    it("promises only the re-prompts the app actually shows", () => {
        const text = policyText("Age, contact, and changes")
        expect(text).not.toContain("review and accept the new version")
        expect(text).toContain("usage analytics shows its notice")
    })

    it("no shipped code keeps a first-run analytics choice that nothing ever records", () => {
        const offenders = [...shippedSources(join(ROOT, "src")), ...shippedSources(join(ROOT, "entrypoints"))].filter(
            file => readFileSync(file, "utf8").includes("usageAnalyticsChoice")
        )
        expect(offenders).toEqual([])
    })
})

describe("privacy policy: what the build actually does", () => {
    it("discloses the ad-redirect block list and that it records nothing", () => {
        const text = policyText("Blocked ad redirects")
        expect(text).toContain("blocks pages, frames, scripts and requests to them on every site")
        expect(text).toContain("nothing about the pages you visit is recorded or sent anywhere")
    })

    it("says lookups send AniList ids for Discover, not the title only", () => {
        const text = policyText("Title lookups")
        expect(text).not.toContain("the title only")
        expect(text).toContain("AniList ids of titles in your library")
    })

    it("discloses the per-site session cookie option", () => {
        expect(policyText("Requests to the sites you track")).toContain("'Use my browser session'")
    })

    it("discloses the where-to-read lookup sending the chosen title's id", () => {
        expect(policyText("Title lookups")).toContain("sending that title's catalog id")
    })

    it("lists everything account sync sends, the wallet call, and the Firefox permission", () => {
        const text = policyText("Account sync")
        for (const field of ["publishing status", "latest chapter number", "on hold", "track it by hand"]) {
            expect(text).toContain(field)
        }
        expect(text).toContain("Scales balance")
        expect(text).toContain("permission to send browsing activity")
    })

    it("discloses the Discover lists from weeb.ltd and the web search hand-off", () => {
        const text = policyText("Title lookups")
        expect(text).toContain("Discover also loads public lists from weeb.ltd")
        expect(text).toContain("send no cookies and nothing about you or your library")
        expect(text).toContain("your browser's own search engine")
        expect(text).toContain("only when you click it")
    })

    it("lists the reachability request to weeb.ltd on each app open", () => {
        expect(policyText("Other requests")).toContain("each time you open the app it sends an empty request")
    })

    it("does not list the chapters you read as never collected, since community and sync send them", () => {
        const never = policyText("What never leaves your device")
        expect(never).not.toMatch(/- The pages and chapters you read/)
        expect(never).toContain("The content of the pages and chapters you read")
    })
})
