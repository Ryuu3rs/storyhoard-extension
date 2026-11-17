import { createServer as createHttpServer } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import { connect } from "node:net"
import { selfSignedCertificate } from "./gated-site.js"

// Cover image hosts served from this machine, so the test sees the headers that really reach the image
// server. A route sees a request before the browser's request rules run, so it cannot show whether a
// session rule removed a cookie. PERMITTED_HOST is one the extension holds a host permission for, OTHER_HOST
// one it does not. weeb.ltd is answered here too, with Discover rails naming one cover on each host.

export const PERMITTED_HOST = "s4.anilist.co"
export const OTHER_HOST = "img.example.net"
export const PERMITTED_COVER = `https://${PERMITTED_HOST}/file/cover-permitted.png`
export const OTHER_COVER = `https://${OTHER_HOST}/cover-other.png`
export const COOKIE = "cover_session=known-visitor"
const HOSTS = [PERMITTED_HOST, OTHER_HOST, "weeb.ltd"]

const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
)

const item = (anilistId, title, cover) => ({
    anilistId,
    workId: null,
    title,
    altTitles: [],
    cover,
    mediaType: "manga",
    genres: [],
    isAdult: false,
    metric: ""
})

export function discoverRail(rail) {
    const items =
        rail === "trending"
            ? [item(9101, "Cover On Permitted Host", PERMITTED_COVER), item(9102, "Cover On Other Host", OTHER_COVER)]
            : []
    return { rail, label: null, note: null, genre: null, items }
}

export async function startCoverHosts() {
    const requests = []
    const server = createHttpsServer(selfSignedCertificate(PERMITTED_HOST), (request, response) => {
        const host = (request.headers.host ?? "").replace(/:\d+$/, "")
        const url = new URL(request.url ?? "/", `https://${host}`)
        if (host === "weeb.ltd") {
            const body =
                url.pathname === "/api/public/discover"
                    ? JSON.stringify(discoverRail(url.searchParams.get("rail")))
                    : "{}"
            response.writeHead(url.pathname === "/api/public/discover" ? 200 : 404, {
                "content-type": "application/json"
            })
            response.end(body)
            return
        }
        if (url.pathname === "/set-cookie") {
            response.writeHead(200, {
                "content-type": "text/html",
                "set-cookie": `${COOKIE}; Path=/; Secure; SameSite=None`
            })
            response.end("<!doctype html><title>set</title>")
            return
        }
        if (url.pathname !== "/favicon.ico")
            requests.push({ host, path: url.pathname, cookie: request.headers.cookie ?? null })
        response.writeHead(200, { "content-type": "image/png" })
        response.end(PNG)
    })
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
    const port = server.address().port

    const proxy = createHttpServer((_request, response) => {
        response.writeHead(403)
        response.end()
    })
    proxy.on("connect", (request, client, head) => {
        if (!HOSTS.some(host => request.url === `${host}:443`)) {
            client.end("HTTP/1.1 403 Forbidden\r\n\r\n")
            return
        }
        const upstream = connect(port, "127.0.0.1", () => {
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
        port,
        proxyPort: proxy.address().port,
        hostResolverRules: HOSTS.map(host => `MAP ${host}:443 127.0.0.1:${port}`).join(","),
        close: async () => {
            server.closeAllConnections()
            proxy.closeAllConnections()
            await Promise.all([
                new Promise(resolve => server.close(resolve)),
                new Promise(resolve => proxy.close(resolve))
            ])
        }
    }
}
