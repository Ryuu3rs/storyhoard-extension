// Download the Mozilla-signed .xpi for an EXISTING add-on version from the AMO API, so it can be
// attached to a GitHub release for permanent Firefox sideloading. web-ext sign cannot do this: it
// only creates new submissions and errors "Version X already exists" on a version that was already
// submitted (which every released version was, via amo-submit.yml). This reads the signed file via
// the AMO REST API instead.
//
// Env: AMO_JWT_ISSUER, AMO_JWT_SECRET (the AMO API credentials), ADDON_GUID (the gecko id),
// VERSION (the version string, e.g. "0.27.0"), OUT_DIR (where to write the .xpi).
//
// Exit 0 on success (file written), exit 2 when the version exists but is not signed/public yet
// (still in review - re-run later), exit 1 on any other error.

import { createHmac, randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"

const issuer = required("AMO_JWT_ISSUER")
const secret = required("AMO_JWT_SECRET")
const guid = required("ADDON_GUID")
const version = required("VERSION").replace(/^v/, "")
const outDir = process.env.OUT_DIR || "amo-artifacts"
const base = "https://addons.mozilla.org"

function required(name) {
    const v = process.env[name]
    if (!v) {
        console.error(`Missing required env ${name}`)
        process.exit(1)
    }
    return v
}

// A fresh short-lived AMO JWT per request (AMO requires exp within 5 minutes of iat).
function jwt() {
    const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url")
    const now = Math.floor(Date.now() / 1000)
    const head = b64({ alg: "HS256", typ: "JWT" })
    const body = b64({ iss: issuer, jti: randomUUID(), iat: now, exp: now + 180 })
    const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")
    return `${head}.${body}.${sig}`
}

async function apiGet(path) {
    const res = await fetch(path.startsWith("http") ? path : `${base}${path}`, {
        headers: { Authorization: `JWT ${jwt()}`, Accept: "application/json" }
    })
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${(await res.text()).slice(0, 300)}`)
    return res.json()
}

// Walk the version list (paginated) to find the one matching VERSION.
async function findVersion() {
    let url = `/api/v5/addons/addon/${encodeURIComponent(guid)}/versions/?page_size=50`
    while (url) {
        const data = await apiGet(url)
        const hit = (data.results || []).find(v => v.version === version)
        if (hit) return hit
        url = data.next || null
    }
    return null
}

// AMO v5 returns a single `file` per version; older shapes used `files[]`. Handle both.
function fileOf(ver) {
    return ver.file || (Array.isArray(ver.files) ? ver.files[0] : undefined)
}

const ver = await findVersion()
if (!ver) {
    console.error(`Version ${version} not found on AMO for ${guid}.`)
    process.exit(1)
}
const file = fileOf(ver)
const status = file?.status || ver.status
if (!file || !file.url || (status && status !== "public" && status !== "approved")) {
    console.error(
        `Version ${version} is not signed/public yet (status: ${status ?? "unknown"}). Re-run once AMO approves it.`
    )
    process.exit(2)
}

const bin = await fetch(file.url, { headers: { Authorization: `JWT ${jwt()}` } })
if (!bin.ok) {
    console.error(`Downloading the signed file failed -> ${bin.status}`)
    process.exit(1)
}
mkdirSync(outDir, { recursive: true })
const name = (file.url.split("/").pop() || `storyhoard-${version}.xpi`).split("?")[0]
const outPath = `${outDir}/${name.endsWith(".xpi") ? name : `storyhoard-${version}.xpi`}`
writeFileSync(outPath, Buffer.from(await bin.arrayBuffer()))
console.log(`Wrote signed xpi: ${outPath}`)
