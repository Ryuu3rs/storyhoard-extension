import { serve } from "@hono/node-server"
import { pathToFileURL } from "node:url"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import {
    createUser,
    getUserByUsername,
    claimUserSecret,
    getUserById,
    getUserSecretHash,
    deleteUser,
    exportUser,
    setUserMinor,
    recordInstallPing,
    linkInstallToUser,
    getInstallStats,
    insertEvents,
    getUserChapterCount,
    getUserSourceCount,
    getStoredAchievements,
    storeAchievements,
    getUserRank,
    getRecommendations,
    getCoReadRecommendations,
    getCommunityStats,
    recordAffiliateClick,
    getAffiliateStats,
    upsertRating,
    getMangaStats,
    createAnnouncement,
    deleteAnnouncement,
    listAllAnnouncements,
    listActiveAnnouncements,
    getAdminStats,
    type EventRow
} from "./db.js"
import { computeUnlocked } from "./achievements.js"
import { validateUsername } from "./username.js"

export const app = new Hono()

app.use(
    "/*",
    cors({ origin: "*", allowMethods: ["GET", "POST", "DELETE"], allowHeaders: ["Content-Type", "Authorization"] })
)

// Best-effort in-memory per-IP rate limit (single instance). Generous windows - only stops
// abuse/DoS bursts (register spam, unbounded event floods), never a normal user.
type RlBucket = { count: number; resetAt: number }
export const rlBuckets = new Map<string, RlBucket>()

// Our reverse proxy (Traefik) appends the real client IP as the rightmost X-Forwarded-For
// hop; every hop to its left is client-supplied and forgeable. Trusting the FIRST hop lets a
// caller rotate/spoof it per request to dodge the limit and to mint unbounded distinct
// buckets. Count TRUSTED_PROXY_DEPTH from the right instead so a forged prefix maps to one
// real bucket.
const TRUSTED_PROXY_DEPTH = (() => {
    const v = Number(process.env.TRUSTED_PROXY_DEPTH)
    return Number.isInteger(v) && v > 0 ? v : 1
})()

// Cap the bucket map so a flood of unique keys cannot grow it without limit (memory DoS).
const RL_MAX_BUCKETS = (() => {
    const v = Number(process.env.RL_MAX_BUCKETS)
    return Number.isInteger(v) && v > 0 ? v : 10000
})()

export function clientIpFromForwardedFor(forwardedFor: string | undefined): string {
    const hops = (forwardedFor ?? "")
        .split(",")
        .map(h => h.trim())
        .filter(Boolean)
    if (hops.length === 0) return "unknown"
    const idx = Math.max(0, hops.length - TRUSTED_PROXY_DEPTH)
    return hops[idx] || "unknown"
}

function evictExpiredOrOldest(now: number): void {
    for (const [key, bucket] of rlBuckets) {
        if (now > bucket.resetAt) rlBuckets.delete(key)
    }
    if (rlBuckets.size < RL_MAX_BUCKETS) return
    const target = Math.max(1, Math.floor(RL_MAX_BUCKETS * 0.1))
    let removed = 0
    for (const key of rlBuckets.keys()) {
        rlBuckets.delete(key)
        if (++removed >= target) break
    }
}

export function withinRateLimit(
    forwardedFor: string | undefined,
    name: string,
    limit: number,
    windowMs: number
): boolean {
    const key = `${name}:${clientIpFromForwardedFor(forwardedFor)}`
    const now = Date.now()
    const bucket = rlBuckets.get(key)
    if (bucket && now <= bucket.resetAt) {
        if (bucket.count >= limit) return false
        bucket.count += 1
        return true
    }
    if (rlBuckets.size >= RL_MAX_BUCKETS) evictExpiredOrOldest(now)
    rlBuckets.set(key, { count: 1, resetAt: now + windowMs })
    return true
}

// Input caps for the free-text fields that reach the DB and the public feed. Titles/sourceIds
// were previously only truthiness-checked, so a non-string 500'd the bind and an unbounded
// string filled disk / injected arbitrary content into the shared trending feed.
const MAX_TITLE_LEN = 300
const MAX_SOURCE_LEN = 100
const MAX_GENRE_LEN = 50
const isBoundedString = (v: unknown, max: number): v is string =>
    typeof v === "string" && v.length > 0 && v.length <= max

const MAX_INSTALL_ID_LEN = 100
const MAX_BROWSER_LEN = 20
const MAX_VERSION_LEN = 30

