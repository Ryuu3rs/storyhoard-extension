import { parseHTML } from "linkedom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { injectChapterPrompt } from "./inject-chapter-prompt"

// Same live-DOM harness as inject-chapter-prompt.test.ts ("the panel in a page that is out to misuse it").
const PAGE = "https://reader.example/manga/demo/chapter-3"
const HOST_ID = "__amr-chapter-prompt__"
type Root = { querySelector(s: string): any; querySelectorAll(s: string): any; elementFromPoint?: unknown }

let panelRoot: Root | undefined
let restoreAttach: (() => void) | undefined

function installDom() {
    const { document, HTMLAnchorElement, HTMLOptionElement, Event } = parseHTML(
        `<!doctype html><html><head><title>Demo chapter 3</title></head><body><div class="reading-content"></div></body></html>`
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
                      data: { mangaId: null, prevUrl: null, nextUrl: null, mangaTitle: null, chapterTitle: null }
                  }
                : { ok: false }
        )
    )
    vi.stubGlobal("chrome", { runtime: { sendMessage, getURL: (p: string) => `chrome-extension://id/${p}` } })
    return document
}

const headings = () =>
    [...(panelRoot!.querySelectorAll("div.title") as Iterable<{ textContent: string }>)].map(n => n.textContent)
const button = (text: string) =>
    [...(panelRoot!.querySelectorAll("button") as Iterable<{ textContent: string }>)].find(
        b => b.textContent === text
    ) as unknown as { dispatchEvent(e: unknown): unknown }

beforeEach(() => {
    vi.useFakeTimers()
    panelRoot = undefined
})
afterEach(() => {
    restoreAttach?.()
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

describe("panel heading after a manual retry on a followed site with auto-add off", () => {
    it("moves off 'Couldn't read the chapter list' once the retry finds the page's own navigation", async () => {
        const document = installDom()
        injectChapterPrompt(PAGE, [], undefined, null, "followed", null)
        // Every bounded rescan finds nothing: the panel gives up.
        await vi.advanceTimersByTimeAsync(61_000)
        expect(headings()).toContain("Couldn't read the chapter list")

        // The site's script draws its chapter navigation late; the user presses Try again.
        const next = document.createElement("a")
        next.setAttribute("href", "/manga/demo/chapter-4")
        next.textContent = "Next"
        document.body.appendChild(next)
        button("Try again").dispatchEvent({
            type: "click",
            isTrusted: true,
            detail: 1,
            clientX: 40,
            clientY: 15,
            bubbles: false,
            _path: []
        })
        await vi.advanceTimersByTimeAsync(1_100)

        // The panel is now tracking the page (handle and footer say so), so the heading must name the page.
        const shadowText = [...(panelRoot!.querySelectorAll("*") as Iterable<{ textContent: string }>)]
            .map(n => n.textContent)
            .join("|")
        expect(shadowText).toContain("tracking this page")
        expect(headings()).not.toContain("Couldn't read the chapter list")
        expect(headings()).toContain("Demo chapter 3")
    })
})
