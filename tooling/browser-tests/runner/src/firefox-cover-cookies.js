import assert from "node:assert/strict"
import { By, until } from "selenium-webdriver"
import { COOKIE, OTHER_HOST, PERMITTED_HOST, startCoverHosts } from "./fixtures/cover-host.js"
import { extensionUuid, withFirefox } from "./firefox-session.js"

// The Firefox half of cover-requests.test.js: Discover covers on the extension's page reach their image
// server without that server's cookies. The image hosts and weeb.ltd run on this machine behind a proxy that
// refuses every other host, so the server sees the headers the browser really sent.

const APP_URL = `moz-extension://${extensionUuid}/app.html`

const hosts = await startCoverHosts()
try {
    await withFirefox(
        {
            insecureCerts: true,
            preferences: {
                "network.proxy.type": 1,
                "network.proxy.ssl": "127.0.0.1",
                "network.proxy.ssl_port": hosts.proxyPort
            },
            failureShot: "firefox-cover-cookies-failure.png"
        },
        async driver => {
            for (const host of [PERMITTED_HOST, OTHER_HOST]) await driver.get(`https://${host}/set-cookie`)

            await driver.get(APP_URL)
            await driver.wait(
                until.elementLocated(
                    By.xpath("//*[contains(@class,'weeb-discover-main')]//*[contains(., 'Cover On Other Host')]")
                ),
                15_000
            )
            await driver.wait(() => new Set(hosts.requests.map(r => r.host)).size >= 2, 10_000)
            console.log("cover requests:", JSON.stringify(hosts.requests))
            for (const request of hosts.requests) assert.equal(request.cookie, null, `cookie sent to ${request.host}`)
            console.log("PASS Discover covers reach both image hosts without their cookies")

            const seenBefore = hosts.requests.length
            await driver.executeAsyncScript(
                `const [src, done] = arguments
                browser.declarativeNetRequest.getSessionRules()
                    .then(rules => browser.declarativeNetRequest.updateSessionRules({
                        removeRuleIds: rules
                            .filter(rule => (rule.action.requestHeaders ?? []).some(h => h.header.toLowerCase() === "cookie"))
                            .map(rule => rule.id)
                    }))
                    .then(() => {
                        const img = new Image()
                        img.onload = img.onerror = () => done()
                        img.src = src
                        document.body.append(img)
                    }, () => done())`,
                `https://${PERMITTED_HOST}/control.png`
            )
            assert.deepEqual(hosts.requests.slice(seenBefore), [
                { host: PERMITTED_HOST, path: "/control.png", cookie: COOKIE }
            ])
            console.log("PASS without the session rule the same image carries the cookie")
        }
    )
} finally {
    await hosts.close()
}