// The current privacy-policy / consent version. A registration must declare it so the
// server records exactly which version each user agreed to; bump it when the policy
// materially changes so the client re-prompts.
const CURRENT_CONSENT_VERSION = 1

// Constant-time bearer check for the admin-only install dashboard. When COMMUNITY_ADMIN_TOKEN
// is unset the endpoint is disabled (403) rather than open - a safe default.
function bearerMatches(header: string | undefined, expected: string | undefined): boolean {
    if (!expected) return false
    const provided = (header ?? "").replace(/^Bearer\s+/i, "")
    const a = Buffer.from(provided)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
}

function isAdmin(header: string | undefined): boolean {
    return bearerMatches(header, process.env.COMMUNITY_ADMIN_TOKEN)
}

// weeb.ltd's server-to-server token for account erasure, export and age flags. Separate from the
// admin token so the site never holds dashboard access. Unset disables the routes (403).
function isInternal(header: string | undefined): boolean {
    return bearerMatches(header, process.env.COMMUNITY_INTERNAL_TOKEN)
}

const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("hex")
const newSecret = () => randomBytes(32).toString("base64url")

// Bare user ids stay accepted for users without a secret until this time (epoch ms), so versions already
// installed keep working. Unset means no cut-off yet.
function bareIdsClosed(): boolean {
    const sunset = Number(process.env.COMMUNITY_BARE_ID_SUNSET ?? 0)
    return sunset > 0 && Date.now() >= sunset
}

// A user with a secret must present it. A user without one is still on the old bare-id scheme.
function isAuthorized(userId: string, header: string | undefined): boolean {
    const stored = getUserSecretHash(userId)
    if (stored === undefined) return false
    if (stored === null) return !bareIdsClosed()
    const provided = Buffer.from(hashSecret((header ?? "").replace(/^Bearer\s+/i, "")))
    const expected = Buffer.from(stored)
    return provided.length === expected.length && timingSafeEqual(provided, expected)
}

app.get("/", c => c.json({ name: "AMR Community API", version: "1.0.0", status: "ok" }))
app.get("/health", c => c.json({ ok: true }))

app.post("/register", async c => {
    if (!withinRateLimit(c.req.header("x-forwarded-for"), "register", 10, 60 * 60 * 1000)) {
        return c.json({ error: "Too many requests" }, 429)
    }
    const body = await c.req
        .json<{ username?: string; consentVersion?: number; installId?: string }>()
        .catch(() => ({}) as { username?: string; consentVersion?: number; installId?: string })
    // Consent is mandatory server-side, not just a client checkbox: no registration (and so no
    // data collection) happens without an explicit, current-version agreement.
    if (body.consentVersion !== CURRENT_CONSENT_VERSION) {
        return c.json({ error: "Consent required", consentVersion: CURRENT_CONSENT_VERSION }, 400)
    }
    const result = validateUsername(body.username ?? "")
    if (!result.ok) return c.json({ error: result.reason }, 400)
    const username = result.value
    // Uniqueness stays ASCII-casefold (COLLATE NOCASE): "Ryuu"/"ryuu" collide, but full
    // unicode-lookalike dedup (confusables, NFKC folding) is out of scope - it would need a
    // schema migration to add a normalized-key column, which we are not doing here.
    if (getUserByUsername(username)) return c.json({ error: "Username already taken" }, 409)
    const userId = randomUUID()
    const secret = newSecret()
    createUser(userId, username, CURRENT_CONSENT_VERSION, hashSecret(secret))
    if (isBoundedString(body.installId, MAX_INSTALL_ID_LEN)) linkInstallToUser(body.installId, userId)
    return c.json({ userId, secret, consentVersion: CURRENT_CONSENT_VERSION })
})

// One-time swap for users registered before secrets existed. The bare id was already their only
// credential, so this grants nothing new, and once claimed the bare id stops working.
app.post("/claim", async c => {
    if (!withinRateLimit(c.req.header("x-forwarded-for"), "claim", 20, 60 * 60 * 1000)) {
        return c.json({ error: "Too many requests" }, 429)
    }
    const body = await c.req.json<{ userId?: string }>().catch(() => ({}) as { userId?: string })
    if (!isBoundedString(body.userId, MAX_INSTALL_ID_LEN)) return c.json({ error: "userId required" }, 400)
    if (!getUserById(body.userId)) return c.json({ error: "User not found" }, 404)
    if (bareIdsClosed()) return c.json({ error: "Claims have closed" }, 410)
    const secret = newSecret()
    if (!claimUserSecret(body.userId, hashSecret(secret))) return c.json({ error: "Already claimed" }, 409)
    return c.json({ secret })
})

