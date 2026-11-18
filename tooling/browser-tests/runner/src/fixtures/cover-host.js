import { createServer as createHttpServer } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import { connect } from "node:net"
import { selfSignedCertificate } from "./gated-site.js"

// Cover image hosts served from this machine, so the test sees the headers that really reach the image
// server. A route sees a request before the browser's request rules run, so it cannot show whether a
// session rule removed a cookie. PERMITTED_HOST is a catalog cover host the extension holds a host
// permission for, OTHER_HOST a host it has no permission for, and FOLLOWED_HOST stands for a site the user
// follows (the test grants it). weeb.ltd is answered here too: Discover rails naming one cover on
// PERMITTED_HOST and one on OTHER_HOST, its cover route, and any other image path.

export const PERMITTED_HOST = "s4.anilist.co"
export const OTHER_HOST = "img.example.net"
export const FOLLOWED_HOST = "img.followed-site.test"
export const PERMITTED_COVER = `https://${PERMITTED_HOST}/file/cover-permitted.png`
export const OTHER_COVER = `https://${OTHER_HOST}/cover-other.png`
export const COOKIE = "cover_session=known-visitor"
export const COOKIE_HOSTS = [PERMITTED_HOST, OTHER_HOST, FOLLOWED_HOST, "weeb.ltd"]
const HOSTS = COOKIE_HOSTS

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
        if (url.pathname === "/set-cookie") {
            response.writeHead(200, {
                "content-type": "text/html",
                "set-cookie": `${COOKIE}; Path=/; Secure; SameSite=None`
            })
            response.end("<!doctype html><title>set</title>")
            return
        }
        if (host === "weeb.ltd" && !url.pathname.startsWith("/api/cover") && !url.pathname.endsWith(".png")) {
            const discover = url.pathname === "/api/public/discover"
            response.writeHead(discover ? 200 : 404, { "content-type": "application/json" })
            response.end(discover ? JSON.stringify(discoverRail(url.searchParams.get("rail"))) : "{}")
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
