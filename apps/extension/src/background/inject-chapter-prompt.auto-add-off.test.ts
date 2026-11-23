import { parseHTML } from "linkedom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { injectChapterPrompt } from "./inject-chapter-prompt"

// Same live-DOM harness as inject-chapter-prompt.test.ts ("the panel in a page that is out to misuse it").
const PAGE = "https://reader.example/manga/demo/chapter-3"
const HOST_ID = "__amr-chapter-prompt__"
type Root = { querySelector(s: string): any; querySelectorAll(s: string): any; elementFromPoint?: unknown }

let panelRoot: Root | undefined
let restoreAttach: (() => void) | undefined

const WITH_NAVIGATION = `<nav><a rel="prev" href="/manga/demo/chapter-2">Prev</a><a rel="next" href="/manga/demo/chapter-4">Next</a></nav><select class="chapter-select"><option value="/manga/demo/chapter-2">Chapter 2</option><option value="/manga/demo/chapter-3" selected>Chapter 3</option><option value="/manga/demo/chapter-4">Chapter 4</option></select>`

function installDom(extraBody: string) {
    const { document, HTMLAnchorElement, HTMLOptionElement, Event } = parseHTML(
        `<!doctype html><html><head><title>Demo chapter 3</title></head><body><div class="reading-content"></div>${extraBody}</body></html>`
    )
    let proto = Object.getPrototypeOf(document.createElement("div"))
    while (proto && !Object.prototype.hasOwnProperty.call(proto, "attachShadow")) proto = Object.getPrototypeOf(proto)
    const elementProto = proto as { attachShadow(init: { mode: string }): Root; getBoundingClientRect?: unknown }
    const original = elementProto.attachShadow
    const originalRect = elementProto.getBoundingClientRect
    elementProto.attachShadow = function (this: unknown, init: { mode: string }) {
        panelRoot = original.call(this, init)
        return panelRoot
    }
    elementProto.getBoundingClientRect = () => ({ x: 0, y: 0, width: 80, height: 30, top: 0, left: 0 })
    restoreAttach = () => {
        elementProto.attachShadow = original
        elementProto.getBoundingClientRect = originalRect
    }
    ;(document as unknown as Record<string, unknown>)["elementFromPoint"] = () => document.getElementById(HOST_ID)
    vi.stubGlobal("window", {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        setInterval: globalThis.setInterval,
        clearInterval: globalThis.clearInterval,
        innerHeight: 800,
        innerWidth: 1200,
        scrollY: 0,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        open: () => null,
        location: { href: PAGE }
    })
    vi.stubGlobal("document", document)
    vi.stubGlobal("location", { href: PAGE, origin: "https://reader.example" })
    vi.stubGlobal("navigator", { userActivation: { isActive: false } })
    vi.stubGlobal("HTMLAnchorElement", HTMLAnchorElement)
    vi.stubGlobal("HTMLOptionElement", HTMLOptionElement)
    vi.stubGlobal("Event", Event)
    vi.stubGlobal("getComputedStyle", () => ({
        backgroundColor: "rgb(20, 20, 20)",
        color: "",
        position: "static",
        opacity: "1",
        visibility: "visible",
        filter: "none",
        mixBlendMode: "normal",
        maskImage: "none"
    }))
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => setTimeout(fn, 0))
    // A followed site with auto-add off: the background keeps no title for this page, so siblings name none.
    const sendMessage = vi.fn((message: { type: string }) =>
        Promise.resolve(
            message.type === "chapter:siblings"
                ? {
                      ok: true,
                      data: {
                          mangaId: null,
                          prevUrl: null,
                          nextUrl: null,
                          mangaTitle: null,
                          chapterTitle: null,
                          autoAdd: false
                      }
                  }
                : { ok: false }
        )
    )
    vi.stubGlobal("chrome", { runtime: { sendMessage, getURL: (p: string) => `chrome-extension://id/${p}` } })
    return document
}

const headings = () =>
    [...(panelRoot!.querySelectorAll("div.title") as Iterable<{ textContent: string }>)].map(n => n.textContent)
const retryShown = () =>
    [...(panelRoot!.querySelectorAll("button") as Iterable<{ textContent: string; hidden: boolean }>)].some(
        b => b.textContent === "Try again" && !b.hidden
    )
const panelText = () =>
    [...(panelRoot!.querySelectorAll("*") as Iterable<{ textContent: string }>)].map(n => n.textContent).join("|")

beforeEach(() => {
    vi.useFakeTimers()
    panelRoot = undefined
})
afterEach(() => {
    restoreAttach?.()
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

describe("followed site with auto-add off: no title is kept, so no list read can fail", () => {
    it("stays on 'tracking this page' when the page shows prev/next links and a chapter select", async () => {
        installDom(WITH_NAVIGATION)
        injectChapterPrompt(PAGE, [], undefined, null, "followed", null)
        await vi.advanceTimersByTimeAsync(5_000)
        expect(panelText()).toContain("tracking this page")
        // Nothing about the page or the site changes; only the bounded rescans run out.
        await vi.advanceTimersByTimeAsync(61_000)
        expect(panelText()).not.toContain("couldn't read the chapter list")
        expect(panelText()).toContain("tracking this page")
        expect(retryShown()).toBe(false)
    })

    it("names the page instead of reporting a failed read when the page has no navigation either", async () => {
        installDom("")
        injectChapterPrompt(PAGE, [], undefined, null, "followed", null)
        await vi.advanceTimersByTimeAsync(61_000)
        expect(panelText()).toContain("tracking this page")
        expect(headings()).toContain("Demo chapter 3")
        expect(headings()).not.toContain("Couldn't read the chapter list")
        expect(retryShown()).toBe(false)
    })
})
