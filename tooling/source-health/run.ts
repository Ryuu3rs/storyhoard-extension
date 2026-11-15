// On-demand source-health check. Probes every registered adapter against a real
// known series and classifies dead / hijacked / migrated / parse-broken sources so
// the manual multi-agent hunt becomes a cheap report a human runs on demand.
//
// Usage: npm run health:sources        (from repo root)
// NEVER runs in CI - it makes real outbound requests and is meant to be read by a
// person. Uses Node global fetch + the shared source-probe signatures.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
    createBoundedRequestClient,
    createOriginAllowlist,
    type FetchFunction,
    type SourceAdapter,
    type SourceContext,
    type SourceManifest
} from "@amr/source-sdk"
import { sourceAdapters } from "@amr/sources"
import {
    fanfoxFamilyAdapters,
    madaraAdapters,
    mangaStreamAdapters,
    mangaBuddyAdapters,
    mangareadAdapter
} from "@amr/sources/sites"
import { BROWSER_HEADERS, CMS, HIJACK, readBoundedBody, SIGNATURES } from "../source-probe/signatures.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "..", "..")
const TARGETS_PATH = join(repoRoot, "packages", "sources", "health-targets.json")
const FIXTURES_DIR = join(repoRoot, "packages", "sources", "src", "__fixtures__")
const OUT_DIR = join(here, "output")
const STATE_PATH = join(OUT_DIR, "health-state.json")
const CONCURRENCY = 5
const TIMEOUT_MS = 20_000
const MAX_BODY = 200_000
const STALE_FIXTURE_DAYS = 90

type Target = { seriesUrl: string; expectTitle?: string; chapterUrl?: string; note?: string }
type Targets = Record<string, Target>

type Verdict =
    | "healthy"
    | "unreachable"
    | "redirected-away"
    | "hijacked"
    | "engine-migrated"
    | "bot-blocked"
    | "parse-broken"
    | "suspect"

// Hard verdicts that mean "this adapter is not usable". "bot-blocked" is alive-but-
// gated (extension has a tab fallback) and "suspect"/"healthy" are not failures.
const DEAD_VERDICTS = new Set<Verdict>([
    "unreachable",
    "redirected-away",
    "hijacked",
    "engine-migrated",
    "parse-broken"
])

const ACTION_HINT: Record<Verdict, string> = {
    healthy: "none",
    "bot-blocked": "none",
    suspect: "investigate",
    unreachable: "investigate",
    "redirected-away": "retire",
    hijacked: "retire",
    "engine-migrated": "retire",
    "parse-broken": "re-fixture"
}

type StateEntry = { verdict: Verdict; raw: Verdict; checkedAt: string }
type State = Record<string, StateEntry>

type Report = {
    id: string
    raw: Verdict
    reported: Verdict
    previous: Verdict | "(none)"
    evidence: string
    actionHint: string
    newlyDead: boolean
}

// Family CMS markers, keyed by adapter id. Absence of these plus an SPA marker is
// the tell for an engine migration off the template the adapter was written for.
// Config-family adapters are grouped by their factory; mangaread is Madara too.
function buildFamilyMarkers(): Map<string, RegExp[]> {
    const map = new Map<string, RegExp[]>()
    const fanfoxMarker = /fanfox|mangahere|detail-info|manga-detail|fmreader|\.mfcdn\.net|chapterlist/i
    for (const a of madaraAdapters) map.set(a.manifest.id, [CMS.madara, CMS.wordpress])
    map.set(mangareadAdapter.manifest.id, [CMS.madara, CMS.wordpress])
    for (const a of mangaStreamAdapters) map.set(a.manifest.id, [CMS.mangastream])
    for (const a of mangaBuddyAdapters) map.set(a.manifest.id, [CMS.mangabuddy])
    for (const a of fanfoxFamilyAdapters) map.set(a.manifest.id, [fanfoxMarker])
    return map
}

function allowedOriginsFor(manifest: SourceManifest): string[] {
    const out = new Set<string>()
    for (const d of manifest.domains) {
        const exactHost = d.replace(/^\*\./, "")
        const bare = exactHost.replace(/^www\./, "")
        out.add(`https://${exactHost}/*`)
        out.add(`*://*.${bare}/*`)
    }
    for (const o of manifest.imageOrigins ?? []) out.add(o)
    return [...out]
}

