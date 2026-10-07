// Profile-backed sources (user-added and seeded) live only in memory and are re-registered from
// IndexedDB each time the service worker starts. A worker woken BY a navigation or a message runs the
// event handler immediately, so a handler that consults the source registry before registration has
// finished sees an already-added site as unknown: the chapter is not captured, the panel is not
// injected and the "add" hint is offered again. Handlers await this gate before any source decision.

// A registration that never settles must not stall every handler forever.
const READY_TIMEOUT_MS = 5000

let ready: Promise<void> = Promise.resolve()

// Start (or restart) registration. Never rejects: a failing registration is logged and the gate
// still opens, so handlers fall back to whatever did register.
export function beginUserSourcesInit(run: () => Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const started = Promise.resolve()
        .then(run)
        .then(
            () => undefined,
            error => console.error("[AMR] User-source registration failed", error)
        )
    const timeout = new Promise<void>(resolve => {
        timer = setTimeout(resolve, READY_TIMEOUT_MS)
    })
    ready = Promise.race([started, timeout]).finally(() => clearTimeout(timer))
    return ready
}

export function userSourcesReady(): Promise<void> {
    return ready
}
