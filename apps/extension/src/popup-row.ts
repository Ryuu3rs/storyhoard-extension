import type { LibraryManga } from "./database"
import { readChapterLabel } from "./reading-status"

export function timeAgo(ts: number | undefined, now: number): string {
    if (!ts) return ""
    const s = Math.floor((now - ts) / 1000)
    if (s < 60) return "just now"
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    const d = Math.floor(h / 24)
    if (d < 30) return `${d}d ago`
    const mo = Math.floor(d / 30)
    if (mo < 12) return `${mo}mo ago`
    return `${Math.floor(mo / 12)}y ago`
}

export function chapterLine(m: LibraryManga): string {
    const read = readChapterLabel(m)
    const latest = m.latestChapterNumber
    if (typeof latest === "number") return `${read} of ${latest}`
    return read
}

export function rowSubtitle(m: LibraryManga, now: number): string {
    const line = chapterLine(m)
    const when = timeAgo(m.latestChapterAt ?? m.updatedAt, now)
    return when ? `${line} · ${when}` : line
}
