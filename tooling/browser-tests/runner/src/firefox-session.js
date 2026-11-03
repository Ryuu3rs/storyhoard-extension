import { start } from "geckodriver"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { firefox as playwrightFirefox } from "playwright"
import { Builder } from "selenium-webdriver"
import firefox from "selenium-webdriver/firefox.js"
import { artifactsDirectory, firefoxExtension } from "../../src/paths.js"

export const extensionId = "amr-next@ryuu3rs.dev"
export const extensionUuid = "8d2b2cc7-86aa-4afd-b733-939aaf4bb217"
const geckodriverPort = Number(process.env.GECKODRIVER_PORT ?? 4444)
const geckodriverUrl = `http://127.0.0.1:${geckodriverPort}`

async function waitForGeckodriver() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
            const response = await fetch(`${geckodriverUrl}/status`)
            if (response.ok) return
        } catch {
            // The driver may still be starting.
        }
        await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error("Geckodriver did not become ready")
}

// Runs `body` against a headless Firefox with the extension installed. The built folder is the default,
// not a zip from .output, which keeps zips of every past release and could load one of those instead.
export async function withFirefox({ bidi = false, systemAccess = false, failureShot }, body) {
    const options = new firefox.Options()
    options.addArguments("-headless")
    if (bidi) options.enableBidi()
    options.setPreference("extensions.webextensions.uuids", JSON.stringify({ [extensionId]: extensionUuid }))
    options.setBinary(process.env.FIREFOX_BIN ?? playwrightFirefox.executablePath())

    const geckodriver = await start({
        host: "127.0.0.1",
        port: geckodriverPort,
        ...(systemAccess ? { allowSystemAccess: true } : {})
    })
    let driver
    try {
        await waitForGeckodriver()
        driver = await new Builder()
            .usingServer(geckodriverUrl)
            .forBrowser("firefox")
            .setFirefoxOptions(options)
            .build()
        const installedId = await driver.installAddon(
            path.resolve(process.env.FIREFOX_EXTENSION_PATH ?? firefoxExtension),
            true
        )
        await body(driver, installedId)
    } catch (error) {
        if (driver) {
            await mkdir(artifactsDirectory, { recursive: true })
            const screenshot = await driver.takeScreenshot()
            await writeFile(path.join(artifactsDirectory, failureShot), screenshot, "base64")
        }
        throw error
    } finally {
        await driver?.quit()
        geckodriver.kill()
    }
}