// Anonymous install/active ping - powers cross-browser install counts. No userId needed and
// no consent gate on the ping ITSELF beyond the client only sending it after the user accepts
// (the install id is random and not tied to identity). Rate-limited so it can't be flooded.
app.post("/ping", async c => {
    if (!withinRateLimit(c.req.header("x-forwarded-for"), "ping", 60, 60 * 1000)) {
        return c.json({ error: "Too many requests" }, 429)
    }
    const body = await c.req
        .json<{ installId?: string; browser?: string; version?: string }>()
        .catch(() => ({}) as { installId?: string; browser?: string; version?: string })
    if (!isBoundedString(body.installId, MAX_INSTALL_ID_LEN)) {
        return c.json({ error: "installId required" }, 400)
    }
    const browser = isBoundedString(body.browser, MAX_BROWSER_LEN) ? body.browser : null
    const version = isBoundedString(body.version, MAX_VERSION_LEN) ? body.version : null
    recordInstallPing(body.installId, browser, version)
    return c.json({ ok: true })
})

// GDPR erasure: a user deletes all their community data. Cascades to events/ratings/
// achievements and unlinks their installs. Idempotent - a missing user still returns ok.
app.delete("/me", async c => {
    if (!withinRateLimit(c.req.header("x-forwarded-for"), "delete-me", 20, 60 * 60 * 1000)) {
        return c.json({ error: "Too many requests" }, 429)
    }
    const body = await c.req.json<{ userId?: string }>().catch(() => ({}) as { userId?: string })
    if (!body.userId) return c.json({ error: "userId required" }, 400)
    if (getUserById(body.userId) && !isAuthorized(body.userId, c.req.header("authorization"))) {
        return c.json({ error: "Not authorized" }, 401)
    }
    const deleted = deleteUser(body.userId)
    return c.json({ ok: true, deleted })
})

// --- weeb.ltd account hooks (COMMUNITY_INTERNAL_TOKEN gated). The site holds the account to
// community-id link, so it calls these on account deletion, data export and age changes. ---

app.delete("/internal/users/:id", c => {
    if (!isInternal(c.req.header("authorization"))) return c.json({ error: "Forbidden" }, 403)
    return c.json({ ok: true, deleted: deleteUser(c.req.param("id")) })
})

app.get("/internal/users/:id/export", c => {
    if (!isInternal(c.req.header("authorization"))) return c.json({ error: "Forbidden" }, 403)
    const data = exportUser(c.req.param("id"))
    return data ? c.json(data) : c.json({ error: "User not found" }, 404)
})

app.put("/internal/users/:id/flags", async c => {
    if (!isInternal(c.req.header("authorization"))) return c.json({ error: "Forbidden" }, 403)
    const body = await c.req.json<{ minor?: unknown }>().catch(() => ({}) as { minor?: unknown })
    if (typeof body.minor !== "boolean") return c.json({ error: "minor must be a boolean" }, 400)
    if (!setUserMinor(c.req.param("id"), body.minor)) return c.json({ error: "User not found" }, 404)
    return c.json({ ok: true })
})

// Admin-only install dashboard. Disabled (403) unless COMMUNITY_ADMIN_TOKEN is set + matched.
app.get("/installs", c => {
    if (!isAdmin(c.req.header("authorization"))) return c.json({ error: "Forbidden" }, 403)
    return c.json(getInstallStats())
})

// --- Admin dashboard (all admin-token gated) ---

const MAX_ANNOUNCE_TITLE = 120
const MAX_ANNOUNCE_BODY = 2000
const VALID_LEVELS = new Set(["info", "update", "warning"])
const VALID_TARGETS = new Set(["all", "browser", "version"])

// Lets the dashboard validate a pasted admin token before showing the panel.
app.get("/admin/check", c => {
    if (!isAdmin(c.req.header("authorization"))) return c.json({ error: "Forbidden" }, 403)
    return c.json({ ok: true })
})

app.get("/admin/stats", c => {
    if (!isAdmin(c.req.header("authorization"))) return c.json({ error: "Forbidden" }, 403)
    return c.json(getAdminStats())
})

app.get("/admin/announcements", c => {
    if (!isAdmin(c.req.header("authorization"))) return c.json({ error: "Forbidden" }, 403)
    return c.json({ announcements: listAllAnnouncements() })
})

