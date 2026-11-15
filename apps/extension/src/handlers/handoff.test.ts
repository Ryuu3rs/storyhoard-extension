import { beforeEach, describe, expect, it, vi } from "vitest"

const confirmPendingLink = vi.fn()
vi.mock("../link-handoff", () => ({
    confirmPendingLink: (...a: unknown[]) => confirmPendingLink(...a),
    discardPendingLink: vi.fn(),
    handleHandoffMessage: vi.fn(),
    pendingLinkHandle: vi.fn()
}))

vi.stubGlobal("browser", { runtime: { getURL: (p: string) => `chrome-extension://ext/${p}` } })

const { handoffHandlers } = await import("./handoff")

const appPage = { sender: { url: "chrome-extension://ext/app.html?confirmLink=1" } } as never

beforeEach(() => {
    confirmPendingLink.mockReset()
    confirmPendingLink.mockResolvedValue({ linked: true, handle: "reader" })
})

describe("handoff:confirm", () => {
    it("passes the handle the confirm page showed through to the staged-link check", async () => {
        await handoffHandlers["handoff:confirm"]!({ type: "handoff:confirm", handle: "reader" } as never, appPage)
        expect(confirmPendingLink).toHaveBeenCalledWith("reader")
    })

    it("still confirms without a handle until the confirm page sends one", async () => {
        await handoffHandlers["handoff:confirm"]!({ type: "handoff:confirm" }, appPage)
        expect(confirmPendingLink).toHaveBeenCalledWith(undefined)
    })

    it("never confirms for a web page", async () => {
        const res = await handoffHandlers["handoff:confirm"]!(
            { type: "handoff:confirm", handle: "reader" } as never,
            {
                sender: { url: "https://weeb.ltd/welcome", tab: { id: 1 } }
            } as never
        )
        expect(res).toEqual({ linked: false, handle: "" })
        expect(confirmPendingLink).not.toHaveBeenCalled()
    })
})
