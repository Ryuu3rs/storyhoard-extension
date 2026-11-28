const MAX_PART_DIGITS = 6

// Compares every dot-separated part by its leading digits; a missing or non-numeric part counts as
// 0. A part longer than six digits is not a real version, so it is never newer.
export function isNewerVersion(candidate: string, current: string): boolean {
    const parts = (v: string) => v.split(".").map(n => /^\d+/.exec(n)?.[0] ?? "0")
    const c = parts(candidate)
    const u = parts(current)
    if ([...c, ...u].some(n => n.length > MAX_PART_DIGITS)) return false
    for (let i = 0; i < Math.max(c.length, u.length); i++) {
        const a = Number(c[i] ?? 0)
        const b = Number(u[i] ?? 0)
        if (a !== b) return a > b
    }
    return false
}
