import { parseHTML } from "linkedom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { injectChapterPrompt } from "./inject-chapter-prompt"

// Same harness as the "out to misuse it" block in inject-chapter-prompt.test.ts. Hit testing is modelled the
// way a real browser does it: an element with pointer-events:none is skipped by both the click and
// document.elementFromPoint, so the click lands on the panel and elementFromPoint names the panel host, even
// though the page's own opaque element is painted on top of the control. In real Chromium a
// pointer-events:none "Close ad" box drawn over the panel's old Track button sent source:add-from-tab, which
// is why following now lives in the toolbar popup only.
describe("a page overlay that ignores the pointer", () => {
    const PAGE = "https://reader.example/manga/demo/chapter-3"
    const HOST_ID = "__amr-chapter-prompt__"
    type Root = { querySelector(s: string): any; querySelectorAll(s: string): any; elementFromPoint?: unknown }

    let sendMessage: ReturnType<typeof vi.fn>
    let panelRoot: Root | undefined
    let restoreAttach: (() => void) | undefined
    let decoyStyle: Record<string, string> | undefined

    function installDom() {
        const { document, HTMLAnchorElement, HTMLOptionElement, Event } = parseHTML(
            `<!doctype html><html><head><title>Demo chapter 3</title></head><body><div class="reading-content"></div></body></html>`
        )
        const elementProto = (() => {
            let proto = Object.getPrototypeOf(document.createElement("div"))
            while (proto && !Object.prototype.hasOwnProperty.call(proto, "attachShadow")) {
                proto = Object.getPrototypeOf(proto)
            }
            return proto as { attachShadow(init: { mode: string }): Root; getBoundingClientRect?: unknown }
        })()
        const original = elementProto.attachShadow
        const originalRect = elementProto.getBoundingClientRect
        elementProto.attachShadow = function (this: unknown, init: { mode: string }) {
            panelRoot = original.call(this, init)
            return panelRoot
        }
        // Every element, the page's decoy included, sits on the same 80x30 box at the top left.
        elementProto.getBoundingClientRect = () => ({
            x: 0,
            y: 0,
            width: 80,
            height: 30,
            top: 0,
            left: 0,
            right: 80,
            bottom: 30
        })
        restoreAttach = () => {
            elementProto.attachShadow = original
            elementProto.getBoundingClientRect = originalRect
        }
        const doc = document as unknown as Record<string, unknown>
        // pointer-events:none takes the decoy out of hit testing, so the browser names the panel host.
        doc["elementFromPoint"] = () => document.getElementById(HOST_ID)
        doc["elementsFromPoint"] = () => [document.getElementById(HOST_ID), document.body, document.documentElement]
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
        vi.stubGlobal("getComputedStyle", (node: { id?: string; className?: string }) => ({
            backgroundColor: "rgb(20, 20, 20)",
            color: "",
            position: "static",
            opacity: "1",
            visibility: "visible",
            filter: "none",
            mixBlendMode: "normal",
            maskImage: "none",
            pointerEvents: "auto",
            zIndex: "auto",
            ...(node?.className === "decoy" ? (decoyStyle ?? {}) : {})
        }))
        vi.stubGlobal("requestAnimationFrame", (fn: () => void) => setTimeout(fn, 0))
        sendMessage = vi.fn((message: { type: string }) =>
            Promise.resolve(
                message.type === "chapter:siblings"
                    ? { ok: true, data: { mangaId: "victim:manga:demo", prevUrl: null, nextUrl: null } }
                    : { ok: false }
            )
        )
        vi.stubGlobal("chrome", { runtime: { sendMessage, getURL: (p: string) => `chrome-extension://id/${p}` } })
        return document
    }

    function userClick(target: { dispatchEvent(e: unknown): unknown }) {
        target.dispatchEvent({
            type: "click",
            isTrusted: true,
            detail: 1,
            clientX: 40,
            clientY: 15,
            bubbles: false,
            _path: []
        })
    }

    const button = (text: string) =>
        [...(panelRoot!.querySelectorAll("button") as Iterable<{ textContent: string }>)].find(
            b => b.textContent === text
        ) as unknown as { click(): void; dispatchEvent(e: unknown): unknown }
    const sentOfType = (type: string) =>
        sendMessage.mock.calls.map(call => call[0] as { type: string }).filter(message => message.type === type)

    beforeEach(() => {
        vi.useFakeTimers()
        panelRoot = undefined
        decoyStyle = undefined
    })
    afterEach(() => {
        restoreAttach?.()
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    // The page appends, after the panel host, an opaque box over the Track button that reads "Close ad", on
    // top (same max z-index, later in the document) and transparent to the pointer. The user clicks "Close ad".
    function coverWithBait(document: ReturnType<typeof installDom>) {
        const decoy = document.createElement("div")
        decoy.className = "decoy"
        decoy.textContent = "Close ad"
        decoyStyle = {
            position: "fixed",
            zIndex: "2147483647",
            backgroundColor: "rgb(255, 255, 255)",
            opacity: "1",
            pointerEvents: "none"
        }
        document.body.appendChild(decoy)
    }

    it("has no control that follows the site, so no bait over the panel can follow it", () => {
        const document = installDom()
        injectChapterPrompt(PAGE, [], undefined, null, "detected", null)
        expect(button("Track this site")).toBeUndefined()
        coverWithBait(document)
        sendMessage.mockClear()
        for (const control of [...(panelRoot!.querySelectorAll("button") as Iterable<unknown>)]) {
            panelRoot!.elementFromPoint = () => control
            userClick(control as { dispatchEvent(e: unknown): unknown })
        }
        expect(sentOfType("source:add-from-tab")).toHaveLength(0)
    })

    it("does not add a title past the auto-add setting and caps through the same bait over Mark read", () => {
        const document = installDom()
        injectChapterPrompt(PAGE, [], undefined, null, "detected", null)
        const mark = button("Mark read")
        panelRoot!.elementFromPoint = () => mark
        coverWithBait(document)
        sendMessage.mockClear()
        userClick(mark)
        const sent = sentOfType("work:track-detected")
        expect(sent).toHaveLength(1)
        expect(sent[0]).toMatchObject({ url: PAGE, markRead: true })
        expect(sent[0]).not.toHaveProperty("explicit")
    })

    it("does not let a planted element of the same mode keep the panel from appearing", () => {
        const document = installDom()
        const planted = document.createElement("div")
        planted.id = HOST_ID
        planted.setAttribute("data-amr-mode", "detected")
        document.body.appendChild(planted)
        injectChapterPrompt(PAGE, [], undefined, null, "detected", null)
        expect(panelRoot).toBeDefined()
        expect(button("Mark read")).toBeDefined()
        expect(document.getElementById(HOST_ID)).not.toBe(planted)
    })

    it("does not come up already open because the page planted an element with the panel's id", () => {
        // The panel reads data-amr-open from whatever element holds its id, so a page that plants
        // <div id="__amr-chapter-prompt__" data-amr-mode="followed" data-amr-open="1"> before injection gets the
        // real panel opened with no click on the handle, and the bait above then needs only one click.
        // Confirmed in real Chromium together with the overlay: one click on "Close ad" sent source:add-from-tab.
        const document = installDom()
        const planted = document.createElement("div")
        planted.id = HOST_ID
        planted.setAttribute("data-amr-mode", "followed")
        planted.setAttribute("data-amr-open", "1")
        document.body.appendChild(planted)
        injectChapterPrompt(PAGE, [], undefined, null, "detected", null)
        const host = document.getElementById(HOST_ID)!
        expect(host).not.toBe(planted)
        expect(host.getAttribute("data-amr-open")).not.toBe("1")
        expect((panelRoot!.querySelector(".panel") as { hidden: boolean }).hidden).toBe(true)
        expect((panelRoot!.querySelector(".handle") as { hidden: boolean }).hidden).toBe(false)
    })
})
