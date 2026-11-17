import { expect } from "@playwright/test"

// Following a site is done from the toolbar popup, never from the on-page panel (a page can draw over the
// panel). The popup acts on the active tab of its window, so it is loaded in a tab of its own and then
// reloaded while the reader page is the active tab, which is what the toolbar shows it over. The popup asks
// for the site and its www twin, so a test grants both up front: a headless browser cannot answer a prompt.
// Chromium only.
export async function addSiteFromPopup(context, extensionId, page) {
    const popup = await context.newPage()
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" })
    await page.bringToFront()
    await popup.reload({ waitUntil: "domcontentloaded" })
    await popup.getByRole("button", { name: "Add this site" }).click({ timeout: 15_000 })
    await popup.getByRole("button", { name: "Add site", exact: true }).click()
    await expect(popup.getByText(/^Site added\./)).toBeVisible({ timeout: 20_000 })
    await popup.close()
}