app.post("/admin/announce", async c => {
    if (!isAdmin(c.req.header("authorization"))) return c.json({ error: "Forbidden" }, 403)
    const body = await c.req
        .json<{
            title?: string
            body?: string
            level?: string
            targetType?: string
            targetValue?: string
            startsAt?: number
            endsAt?: number
        }>()
        .catch(() => ({}) as Record<string, never>)
    if (!isBoundedString(body.title, MAX_ANNOUNCE_TITLE)) return c.json({ error: "title required" }, 400)
    if (!isBoundedString(body.body, MAX_ANNOUNCE_BODY)) return c.json({ error: "body required" }, 400)
    const level = typeof body.level === "string" && VALID_LEVELS.has(body.level) ? body.level : "info"
    const targetType =
        typeof body.targetType === "string" && VALID_TARGETS.has(body.targetType) ? body.targetType : "all"
    const targetValue =
        targetType === "all" ? null : isBoundedString(body.targetValue, MAX_VERSION_LEN) ? body.targetValue : null
    if (targetType !== "all" && !targetValue) return c.json({ error: "targetValue required for this target" }, 400)
    const startsAt = Number.isFinite(body.startsAt)
        ? Math.floor(body.startsAt as number)
        : Math.floor(Date.now() / 1000)
    const endsAt = Number.isFinite(body.endsAt) ? Math.floor(body.endsAt as number) : null
    const id = randomUUID()
    createAnnouncement(id, { title: body.title, body: body.body, level, targetType, targetValue, startsAt, endsAt })
    return c.json({ ok: true, id })
})

app.delete("/admin/announce", async c => {
    if (!isAdmin(c.req.header("authorization"))) return c.json({ error: "Forbidden" }, 403)
    const body = await c.req.json<{ id?: string }>().catch(() => ({}) as { id?: string })
    if (!body.id) return c.json({ error: "id required" }, 400)
    return c.json({ ok: true, deleted: deleteAnnouncement(body.id) })
})

// Public: the app fetches its active announcements, filtered to its browser/version.
app.get("/announcements", c => {
    if (!withinRateLimit(c.req.header("x-forwarded-for"), "announcements", 60, 60 * 1000)) {
        return c.json({ error: "Too many requests" }, 429)
    }
    const browser = c.req.query("browser")?.slice(0, MAX_BROWSER_LEN) ?? null
    const version = c.req.query("version")?.slice(0, MAX_VERSION_LEN) ?? null
    return c.json({ announcements: listActiveAnnouncements(browser, version) })
})

// Outbound click from the website's buy-legit gateway (server-to-server from weeb.ltd's
// /api/out redirect). Anonymous by design; bounded + rate-limited so it can't be flooded.
const MAX_AFFILIATE_SOURCE_LEN = 32
app.post("/affiliate/click", async c => {
    if (!withinRateLimit(c.req.header("x-forwarded-for"), "affiliate-click", 120, 60 * 1000)) {
        return c.json({ error: "Too many requests" }, 429)
    }
    const body = await c.req
        .json<{ source?: string; title?: string; region?: string }>()
        .catch(() => ({}) as { source?: string; title?: string; region?: string })
    if (!isBoundedString(body.source, MAX_AFFILIATE_SOURCE_LEN) || !isBoundedString(body.title, MAX_TITLE_LEN)) {
        return c.json({ error: "source and title required" }, 400)
    }
    const region = typeof body.region === "string" && /^[A-Z]{2}$/.test(body.region) ? body.region : null
    recordAffiliateClick(body.source, body.title, region)
    return c.json({ ok: true })
})

app.get("/admin/affiliate", c => {
    if (!isAdmin(c.req.header("authorization"))) return c.json({ error: "Forbidden" }, 403)
    const days = Math.min(365, Math.max(1, Number(c.req.query("days")) || 30))
    return c.json(getAffiliateStats(days))
})

