import assert from "node:assert/strict"
import { By, until } from "selenium-webdriver"
import { COOKIE, COOKIE_HOSTS, FOLLOWED_HOST, PERMITTED_HOST, startCoverHosts } from "./fixtures/cover-host.js"
import { extensionUuid, grantOrigin, withFirefox } from "./firefox-session.js"

// The Firefox half of cover-requests.test.js: Discover covers on the extension's page reach their image
// server without that server's cookies, while a site the user follows keeps its own. The image hosts and
// weeb.ltd run on this machine behind a proxy that refuses every other host, so the server sees the headers
// the browser really sent.

const APP_URL = `moz-extension://${extensionUuid}/app.html`

const loadImage = (driver, src) =>
    driver.executeAsyncScript(
        `const [src, done] = arguments
        const img = new Image()
        img.onload = img.onerror = () => done()
        img.src = src
        document.body.append(img)`,
        src
    )

const hosts = await startCoverHosts()
try {
    await withFirefox(
        {
            systemAccess: true,
            insecureCerts: true,
            preferences: {
                "network.proxy.type": 1,
                "network.proxy.ssl": "127.0.0.1",
                "network.proxy.ssl_port": hosts.proxyPort
            },
            failureShot: "firefox-cover-cookies-failure.png"
        },
        async driver => {
            await grantOrigin(driver, `https://${FOLLOWED_HOST}`)
            for (const host of COOKIE_HOSTS) await driver.get(`https://${host}/set-cookie`)

            await driver.get(APP_URL)
            await driver.wait(
                until.elementLocated(
                    By.xpath("//*[contains(@class,'weeb-discover-main')]//*[contains(., 'Cover On Other Host')]")
                ),
                15_000
            )
            await driver.wait(() => new Set(hosts.requests.map(r => r.host)).size >= 2, 10_000)
            console.log("Discover cover requests:", JSON.stringify(hosts.requests))
            for (const request of hosts.requests) assert.equal(request.cookie, null, `cookie sent to ${request.host}`)
            console.log("PASS Discover covers reach both image hosts without their cookies")

            const seenBefore = hosts.requests.length
            for (const src of [
                `https://${PERMITTED_HOST}/file/library.png`,
                "https://weeb.ltd/api/cover?u=a&s=b",
                `https://${FOLLOWED_HOST}/library-cover.png`,
                "https://weeb.ltd/images/banner.png"
            ]) {
                await loadImage(driver, src)
            }
            assert.deepEqual(hosts.requests.slice(seenBefore), [
                { host: PERMITTED_HOST, path: "/file/library.png", cookie: null },
                { host: "weeb.ltd", path: "/api/cover", cookie: null },
                { host: FOLLOWED_HOST, path: "/library-cover.png", cookie: COOKIE },
                { host: "weeb.ltd", path: "/images/banner.png", cookie: COOKIE }
            ])
            console.log("PASS only catalog cover hosts lose their cookies; a followed site keeps its own")

            const controlFrom = hosts.requests.length
            await driver.executeAsyncScript(
                `const done = arguments[arguments.length - 1]
                browser.declarativeNetRequest.getSessionRules()
                    .then(rules => browser.declarativeNetRequest.updateSessionRules({
                        removeRuleIds: rules
                            .filter(rule => (rule.action.requestHeaders ?? []).some(h => h.header.toLowerCase() === "cookie"))
                            .map(rule => rule.id)
                    }))
                    .then(() => done(), () => done())`
            )
            await loadImage(driver, `https://${PERMITTED_HOST}/control.png`)
            assert.deepEqual(hosts.requests.slice(controlFrom), [
                { host: PERMITTED_HOST, path: "/control.png", cookie: COOKIE }
            ])
            console.log("PASS without the session rules the catalog image carries the cookie")
        }
    )
} finally {
    await hosts.close()
}
