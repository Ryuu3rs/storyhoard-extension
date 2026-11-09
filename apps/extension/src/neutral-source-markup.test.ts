import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const FILES = [
    "../entrypoints/app/App.svelte",
    "../entrypoints/app/FindSource.svelte",
    "../entrypoints/app/ImportReconcile.svelte",
    "../entrypoints/popup/App.svelte",
    "../entrypoints/reader/App.svelte"
]

function markupOf(source: string): string {
    return source.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "")
}

// Text interpolations that would print a raw source id to the user. An attribute value (`value={sid}`,
// `data-source={...}`) is a use of the id, not something rendered, so a brace directly after `=` is skipped.
function bareSourceIdInterpolations(markup: string): string[] {
    const found: string[] = []
    const re = /(.)\{([^{}]*)\}/g
    for (const match of markup.matchAll(re)) {
        const [, before, rawExpression] = match
        const expression = (rawExpression ?? "").trim()
        if (before === "=" || /^[#:@/]/.test(expression)) continue
        const bareIdentifier = /^(?:[\w$?]+\.)*(?:sourceId|sid|source)$/.test(expression)
        const printsId =
            /sourceId/.test(expression) && !/sourceName\(|label/i.test(expression) && !/[=!]==?/.test(expression)
        if (bareIdentifier || printsId) found.push(`{${expression}}`)
    }
    return found
}

describe("neutral source names in markup", () => {
    for (const file of FILES) {
        it(`${file.replace("../entrypoints/", "")} never renders a bare source id`, () => {
            const markup = markupOf(readFileSync(resolve(__dirname, file), "utf8"))
            expect(bareSourceIdInterpolations(markup)).toEqual([])
        })
    }

    it("the detector flags the interpolations the app used to render", () => {
        expect(bareSourceIdInterpolations("<p>{detailManga.sourceId} · {detailManga.status}</p>")).toEqual([
            "{detailManga.sourceId}"
        ])
        expect(bareSourceIdInterpolations('<span class="x">{s.sourceId}</span>')).toEqual(["{s.sourceId}"])
        expect(bareSourceIdInterpolations("<span>{source}</span><span>{sid}</span>")).toEqual(["{source}", "{sid}"])
        expect(bareSourceIdInterpolations('<span>{group.map(m => m.sourceId).join(", ")}</span>')).toHaveLength(1)
    })

    it("the detector allows labelled output and attribute uses", () => {
        expect(bareSourceIdInterpolations("<p>{sourceName(detailManga.sourceId)}</p>")).toEqual([])
        expect(bareSourceIdInterpolations("<option value={sid}>{sourceName(sid)}</option>")).toEqual([])
        expect(bareSourceIdInterpolations("<li data-source={manga.sourceId}></li>")).toEqual([])
        expect(bareSourceIdInterpolations("{#each searchBySource as [sourceId, results]}")).toEqual([])
    })
})
