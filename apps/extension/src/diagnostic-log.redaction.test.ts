import { describe, expect, it } from "vitest"
import type { LogEntry } from "./database"
import { formatDiagnosticLog } from "./diagnostic-log"

const entry = (message: string, detail?: string): LogEntry =>
    ({ id: 1, ts: 0, level: "warn", scope: "account-sync", message, ...(detail ? { detail } : {}) }) as LogEntry

const DEVICE_LINK = "weeb_Qm9vS0xpbmtUb2tlblZhbHVlMTIzNDU2Nzg5MEFCQ0Rl"
const ACCOUNT_ID = "u_8f3a2c71b9e04d6f"
const ANILIST_JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlLXZhbHVlLWhlcmU"
const GITHUB_PAT = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

function exported(entries: LogEntry[]): string {
    return formatDiagnosticLog(entries, {
        version: "0.0.0",
        browser: "chrome",
        secrets: [DEVICE_LINK, ACCOUNT_ID, ANILIST_JWT, GITHUB_PAT]
    })
}

describe("diagnostic log export redaction", () => {
    it("redacts the known secrets: device link, account id, AniList and GitHub tokens", () => {
        const out = exported([
            entry(`link ${DEVICE_LINK} for ${ACCOUNT_ID}`, JSON.stringify({ a: ANILIST_JWT, g: GITHUB_PAT }))
        ])
        for (const secret of [DEVICE_LINK, ACCOUNT_ID, ANILIST_JWT, GITHUB_PAT]) expect(out).not.toContain(secret)
    })

    it("redacts a device link that is no longer the stored one (rotated or re-linked)", () => {
        const rotated = "weeb_abcdefghijklmnopqrstuvwxyzabcdefghijklmnopq"
        const out = exported([entry(`request failed with Bearer-less token ${rotated}`)])
        expect(out).not.toContain(rotated)
    })

    it("redacts an email address carried in a server error message", () => {
        const out = exported([entry("weeb.ltd request failed: account reader.person@example.org is suspended")])
        expect(out).not.toContain("reader.person@example.org")
    })

    it("redacts a token carried in a URL query string", () => {
        const url =
            "https://reader-host.example/chapter/12?token=4f1c9e0b7a2d5e8f1c3b6a9d0e2f4a7c&sig=abcdefghijklmnopqrstuvwxyz0123"
        const out = exported([entry("page request failed", JSON.stringify({ url }))])
        expect(out).not.toContain("4f1c9e0b7a2d5e8f1c3b6a9d0e2f4a7c")
        expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz0123")
    })
})
