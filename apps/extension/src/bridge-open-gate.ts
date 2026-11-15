// Gate for the weeb.ltd bridge's storyhoard:open event. Each open adds a library row, runs a search
// and opens a tab, so a page that fires the event in a loop (a bug, or injected script on the site)
// must not be able to flood the user. An open needs a recent user gesture where the browser can
// report one, at most one goes through per OPEN_INTERVAL_MS, and the same title fired again within
// REPEAT_WINDOW_MS (a double click, a re-render re-dispatching) is dropped.
const OPEN_INTERVAL_MS = 3000
const REPEAT_WINDOW_MS = 30_000

export type OpenPayload = { anilistId: number; title: string }

export function createOpenGate(now: () => number = Date.now) {
    let lastAt = Number.NEGATIVE_INFINITY
    let lastKey = ""
    // userActive is navigator.userActivation?.isActive: undefined where the API is missing, so older
    // browsers still work under the throttle alone.
    return (payload: OpenPayload, userActive: boolean | undefined): boolean => {
        if (userActive === false) return false
        const at = now()
        const key = `${payload.anilistId}\u0000${payload.title}`
        if (at - lastAt < OPEN_INTERVAL_MS) return false
        if (key === lastKey && at - lastAt < REPEAT_WINDOW_MS) return false
        lastAt = at
        lastKey = key
        return true
    }
}