// Mirrors the extension's production wrapFetch: pass the adapter's own init straight
// through, injecting NOTHING. Adapters that need a browser identity set BROWSER_HEADERS
// themselves (webtoons/asura/mangahub); JSON APIs (MangaDex) are left alone - MangaDex
// actively 400s a synthetic browser User-Agent, so forcing one here would false-flag a
// perfectly healthy adapter as parse-broken. The raw HTML probe below keeps its own
// full browser headers for bot-wall/CMS detection.
const nodeFetch: FetchFunction = async (url, init) => {
    const response = await fetch(url, {
        method: init.method,
        redirect: "follow",
        signal: init.signal,
        ...(init.headers === undefined ? {} : { headers: init.headers }),
        ...(init.body === undefined ? {} : { body: init.body })
    })
    return {
        ok: response.ok,
        status: response.status,
        url: response.url,
        text: () => response.text()
    }
}

function makeContext(manifest: SourceManifest): SourceContext {
    return {
        request: createBoundedRequestClient({
            fetch: nodeFetch,
            allowedOrigins: allowedOriginsFor(manifest),
            // Generous cap: some adapters paginate a chapter list heavily (Webtoons
            // walks up to 50 list pages, one request each). Too low a cap here would
            // masquerade as a parse-broken verdict.
            maxRequests: 60,
            maxResponseBytes: 5_000_000,
            timeoutMs: TIMEOUT_MS,
            maxRetries: 1
        }),
        now: () => Date.now(),
        logger: { debug: () => undefined, warn: () => undefined }
    }
}

type RawProbe = {
    networkError?: string
    status: number
    finalUrl: string
    body: string
}

async function rawProbe(url: string): Promise<RawProbe> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
        const res = await fetch(url, {
            method: "GET",
            redirect: "follow",
            signal: controller.signal,
            headers: BROWSER_HEADERS
        })
        const body = await readBoundedBody(res, MAX_BODY)
        return { status: res.status, finalUrl: res.url || url, body }
    } catch (error) {
        const name = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        return { networkError: name, status: 0, finalUrl: url, body: "" }
    } finally {
        clearTimeout(timer)
    }
}

function matchedHijackBuckets(body: string): string[] {
    return Object.entries(HIJACK)
        .filter(([, re]) => re.test(body))
        .map(([name]) => name)
}

function matchedAntiScrape(body: string, status: number): string[] {
    const hits = Object.entries(SIGNATURES)
        .filter(([, re]) => re.test(body))
        .map(([name]) => name)
    if (status === 403 && !hits.includes("cloudflare") && /cf-ray|cloudflare/i.test(body)) hits.push("cloudflare")
    return hits
}

