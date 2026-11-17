// The on-page panel is built in a closed shadow root, so a page's scripts cannot reach it, and neither can
// Playwright locators. These helpers reach it through the DevTools protocol, which sees closed roots, and
// click with real mouse input at the control's own position, so the panel's checks (a trusted click on the
// visible control, on top at that point) see exactly what a user's click looks like. Chromium only.

const HOST = "#__amr-chapter-prompt__"

const DESCRIBE = `function () {
    const rect = this.getBoundingClientRect()
    const style = getComputedStyle(this)
    return {
        text: (this.textContent || "").trim(),
        label: this.getAttribute("aria-label"),
        disabled: this.disabled === true,
        options: this.options ? this.options.length : undefined,
        selected: this.selectedOptions && this.selectedOptions[0] ? this.selectedOptions[0].textContent.trim() : undefined,
        visible: rect.width > 0 && rect.height > 0 && style.visibility === "visible",
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2
    }
}`

function attribute(node, name) {
    const attributes = node.attributes ?? []
    for (let i = 0; i < attributes.length; i += 2) if (attributes[i] === name) return attributes[i + 1]
    return undefined
}

function findHost(node, mode) {
    if (attribute(node, "id") === HOST.slice(1) && (!mode || attribute(node, "data-amr-mode") === mode)) return node
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
        const found = findHost(child, mode)
        if (found) return found
    }
    return undefined
}

async function withPanelRoot(page, mode, run) {
    const session = await page.context().newCDPSession(page)
    try {
        const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true })
        const shadow = findHost(root, mode)?.shadowRoots?.[0]
        return await run(session, shadow)
    } finally {
        await session.detach().catch(() => {})
    }
}

async function callOn(session, nodeId, functionDeclaration) {
    const { object } = await session.send("DOM.resolveNode", { nodeId })
    const { result } = await session.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration,
        returnByValue: true
    })
    return result.value
}

// Every element in the panel matching the selector, described: text, aria-label, disabled, option count,
// selected option, visibility and its centre on the page. Empty when there is no panel (of that mode).
export async function panelElements(page, selector, { mode } = {}) {
    return withPanelRoot(page, mode, async (session, shadow) => {
        if (!shadow) return []
        const { nodeIds } = await session.send("DOM.querySelectorAll", { nodeId: shadow.nodeId, selector })
        const described = []
        for (const nodeId of nodeIds) described.push(await callOn(session, nodeId, DESCRIBE))
        return described
    })
}

// The panel's text as the user sees it (hidden parts left out). Undefined when there is no panel.
export async function panelText(page, { mode } = {}) {
    return withPanelRoot(page, mode, async (session, shadow) => {
        if (!shadow) return undefined
        return callOn(
            session,
            shadow.nodeId,
            `function () { const wrap = this.querySelector(".wrap"); return wrap ? wrap.innerText : "" }`
        )
    })
}

// Click a visible, enabled panel control with the mouse, once it has stopped moving (the panel animates in).
export async function clickPanel(page, selector, { text, mode, timeout = 10_000 } = {}) {
    const deadline = Date.now() + timeout
    const find = async () =>
        (await panelElements(page, selector, { mode })).find(
            element => element.visible && !element.disabled && (text === undefined || element.text === text)
        )
    let last
    while (Date.now() < deadline) {
        const found = await find()
        if (found && last && found.x === last.x && found.y === last.y) {
            await page.mouse.click(found.x, found.y)
            return
        }
        last = found
        await page.waitForTimeout(200)
    }
    throw new Error(`No visible, enabled panel control ${selector}${text ? ` "${text}"` : ""} within ${timeout}ms`)
}
