export const SIDEBAR_COLLAPSED_KEY = "sidebarCollapsed"
export const SIDEBAR_AUTO_COLLAPSE_WIDTH = 900

let primed = false

// Read once before the app mounts so the shell renders in the remembered state, with no
// expanded-then-collapsed flash.
export async function primeSidebarCollapsed(): Promise<boolean> {
    try {
        primed = (await browser.storage.local.get(SIDEBAR_COLLAPSED_KEY))[SIDEBAR_COLLAPSED_KEY] === true
    } catch {
        primed = false
    }
    return primed
}

export function primedSidebarCollapsed(): boolean {
    return primed
}

export async function saveSidebarCollapsed(collapsed: boolean): Promise<void> {
    primed = collapsed
    try {
        await browser.storage.local.set({ [SIDEBAR_COLLAPSED_KEY]: collapsed })
    } catch {
        // the choice still applies for this session
    }
}

export type SidebarState = {
    remembered: boolean
    narrow: boolean
    narrowExpanded: boolean
}

export function isSidebarCollapsed(state: SidebarState): boolean {
    return state.narrow ? !state.narrowExpanded : state.remembered
}

// On a narrow window the toggle only expands for now; the remembered choice is for wide windows.
export function toggleSidebar(state: SidebarState): SidebarState {
    if (state.narrow) return { ...state, narrowExpanded: !state.narrowExpanded }
    return { ...state, remembered: !state.remembered }
}

export function isNarrowWindow(width: number): boolean {
    return width < SIDEBAR_AUTO_COLLAPSE_WIDTH
}
