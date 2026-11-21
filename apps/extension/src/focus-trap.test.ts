import { afterEach, describe, expect, it, vi } from "vitest"
import { keepFocusIn } from "./focus-trap"

// Minimal DOM: only what keepFocusIn touches. The title view's dialog holds two buttons; the command palette
// (opened with Ctrl/Cmd-K over the title view, rendered outside it) is another dialog.
type Fake = { name: string; focus: () => void; getClientRects: () => unknown[]; closest: () => unknown }
let active: Fake | null
const focused = () => active?.name

function fakeEl(name: string, inDialog = false): Fake {
    const el: Fake = {
        name,
        focus: () => {
            active = el
        },
        getClientRects: () => [{}],
        closest: () => (inDialog ? {} : null)
    }
    return el
}

function setup() {
    const items = [fakeEl("title back", true), fakeEl("title read", true)]
    const box = {
        querySelectorAll: () => items,
        contains: (el: unknown) => items.includes(el as Fake)
    } as unknown as HTMLElement
    vi.stubGlobal("document", {
        get activeElement() {
            return active
        }
    })
    const tab = (shiftKey = false) =>
        ({ key: "Tab", shiftKey, preventDefault: vi.fn() }) as unknown as KeyboardEvent & {
            preventDefault: ReturnType<typeof vi.fn>
        }
    return { box, items, tab }
}

afterEach(() => vi.unstubAllGlobals())

describe("keepFocusIn", () => {
    it("leaves Tab alone while focus is inside another open dialog", () => {
        const { box, tab } = setup()
        active = fakeEl("palette input", true)
        const event = tab()
        keepFocusIn(box, event)
        expect(focused()).toBe("palette input")
        expect(event.preventDefault).not.toHaveBeenCalled()
    })

    it("brings focus that fell to the body back to the first or last control", () => {
        const { box, tab } = setup()
        active = fakeEl("body")
        keepFocusIn(box, tab())
        expect(focused()).toBe("title back")
        active = fakeEl("body")
        keepFocusIn(box, tab(true))
        expect(focused()).toBe("title read")
    })

    it("brings focus back when nothing is focused", () => {
        const { box, tab } = setup()
        active = null
        const event = tab()
        keepFocusIn(box, event)
        expect(focused()).toBe("title back")
        expect(event.preventDefault).toHaveBeenCalled()
    })

    it("wraps Tab and Shift+Tab inside the dialog", () => {
        const { box, items, tab } = setup()
        active = items[1]!
        keepFocusIn(box, tab())
        expect(focused()).toBe("title back")
        keepFocusIn(box, tab(true))
        expect(focused()).toBe("title read")
    })
})
