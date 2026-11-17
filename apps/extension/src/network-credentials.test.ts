import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// Every request the extension makes sends no cookies unless it is on the short list below, where a cookie is
// part of what the user asked for. A cookie would tie the request to whatever session the browser holds for
// that host (a signed-in weeb.ltd, GitHub or AniList tab), which the privacy policy says these never carry.
const COOKIES_ALLOWED: Record<string, string> = {
    // The per-site "send my cookies" option: the user turned it on for that site, and the site's own
    // fetch decides between "include" and "omit".
    "src/sources.ts": "per-site session option",
    // The one-time link handoff from a signed-in weeb.ltd page.
    "src/account.ts#/api/ext/redeem": "account link handoff",
    // Pass-throughs into catalog-search, whose own calls set credentials themselves.
    "src/handlers/library.ts": "pass-through to catalog-search",
    "src/handlers/resolve-sources.ts": "pass-through to catalog-search",
    // Page downloads of the local reader build, never in the store build.
    "src/handlers/downloads-bookmarks-analytics.ts": "local reader build only"
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

function files(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) return name === "node_modules" ? [] : files(path)
        return /\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : []
    })
}

function callAt(text: string, start: number): string {
    let depth = 0
    for (let i = start; i < text.length; i++) {
        if (text[i] === "(") depth++
        else if (text[i] === ")" && --depth === 0) return text.slice(start, i + 1)
    }
    return text.slice(start)
}

const calls = ["src", "entrypoints"].flatMap(dir =>
    files(join(ROOT, dir)).flatMap(path => {
        const file = relative(ROOT, path).split(sep).join("/")
        const text = readFileSync(path, "utf8")
        return [...text.matchAll(/\bfetch\(/g)].map(match => ({ file, call: callAt(text, match.index + 5) }))
    })
)

describe("network requests carry no cookies", () => {
    it("finds the requests it is meant to check", () => {
        expect(calls.length).toBeGreaterThan(15)
    })

    it("sets credentials omit on every request not on the allowed list", () => {
        const allowed = (file: string, call: string) =>
            COOKIES_ALLOWED[file] !== undefined ||
            Object.keys(COOKIES_ALLOWED).some(key => {
                const [keyFile, marker] = key.split("#")
                return marker !== undefined && keyFile === file && call.includes(marker)
            })
        const offenders = calls
            .filter(({ file, call }) => !allowed(file, call) && !/credentials:\s*"omit"/.test(call))
            .map(({ file, call }) => `${file}: fetch${call.slice(0, 80)}`)
        expect(offenders).toEqual([])
    })
})
