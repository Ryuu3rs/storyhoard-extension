import { expect, test } from "@playwright/test"
import { chromium } from "playwright"
import { chromiumExtension } from "../../src/paths.js"
import { COOKIE, OTHER_HOST, PERMITTED_COVER, PERMITTED_HOST, startCoverHosts } from "./fixtures/cover-host.js"

// The policy says a cover image load tells the image server "your IP address and that the image was
// requested, nothing else". Discover rail covers are <img> tags on the extension's own page, so check what
// the image request carries when the user also has a cookie on that host. The image hosts run on this
// machine (fixtures/cover-host.js), so the headers checked are the ones that reach the server.

const [name, value] = COOKIE.split("=")

test("a Discover cover request carries no cookie and no referer naming the extension", async () => {
    const hosts = await startCoverHosts()
    const context = await chromium.launchPersistentContext("", {
        channel: "chromium",
        headless: true,
        ignoreHTTPSErrors: true,
        args: [
            `--disable-extensions-except=${chromiumExtension}`,
            `--load-extension=${chromiumExtension}`,
            `--host-resolver-rules=${hosts.hostResolverRules}`,
            "--ignore-certificate-errors"
        ]
    })
    try {
        await context.addCookies(
            [PERMITTED_HOST, OTHER_HOST].map(domain => ({
                name,
                value,
                domain,
                path: "/",
                secure: true,
                sameSite: "None"
            }))
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

        console.log("cover requests:", JSON.stringify(hosts.requests))
        for (const request of hosts.requests) expect(request.cookie, `cookie sent to ${request.host}`).toBeNull()
        for (const referer of referers) expect(referer).not.toMatch(/^chrome-extension:/)

        await expect(page.locator(`.weeb-discover-main img[src="${PERMITTED_COVER}"]`)).not.toHaveAttribute(
            "crossorigin",
            /.*/
        )

        // Without the session rule the same image does carry the cookie, so the check above is not vacuous.
        await worker.evaluate(async () => {
            const rules = await chrome.declarativeNetRequest.getSessionRules()
            const cookieRules = rules.filter(rule =>
                rule.action.requestHeaders?.some(h => h.header.toLowerCase() === "cookie" && h.operation === "remove")
            )
            await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: cookieRules.map(r => r.id) })
        })
        const seenBefore = hosts.requests.length
        await page.evaluate(async src => {
            const img = new Image()
            img.src = src
            document.body.append(img)
            await new Promise(resolve => (img.onload = img.onerror = resolve))
        }, `https://${PERMITTED_HOST}/control.png`)
        expect(hosts.requests.slice(seenBefore)).toEqual([
            { host: PERMITTED_HOST, path: "/control.png", cookie: COOKIE }
        ])
    } finally {
        await context.close()
        await hosts.close()
    }
})
