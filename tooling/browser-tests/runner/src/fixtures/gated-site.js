import { createSign, generateKeyPairSync } from "node:crypto"
import { createServer as createHttpServer } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import { connect } from "node:net"

// A made-up site for the user-gate tests in both browsers. It runs on this machine and both browsers are
// pointed at it for this one host, so a real background fetch goes through the real network stack and the
// test can see whether the browser really attached a cookie. Route interception cannot show that, because
// a request answered at that layer has not had its cookies added yet.

export const HOST = "gated-demo.net"
export const ORIGIN = `https://${HOST}`
export const TITLE = "Starlit Harbor"
export const SERIES_URL = `${ORIGIN}/manga/gated-demo`
export const REFUSED_TITLE = "Plainly Refused Series"
export const MOVED_TITLE = "Moved Series"

const CLEARANCE = "gate_clearance=passed"
const CHALLENGE_HTML = `<!doctype html><html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>`
const SERIES_HTML = `<!doctype html><html><head><meta property="og:title" content="${TITLE}"><title>${TITLE}</title></head><body>
<a href="/manga/gated-demo/ch-1">Chapter 1</a>
<a href="/manga/gated-demo/ch-2">Chapter 2</a>
</body></html>`

function der(tag, ...parts) {
    const body = Buffer.concat(parts)
    const length =
        body.length < 0x80
            ? Buffer.from([body.length])
            : body.length < 0x100
              ? Buffer.from([0x81, body.length])
              : Buffer.from([0x82, body.length >> 8, body.length & 0xff])
    return Buffer.concat([Buffer.from([tag]), length, body])
}

// A throwaway self-signed certificate made at test time, so no key is ever committed. Both browsers are
// told to ignore certificate errors for these tests.
function selfSignedCertificate() {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const sequence = (...parts) => der(0x30, ...parts)
    const objectId = hex => der(0x06, Buffer.from(hex, "hex"))
    const utcTime = text => der(0x17, Buffer.from(text))
    const sha256WithRsa = sequence(objectId("2a864886f70d01010b"), der(0x05))
    const name = sequence(der(0x31, sequence(objectId("550403"), der(0x0c, Buffer.from(HOST)))))
    const certificateBody = sequence(
        der(0xa0, der(0x02, Buffer.from([2]))),
        der(0x02, Buffer.from([1])),
        sha256WithRsa,
        name,
        sequence(utcTime("250101000000Z"), utcTime("351231235959Z")),
        name,
        publicKey.export({ type: "spki", format: "der" })
    )
    const signature = createSign("sha256").update(certificateBody).sign(privateKey)
    const certificate = sequence(
        certificateBody,
        sha256WithRsa,
        der(0x03, Buffer.concat([Buffer.from([0]), signature]))
    )
    const lines = certificate
        .toString("base64")
        .match(/.{1,64}/g)
        .join("\n")
    return {
        key: privateKey.export({ type: "pkcs8", format: "pem" }),
        cert: `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`
    }
}

// Answers like a site behind a bot check: a page without the clearance cookie gets the challenge, and
// loading a page in a real tab is what passes it. `proxyPort` is for a browser that can only reach this
// host through a proxy; it refuses to connect anywhere else, so nothing leaves the machine.
export async function startGatedSite() {
    const requests = []
    const site = createHttpsServer(selfSignedCertificate(), (request, response) => {
        const path = request.url ?? "/"
        const hasCookie = (request.headers["cookie"] ?? "").includes(CLEARANCE)
        const inTab = request.headers["sec-fetch-dest"] === "document"
        requests.push({ path, method: request.method, hasCookie, inTab })
        const send = (status, body, headers = {}) => {
            response.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers })
            response.end(body)
        }
        if (path.startsWith("/manga/moved")) return send(302, "", { location: "/manga/gated-demo" })
        if (path.startsWith("/manga/refused")) return send(403, "<html><body>Forbidden</body></html>")
        if (hasCookie) return send(200, SERIES_HTML)
        return send(403, CHALLENGE_HTML, inTab ? { "set-cookie": `${CLEARANCE}; Path=/; Secure; SameSite=Lax` } : {})
    })
    await new Promise(resolve => site.listen(0, "127.0.0.1", resolve))
    const sitePort = site.address().port

    const proxy = createHttpServer((_request, response) => {
        response.writeHead(403)
        response.end()
    })
    proxy.on("connect", (request, client, head) => {
        if (request.url !== `${HOST}:443`) {
            client.end("HTTP/1.1 403 Forbidden\r\n\r\n")
            return
        }
        const upstream = connect(sitePort, "127.0.0.1", () => {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
            upstream.write(head)
            upstream.pipe(client)
            client.pipe(upstream)
        })
        upstream.on("error", () => client.destroy())
        client.on("error", () => upstream.destroy())
    })
    await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve))

    return {
        requests,
        sitePort,
        proxyPort: proxy.address().port,
        close: async () => {
            site.closeAllConnections()
            proxy.closeAllConnections()
            await Promise.all([
                new Promise(resolve => site.close(resolve)),
                new Promise(resolve => proxy.close(resolve))
            ])
        }
    }
}

const PROFILE = {
    profileFormat: 2,
    id: HOST,
    name: "Gated Demo",
    engine: "generic",
    origin: ORIGIN,
    domains: [HOST],
    languages: ["en"],
    capabilities: ["chapters", "manga"],
    numberingKind: "chapter",
    requestRateLimit: { requests: 50, intervalMs: 1000 },
    origins: [`${ORIGIN}/*`],
    match: { manga: "^/manga/([a-z0-9-]+)/?$", chapter: "^/manga/([a-z0-9-]+)/ch-([0-9.]+)/?$" },
    series: { urlTemplate: "/manga/{slug}", titlePattern: '<meta property="og:title" content="(?<title>[^"]+)"' },
    list: {
        itemPattern:
            '<a href="(?<chapterUrl>/manga/[a-z0-9-]+/ch-(?<chapterNumber>[0-9.]+))">(?<chapterTitle>[^<]*)</a>'
    }
}

// What the app's own import takes: followed titles on the made-up site, plus that site's profile.
export function libraryEnvelope(titles = [{ slug: "gated-demo", title: TITLE }], now = Date.now()) {
    const mangaId = slug => `${HOST}:manga:${slug}`
    return {
        format: "all-mangas-reader",
        version: 1,
        data: {
            manga: titles.map(({ slug, title }) => ({
                id: mangaId(slug),
                title,
                normalizedTitle: title.toLowerCase(),
                authors: [],
                status: "ongoing",
                addedAt: now,
                updatedAt: now,
                sourceId: HOST,
                sourceMangaId: slug,
                sourceUrl: `${ORIGIN}/manga/${slug}`,
                mangaUrl: `${ORIGIN}/manga/${slug}`
            })),
            sourceLinks: titles.map(({ slug }) => ({
                mangaId: mangaId(slug),
                sourceId: HOST,
                sourceMangaId: slug,
                url: `${ORIGIN}/manga/${slug}`,
                addedAt: now,
                updatedAt: now
            })),
            archProfiles: [{ id: HOST, profile: PROFILE, importedAt: now, origin: "user" }]
        }
    }
}