app.post("/events", async c => {
    if (!withinRateLimit(c.req.header("x-forwarded-for"), "events", 120, 60 * 1000)) {
        return c.json({ error: "Too many requests" }, 429)
    }
    const body = await c.req
        .json<{
            userId?: string
            events?: Array<{
                type?: string
                sourceId?: string
                mangaTitle?: string
                genres?: string[]
                date?: string
                chapter?: string
            }>
        }>()
        .catch(() => ({}))

    if (!body.userId) return c.json({ error: "userId required" }, 400)
    if (!getUserById(body.userId)) return c.json({ error: "User not found" }, 404)
    if (!isAuthorized(body.userId, c.req.header("authorization"))) return c.json({ error: "Not authorized" }, 401)

    const today = new Date().toISOString().slice(0, 10)
    // Guard the shape before iterating: a non-array `events`, or a null/non-object element,
    // must yield zero rows (clean 2xx with an empty batch) rather than throwing an unguarded
    // 500 - matching the field-by-field validation every other route already does.
    const incoming = Array.isArray(body.events) ? body.events : []
    const rows: EventRow[] = incoming
        .filter(
            e =>
                e != null &&
                typeof e === "object" &&
                e.type === "chapter_read" &&
                isBoundedString(e.sourceId, MAX_SOURCE_LEN) &&
                isBoundedString(e.mangaTitle, MAX_TITLE_LEN) &&
                typeof e.date === "string" &&
                e.date.length > 0 &&
                e.date <= today
        )
        .slice(0, 500)
        .map(e => ({
            id: randomUUID(),
            sourceId: e.sourceId!,
            mangaTitle: e.mangaTitle!,
            genres: Array.isArray(e.genres) ? e.genres.filter(g => isBoundedString(g, MAX_GENRE_LEN)).slice(0, 20) : [],
            date: e.date!.slice(0, 10),
            // insertEvents trims + canonicalizes the chapter before it becomes part of the
            // dedup key; here we only bound its length.
            ...(isBoundedString(e.chapter, 32) ? { chapter: e.chapter! } : {})
        }))

    if (rows.length > 0) insertEvents(body.userId, rows)

    const chapters = getUserChapterCount(body.userId)
    const sources = getUserSourceCount(body.userId)
    const allUnlocked = computeUnlocked(chapters, sources)
    const alreadyStored = new Set(getStoredAchievements(body.userId))
    const newAchievements = allUnlocked.filter(id => !alreadyStored.has(id))
    if (newAchievements.length > 0) storeAchievements(body.userId, newAchievements)

    return c.json({
        rank: getUserRank(body.userId),
        newAchievements,
        recommendations: getRecommendations(body.userId)
    })
})

app.post("/rate", async c => {
    if (!withinRateLimit(c.req.header("x-forwarded-for"), "rate", 120, 60 * 1000)) {
        return c.json({ error: "Too many requests" }, 429)
    }
    const body = await c.req.json<{ userId?: string; mangaTitle?: string; rating?: number }>().catch(() => ({}))
    if (!body.userId || !isBoundedString(body.mangaTitle, MAX_TITLE_LEN) || !body.mangaTitle.trim()) {
        return c.json({ error: "userId and a valid mangaTitle required" }, 400)
    }
    if (!getUserById(body.userId)) return c.json({ error: "User not found" }, 404)
    if (!isAuthorized(body.userId, c.req.header("authorization"))) return c.json({ error: "Not authorized" }, 401)
    const rating = Number(body.rating)
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return c.json({ error: "Rating must be 1-5" }, 400)
    upsertRating(body.userId, body.mangaTitle.trim(), rating)
    return c.json({ ok: true })
})

app.get("/recommendations", c => {
    if (!withinRateLimit(c.req.header("x-forwarded-for"), "recommendations", 120, 60 * 1000)) {
        return c.json({ error: "Too many requests" }, 429)
    }
    const userId = c.req.query("userId")?.trim()
    if (!userId) return c.json({ error: "userId required" }, 400)
    if (!getUserById(userId)) return c.json({ error: "User not found" }, 404)
    if (!isAuthorized(userId, c.req.header("authorization"))) return c.json({ error: "Not authorized" }, 401)
    return c.json({ recommendations: getCoReadRecommendations(userId) })
})

app.get("/manga", c => {
    if (!withinRateLimit(c.req.header("x-forwarded-for"), "manga", 120, 60 * 1000)) {
        return c.json({ error: "Too many requests" }, 429)
    }
    const title = c.req.query("title")?.trim()
    if (!title) return c.json({ error: "title required" }, 400)
    if (title.length > MAX_TITLE_LEN) return c.json({ error: "title too long" }, 400)
    return c.json(getMangaStats(title))
})

// /community runs several full-table GROUP BY aggregations per hit; better-sqlite3 is
// synchronous so an unmetered flood blocks the event loop and starves the write endpoints.
app.get("/community", c => {
    if (!withinRateLimit(c.req.header("x-forwarded-for"), "community", 120, 60 * 1000)) {
        return c.json({ error: "Too many requests" }, 429)
    }
    return c.json(getCommunityStats())
})

// Only listen when run directly, not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const port = Number(process.env.PORT ?? 3000)
    serve({ fetch: app.fetch, port }, () => {
        console.log(`[AMR community] :${port}`)
    })
}
