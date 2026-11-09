import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// App.svelte is not mounted under vitest, so these pin the import/restore wiring at source level.
const app = readFileSync(fileURLToPath(new URL("../entrypoints/app/App.svelte", import.meta.url)), "utf8")

function fnBody(name: string): string {
    const start = app.indexOf(`function ${name}(`)
    expect(start).toBeGreaterThan(-1)
    const next = app.indexOf("\n    async function ", start + 1)
    const nextSync = app.indexOf("\n    function ", start + 1)
    const end = Math.min(...[next, nextSync].filter(i => i > -1))
    return app.slice(start, end)
}

describe("App import and restore wiring", () => {
    it("defaults import conflicts to merge, matching the backend", () => {
        const body = fnBody("processImport")
        expect(body).toContain('"merge" as ImportResolution')
        expect(body).not.toContain('"overwrite" as ImportResolution')
    })

    it("opens the reader target only through the http(s) gate", () => {
        const body = fnBody("openInReader")
        expect(body).not.toContain("browser.tabs.create")
        expect(body).toContain("openExternal(")
    })

    it("reports skipped records after an import and a restore", () => {
        expect(fnBody("applyImport")).toMatch(/skipped/)
        expect(fnBody("applyImport")).toMatch(/result\.skipped/)
        expect(fnBody("restoreBackupById")).toMatch(/skipped/)
    })
})
