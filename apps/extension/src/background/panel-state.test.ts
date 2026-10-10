import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { panelStateText, selectPanelState, type PanelMode, type PanelState, type PanelStateInput } from "./panel-state"

const base: PanelStateInput = {
    mode: "followed",
    labelResolved: false,
    listCount: 1,
    mangaResolved: false,
    hasNeighbour: false,
    backoffExhausted: false
}
const state = (patch: Partial<PanelStateInput>): PanelState => selectPanelState({ ...base, ...patch })

describe("selectPanelState", () => {
    it("never claims success before anything resolves", () => {
        for (const mode of ["followed", "detected", "official"] as PanelMode[]) {
            expect(state({ mode })).toBe("detecting")
        }
    })

    it("a resolved followed site is followed, a resolved detected site needs a follow", () => {
        expect(state({ mode: "followed", mangaResolved: true })).toBe("followed")
        expect(state({ mode: "followed", listCount: 12 })).toBe("followed")
        expect(state({ mode: "detected", mangaResolved: true })).toBe("needs-follow")
        expect(state({ mode: "detected", listCount: 12 })).toBe("needs-follow")
    })

    it("the lone 'This chapter' placeholder is not a resolved list", () => {
        expect(state({ listCount: 1 })).toBe("detecting")
    })

    it("a partial read (a prev/next link or a label) is tracking-page while retries remain", () => {
        expect(state({ hasNeighbour: true })).toBe("tracking-page")
        expect(state({ mode: "detected", hasNeighbour: true })).toBe("tracking-page")
        expect(state({ labelResolved: true })).toBe("tracking-page")
    })

    it("an exhausted backoff that never resolved is couldnt-read-list, even with a stray neighbour link", () => {
        expect(state({ backoffExhausted: true })).toBe("couldnt-read-list")
        expect(state({ backoffExhausted: true, hasNeighbour: true })).toBe("couldnt-read-list")
        expect(state({ mode: "detected", backoffExhausted: true })).toBe("couldnt-read-list")
    })

    it("an exhausted backoff does not undo a resolved panel", () => {
        expect(state({ backoffExhausted: true, mangaResolved: true })).toBe("followed")
        expect(state({ mode: "detected", backoffExhausted: true, mangaResolved: true })).toBe("needs-follow")
    })

    it("an official site has no list to read, so it is only ever detecting or tracking-page", () => {
        expect(state({ mode: "official" })).toBe("detecting")
        expect(state({ mode: "official", mangaResolved: true })).toBe("tracking-page")
        expect(state({ mode: "official", backoffExhausted: true })).toBe("tracking-page")
        expect(state({ mode: "official", labelResolved: true })).toBe("tracking-page")
    })
})

describe("panelStateText", () => {
    it("never reads 'Tracking' or 'tracked by StoryHoard' unless the panel actually resolved", () => {
        for (const s of ["detecting", "tracking-page", "needs-follow", "couldnt-read-list"] as PanelState[]) {
            const text = panelStateText(s, "")
            expect(text.handle).not.toBe("Tracking")
            expect(text.footer).not.toBe("tracked by StoryHoard")
        }
        expect(panelStateText("followed", "")).toMatchObject({ handle: "Tracking", footer: "tracked by StoryHoard" })
    })

    it("prefers the resolved chapter label for the handle", () => {
        expect(panelStateText("followed", "Chapter 12").handle).toBe("Chapter 12")
        expect(panelStateText("needs-follow", "Chapter 12").handle).toBe("Chapter 12")
    })

    it("offers a retry only when the list could not be read", () => {
        expect(panelStateText("couldnt-read-list", "Chapter 12")).toMatchObject({
            handle: "Couldn't read list",
            retry: true
        })
        for (const s of ["detecting", "tracking-page", "followed", "needs-follow"] as PanelState[]) {
            expect(panelStateText(s, "").retry).toBe(false)
        }
    })

    it("carries no long dash", () => {
        for (const s of ["detecting", "tracking-page", "followed", "needs-follow", "couldnt-read-list"] as const) {
            const { handle, footer } = panelStateText(s, "")
            expect(handle + footer).not.toMatch(/[--]/)
        }
    })
})

// The panel is serialised into the page and cannot import these, so it carries inline copies. Any
// edit to one without the other would make the page and the tests disagree.
describe("the inline copies in the panel match the exported helpers", () => {
    const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8")
    const panel = read("./inject-chapter-prompt.ts")
    const helpers = read("./panel-state.ts")

    function functionText(source: string, name: string): string {
        const start = source.indexOf(`function ${name}(`)
        expect(start, `${name} not found`).toBeGreaterThan(-1)
        const open = source.indexOf("{", source.indexOf("):", start))
        let depth = 0
        for (let i = open; i < source.length; i++) {
            if (source[i] === "{") depth++
            else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1).replace(/\s+/g, "")
        }
        throw new Error(`${name} is not closed`)
    }

    for (const name of ["selectPanelState", "panelStateText"]) {
        it(name, () => {
            expect(functionText(panel, name)).toBe(functionText(helpers, name))
        })
    }
})
