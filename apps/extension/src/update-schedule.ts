import { effectiveReadingStatus } from "./reading-status"
import type { LibraryManga } from "./database"

export const UPDATE_INTERVAL_MINUTES = [0, 5, 10, 15, 30, 60, 180, 360, 720, 1440] as const
export type UpdateIntervalMinutes = (typeof UPDATE_INTERVAL_MINUTES)[number]

export const DEFAULT_UPDATE_INTERVAL_MINUTES: UpdateIntervalMinutes = 720

export function isUpdateIntervalMinutes(value: unknown): value is UpdateIntervalMinutes {
    return typeof value === "number" && (UPDATE_INTERVAL_MINUTES as readonly number[]).includes(value)
}

// Settings saved before the schedule was in minutes carry updateIntervalHours (0, 6, 12 or 24).
export function updateIntervalFromStored(stored: {
    updateIntervalMinutes?: unknown
    updateIntervalHours?: unknown
}): UpdateIntervalMinutes {
    if (isUpdateIntervalMinutes(stored.updateIntervalMinutes)) return stored.updateIntervalMinutes
    const hours = stored.updateIntervalHours
    if (hours === 0 || hours === 6 || hours === 12 || hours === 24) return (hours * 60) as UpdateIntervalMinutes
    return DEFAULT_UPDATE_INTERVAL_MINUTES
}

const MINUTE_MS = 60_000

// Paused, planned and dropped titles are not what the user is reading, so a fast schedule skips them.
export const SLOW_TITLE_INTERVAL_MINUTES = 360
export const HOST_MIN_GAP_MS = 2000

export function effectiveIntervalMs(item: LibraryManga, intervalMinutes: number, autoPauseDays: number, now: number) {
    const status = effectiveReadingStatus(item, { autoPauseDays, now })
    const slow = status === "on-hold" || status === "dropped" || status === "planning"
    return Math.max(intervalMinutes, slow ? SLOW_TITLE_INTERVAL_MINUTES : 0) * MINUTE_MS
}

export type LastChecked = Record<string, number>

// Never-checked titles come first, then the longest-unchecked.
export function selectDueTitles(
    titles: LibraryManga[],
    lastChecked: LastChecked,
    intervalMinutes: number,
    autoPauseDays: number,
    now: number
): LibraryManga[] {
    return titles
        .filter(item => {
            const last = lastChecked[item.id]
            return last === undefined || now - last >= effectiveIntervalMs(item, intervalMinutes, autoPauseDays, now)
        })
        .sort((a, b) => (lastChecked[a.id] ?? 0) - (lastChecked[b.id] ?? 0))
}

export type RunBudget = { wallMs: number; maxTitles: number }

// A scheduled run has to finish before the next alarm: about half the interval, never under 90 s and
// never past the point where the stale-progress recovery would call the run dead.
export function runBudget(intervalMinutes: number): RunBudget {
    const wallMs = Math.min(Math.max((intervalMinutes * MINUTE_MS) / 2, 90_000), 14 * MINUTE_MS)
    return { wallMs, maxTitles: Math.floor(wallMs / 1000) }
}

export function hostOf(url: string): string | undefined {
    try {
        return new URL(url).host.toLowerCase() || undefined
    } catch {
        return undefined
    }
}

export type HostBackoff = Record<string, { until: number; step: number }>

const BACKOFF_BASE_MS = 30 * MINUTE_MS
const BACKOFF_MAX_MS = 6 * 60 * MINUTE_MS

export function isBackedOff(backoff: HostBackoff, host: string, now: number): boolean {
    const entry = backoff[host]
    return entry !== undefined && entry.until > now
}

export function recordHostBlock(backoff: HostBackoff, host: string, now: number): void {
    const step = (backoff[host]?.step ?? -1) + 1
    backoff[host] = { until: now + Math.min(BACKOFF_BASE_MS * 2 ** step, BACKOFF_MAX_MS), step }
}

export function recordHostSuccess(backoff: HostBackoff, host: string): void {
    delete backoff[host]
}

export function pruneBackoff(backoff: HostBackoff, now: number): HostBackoff {
    const kept: HostBackoff = {}
    for (const [host, entry] of Object.entries(backoff)) {
        if (entry.until > now || entry.step > 0) kept[host] = entry
    }
    return kept
}

type Slot<T> = { item: T; order: number }

// Hands titles out in their given order, but never one whose host was asked less than minGapMs ago:
// a ready host with the oldest-checked title goes first, and when every host is cooling down the
// caller is told how long to wait.
export class HostQueue<T> {
    private readonly queues = new Map<string, Slot<T>[]>()
    private readonly lastAt = new Map<string, number>()

    constructor(
        items: T[],
        hostFor: (item: T) => string,
        private readonly minGapMs = HOST_MIN_GAP_MS
    ) {
        items.forEach((item, order) => {
            const host = hostFor(item)
            const queue = this.queues.get(host) ?? []
            queue.push({ item, order })
            this.queues.set(host, queue)
        })
    }

    get size(): number {
        let count = 0
        for (const queue of this.queues.values()) count += queue.length
        return count
    }

    next(now: number): { item: T; host: string } | { waitMs: number } | undefined {
        let best: { host: string; order: number } | undefined
        let soonest = Infinity
        for (const [host, queue] of this.queues) {
            const head = queue[0]
            if (!head) continue
            const readyAt = (this.lastAt.get(host) ?? -Infinity) + this.minGapMs
            if (readyAt <= now) {
                if (!best || head.order < best.order) best = { host, order: head.order }
            } else {
                soonest = Math.min(soonest, readyAt)
            }
        }
        if (best) {
            const queue = this.queues.get(best.host)!
            const slot = queue.shift()!
            if (queue.length === 0) this.queues.delete(best.host)
            return { item: slot.item, host: best.host }
        }
        return soonest === Infinity ? undefined : { waitMs: soonest - now }
    }

    markRequested(host: string, at: number): void {
        this.lastAt.set(host, at)
    }

    // Drops everything still queued for a host that refused us; returns how many titles that was.
    skipHost(host: string): number {
        const dropped = this.queues.get(host)?.length ?? 0
        this.queues.delete(host)
        return dropped
    }
}
