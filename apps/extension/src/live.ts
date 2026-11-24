// Cross-surface live-update bus. Any of the app dashboard tab, reader tab, or
// popup can be open at once, and today none of them notice when another surface
// mutates shared data (editing a manga's notes in one dashboard tab doesn't show
// up in a second one; a background chapter-list refresh doesn't update an
// already-open reader tab's next/prev controls). This generalizes the existing
// ad-hoc `updateProgress` storage-polling pattern (see
// entrypoints/app/App.svelte's browser.storage.onChanged listener) into a single
// small event bus: background-side mutations call publishLive(), page-side code
// calls subscribeLive() to react.
//
// Transport: browser.storage.session (falling back to storage.local when session
// storage isn't available) plus each surface's own storage.onChanged listener.
// Chrome's storage.onChanged does NOT fire for a value that's deep-equal to the
// previous one, so every LiveEvent carries a monotonically increasing `seq` (and
// `at`) to guarantee each write is observably different even when two publishes
// happen to carry identical scopes/mangaIds.

export type LiveScope = "library" | "chapters" | "progress" | "siteSessions" | "all"

export type LiveEvent = {
    seq: number
    at: number
    scopes: LiveScope[]
    mangaIds?: string[]
}

const LIVE_EVENT_KEY = "liveEvent"

// Leading + trailing coalescing window for publishLive: a call with nothing
// published in the last COALESCE_WINDOW_MS writes immediately (leading edge);
// calls arriving inside that window merge into a single pending record that
// flushes once at the window's end (trailing edge), instead of writing to
// storage (and firing storage.onChanged on every open surface) once per call.
const COALESCE_WINDOW_MS = 50

// Per-subscriber trailing debounce: a burst of qualifying events collapses into
// one callback invocation, firing this long after the last qualifying event.
const SUBSCRIBER_DEBOUNCE_MS = 250

let seq = 0
// -Infinity so the very first publishLive call is always a leading-edge
// immediate write - nothing has ever been published.
let lastWriteAt = -Infinity
let pendingScopes: Set<LiveScope> | null = null
let pendingMangaIds: Set<string> | null = null
let pendingTimer: ReturnType<typeof setTimeout> | undefined

function hasSessionStorage(): boolean {
    // Feature-detect rather than try/catch: browser.storage.session is undefined
    // on older browsers that don't support MV3 session storage (its presence, not
    // just a thrown error, is what distinguishes support here).
    return (
        typeof browser !== "undefined" &&
        typeof browser.storage !== "undefined" &&
        typeof browser.storage.session !== "undefined"
    )
}

async function writeLiveEvent(scopes: LiveScope[], mangaIds?: string[]): Promise<void> {
    seq += 1
    const event: LiveEvent = {
        seq,
        at: Date.now(),
        scopes,
        ...(mangaIds && mangaIds.length > 0 ? { mangaIds } : {})
    }
    if (hasSessionStorage()) {
        await browser.storage.session.set({ [LIVE_EVENT_KEY]: event })
    } else {
        await browser.storage.local.set({ [LIVE_EVENT_KEY]: event })
    }
}

// Background-side only. Announces that data in the given scopes changed, so
// every open surface's subscribeLive() callback re-fetches. Call this after a
// mutation has actually committed - never speculatively before.
export function publishLive(scopes: LiveScope[], mangaIds?: string[]): void {
    const now = Date.now()
    if (now - lastWriteAt >= COALESCE_WINDOW_MS && pendingTimer === undefined) {
        lastWriteAt = now
        void writeLiveEvent(scopes, mangaIds)
        return
    }

    if (!pendingScopes) pendingScopes = new Set()
    if (!pendingMangaIds) pendingMangaIds = new Set()
    for (const scope of scopes) pendingScopes.add(scope)
    for (const mangaId of mangaIds ?? []) pendingMangaIds.add(mangaId)

    if (pendingTimer === undefined) {
        const elapsed = now - lastWriteAt
        const delay = Math.max(0, COALESCE_WINDOW_MS - elapsed)
        pendingTimer = setTimeout(() => {
            const scopesToWrite = pendingScopes ? [...pendingScopes] : []
            const mangaIdsToWrite = pendingMangaIds && pendingMangaIds.size > 0 ? [...pendingMangaIds] : undefined
            pendingScopes = null
            pendingMangaIds = null
            pendingTimer = undefined
            lastWriteAt = Date.now()
            void writeLiveEvent(scopesToWrite, mangaIdsToWrite)
        }, delay)
    }
}

// Page-side only. Registers a single storage.onChanged listener and invokes
// `cb` (debounced SUBSCRIBER_DEBOUNCE_MS, trailing) whenever a published event's
// scopes intersect `scopes`, or the event includes "all". Returns an
// unsubscribe function.
export function subscribeLive(scopes: LiveScope[], cb: (ev: LiveEvent) => void): () => void {
    const wanted = new Set(scopes)
    let debounceTimer: ReturnType<typeof setTimeout> | undefined
    let latest: LiveEvent | undefined

    const listener = (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, area: string) => {
        if (area !== "session" && area !== "local") return
        const change = changes[LIVE_EVENT_KEY]
        if (!change) return
        const event = change.newValue as LiveEvent | undefined
        if (!event) return
        const matches = event.scopes.includes("all") || event.scopes.some(scope => wanted.has(scope))
        if (!matches) return

        latest = event
        if (debounceTimer !== undefined) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
            debounceTimer = undefined
            if (latest) cb(latest)
        }, SUBSCRIBER_DEBOUNCE_MS)
    }

    browser.storage.onChanged.addListener(listener)

    return () => {
        browser.storage.onChanged.removeListener(listener)
        if (debounceTimer !== undefined) {
            clearTimeout(debounceTimer)
            debounceTimer = undefined
        }
    }
}
