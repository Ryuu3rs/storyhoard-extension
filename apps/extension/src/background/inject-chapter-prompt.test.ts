import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// injectChapterPrompt is serialized into the page, so it cannot be imported and run here. These
// guards read its source to keep two regressions out: restyle selectors broad enough to reach
// layout wrappers on a site's own markup, and saved view prefs being auto-restored on official
// sites (which would make one bad toggle a persistent break).
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

    it("hands its mode on when it re-injects itself after an in-page navigation", () => {
        expect(source).toContain("injectChapterPrompt(location.href, officialSites, _support, renderedSelectors, mode)")
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
    it("frames it as more chapters on another site, not a ranker for the reader", () => {
        expect(source).toContain('"More chapters on " + d.officialName')
        expect(source).toContain('"More chapters on another site"')
        expect(source).toContain('el("button", "btn pri", "Go there")')
        expect(source).not.toMatch(/Open best|more complete version/i)
    })

    it("still names a site only when the handler reports a verified official one", () => {
        expect(source).toContain("d.officialName")
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

    it("sends the list on followed and detected sites, never an official one (null selectors switch it off)", () => {
        const body = bodyOf("reportRenderedList")
        expect(body).toContain("if (isOfficial || !renderedSelectors) return")
        expect(body).toContain("work:record-chapter-list")
    })

    it("hands the declared selectors on when it re-injects itself after an in-page navigation", () => {
        expect(source).toContain("renderedSelectors, mode)")
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
    it("never seeds an official site, only from same-origin links of the chapter's own path shape", () => {
        const body = bodyOf("seedGenericNavFromDom")
        expect(body).toContain("if (isOfficial")
        expect(body).toContain("u.origin !== here.origin")
        expect(body).toContain("segments.length !== hereSegments.length")
    })

    it("fills only a side that is still empty, so the database list and the site seeds win", () => {
        const body = bodyOf("seedGenericNavFromDom")
        expect(body).toContain("!prevUrl && PREV.test(label)")
        expect(body).toContain("!nextUrl && NEXT.test(label)")
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

    it("retries on a bounded backoff that stops once the panel resolves, not two fixed timers", () => {
        expect(source).toContain("const RESCAN_DELAYS = [")
        expect(bodyOf("panelResolved")).toMatch(/chapSel\.options\.length > 1 \|\| !!panelMangaId/)
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
        expect(bodyOf("seedGenericNavFromDom")).toContain("if (isOfficial ||")
        expect(bodyOf("reportRenderedList")).toContain("if (isOfficial || !renderedSelectors) return")
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
        expect(body).toContain('type: "work:track-detected", url: chapterUrl, explicit: true')
    })

    it("keeps scanning until the list is read, since the title is tracked by the panel itself", () => {
        expect(bodyOf("scanSettled")).toContain("isDetected ? chapSel.options.length > 1 : panelResolved()")
    })

    it("treats a declined record (auto-add off) as resolved so the state is not a failed read", () => {
        expect(bodyOf("currentPanelState")).toContain("mangaResolved: !!panelMangaId || detectedDeclined")
    })
})
