import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parseHTML } from "linkedom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { injectChapterPrompt } from "./inject-chapter-prompt"

// injectChapterPrompt is serialized into the page. Most guards here read its source to keep
// regressions out: restyle selectors broad enough to reach layout wrappers on a site's own markup,
// and saved view prefs being auto-restored on official sites (which would make one bad toggle a
// persistent break). The last block runs the real panel in a DOM and acts as a hostile page would.
const source = readFileSync(fileURLToPath(new URL("./inject-chapter-prompt.ts", import.meta.url)), "utf8")

describe("injectChapterPrompt restyle scoping", () => {
    it("never targets every element whose class merely contains 'chapter' or 'page'", () => {
        expect(source).not.toMatch(/div\[class\*=/)
        expect(source).not.toMatch(/img\[class\*=/)
    })

    it("scopes the restyle layers to the marked page-image container", () => {
        for (const layer of ["DARK_CSS", "FIT_CSS", "SCROLL_CSS", "NO_GAP_CSS"]) {
            const start = source.indexOf(`const ${layer}`)
            expect(start).toBeGreaterThan(-1)
            expect(source.slice(start, start + 600)).toContain("[data-amr-reader]")
        }
    })

    it("only restores saved view prefs on followed sites", () => {
        const start = source.indexOf("function loadPrefs")
        expect(start).toBeGreaterThan(-1)
        expect(source.slice(start, start + 200)).toContain("if (!isFollowed) return")
    })
})

describe("injectChapterPrompt panel modes", () => {
    it("takes an explicit mode argument and no longer derives behaviour from a not-official flag", () => {
        expect(source).toMatch(/mode: PanelMode = "followed"/)
        expect(source).not.toContain("userAdded")
        expect(source).toContain('const isOfficial = mode === "official"')
        expect(source).toContain('const isFollowed = mode === "followed"')
    })

    it("keeps the restyle, pop-up blocker and keyboard shortcuts on the followed mode only", () => {
        expect(source).toContain("setPopupBlock(isFollowed)")
        expect(source).toContain("if (isFollowed) document.addEventListener")
        expect(source).toContain('let theme: "auto" | "light" | "dark" = isFollowed && pageIsLight')
    })

    it("re-resolves its mode when it re-injects itself after an in-page navigation, keeping its own if unsure", () => {
        expect(source).toContain('type: "panel:resolve-mode", url: landedUrl')
        expect(source).toContain("reinject(mode, renderedSelectors)")
        // A detected panel never comes back up on a page the background says is no reader page.
        expect(source).toMatch(/\} else if \(resp\?\.ok && isDetected\) \{[\s\S]{0,260}?return\s*\}/)
        expect(source).toContain("injectChapterPrompt(landedUrl, officialSites, _support, nextSelectors, nextMode)")
    })
})

describe("injectChapterPrompt honest states", () => {
    it("derives the handle label and footer from the panel state, not a fixed default", () => {
        expect(source).not.toContain('"tracked by StoryHoard"))')
        expect(source).not.toMatch(/chapLabel !== "" \? chapLabel : "Tracking"/)
        expect(bodyOf("renderPanelState")).toContain("panelStateText(state, chapLabel)")
        expect(bodyOf("updateProgress")).toContain("renderPanelState()")
    })

    it("counts finished rescans so the state knows when the bounded backoff gave up", () => {
        expect(bodyOf("scanRenderedPage")).toContain("rescansDone += 1")
        expect(bodyOf("currentPanelState")).toContain("rescansDone >= RESCAN_DELAYS.length")
    })

    it("offers a manual retry that restarts the whole resolve", () => {
        const body = bodyOf("retryScan")
        expect(body).toContain("rescanIndex = 0")
        expect(body).toContain("rescansDone = 0")
        expect(body).toContain('renderedListSignature = ""')
        expect(source).toContain('retryBtn.addEventListener("click"')
    })
})

describe("injectChapterPrompt better-version hint copy", () => {
    it("offers a verified official site without naming it, and never another unofficial mirror", () => {
        expect(source).toContain('"More chapters on the official site"')
        // Must never offer a generic/unofficial "another site" destination.
        expect(source).not.toContain('"More chapters on another site"')
        // The hint is hidden unless the handler reports an official destination.
        expect(source).toContain("if (!d.bestUrl || !d.bestIsOfficial) return")
        expect(source).toContain('el("button", "btn pri", "Go there")')
        expect(source).not.toMatch(/Open best|more complete version/i)
    })

    it("shows the hint only when the handler reports a verified official site", () => {
        expect(source).toContain("d.bestIsOfficial")
        expect(source).not.toContain("officialName")
        expect(source).toContain("hasBetter")
    })
})

function bodyOf(name: string): string {
    const start = source.indexOf(`function ${name}(`)
    expect(start).toBeGreaterThan(-1)
    const next = source.indexOf("\n    function ", start + 10)
    return source.slice(start, next === -1 ? start + 4000 : next)
}

describe("injectChapterPrompt rendered chapter list", () => {
    it("only reads the DOM: the list scrape makes no request of its own", () => {
        const body = bodyOf("readRenderedChapterList")
        expect(body).not.toMatch(/\bfetch\(|XMLHttpRequest|sendMessage|\.src\s*=/)
    })

    it("is scoped to the profile selectors or the known list containers, and capped", () => {
        const body = bodyOf("readRenderedChapterList")
        expect(body).toContain("renderedSelectors?.container")
        expect(body).toContain("renderedSelectors?.item")
        expect(body).toContain("KNOWN_CONTAINERS")
        expect(body).toContain("LIST_ITEM_CAP")
        expect(source).toContain("const LIST_ITEM_CAP = 2000")
    })

    it("catches an invalid selector instead of throwing out of the panel", () => {
        const body = bodyOf("readRenderedChapterList")
        expect(body).toMatch(/try \{\s*return Array\.from\(root\.querySelectorAll\(selector\)\)/)
    })

    it("sends the list on every registered source, gated only so a detected page records first", () => {
        const body = bodyOf("reportRenderedList")
        expect(body).not.toContain("if (isOfficial")
        expect(body).toContain("if (isDetected && !detectedRecorded) return")
        expect(body).toContain("work:record-chapter-list")
    })

    it("hands the declared selectors on when it re-injects itself after an in-page navigation", () => {
        expect(source).toContain("reinject(mode, renderedSelectors)")
        expect(source).toContain("reinject(next.mode, next.renderedSelectors ?? null)")
    })
})

describe("injectChapterPrompt chapter label", () => {
    it("sends the page's own chapter label with every chapter:track", () => {
        const body = bodyOf("trackChapter")
        expect(body).toContain("...(label ? { label } : {})")
        expect(body).toContain('type: "chapter:track", url: chapterUrl')
        expect(bodyOf("currentChapterLabel")).toContain("document.title")
    })
})

describe("injectChapterPrompt generic prev/next seed", () => {
    it("seeds from same-origin links of the chapter's own path shape, official sources included", () => {
        const body = bodyOf("seedGenericNavFromDom")
        expect(body).not.toContain("if (isOfficial")
        expect(body).toContain("u.origin !== here.origin")
        expect(body).toContain("segments.length !== hereSegments.length")
    })

    it("keeps the page's own next/prev over the fetched list sibling on an official source", () => {
        const body = bodyOf("loadSiblings")
        expect(body).toContain("!(isOfficial && prevFromPage)")
        expect(body).toContain("!(isOfficial && nextFromPage)")
    })

    it("takes a side only when it is empty or the page's link is a provably nearer chapter", () => {
        const body = bodyOf("seedGenericNavFromDom")
        expect(body).toContain("!prevUrl || pageStepIsCloser(pagePrevUrl, prevUrl, -1)")
        expect(body).toContain("!nextUrl || pageStepIsCloser(pageNextUrl, nextUrl, 1)")
    })

    it("needs a readable number on all three addresses before the page beats the list", () => {
        const body = bodyOf("pageStepIsCloser")
        expect(body).toContain("here === null || page === null || list === null")
        expect(body).toContain("here < page && page < list")
        expect(body).toContain("list < page && page < here")
    })
})

describe("injectChapterPrompt first-load resolution (cold-worker race)", () => {
    it("caches the sent-list signature only AFTER the worker confirms it recorded/advanced", () => {
        const body = bodyOf("reportRenderedList")
        const assign = body.indexOf("renderedListSignature = signature")
        const confirm = body.indexOf("resp.data.recorded")
        expect(confirm).toBeGreaterThan(-1)
        // The assignment must sit inside the success branch (after the recorded/advanced check), so a
        // send that lands on a cold worker is retried rather than cached-and-skipped forever.
        expect(assign).toBeGreaterThan(confirm)
    })

    it("retries on a bounded backoff that stops once the list is in, not two fixed timers", () => {
        expect(source).toContain("const RESCAN_DELAYS = [")
        expect(bodyOf("scanSettled")).toContain("return chapSel.options.length > 1")
        // The title is saved before its list on a first visit, so knowing the title must not stop the scan.
        expect(bodyOf("scanSettled")).not.toContain("panelMangaId")
        // Hard cap: never schedules past the end of the backoff array.
        expect(bodyOf("scheduleRescan")).toContain("rescanIndex >= RESCAN_DELAYS.length")
        // The old unconditional fixed retries are gone.
        expect(source).not.toContain("setTimeout(scanRenderedPage, 1500)")
        expect(source).not.toContain("setTimeout(scanRenderedPage, 6000)")
    })
})

describe("injectChapterPrompt detected mode is observe only", () => {
    it("never applies the restyle, pop-up blocker, keyboard shortcuts or saved prefs", () => {
        expect(source).toContain("setPopupBlock(isFollowed)")
        expect(source).toContain("if (isFollowed) document.addEventListener")
        expect(source).toContain('let theme: "auto" | "light" | "dark" = isFollowed && pageIsLight')
        expect(bodyOf("loadPrefs")).toContain("if (!isFollowed) return")
        expect(source).not.toMatch(/isDetected[^\n]*(setLayer|setPopupBlock|loadPrefs)/)
    })

    it("hides the reading-view and page-width controls until the site is followed", () => {
        expect(source).toContain('if (!isDetected) {\n        mainView.append(el("div", "lbl", "Reading view"))')
        expect(source).toContain('if (!isDetected) {\n        setView.append(el("div", "lbl", "Page width"))')
    })

    it("reads the on-page list and the prev/next links on a detected page", () => {
        expect(bodyOf("seedGenericNavFromDom")).toContain("if (pagePrevUrl && pageNextUrl) return")
        expect(bodyOf("reportRenderedList")).toContain("if (isDetected && !detectedRecorded) return")
    })

    it("keeps a tracking-only record via work:track-detected, retried until the background answers", () => {
        const body = bodyOf("ensureDetectedRecord")
        expect(body).toContain("if (!isDetected || detectedRecorded) return")
        expect(body).toContain("work:track-detected")
        expect(body).toContain("resp.data.retry")
        expect(bodyOf("scanRenderedPage")).toContain("ensureDetectedRecord()")
    })

    it("sends the list only after the tracking-only record exists", () => {
        expect(bodyOf("reportRenderedList")).toContain("if (isDetected && !detectedRecorded) return")
    })

    it("marks read through work:track-detected, not the source-bound chapter:track", () => {
        const body = bodyOf("trackChapter")
        expect(body).toContain('type: "work:track-detected"')
        expect(body).toContain("url: chapterUrl")
    })

    it("treats a declined record (auto-add off) as resolved so the state is not a failed read", () => {
        expect(bodyOf("currentPanelState")).toContain("mangaResolved: !!panelMangaId || detectedDeclined")
    })
})

describe("injectChapterPrompt following lives in the toolbar popup", () => {
    it("points a detected panel at the toolbar button and has no control that follows the site", () => {
        expect(source).toContain("use the StoryHoard button in the browser toolbar")
        expect(source).toContain("if (isDetected) mainView.append(followOffer)")
        expect(source).not.toContain("source:add-from-tab")
        expect(source).not.toContain("Track this site")
        expect(source).not.toMatch(/permissions\.request/)
    })

    it("keeps the copy neutral", () => {
        const copy =
            "To track this site for new-chapter updates and reader tools, use the StoryHoard button in the browser toolbar."
        expect(source).toContain(copy)
        expect(copy).not.toMatch(/free|download|pirat|scrap|crack|bypass/i)
    })
})

describe("injectChapterPrompt hands over to the followed panel", () => {
    it("a panel of the same mode is left alone, a different mode replaces it and keeps it open", () => {
        expect(source).toContain("if (existingHost && previousPanel!.mode === mode) return")
        expect(source).toContain('hostEl.setAttribute("data-amr-mode", mode)')
        expect(source).toContain("existingHost?.remove()")
        expect(source).toContain("panelOpen = expanded")
        expect(source).toContain("if (reopen) show(true)")
    })

    it("knows its own host from isolated-world state, never from the page's DOM", () => {
        expect(source).not.toContain("getElementById(HOST_ID)")
        expect(source).not.toContain('getAttribute("data-amr-mode")')
        expect(source).not.toContain('getAttribute("data-amr-open")')
        expect(source).toContain("previousPanel.host.ownerDocument === document")
    })

    it("the replaced panel stops its own timers and listeners once its host is gone", () => {
        expect(bodyOf("scanRenderedPage")).toContain("if (!hostEl.isConnected) return")
        expect(source).toMatch(/if \(!hostEl\.isConnected\) \{\s*teardown\(\)/)
    })
})

describe("injectChapterPrompt replaced panel stops at once", () => {
    it("runs the previous panel's teardown before it builds anything", () => {
        const call = source.indexOf("previousCleanup()")
        expect(call).toBeGreaterThan(-1)
        expect(call).toBeLessThan(source.indexOf("existingHost?.remove()"))
        expect(call).toBeLessThan(source.indexOf("const hostEl = document.createElement"))
        expect(source).toContain('const CLEANUP_KEY = "__amrPanelCleanup__"')
        expect(source).toContain("(globalThis as any)[CLEANUP_KEY] = teardown")
    })

    it("tears down the scroll and key listeners, the poll and every pending timer synchronously", () => {
        const body = bodyOf("teardown")
        expect(body).toContain("tornDown = true")
        expect(body).toContain("window.clearTimeout(id)")
        expect(body).toContain("window.clearInterval(poll.id)")
        expect(body).toContain('window.removeEventListener("scroll", onScroll)')
        expect(body).toContain('document.removeEventListener("keydown", onKeyDown)')
    })

    it("starts every timeout through the tracked helper, so none can outlive the panel", () => {
        expect(source.match(/\bsetTimeout\(/g)).toHaveLength(1)
        expect(bodyOf("later")).toContain("window.setTimeout(")
        expect(bodyOf("scheduleRescan")).toContain("later(() => {")
        expect(source).toContain("}, 2500)")
        expect(source).not.toMatch(/^\s*setTimeout\(/m)
    })

    it("does nothing from a torn-down panel, so a late scroll cannot mark a chapter", () => {
        expect(bodyOf("trackChapter")).toContain("if (tornDown) return")
        expect(bodyOf("updateProgress")).toContain("if (tornDown) return")
        expect(bodyOf("ensureDetectedRecord")).toContain("tornDown")
    })

    it("hands over through teardown when it re-injects itself after an in-page navigation", () => {
        expect(source).toMatch(/teardown\(\)\s*hostEl\.remove\(\)/)
        expect(source).not.toContain("injectChapterPrompt(location.href")
    })
})

describe("injectChapterPrompt gesture guards and Mark read", () => {
    const handlerAfter = (needle: string): string => {
        const start = source.indexOf(needle)
        expect(start).toBeGreaterThan(-1)
        return source.slice(start, start + 220)
    }

    it("acts on Mark read and Mark & next only for a genuine click on the visible control", () => {
        expect(handlerAfter('btrack.addEventListener("click"')).toContain("clickIsGenuine(event, btrack)")
        expect(handlerAfter('bmarknext.addEventListener("click"')).toContain("clickIsGenuine(event, bmarknext)")
        const body = bodyOf("clickIsGenuine")
        expect(body).toContain("if (!event.isTrusted")
        expect(body).toContain("document.elementFromPoint(event.clientX, event.clientY) !== hostEl")
        expect(body).toContain("hitInPanel.call(shadow, event.clientX, event.clientY)")
        expect(body).toContain("opacity < 0.9")
    })

    it("builds the panel in a closed shadow root", () => {
        expect(source).toContain('hostEl.attachShadow({ mode: "closed" })')
        expect(source).not.toContain('attachShadow({ mode: "open" })')
    })

    it("ignores a page script's events on every other control", () => {
        for (const needle of [
            'bfull.addEventListener("click"',
            'slider.addEventListener("input"',
            'openApp.addEventListener("click"',
            'gear.addEventListener("click"',
            'backBtn.addEventListener("click"',
            'chapSel.addEventListener("change"',
            'handle.addEventListener("pointerdown"',
            'minBtn.addEventListener("click"',
            'hintBtn.addEventListener("click"',
            'bprev.addEventListener("click"',
            'bnext.addEventListener("click"'
        ]) {
            expect(handlerAfter(needle), needle).toMatch(/\.isTrusted/)
        }
        const theme = source.indexOf('b.addEventListener("click"')
        expect(theme).toBeGreaterThan(-1)
        expect(source.slice(theme, theme + 200)).toContain("event.isTrusted")
    })

    it("treats a click like the end-of-chapter auto-mark: neither can add past auto-add and its caps", () => {
        const body = bodyOf("trackChapter")
        expect(body).toContain('{ type: "work:track-detected", url: chapterUrl, markRead: true }')
        expect(source).not.toMatch(/explicit:/)
        expect(bodyOf("updateProgress")).toContain("void trackChapter()")
        expect(source.match(/trackChapter\(\)/g)).toHaveLength(4)
    })
})

describe("injectChapterPrompt retry guard", () => {
    it("ignores an untrusted or repeated click while a scan chain is in flight", () => {
        const start = source.indexOf('retryBtn.addEventListener("click"')
        expect(start).toBeGreaterThan(-1)
        const handler = source.slice(start, start + 200)
        expect(handler).toContain("event.isTrusted")
        expect(handler).toContain("scanTimerPending")
        expect(bodyOf("retryScan")).toContain("if (scanTimerPending) return")
    })

    it("marks a scan pending from scheduling until it runs, and disables the button meanwhile", () => {
        const body = bodyOf("scheduleRescan")
        expect(body).toContain("scanTimerPending = true")
        expect(body).toContain("scanTimerPending = false")
        expect(bodyOf("renderPanelState")).toContain("retryBtn.disabled = scanTimerPending")
    })
})

describe("injectChapterPrompt teardown is exception-safe", () => {
    it("references only hoisted functions for the listeners it removes, never a later const", () => {
        const body = bodyOf("teardown")
        for (const name of ["onScroll", "onKeyDown"]) {
            expect(body).toContain(name)
            expect(source).toContain(`function ${name}(`)
            expect(source).not.toMatch(new RegExp(`const ${name}\\b`))
        }
    })

    it("only reads state declared before it", () => {
        const teardownAt = source.indexOf("function teardown(")
        for (const name of ["tornDown", "pendingTimers", "poll", "CLEANUP_KEY"]) {
            const declared = source.search(new RegExp(`(?:const|let) ${name}\\b`))
            expect(declared, name).toBeGreaterThan(-1)
            expect(declared, name).toBeLessThan(teardownAt)
        }
    })
})

describe("remembered reading-view defaults (global, not only per-title)", () => {
    it("saves each sidebar toggle to the global settings, so it sticks across titles and sites", () => {
        expect(source).toContain('type: "settings:update"')
        expect(source).toContain("saveReaderDefault({ continuousScroll: v })")
        expect(source).toContain("saveReaderDefault({ fitWidth: v })")
        expect(source).toContain("saveReaderDefault({ noGap: v })")
        expect(source).toContain("readerContinuousScroll")
    })

    it("starts the controls in the remembered global state on load, without echoing a save", () => {
        expect(source).toContain("applyReaderDefaults()")
        const body = bodyOf("applyReaderDefaults")
        expect(body).toContain('setAttribute("data-amr-continuous", "1")')
        expect(body).toContain("setScrollTog?.(true)")
        // Applying the default must not call saveReaderDefault/savePref (no write echo).
        expect(body).not.toContain("saveReaderDefault")
        expect(body).not.toContain("savePref")
    })
})

describe("injectChapterPrompt switch and keyboard guards", () => {
    it("flips a switch only for a genuine click on the visible switch", () => {
        const start = source.indexOf('sw.addEventListener("click"')
        expect(start).toBeGreaterThan(-1)
        expect(source.slice(start, start + 400)).toContain("if (!clickIsGenuine(event, sw)) return")
        expect(source.match(/sw\.addEventListener\("click"/g)).toHaveLength(1)
    })

    it("reads the real key target through shadow roots and ignores keys typed inside the panel", () => {
        const body = bodyOf("onKeyDown")
        expect(body).toContain("e.composedPath()")
        expect(body).toContain("path.includes(hostEl)")
        expect(body).not.toContain("e.target as HTMLElement")
    })
})

describe("the panel in a page that is out to misuse it", () => {
    const PAGE = "https://reader.example/manga/demo/chapter-3"
    const HOST_ID = "__amr-chapter-prompt__"
    type Root = { querySelector(s: string): any; querySelectorAll(s: string): any; elementFromPoint?: unknown }

    let sendMessage: ReturnType<typeof vi.fn>
    let panelRoot: Root | undefined
    let restoreAttach: (() => void) | undefined
    let hostStyle: Record<string, string>

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
        elementProto.getBoundingClientRect = () => ({ x: 0, y: 0, width: 80, height: 30, top: 0, left: 0 })
        restoreAttach = () => {
            elementProto.attachShadow = original
            elementProto.getBoundingClientRect = originalRect
        }
        const doc = document as unknown as Record<string, unknown>
        doc["elementFromPoint"] = () => document.getElementById(HOST_ID)
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
        hostStyle = {}
        vi.stubGlobal("getComputedStyle", (node: { id?: string }) => ({
            backgroundColor: "rgb(20, 20, 20)",
            color: "",
            position: "static",
            opacity: "1",
            visibility: "visible",
            filter: "none",
            mixBlendMode: "normal",
            maskImage: "none",
            ...(node?.id === HOST_ID ? hostStyle : {})
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

    // A click as the browser reports a real one: trusted, at a point on the screen.
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
    })
    afterEach(() => {
        restoreAttach?.()
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it("keeps its controls out of the page's reach in a closed shadow root", () => {
        const document = installDom()
        injectChapterPrompt(PAGE, [], undefined, null, "detected", null)
        expect(document.getElementById(HOST_ID)!.shadowRoot).toBeNull()
        expect(button("Mark read")).toBeDefined()
    })

    it("ignores a page script's click() on Mark & next", () => {
        installDom()
        injectChapterPrompt(PAGE, [], undefined, null, "followed", null)
        sendMessage.mockClear()
        button("Mark & next").click()
        expect(sentOfType("chapter:track")).toHaveLength(0)
    })

    it("ignores a page script's click on the theme buttons, which set the global reader theme", () => {
        installDom()
        injectChapterPrompt(PAGE, [], undefined, null, "followed", null)
        const light = [...panelRoot!.querySelectorAll(".seg button")].find(
            (b: { textContent: string }) => b.textContent === "Light"
        ) as { click(): void }
        sendMessage.mockClear()
        light.click()
        expect(sentOfType("settings:update")).toEqual([])
    })

    it("ignores a page script's input on the page-width slider", async () => {
        installDom()
        injectChapterPrompt(PAGE, [], undefined, null, "followed", null)
        await vi.advanceTimersByTimeAsync(0)
        const slider = panelRoot!.querySelector("input.slider") as { value: string; dispatchEvent(e: Event): void }
        sendMessage.mockClear()
        slider.value = "30"
        slider.dispatchEvent(new (globalThis as unknown as { Event: typeof Event }).Event("input"))
        expect(sentOfType("library:reading-prefs")).toEqual([])
    })

    it("marks read on the user's own click on the visible Mark read button", () => {
        installDom()
        injectChapterPrompt(PAGE, [], undefined, null, "detected", null)
        const mark = button("Mark read")
        panelRoot!.elementFromPoint = () => mark
        sendMessage.mockClear()
        userClick(mark)
        expect(sentOfType("work:track-detected")).toHaveLength(1)
    })

    it("does not mark read when the page made the panel see-through and put its own bait over it", () => {
        installDom()
        injectChapterPrompt(PAGE, [], undefined, null, "detected", null)
        const mark = button("Mark read")
        panelRoot!.elementFromPoint = () => mark
        hostStyle = { opacity: "0" }
        sendMessage.mockClear()
        userClick(mark)
        expect(sentOfType("work:track-detected")).toHaveLength(0)
    })

    it("does not mark read when the page's own element sits on top of the button at the click point", () => {
        const document = installDom()
        injectChapterPrompt(PAGE, [], undefined, null, "detected", null)
        const mark = button("Mark read")
        const decoy = document.createElement("div")
        document.body.appendChild(decoy)
        ;(document as unknown as Record<string, unknown>)["elementFromPoint"] = () => decoy
        panelRoot!.elementFromPoint = () => decoy
        sendMessage.mockClear()
        userClick(mark)
        expect(sentOfType("work:track-detected")).toHaveLength(0)
    })

    it("does not mark read when another panel element covers the button at the click point", () => {
        installDom()
        injectChapterPrompt(PAGE, [], undefined, null, "followed", null)
        const mark = button("Mark read")
        panelRoot!.elementFromPoint = () => button("Fullscreen")
        sendMessage.mockClear()
        userClick(mark)
        expect(sentOfType("chapter:track")).toHaveLength(0)
        panelRoot!.elementFromPoint = () => mark
        userClick(mark)
        expect(sentOfType("chapter:track")).toHaveLength(1)
    })
})
