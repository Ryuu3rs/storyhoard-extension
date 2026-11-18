import { getSettings } from "./settings"

export type StartSection = "Discover" | "Library"

let primed: StartSection = "Discover"

// Read once before the app mounts, so it opens on the chosen page without painting or loading Discover
// first, and a click made while the library loads is never undone.
export async function primeStartSection(): Promise<StartSection> {
    try {
        primed = (await getSettings()).startPage === "library" ? "Library" : "Discover"
    } catch {
        primed = "Discover"
    }
    return primed
}

export function primedStartSection(): StartSection {
    return primed
}
