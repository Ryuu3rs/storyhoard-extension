// Pure helpers for the on-site panel. The panel itself (inject-chapter-prompt.ts) is serialised into
// the page and cannot import anything at run time, so it carries inline copies of selectPanelState
// and panelStateText. panel-state.test.ts fails if a copy drifts from the function exported here.

// official: a verified partner site, overlay only. followed: a registered source (list, restyle,
// pop-up blocker, background checks). detected: a reader page the user has not followed, observed
// passively (label, on-page list, prev/next, progress) and nothing else.
export type PanelMode = "official" | "followed" | "detected"

export type PanelState = "detecting" | "tracking-page" | "followed" | "needs-follow" | "couldnt-read-list"

export type PanelStateInput = {
    mode: PanelMode
    // The chapter label resolved from the tracked title.
    labelResolved: boolean
    // Entries in the chapter dropdown, counting the lone "This chapter" placeholder.
    listCount: number
    // The background matched this page to a tracked title.
    mangaResolved: boolean
    // A previous or next chapter link is known.
    hasNeighbour: boolean
    // Every bounded rescan has run and the panel still did not resolve.
    backoffExhausted: boolean
}

export type PanelText = { handle: string; footer: string; retry: boolean }

export function selectPanelState(input: PanelStateInput): PanelState {
    const resolved = input.mangaResolved || input.listCount > 1
    if (input.mode === "official") {
        return resolved || input.backoffExhausted || input.labelResolved ? "tracking-page" : "detecting"
    }
    if (resolved) return input.mode === "detected" ? "needs-follow" : "followed"
    if (input.backoffExhausted) return "couldnt-read-list"
    return input.hasNeighbour || input.labelResolved ? "tracking-page" : "detecting"
}

export function panelStateText(state: PanelState, label: string): PanelText {
    if (state === "detecting") return { handle: label || "Detecting...", footer: "detecting chapter...", retry: false }
    if (state === "tracking-page") return { handle: label || "This page", footer: "tracking this page", retry: false }
    if (state === "needs-follow") {
        return { handle: label || "Detected", footer: "tracked on this device only", retry: false }
    }
    if (state === "couldnt-read-list") {
        return { handle: "Couldn't read list", footer: "couldn't read the chapter list", retry: true }
    }
    return { handle: label || "Tracking", footer: "tracked by StoryHoard", retry: false }
}
