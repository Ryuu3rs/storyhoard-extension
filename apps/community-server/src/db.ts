import Database from "better-sqlite3"
import { join } from "node:path"

const DATA_DIR = process.env.DATA_DIR ?? "./data"
const db = new Database(join(DATA_DIR, "community.db"))
db.pragma("journal_mode = WAL")
db.pragma("foreign_keys = ON")

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id   TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL COLLATE NOCASE,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS events (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_id  TEXT NOT NULL,
        manga_title TEXT NOT NULL,
        genres     TEXT NOT NULL DEFAULT '[]',
        date       TEXT NOT NULL,
        synced_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
    CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id);

    CREATE TABLE IF NOT EXISTS user_achievements (
        user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        achievement_id TEXT NOT NULL,
        unlocked_at    INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (user_id, achievement_id)
    );

    CREATE TABLE IF NOT EXISTS ratings (
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        manga_title TEXT NOT NULL,
        rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (user_id, manga_title)
    );
    CREATE INDEX IF NOT EXISTS idx_ratings_title ON ratings(manga_title);

    -- Anonymous per-install rows for cross-browser install/active counts. install_id is a
    -- random client id (NOT a user identifier); user_id is only linked once a user opts in
    -- and registers, so it stays NULL for installs that never enable community features.
    CREATE TABLE IF NOT EXISTS installs (
        install_id TEXT PRIMARY KEY,
        user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
        browser    TEXT,
        version    TEXT,
        first_seen INTEGER NOT NULL DEFAULT (unixepoch()),
        last_seen  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_installs_last_seen ON installs(last_seen);

    -- Owner-authored broadcast messages shown as a banner in the app. Targeted to all
    -- installs, or filtered by browser / extension version. starts_at/ends_at bound the
    -- active window (ends_at NULL = no expiry).
    CREATE TABLE IF NOT EXISTS announcements (
        id           TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        body         TEXT NOT NULL,
        level        TEXT NOT NULL DEFAULT 'info',
        target_type  TEXT NOT NULL DEFAULT 'all',
        target_value TEXT,
        starts_at    INTEGER NOT NULL DEFAULT (unixepoch()),
        ends_at      INTEGER,
        created_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_announcements_window ON announcements(starts_at, ends_at);

    -- Outbound affiliate / official-source clicks from the website's buy-legit gateway.
    -- No user identity: just which source, which title, which storefront region, when.
    CREATE TABLE IF NOT EXISTS affiliate_clicks (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        source     TEXT NOT NULL,
        title      TEXT NOT NULL,
        region     TEXT,
        clicked_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_time ON affiliate_clicks(clicked_at);
`)

// Schema additions kept idempotent so a restart on an older database upgrades in place.
const eventCols = (db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>).map(c => c.name)
if (!eventCols.includes("chapter")) db.exec("ALTER TABLE events ADD COLUMN chapter TEXT")
// Dedup used to be one row per title per day, which collapsed a 20-chapter binge into a
// single "chapter read". Rows now dedup per chapter; rows without a chapter keep the old
// per-day behaviour through COALESCE so older clients still cannot double-count.
db.exec(`
    DROP INDEX IF EXISTS idx_events_dedup;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedup_chapter
        ON events(user_id, manga_title, date, source_id, COALESCE(chapter, ''));
`)

// Known source display names (mirrors the adapter manifest names in packages/sources). Used
// to strip a trailing " | <source>" that some adapters append to a title. Matching a fixed
// name list - rather than "any short trailing segment" - is what keeps a real subtitle like
// "Attack on Titan | Before the Fall" intact while still collapsing "One Piece | Weeb Central"
// onto "One Piece". A source missing from this list just isn't stripped (a harmless split),
// never a wrong merge. community-server is built in isolation (no @amr/sources import), so the
// list is inlined; add new source names here when adapters are added.
const SOURCE_NAMES = new Set(
    [
        "AGR Comics",
        "Aqua Manga",
        "Aqua Scans",
        "Arven Comics",
        "Arven Scans",
        "Asura Comic",
        "Asura Scans",
        "BrainRotComics",
        "Casa Comic",
        "Comix",
        "DragonTea",
        "Drake Comic",
        "Dynasty Scans",
        "EA Hentai",
        "FanFox",
        "Flame Comics",
        "GD Scans",
        "HariManga",
        "HenTalk",
        "Hentai20",
        "HentaiRead",
        "HiveToon",
        "Kagane",
        "Kappa Beast",
        "KunManga",
        "LHTranslation",
        "LikeManga",
        "Manga District",
        "Manga Galaxy",
        "MangaBuddy",
        "MangaDex",
        "MangaFreak",
        "MangaHere",
        "MangaHub",
        "MangaK",
        "MangaKatana",
        "MangaMirror",
        "MangaNato",
        "MangaPark",
        "MangaPuma",
        "MangaRead",
        "MangaSushi",
        "ManhuaPlus",
        "ManhuaTop",
        "ManhuaUS",
        "Manhwa Hentai",
        "ManhwaTop",
        "ManyToon",
        "MgRead",
        "Mgeko",
        "NatoManga",
        "Novelmic",
        "Nyanu Kafe",
        "OlympusStaff",
        "Omega Scans",
        "Oppai Stream",
        "Phoenix Scans",
        "Rawkuma",
        "S2Manga",
        "SauceManhwa",
        "Spider Scans",
        "Surya Toon",
        "Temple Scan",
        "Thunder Scans EN",
        "Tritinia Scans",
        "UToon",
        "WEBTOON",
        "Weeb Central"
    ].map(n => n.toLowerCase())
)

// Strip a trailing " | <source name>" (ASCII or fullwidth pipe) so the same series groups
// across sources and the trending list is not split. Only the LAST segment is considered, and
// only when it is a known source name, so a real subtitle is never removed. Idempotent: a title
// already stripped has no trailing source segment left to match.
export function normalizeTitle(title: string): string {
    const match = title.match(/^(.*)[|｜]\s*([^|｜]+?)\s*$/)
    const tail = match?.[2]
    if (match && tail && SOURCE_NAMES.has(tail.toLowerCase())) {
        const head = match[1]!.trim()
        if (head.length >= 2) return head
    }
    return title.trim()
}

// Additive migration for existing DBs: consent bookkeeping on users. better-sqlite3's
// ALTER TABLE throws "duplicate column" if the column already exists, so guard on
// table_info rather than blindly ALTERing on every boot.
function addColumnIfMissing(table: string, column: string, ddl: string): void {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
}
addColumnIfMissing("users", "consent_version", "consent_version INTEGER")
addColumnIfMissing("users", "consent_at", "consent_at INTEGER")
addColumnIfMissing("users", "secret_hash", "secret_hash TEXT")
// Set by weeb.ltd for a linked account it knows is under 18. Unknown age stays 0 (owner, 7 Nov).
addColumnIfMissing("users", "minor", "minor INTEGER NOT NULL DEFAULT 0")

function weekBounds(): [string, string] {
    const now = new Date()
    const day = now.getUTCDay()
    const diffToMonday = day === 0 ? -6 : 1 - day
    const mon = new Date(now)
    mon.setUTCDate(now.getUTCDate() + diffToMonday)
    const sun = new Date(mon)
    sun.setUTCDate(mon.getUTCDate() + 6)
    const fmt = (d: Date) => d.toISOString().slice(0, 10)
    return [fmt(mon), fmt(sun)]
}

export function createUser(id: string, username: string, consentVersion = 1, secretHash: string | null = null): void {
    db.prepare(
        "INSERT INTO users (id, username, consent_version, consent_at, secret_hash) VALUES (?, ?, ?, unixepoch(), ?)"
    ).run(id, username, consentVersion, secretHash)
}

export function getUserSecretHash(id: string): string | null | undefined {
    const row = db.prepare("SELECT secret_hash FROM users WHERE id = ?").get(id) as
        | { secret_hash: string | null }
        | undefined
    return row?.secret_hash
}

// True only for the request that actually set it, so two claims cannot both get a secret.
export function claimUserSecret(id: string, secretHash: string): boolean {
    return (
        db.prepare("UPDATE users SET secret_hash = ? WHERE id = ? AND secret_hash IS NULL").run(secretHash, id)
            .changes === 1
    )
}

export function getUserByUsername(username: string): { id: string; username: string } | undefined {
    return db.prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE").get(username) as
        | { id: string; username: string }
        | undefined
}

export function getUserById(id: string): { id: string; username: string } | undefined {
    return db.prepare("SELECT id, username FROM users WHERE id = ?").get(id) as
        | { id: string; username: string }
        | undefined
}

// GDPR erasure: removing the user row cascades to events, ratings, and achievements
// (ON DELETE CASCADE) and nulls the link on any install row. Returns whether a row existed.
export function deleteUser(id: string): boolean {
    return db.prepare("DELETE FROM users WHERE id = ?").run(id).changes > 0
}

export function setUserMinor(id: string, minor: boolean): boolean {
    return db.prepare("UPDATE users SET minor = ? WHERE id = ?").run(minor ? 1 : 0, id).changes > 0
}

export type UserExport = {
    user: { id: string; username: string; createdAt: number; consentVersion: number | null; consentAt: number | null }
    events: Array<{ sourceId: string; title: string; genres: string[]; chapter: string | null; date: string }>
    ratings: Array<{ title: string; rating: number; updatedAt: number }>
    achievements: Array<{ id: string; unlockedAt: number }>
    installs: Array<{
        installId: string
        browser: string | null
        version: string | null
        firstSeen: number
        lastSeen: number
    }>
}

function parseGenres(raw: string): string[] {
    try {
        const parsed: unknown = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === "string") : []
    } catch {
        return []
    }
}

// Everything held about one community user, for the weeb.ltd data export.
export function exportUser(id: string): UserExport | undefined {
    const user = db
        .prepare(
            "SELECT id, username, created_at as createdAt, consent_version as consentVersion, consent_at as consentAt FROM users WHERE id = ?"
        )
        .get(id) as UserExport["user"] | undefined
    if (!user) return undefined
    const events = (
        db
            .prepare(
                "SELECT source_id as sourceId, manga_title as title, genres, chapter, date FROM events WHERE user_id = ? ORDER BY date, synced_at"
            )
            .all(id) as Array<Omit<UserExport["events"][number], "genres"> & { genres: string }>
    ).map(e => ({ ...e, genres: parseGenres(e.genres) }))
    const ratings = db
        .prepare(
            "SELECT manga_title as title, rating, updated_at as updatedAt FROM ratings WHERE user_id = ? ORDER BY manga_title"
        )
        .all(id) as UserExport["ratings"]
    const achievements = db
        .prepare(
            "SELECT achievement_id as id, unlocked_at as unlockedAt FROM user_achievements WHERE user_id = ? ORDER BY unlocked_at"
        )
        .all(id) as UserExport["achievements"]
    const installs = db
        .prepare(
            "SELECT install_id as installId, browser, version, first_seen as firstSeen, last_seen as lastSeen FROM installs WHERE user_id = ? ORDER BY first_seen"
        )
        .all(id) as UserExport["installs"]
    return { user, events, ratings, achievements, installs }
}

// Anonymous install/active ping. Upserts the install row (first_seen kept, last_seen bumped)
// and links a user_id only if the caller is a registered, opted-in user.
export function recordInstallPing(installId: string, browser: string | null, version: string | null): void {
    db.prepare(
        `INSERT INTO installs (install_id, browser, version, first_seen, last_seen)
         VALUES (?, ?, ?, unixepoch(), unixepoch())
         ON CONFLICT (install_id) DO UPDATE SET
            browser = excluded.browser, version = excluded.version, last_seen = unixepoch()`
    ).run(installId, browser, version)
}

export function linkInstallToUser(installId: string, userId: string): void {
    db.prepare(
        `INSERT INTO installs (install_id, user_id, first_seen, last_seen)
         VALUES (?, ?, unixepoch(), unixepoch())
         ON CONFLICT (install_id) DO UPDATE SET user_id = excluded.user_id, last_seen = unixepoch()`
    ).run(installId, userId)
}

// Admin-only install dashboard: totals, 7-day active, and per-browser / per-version splits.
export function getInstallStats(): {
    total: number
    active7d: number
    byBrowser: Array<{ browser: string; count: number }>
    byVersion: Array<{ version: string; count: number }>
} {
    const total = (db.prepare("SELECT COUNT(*) as n FROM installs").get() as { n: number }).n
    const active7d = (
        db.prepare("SELECT COUNT(*) as n FROM installs WHERE last_seen >= unixepoch() - 7 * 86400").get() as {
            n: number
        }
    ).n
    const byBrowser = db
        .prepare(
            "SELECT COALESCE(browser, 'unknown') as browser, COUNT(*) as count FROM installs GROUP BY browser ORDER BY count DESC"
        )
        .all() as Array<{ browser: string; count: number }>
    const byVersion = db
        .prepare(
            "SELECT COALESCE(version, 'unknown') as version, COUNT(*) as count FROM installs GROUP BY version ORDER BY count DESC LIMIT 20"
        )
        .all() as Array<{ version: string; count: number }>
    return { total, active7d, byBrowser, byVersion }
}

export type EventRow = {
    id: string
    sourceId: string
    mangaTitle: string
    genres: string[]
    date: string
    chapter?: string
}

const _insertEvent = db.prepare(
    "INSERT OR IGNORE INTO events (id, user_id, source_id, manga_title, genres, date, chapter) VALUES (?, ?, ?, ?, ?, ?, ?)"
)
const _knownGenres = db.prepare("SELECT genres FROM events WHERE manga_title = ? AND genres != '[]' LIMIT 1")
const _backfillGenres = db.prepare("UPDATE events SET genres = ? WHERE manga_title = ? AND genres = '[]'")

// Genres ride along on each event but the extension only knows them once a title has been
// enriched, so many rows arrive empty. Any row that does carry genres fills the gaps for
// every other row of the same title, in both directions, so genre stats stop under-counting.
export const insertEvents = db.transaction((userId: string, rows: EventRow[]) => {
    for (const e of rows) {
        const title = normalizeTitle(e.mangaTitle)
        let genres = e.genres
        if (genres.length === 0) {
            const known = _knownGenres.get(title) as { genres: string } | undefined
            // Guard the parse: a single malformed stored value must not abort the whole
            // transaction (which would 500 the /events batch and drop every sibling row).
            if (known) {
                try {
                    genres = JSON.parse(known.genres) as string[]
                } catch {
                    genres = []
                }
            }
        }
        // Canonicalize the chapter before it forms the dedup key: trim (so "5" / " 5" / "5 "
        // are one key), fold a numeric chapter ("05" / "5.0" -> "5"), and treat empty as
        // no-chapter (NULL -> per-day dedup). A non-numeric label like the extension's
        // "h<hash>" for an unnumbered chapter passes through untouched.
        let chapter = typeof e.chapter === "string" ? e.chapter.trim() : ""
        if (/^\d+(\.\d+)?$/.test(chapter)) chapter = String(Number(chapter))
        _insertEvent.run(
            e.id,
            userId,
            e.sourceId,
            title,
            JSON.stringify(genres),
            e.date,
            chapter.length > 0 ? chapter : null
        )
        if (genres.length > 0) _backfillGenres.run(JSON.stringify(genres), title)
    }
})

export function getUserChapterCount(userId: string): number {
    return (db.prepare("SELECT COUNT(*) as n FROM events WHERE user_id = ?").get(userId) as { n: number }).n
}

export function getUserSourceCount(userId: string): number {
    return (
        db.prepare("SELECT COUNT(DISTINCT source_id) as n FROM events WHERE user_id = ?").get(userId) as { n: number }
    ).n
}

export function getStoredAchievements(userId: string): string[] {
    return (
        db.prepare("SELECT achievement_id FROM user_achievements WHERE user_id = ?").all(userId) as Array<{
            achievement_id: string
        }>
    ).map(r => r.achievement_id)
}

const _insertAchievement = db.prepare("INSERT OR IGNORE INTO user_achievements (user_id, achievement_id) VALUES (?, ?)")

export function storeAchievements(userId: string, ids: string[]): void {
    for (const id of ids) _insertAchievement.run(userId, id)
}

export function getUserRank(userId: string): number | null {
    const [start, end] = weekBounds()
    const row = db
        .prepare(
            `WITH weekly AS (
                SELECT user_id, COUNT(*) as n FROM events
                WHERE date >= ? AND date <= ? GROUP BY user_id
            ),
            ranked AS (
                SELECT user_id, RANK() OVER (ORDER BY n DESC) as rank FROM weekly
            )
            SELECT rank FROM ranked WHERE user_id = ?`
        )
        .get(start, end, userId) as { rank: number } | undefined
    return row?.rank ?? null
}

// A candidate title must be read by at least this many distinct users before it can be
// surfaced by any recommender. Without this floor, a title read by a single other user leaks
// that one user's private library (an intersection/probe deanonymization).
const MIN_DISTINCT_READERS = 3

export function getRecommendations(userId: string): Array<{ title: string; sourceId: string }> {
    return db
        .prepare(
            `WITH user_genres AS (
                SELECT value as genre, COUNT(*) as cnt
                FROM events, json_each(genres)
                WHERE user_id = ? AND json_valid(genres) GROUP BY genre ORDER BY cnt DESC LIMIT 3
            ),
            user_titles AS (
                SELECT DISTINCT manga_title FROM events WHERE user_id = ?
            )
            SELECT e.manga_title as title, e.source_id as sourceId, COUNT(DISTINCT e.user_id) as cnt
            FROM events e
            WHERE e.user_id != ?
                AND e.manga_title NOT IN (SELECT manga_title FROM user_titles)
                AND json_valid(e.genres)
                AND EXISTS (
                    SELECT 1 FROM json_each(e.genres) g
                    JOIN user_genres ug ON g.value = ug.genre
                )
            GROUP BY e.manga_title
            HAVING COUNT(DISTINCT e.user_id) >= ?
            ORDER BY cnt DESC LIMIT 5`
        )
        .all(userId, userId, userId, MIN_DISTINCT_READERS) as Array<{ title: string; sourceId: string }>
}

export function getCoReadRecommendations(userId: string): Array<{ title: string; sourceId: string }> {
    return db
        .prepare(
            `WITH my_titles AS (
                SELECT DISTINCT manga_title FROM events WHERE user_id = ?
            ),
            co_readers AS (
                SELECT user_id, COUNT(DISTINCT manga_title) AS overlap
                FROM events
                WHERE user_id != ?
                    AND manga_title IN (SELECT manga_title FROM my_titles)
                GROUP BY user_id
            ),
            candidates AS (
                SELECT e.user_id AS user_id, e.manga_title AS manga_title, e.source_id AS source_id
                FROM events e
                JOIN co_readers cr ON e.user_id = cr.user_id
                WHERE e.manga_title NOT IN (SELECT manga_title FROM my_titles)
                GROUP BY e.user_id, e.manga_title
            )
            SELECT c.manga_title AS title, c.source_id AS sourceId, SUM(cr.overlap) AS score
            FROM candidates c
            JOIN co_readers cr ON c.user_id = cr.user_id
            GROUP BY c.manga_title
            HAVING COUNT(DISTINCT c.user_id) >= ?
            ORDER BY score DESC, c.manga_title ASC LIMIT 10`
        )
        .all(userId, userId, MIN_DISTINCT_READERS) as Array<{ title: string; sourceId: string }>
}

export function upsertRating(userId: string, mangaTitle: string, rating: number): void {
    // Normalize on the same rule as events, so a rating and a read of the same series key on
    // the same title - otherwise ratings (raw) and reader counts (normalized) never join.
    const title = normalizeTitle(mangaTitle)
    db.prepare(
        `INSERT INTO ratings (user_id, manga_title, rating, updated_at) VALUES (?, ?, ?, unixepoch())
         ON CONFLICT (user_id, manga_title) DO UPDATE SET rating = excluded.rating, updated_at = unixepoch()`
    ).run(userId, title, rating)
}

export function getMangaStats(mangaTitle: string): {
    avgRating: number | null
    ratingCount: number
    readerCount: number
} {
    const title = normalizeTitle(mangaTitle)
    const r = db
        .prepare("SELECT ROUND(AVG(rating), 1) as avg, COUNT(*) as cnt FROM ratings WHERE manga_title = ?")
        .get(title) as { avg: number | null; cnt: number }
    const u = db.prepare("SELECT COUNT(DISTINCT user_id) as cnt FROM events WHERE manga_title = ?").get(title) as {
        cnt: number
    }
    // Apply the same k-anonymity floor the recommenders use. This endpoint is public and
    // unauthenticated, so exposing an exact avgRating for a lone rater discloses that one
    // user's private rating, and a sub-floor readerCount discloses a single user's presence.
    // Below the floor, suppress the precise values (indistinguishable from "no data").
    const enoughRaters = r.cnt >= MIN_DISTINCT_READERS
    const enoughReaders = u.cnt >= MIN_DISTINCT_READERS
    return {
        avgRating: enoughRaters ? r.avg : null,
        ratingCount: enoughRaters ? r.cnt : 0,
        readerCount: enoughReaders ? u.cnt : 0
    }
}

export function getTopRated(): Array<{ title: string; avgRating: number; ratingCount: number }> {
    return db
        .prepare(
            `SELECT manga_title as title, ROUND(AVG(rating), 1) as avgRating, COUNT(*) as ratingCount
             FROM ratings GROUP BY manga_title HAVING COUNT(*) >= 3
             ORDER BY avgRating DESC, ratingCount DESC LIMIT 10`
        )
        .all() as Array<{ title: string; avgRating: number; ratingCount: number }>
}

export function getCommunityStats(): {
    leaderboard: Array<{ rank: number; username: string; chaptersWeek: number }>
    trendingManga: Array<{ title: string; sourceId: string; count: number }>
    topGenres: Array<{ genre: string; count: number }>
    topRated: Array<{ title: string; avgRating: number; ratingCount: number }>
    totalUsers: number
} {
    const [start, end] = weekBounds()

    const leaderboard = db
        .prepare(
            `SELECT u.username, COUNT(*) as chaptersWeek,
                RANK() OVER (ORDER BY COUNT(*) DESC) as rank
            FROM events e JOIN users u ON e.user_id = u.id
            WHERE e.date >= ? AND e.date <= ? AND u.minor = 0
            GROUP BY e.user_id ORDER BY chaptersWeek DESC LIMIT 10`
        )
        .all(start, end) as Array<{ rank: number; username: string; chaptersWeek: number }>

    const trendingManga = db
        .prepare(
            `SELECT manga_title as title, source_id as sourceId, COUNT(DISTINCT user_id) as count
            FROM events WHERE date >= ? AND date <= ?
            GROUP BY manga_title
            HAVING COUNT(DISTINCT user_id) >= ?
            ORDER BY count DESC LIMIT 5`
        )
        .all(start, end, MIN_DISTINCT_READERS) as Array<{ title: string; sourceId: string; count: number }>

    const topGenres = db
        .prepare(
            `SELECT value as genre, COUNT(*) as count
            FROM events, json_each(genres)
            WHERE date >= ? AND date <= ? AND json_valid(genres)
            GROUP BY genre ORDER BY count DESC LIMIT 10`
        )
        .all(start, end) as Array<{ genre: string; count: number }>

    const totalUsers = (db.prepare("SELECT COUNT(*) as n FROM users").get() as { n: number }).n

    return { leaderboard, trendingManga, topGenres, topRated: getTopRated(), totalUsers }
}

// --- Announcements (owner broadcast) + admin dashboard stats ---

export type AnnouncementInput = {
    title: string
    body: string
    level: string
    targetType: string
    targetValue: string | null
    startsAt: number
    endsAt: number | null
}
export type Announcement = AnnouncementInput & { id: string; createdAt: number }

type AnnouncementRow = {
    id: string
    title: string
    body: string
    level: string
    target_type: string
    target_value: string | null
    starts_at: number
    ends_at: number | null
    created_at: number
}

function rowToAnnouncement(r: AnnouncementRow): Announcement {
    return {
        id: r.id,
        title: r.title,
        body: r.body,
        level: r.level,
        targetType: r.target_type,
        targetValue: r.target_value,
        startsAt: r.starts_at,
        endsAt: r.ends_at,
        createdAt: r.created_at
    }
}

export function createAnnouncement(id: string, a: AnnouncementInput): void {
    db.prepare(
        `INSERT INTO announcements (id, title, body, level, target_type, target_value, starts_at, ends_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, a.title, a.body, a.level, a.targetType, a.targetValue, a.startsAt, a.endsAt)
}

export function deleteAnnouncement(id: string): boolean {
    return db.prepare("DELETE FROM announcements WHERE id = ?").run(id).changes > 0
}

export function listAllAnnouncements(): Announcement[] {
    return (db.prepare("SELECT * FROM announcements ORDER BY created_at DESC").all() as AnnouncementRow[]).map(
        rowToAnnouncement
    )
}

// Public feed for the app: only announcements currently in their active window and matching
// the caller's browser/version (or targeted at everyone).
export function listActiveAnnouncements(browser: string | null, version: string | null): Announcement[] {
    const now = Math.floor(Date.now() / 1000)
    return (
        db
            .prepare(
                `SELECT * FROM announcements
                 WHERE starts_at <= ? AND (ends_at IS NULL OR ends_at > ?)
                   AND (target_type = 'all'
                        OR (target_type = 'browser' AND target_value = ?)
                        OR (target_type = 'version' AND target_value = ?))
                 ORDER BY created_at DESC`
            )
            .all(now, now, browser, version) as AnnouncementRow[]
    ).map(rowToAnnouncement)
}

export function getAdminStats(): {
    installs: ReturnType<typeof getInstallStats>
    users: number
    usersWithoutSecret: number
    ratings: number
    events: number
    announcements: number
} {
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n
    return {
        installs: getInstallStats(),
        users: count("SELECT COUNT(*) as n FROM users"),
        usersWithoutSecret: count("SELECT COUNT(*) as n FROM users WHERE secret_hash IS NULL"),
        ratings: count("SELECT COUNT(*) as n FROM ratings"),
        events: count("SELECT COUNT(*) as n FROM events"),
        announcements: count("SELECT COUNT(*) as n FROM announcements")
    }
}

// --- Affiliate click tracking (website buy-legit gateway) ---

export function recordAffiliateClick(source: string, title: string, region: string | null): void {
    db.prepare("INSERT INTO affiliate_clicks (source, title, region) VALUES (?, ?, ?)").run(source, title, region)
}

export type AffiliateStats = {
    days: number
    total: number
    window: number
    bySource: Array<{ source: string; count: number }>
    byRegion: Array<{ region: string; count: number }>
    topTitles: Array<{ title: string; count: number }>
}

export function getAffiliateStats(days: number): AffiliateStats {
    const since = Math.floor(Date.now() / 1000) - days * 86400
    const total = (db.prepare("SELECT COUNT(*) as n FROM affiliate_clicks").get() as { n: number }).n
    const window = (
        db.prepare("SELECT COUNT(*) as n FROM affiliate_clicks WHERE clicked_at >= ?").get(since) as { n: number }
    ).n
    const bySource = db
        .prepare(
            `SELECT source, COUNT(*) as count FROM affiliate_clicks WHERE clicked_at >= ?
             GROUP BY source ORDER BY count DESC`
        )
        .all(since) as Array<{ source: string; count: number }>
    const byRegion = db
        .prepare(
            `SELECT COALESCE(region, '??') as region, COUNT(*) as count FROM affiliate_clicks
             WHERE clicked_at >= ? GROUP BY region ORDER BY count DESC`
        )
        .all(since) as Array<{ region: string; count: number }>
    const topTitles = db
        .prepare(
            `SELECT title, COUNT(*) as count FROM affiliate_clicks WHERE clicked_at >= ?
             GROUP BY title ORDER BY count DESC LIMIT 25`
        )
        .all(since) as Array<{ title: string; count: number }>
    return { days, total, window, bySource, byRegion, topTitles }
}