// Regex-scan the fixture file for a capturedAt/FIXTURE_META date. FIXTURE_META may
// not exist yet - absence is handled by returning undefined (no staleness note).
function fixtureCapturedAt(id: string): string | undefined {
    let text: string
    try {
        text = readFileSync(join(FIXTURES_DIR, `${id}.ts`), "utf8")
    } catch {
        return undefined
    }
    const m = text.match(/capturedAt\s*[:=]\s*["'`]([^"'`]+)["'`]/)
    return m?.[1]
}

function staleFixtureNote(id: string): string {
    const captured = fixtureCapturedAt(id)
    if (!captured) return ""
    const ms = Date.parse(captured)
    if (Number.isNaN(ms)) return ""
    const ageDays = Math.floor((Date.now() - ms) / 86_400_000)
    return ageDays > STALE_FIXTURE_DAYS ? ` fixture stale (${ageDays}d old, captured ${captured})` : ""
}

const familyMarkers = buildFamilyMarkers()

async function classify(adapter: SourceAdapter, target: Target): Promise<{ verdict: Verdict; evidence: string }> {
    const manifest = adapter.manifest
    const probe = await rawProbe(target.seriesUrl)

    // 1. DNS failure / connect timeout on origin.
    if (probe.networkError) {
        return { verdict: "unreachable", evidence: probe.networkError }
    }

    // 2. Final redirect origin outside what production would accept. Uses the same
    // origin allowlist the bounded-request-client enforces in the extension (exact
    // origins + wildcard host/subdomain patterns), so a legitimate bare -> www or
    // any same-family subdomain 301 is NOT false-flagged - only a redirect the real
    // extension would also reject counts as redirected-away. Keeps the retire hint
    // trustworthy.
    let finalOrigin = ""
    try {
        finalOrigin = new URL(probe.finalUrl).origin
    } catch {
        finalOrigin = ""
    }
    const isOriginAllowed = createOriginAllowlist(allowedOriginsFor(manifest))
    if (finalOrigin && !isOriginAllowed(finalOrigin)) {
        return {
            verdict: "redirected-away",
            evidence: `redirects to ${finalOrigin} (status ${probe.status})`
        }
    }

    // 3. Parked / hijack signatures.
    const hijackBuckets = matchedHijackBuckets(probe.body)
    if (hijackBuckets.length > 0) {
        return { verdict: "hijacked", evidence: `parking/hijack markers: ${hijackBuckets.join(", ")}` }
    }

    // 4. 200 but the adapter's engine markers are gone and an SPA marker is present.
    const markers = familyMarkers.get(manifest.id)
    if (probe.status === 200 && markers) {
        const enginePresent = markers.some(re => re.test(probe.body))
        if (!enginePresent && CMS.spa.test(probe.body)) {
            return { verdict: "engine-migrated", evidence: "engine markers absent, SPA markers present" }
        }
    }

    // 5. Bot wall (informational - extension has a tab fallback).
    const antiScrape = matchedAntiScrape(probe.body, probe.status)
    if (antiScrape.length > 0) {
        return { verdict: "bot-blocked", evidence: `bot wall: ${antiScrape.join(", ")}` }
    }

    // 6. Run the real adapter through the bounded client.
    const context = makeContext(manifest)
    try {
        const manga = await adapter.resolveManga({ url: new URL(target.seriesUrl) }, context)
        const chapters = await adapter.listChapters({ manga }, context)
        const title = manga.manga.title
        if (chapters.length === 0) {
            return { verdict: "parse-broken", evidence: `resolved "${title}" but listChapters returned 0 chapters` }
        }
        if (target.expectTitle && !title.toLowerCase().includes(target.expectTitle.toLowerCase())) {
            return {
                verdict: "parse-broken",
                evidence: `title "${title}" lacks expected substring "${target.expectTitle}"`
            }
        }
        // 7. Healthy. Flag the sortKey-0 tripwire (a chapter with sortKey 0 whose
        // title has no "0" is almost always the parse bug, not a real chapter 0).
        const tripwire = chapters.filter(c => c.sortKey === 0 && !c.title.includes("0"))
        const sample = tripwire
            .slice(0, 3)
            .map(c => `"${c.title}"`)
            .join(", ")
        const tripNote =
            tripwire.length > 0
                ? ` [sortKey-0 tripwire: ${tripwire.length} chapter(s), e.g. ${sample}${tripwire.length > 3 ? ", ..." : ""}]`
                : ""
        return { verdict: "healthy", evidence: `${chapters.length} chapters, title "${title}"${tripNote}` }
    } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        return { verdict: "parse-broken", evidence: message }
    }
}

function loadState(): State {
    try {
        return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State
    } catch {
        return {}
    }
}

function loadTargets(): Targets {
    return JSON.parse(readFileSync(TARGETS_PATH, "utf8")) as Targets
}

async function runPool<T, R>(items: T[], worker: (item: T) => Promise<R>): Promise<R[]> {
    const out = new Array<R>(items.length)
    let next = 0
    async function lane(): Promise<void> {
        while (next < items.length) {
            const i = next++
            out[i] = await worker(items[i]!)
        }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, lane))
    return out
}

function toMarkdown(reports: Report[], stamp: string): string {
    const order: Record<string, number> = {
        hijacked: 0,
        "redirected-away": 1,
        "engine-migrated": 2,
        "parse-broken": 3,
        unreachable: 4,
        suspect: 5,
        "bot-blocked": 6,
        healthy: 7
    }
    const sorted = [...reports].sort(
        (a, b) => (order[a.reported] ?? 9) - (order[b.reported] ?? 9) || a.id.localeCompare(b.id)
    )
    const rows = sorted.map(
        r =>
            `| ${r.id} | ${r.newlyDead ? `**${r.reported}**` : r.reported} | ${r.evidence.replace(/\|/g, "\\|")} | ${r.previous} | ${r.actionHint} |`
    )
    const counts = reports.reduce<Record<string, number>>((acc, r) => {
        acc[r.reported] = (acc[r.reported] ?? 0) + 1
        return acc
    }, {})
    const summary = Object.entries(counts)
        .sort((a, b) => (order[a[0]] ?? 9) - (order[b[0]] ?? 9))
        .map(([k, v]) => `${k} ${v}`)
        .join(" · ")
    return [
        `# Source health report`,
        ``,
        `Generated: ${stamp}`,
        ``,
        `Summary: ${summary}`,
        ``,
        `Verdicts: healthy · bot-blocked (alive but gated, not dead) · suspect (first failed run - confirm next run) · unreachable · redirected-away · hijacked · engine-migrated · parse-broken. Bold = newly crossed into a hard-dead state this run.`,
        ``,
        `| adapter | verdict | evidence | previous | action |`,
        `| --- | --- | --- | --- | --- |`,
        ...rows,
        ``
    ].join("\n")
}

async function main(): Promise<void> {
    const targets = loadTargets()
    const state = loadState()
    const nowIso = new Date().toISOString()

    const adapters = sourceAdapters.filter(a => targets[a.manifest.id])
    const missing = sourceAdapters.filter(a => !targets[a.manifest.id]).map(a => a.manifest.id)
    if (missing.length > 0) {
        console.warn(`No health target for: ${missing.join(", ")} (skipped - add them to health-targets.json)`)
    }

    console.log(`Checking ${adapters.length} adapters (concurrency ${CONCURRENCY})...\n`)

    const results = await runPool(adapters, async adapter => {
        const target = targets[adapter.manifest.id]!
        const { verdict: raw, evidence } = await classify(adapter, target)
        return { adapter, raw, evidence }
    })

    const reports: Report[] = []
    const nextState: State = { ...state }

    for (const { adapter, raw, evidence } of results) {
        const id = adapter.manifest.id
        const prev = state[id]
        const isFailure = DEAD_VERDICTS.has(raw)
        // First-time failure is "suspect"; a failure that repeats a prior failure is
        // promoted to the hard verdict. Non-failures report as-is.
        let reported: Verdict
        if (!isFailure) reported = raw
        else if (prev && DEAD_VERDICTS.has(prev.raw)) reported = raw
        else reported = "suspect"

        const newlyDead = DEAD_VERDICTS.has(reported) && prev?.verdict !== reported
        let evidenceLine = evidence
        if (reported === "parse-broken") evidenceLine += staleFixtureNote(id)
        if (reported === "suspect") evidenceLine = `first failed run (raw: ${raw}) - ${evidence}`

        reports.push({
            id,
            raw,
            reported,
            previous: prev?.verdict ?? "(none)",
            evidence: evidenceLine,
            actionHint: ACTION_HINT[reported],
            newlyDead
        })
        nextState[id] = { verdict: reported, raw, checkedAt: nowIso }

        const tag = newlyDead ? "NEW " : ""
        console.log(`[${tag}${reported.toUpperCase().padEnd(15)}] ${id} - ${evidenceLine}`)
    }

    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(STATE_PATH, JSON.stringify(nextState, null, 2))
    writeFileSync(join(OUT_DIR, "health-report.json"), JSON.stringify({ generated: nowIso, reports }, null, 2))
    writeFileSync(join(OUT_DIR, "health-report.md"), toMarkdown(reports, nowIso))

    const newlyDeadCount = reports.filter(r => r.newlyDead).length
    console.log(`\nWrote output/health-report.md, output/health-report.json, output/health-state.json`)
    if (newlyDeadCount > 0) {
        console.error(`\n${newlyDeadCount} adapter(s) newly crossed into a hard-dead state this run.`)
        process.exit(1)
    }
}

main().catch(error => {
    console.error(error)
    process.exit(1)
})
