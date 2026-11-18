import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { chromiumExtension } from "../../src/paths.js"
import {
    COOKIE,
    COOKIE_HOSTS,
    FOLLOWED_HOST,
    PERMITTED_COVER,
    PERMITTED_HOST,
    startCoverHosts
} from "./fixtures/cover-host.js"

// The policy says a cover image load tells the image server "your IP address and that the image was
// requested, nothing else". Discover rail covers are <img> tags on the extension's own page, so check what
// the image request carries when the user also has a cookie on that host. The image hosts run on this
// machine (fixtures/cover-host.js), so the headers checked are the ones that reach the server. A site the
// user follows keeps its cookies: the extension holds a grant for FOLLOWED_HOST, written into a temp copy of
// the manifest as in site-gate.test.js.

const [name, value] = COOKIE.split("=")

function buildWithFollowedSite() {
    const directory = mkdtempSync(path.join(tmpdir(), "amr-covers-"))
    cpSync(chromiumExtension, directory, { recursive: true })
    const manifestPath = path.join(directory, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    manifest.host_permissions = [...(manifest.host_permissions ?? []), `https://${FOLLOWED_HOST}/*`]
    writeFileSync(manifestPath, JSON.stringify(manifest))
    return directory
}

const loadImage = (page, src) =>
    page.evaluate(async url => {
        const img = new Image()
        img.src = url
        document.body.append(img)
        await new Promise(resolve => (img.onload = img.onerror = resolve))
    }, src)

test("cover requests carry no cookie to catalog hosts, while a followed site keeps its own", async () => {
    const hosts = await startCoverHosts()
    const extension = buildWithFollowedSite()
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        ignoreHTTPSErrors: true,
        args: [
            `--disable-extensions-except=${extension}`,
            `--load-extension=${extension}`,
            `--host-resolver-rules=${hosts.hostResolverRules}`,
            "--ignore-certificate-errors"
        ]
    })
    try {
        await context.addCookies(
            COOKIE_HOSTS.map(domain => ({ name, value, domain, path: "/", secure: true, sameSite: "None" }))
        )
        await context.route("https://graphql.anilist.co/**", route =>
            route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: null }) })
        )
        const referers = []
        context.on("request", request => {
            if (request.resourceType() === "image") referers.push(request.headers()["referer"] ?? "")
        })

        let [worker] = context.serviceWorkers()
        worker ??= await context.waitForEvent("serviceworker")
        const page = await context.newPage()
        await page.goto(`chrome-extension://${new URL(worker.url()).host}/app.html`, { waitUntil: "domcontentloaded" })
        await expect(page.locator(".weeb-discover-main").getByText("Cover On Other Host")).toBeVisible()
        await expect
            .poll(() => new Set(hosts.requests.map(r => r.host)).size, { timeout: 10_000 })
            .toBeGreaterThanOrEqual(2)

        console.log("Discover cover requests:", JSON.stringify(hosts.requests))
        for (const request of hosts.requests) expect(request.cookie, `cookie sent to ${request.host}`).toBeNull()
        for (const referer of referers) expect(referer).not.toMatch(/^chrome-extension:/)
        await expect(page.locator(`.weeb-discover-main img[src="${PERMITTED_COVER}"]`)).not.toHaveAttribute(
            "crossorigin",
            /.*/
        )

        // Plain image loads from the extension's page, as library covers are: the rules reach the catalog
        // hosts and weeb.ltd's cover route only.
        const seenBefore = hosts.requests.length
        for (const src of [
            `https://${PERMITTED_HOST}/file/library.png`,
            "https://weeb.ltd/api/cover?u=a&s=b",
            `https://${FOLLOWED_HOST}/library-cover.png`,
            "https://weeb.ltd/images/banner.png"
        ]) {
            await loadImage(page, src)
        }
        expect(hosts.requests.slice(seenBefore)).toEqual([
            { host: PERMITTED_HOST, path: "/file/library.png", cookie: null },
            { host: "weeb.ltd", path: "/api/cover", cookie: null },
            { host: FOLLOWED_HOST, path: "/library-cover.png", cookie: COOKIE },
            { host: "weeb.ltd", path: "/images/banner.png", cookie: COOKIE }
        ])

        // Without the session rules the catalog host gets the cookie too, so the checks above are not vacuous.
        await worker.evaluate(async () => {
            const rules = await chrome.declarativeNetRequest.getSessionRules()
            const cookieRules = rules.filter(rule =>
                rule.action.requestHeaders?.some(h => h.header.toLowerCase() === "cookie" && h.operation === "remove")
            )
            await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: cookieRules.map(r => r.id) })
        })
        const controlFrom = hosts.requests.length
        await loadImage(page, `https://${PERMITTED_HOST}/control.png`)
        expect(hosts.requests.slice(controlFrom)).toEqual([
            { host: PERMITTED_HOST, path: "/control.png", cookie: COOKIE }
        ])
    } finally {
        await context.close()
        await hosts.close()
        rmSync(extension, { recursive: true, force: true })
    }
})
