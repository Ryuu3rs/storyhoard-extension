import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { CONSENT_SUMMARY, DATA_COLLECTED, PRIVACY_POLICY, USAGE_ANALYTICS_LINE } from "./privacy-policy"

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

const ANALYTICS_LINE = "We collect anonymous usage stats. Turn them on or off in Settings."

describe("privacy policy: usage analytics", () => {
    it("says exactly one line about usage analytics", () => {
        expect(USAGE_ANALYTICS_LINE).toBe(ANALYTICS_LINE)
        const sections = PRIVACY_POLICY.filter(section => section.heading === "Usage analytics")
        expect(sections).toEqual([{ heading: "Usage analytics", body: [ANALYTICS_LINE] }])
    })

    it("has no other analytics wording anywhere in the policy", () => {
        const rest = PRIVACY_POLICY.filter(section => section.heading !== "Usage analytics")
            .flatMap(section => section.body)
            .join(" ")
        for (const phrase of [
            /analytics install id/i,
            /device link\)?, so the usage/i,
            /usage analytics/i,
            /usage counts/i,
            /one-time notice/i,
            /counted while/i,
            /discards everything/i,
            /counts which titles are searched/i
        ]) {
            expect(rest).not.toMatch(phrase)
        }
    })

    it("promises only the re-prompts the app actually shows", () => {
        const text = policyText("Age, contact, and changes")
        expect(text).not.toContain("review and accept the new version")
        expect(text).toContain("community features ask for your consent again")
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

    it("says the where-to-read lookup also runs for a title opened from Discover", () => {
        expect(policyText("Title lookups")).toContain("When you open a title from search or Discover")
    })

    it("says the GitHub backup carries private notes, ratings and flags", () => {
        expect(policyText("Backups and list sync")).toContain("private notes, ratings and flags")
    })

    it("says Discover may send the genres you read most to AniList", () => {
        expect(policyText("Title lookups")).toContain("may send the genres you read most")
    })

    it("says a title search and an opened result also go to the official sources StoryHoard includes", () => {
        const text = policyText("Title lookups")
        expect(text).toContain("The same words also go, straight from your browser, to the official sources")
        expect(text).toContain("opening a result sends its title to them too")
        expect(policyText("We never sell your data")).toContain("the official sources StoryHoard includes")
    })

    it("says the Sources page pings every listed site, not only tracked ones", () => {
        const text = policyText("Requests to the sites you track")
        expect(text).toContain("Opening the Sources page sends a short request to the home page of every site")
        expect(text).toContain("that you may not track")
    })

    it("does not say detected titles never leave the device while they go through title lookups", () => {
        const text = policyText("Detect on all sites")
        expect(text).not.toMatch(/They stay on your device, and/)
        expect(text).toContain("stay on your device, apart from the title lookups above")
    })

    it("says the AniList import reads the user's list", () => {
        expect(policyText("Backups and list sync")).toContain("reads your AniList list with that token")
    })

    // No route removes the community link on unlink; only deleting the weeb.ltd account does.
    it("does not promise that unlinking removes the community tie", () => {
        const text = policyText("Account sync")
        expect(text).not.toMatch(/unlinking or deleting the account removes the tie/i)
        expect(text).toContain("Unlinking does not remove the tie")
        expect(text).toContain("Deleting your weeb.ltd account removes it")
    })

    it("does not say the community username is one you choose: a random one is assigned", () => {
        expect(DATA_COLLECTED.join(" ")).not.toContain("A username you choose")
        expect(DATA_COLLECTED.join(" ")).toContain("a random one is assigned")
    })

    it("names the browser's search engine among the outside services", () => {
        expect(policyText("We never sell your data")).toContain(
            "your browser's search engine (only when you click Search the web)"
        )
    })
})

describe("community consent card", () => {
    it("is about community only, short, and says it is opt-in", () => {
        expect(CONSENT_SUMMARY).not.toMatch(/anonymous|usage|analytics/i)
        expect(CONSENT_SUMMARY).toContain("reading activity and a username")
        expect(CONSENT_SUMMARY).toContain("Opt-in")
        expect(CONSENT_SUMMARY.length).toBeLessThanOrEqual(140)
    })
})
